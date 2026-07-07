
from flask import Blueprint, request, jsonify, current_app
import requests, os, re
from dotenv import load_dotenv
from dataverse_helper import get_access_token, get_dataverse_session, get_supabase

tasks_bp = Blueprint("project_tasks", __name__, url_prefix="/api")

load_dotenv()

# ======================
# Dataverse Config
# ======================
DATAVERSE_BASE = os.getenv("RESOURCE")
DATAVERSE_API = os.getenv("DATAVERSE_API", "/api/data/v9.2")
ENTITY_SET_TASKS = "crc6f_hr_taskdetailses"

# ======================
# Helper Functions
# ======================
def dv_url(path):
    return f"{DATAVERSE_BASE}{DATAVERSE_API}{path}"

def headers():
    token = get_access_token()
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "OData-Version": "4.0",
        "Content-Type": "application/json",
    }

# ======================
# Auto-generate Task ID
# ======================
def generate_task_id(task_type="Task"):
    """Generate next work-item ID (TASK001 / BUG001, etc.).

    Uses Supabase natively - fetches ALL existing IDs with the prefix and
    computes the true numeric max. Avoids relying on $orderby which can
    silently fail in the OData adapter and produce colliding IDs.
    """
    prefix = "BUG" if str(task_type or "Task").strip().lower() == "bug" else "TASK"
    try:
        sb = get_supabase()
        # Fetch all existing IDs whose value starts with the prefix
        resp = (
            sb.table(ENTITY_SET_TASKS)
              .select("crc6f_taskid")
              .ilike("crc6f_taskid", f"{prefix}%")
              .execute()
        )
        rows = resp.data or []
        max_num = 0
        pattern = re.compile(rf"^{prefix}(\d+)$", re.IGNORECASE)
        for r in rows:
            val = str(r.get("crc6f_taskid") or "").strip().upper()
            m = pattern.match(val)
            if m:
                try:
                    num = int(m.group(1))
                    if num > max_num:
                        max_num = num
                except ValueError:
                    continue

        next_num = max_num + 1
        new_id = f"{prefix}{next_num:03d}"
        print(f"[generate_task_id] Prefix: {prefix}, existing={len(rows)}, max={max_num}, new={new_id}")
        return new_id
    except Exception as e:
        print(f"⚠️ Error generating task id: {e}")
        # Fallback: use timestamp-based suffix to minimise collision risk
        import time
        return f"{prefix}{int(time.time()) % 100000:05d}"


# ======================
# 1️⃣ GET ALL TASKS BY PROJECT
# ======================
@tasks_bp.route("/projects/<project_code>/tasks", methods=["GET"])
def get_tasks(project_code):
    """Fetch all tasks for a specific project, grouped by correct board ID"""
    try:
        token = get_access_token()
        hdrs = headers()

        # 🔹 Fetch all tasks for the given project (optionally scoped to a board)
        board_id = (request.args.get("board_id") or "").strip()
        filter_q = f"crc6f_projectid eq '{project_code}'"
        if board_id:
            filter_q += f" and crc6f_boardid eq '{board_id}'"

        url = f"{DATAVERSE_BASE}{DATAVERSE_API}/{ENTITY_SET_TASKS}?$filter={filter_q}"
        res = get_dataverse_session().get(url, headers=hdrs, timeout=15)

        if not res.ok:
            current_app.logger.error(f"❌ Failed to fetch tasks for {project_code}: {res.text}")
            return jsonify({"success": False, "error": res.text}), res.status_code

        data = res.json().get("value", [])
        tasks = []
        for idx, t in enumerate(data, start=1):
            tasks.append({
                "guid": t.get("crc6f_hr_taskdetailsid"),
                "task_id": t.get("crc6f_taskid"),
                "task_name": t.get("crc6f_taskname"),
                "task_priority": t.get("crc6f_taskpriority"),
                "task_status": t.get("crc6f_taskstatus"),
                "assigned_to": t.get("crc6f_assignedto"),
                "due_date": t.get("crc6f_duedate"),
                "due_time": t.get("crc6f_duetime"),
                "board_id": t.get("crc6f_boardid"),
                "project_id": project_code,
                "display_index": idx  # ✅ for 1, 2, 3 numbering
            })

        current_app.logger.info(f"✅ Loaded {len(tasks)} tasks for project {project_code}")
        return jsonify({"success": True, "tasks": tasks}), 200

    except Exception as e:
        current_app.logger.exception("Error fetching tasks")
        return jsonify({"success": False, "error": str(e)}), 500


# ======================
# 2️⃣ ADD TASK
# ======================
@tasks_bp.route("/projects/<project_code>/tasks", methods=["POST"])
def add_task(project_code):
    """Add new task to project"""
    try:
        body = request.get_json(force=True) or {}
        current_app.logger.info(f"📥 Add Task for {project_code}: {body}")

        token = get_access_token()
        hdrs = headers()

        task_type = str(body.get("task_type") or "Task").strip().lower()
        task_prefix = "BUG" if task_type == "bug" else "TASK"

        # ✅ Generate and verify unique Task ID (retry if collision)
        generated_id = None
        candidate_id = generate_task_id(task_type)
        attempt = 0
        MAX_ATTEMPTS = 10

        while attempt < MAX_ATTEMPTS:
            check_url = f"{DATAVERSE_BASE}{DATAVERSE_API}/{ENTITY_SET_TASKS}?$filter=crc6f_taskid eq '{candidate_id}'"
            check_res = get_dataverse_session().get(check_url, headers=hdrs, timeout=10)

            if not check_res.ok:
                # Check request itself failed — trust the Supabase-generated ID and proceed
                current_app.logger.warning(f"[add_task] Uniqueness check failed ({check_res.status_code}), using candidate {candidate_id} anyway")
                generated_id = candidate_id
                break

            existing = check_res.json().get("value", [])
            if not existing:
                generated_id = candidate_id
                break

            # Confirmed collision; increment numeric suffix and retry
            match = re.search(rf"{task_prefix}(\d+)", candidate_id)
            next_num = int(match.group(1)) + 1 if match else attempt + 1
            candidate_id = f"{task_prefix}{next_num:03d}"
            attempt += 1

        if not generated_id:
            return jsonify({"success": False, "error": "Unable to generate unique TASK ID"}), 400

        # Resolve board identifier (accept both legacy board_name and new board_id field)
        board_identifier = body.get("board_id") or body.get("board_name")

        # ✅ Continue if no duplicate found
        dv_payload = {
            "crc6f_taskid": generated_id,
            "crc6f_taskname": body.get("task_name"),
            "crc6f_taskdescription": body.get("task_description"),
            "crc6f_tasktype": body.get("task_type"),
            "crc6f_taskpriority": body.get("task_priority"),
            "crc6f_taskstatus": body.get("task_status", "New"),
            "crc6f_assignedto": body.get("assigned_to"),
            "crc6f_assigneddate": body.get("assigned_date"),
            "crc6f_duedate": body.get("due_date"),
            "crc6f_duetime": body.get("due_time"),
            "crc6f_projectid": project_code,
            "crc6f_boardid": board_identifier,
        }

        dv_payload = {k: v for k, v in dv_payload.items() if v not in (None, "", [])}
        url = f"{DATAVERSE_BASE}{DATAVERSE_API}/{ENTITY_SET_TASKS}"
        res = get_dataverse_session().post(url, headers=hdrs, json=dv_payload, timeout=15)

        current_app.logger.info(f"Dataverse response {res.status_code}: {res.text}")

        if res.status_code in (200, 201, 204):
            return jsonify({"success": True, "message": "Task created successfully"}), 201
        else:
            return jsonify({"success": False, "error": res.text}), res.status_code

    except Exception as e:
        current_app.logger.exception("Error in add_task")
        return jsonify({"success": False, "error": str(e)}), 500



# ======================
# 3️⃣ UPDATE TASK
# ======================
@tasks_bp.route("/tasks/<guid>", methods=["PATCH"])
def update_task(guid):
    """Update task fields"""
    try:
        body = request.get_json(force=True)
        current_app.logger.info(f"✏️ Update Task {guid} with {body}")

        token = get_access_token()
        hdrs = headers()

        allowed_fields = {
            "task_name": "crc6f_taskname",
            "task_description": "crc6f_taskdescription",
            "task_priority": "crc6f_taskpriority",
            "task_status": "crc6f_taskstatus",
            "assigned_to": "crc6f_assignedto",
            "assigned_date": "crc6f_assigneddate",
            "due_date": "crc6f_duedate",
            "due_time": "crc6f_duetime",
        }

        payload = {v: body[k] for k, v in allowed_fields.items() if k in body}
        url = f"{DATAVERSE_BASE}{DATAVERSE_API}/{ENTITY_SET_TASKS}({guid})"
        res = get_dataverse_session().patch(url, headers=hdrs, json=payload, timeout=15)

        if res.status_code in (200, 204):
            return jsonify({"success": True, "message": "Task updated successfully"}), 200
        else:
            return jsonify({"success": False, "error": res.text}), res.status_code

    except Exception as e:
        current_app.logger.exception("Error updating task")
        return jsonify({"success": False, "error": str(e)}), 500


# ======================
# 4️⃣ DELETE TASK
# ======================
@tasks_bp.route("/tasks/<guid>", methods=["DELETE"])
def delete_task(guid):
    """Delete a task by GUID"""
    try:
        token = get_access_token()
        hdrs = {"Authorization": f"Bearer {token}", "Accept": "application/json"}

        del_url = f"{DATAVERSE_BASE}{DATAVERSE_API}/{ENTITY_SET_TASKS}({guid})"
        res = get_dataverse_session().delete(del_url, headers=hdrs, timeout=15)

        if res.status_code in (200, 204):
            current_app.logger.info(f"🗑️ Task {guid} deleted")
            return jsonify({"success": True, "message": "Task deleted successfully"}), 200
        else:
            return jsonify({"success": False, "error": res.text}), res.status_code

    except Exception as e:
        current_app.logger.exception("Error deleting task")
        return jsonify({"success": False, "error": str(e)}), 500


# ======================
# 5️⃣ GET SINGLE TASK BY ID
# ======================
@tasks_bp.route("/tasks/<guid>", methods=["GET"])
def get_task(guid):
    """Fetch single task details by GUID"""
    try:
        token = get_access_token()
        hdrs = {"Authorization": f"Bearer {token}", "Accept": "application/json"}

        select_fields = ",".join([
            "crc6f_taskname", "crc6f_taskdescription",
            "crc6f_taskpriority", "crc6f_taskstatus",
            "crc6f_assignedto", "crc6f_assigneddate",
            "crc6f_duedate", "crc6f_taskid"
        ])
        url = f"{DATAVERSE_BASE}{DATAVERSE_API}/{ENTITY_SET_TASKS}({guid})?$select={select_fields}"
        res = get_dataverse_session().get(url, headers=hdrs, timeout=15)

        if not res.ok:
            current_app.logger.error(f"Failed fetching task {guid}: {res.status_code} {res.text}")
            return jsonify({"success": False, "error": res.text}), res.status_code

        rec = res.json()
        task = {
            "guid": guid,
            "task_name": rec.get("crc6f_taskname"),
            "task_description": rec.get("crc6f_taskdescription"),
            "task_priority": rec.get("crc6f_taskpriority"),
            "task_status": rec.get("crc6f_taskstatus"),
            "assigned_to": rec.get("crc6f_assignedto"),
            "assigned_date": rec.get("crc6f_assigneddate"),
            "due_date": rec.get("crc6f_duedate"),
            "task_id": rec.get("crc6f_taskid"),
        }
        return jsonify({"success": True, "task": task}), 200

    except Exception as e:
        current_app.logger.exception("Error fetching task")
        return jsonify({"success": False, "error": str(e)}), 500

