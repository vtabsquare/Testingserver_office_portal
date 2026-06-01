# # ============================================================
# # 📁 boards_bp.py
# # Manage Boards inside Projects (Full CRUD + auto ID)
# # ============================================================
# from flask import Blueprint, request, jsonify, current_app
# import requests, os, re, traceback
# from dotenv import load_dotenv
# from dataverse_helper import get_access_token

# bp = Blueprint("project_boards", __name__, url_prefix="/api")

# load_dotenv()

# # ======================
# # Dataverse Config
# # ======================
# DATAVERSE_BASE = os.getenv("RESOURCE")
# DATAVERSE_API = os.getenv("DATAVERSE_API", "/api/data/v9.2")
# ENTITY_SET_BOARDS = "crc6f_hr_projectdetailses"  # your table for boards
# PROJECT_HEADER_ES = "crc6f_hr_projectheaders"

# # Field names
# F_BOARD_ID = "crc6f_boardid"
# F_BOARD_NAME = "crc6f_boardname"
# F_DESC = "crc6f_boarddescription"
# F_NO_TASKS = "crc6f_nooftasks"
# F_NO_MEMBERS = "crc6f_noofmembers"
# F_PROJECT_ID = "crc6f_projectid"
# F_GUID = "crc6f_hr_projectdetailsid"

# def dv_url(path):
#     return f"{DATAVERSE_BASE}{DATAVERSE_API}{path}"

# def headers():
#     token = get_access_token()
#     return {
#         "Authorization": f"Bearer {token}",
#         "Accept": "application/json",
#         "OData-Version": "4.0",
#         "Content-Type": "application/json"
#     }

# # ============================================================
# # Auto Generate Board ID (like BRD001, BRD002)
# # ============================================================
# def generate_board_id():
#     try:
#         token = get_access_token()
#         hdr = {"Authorization": f"Bearer {token}", "Accept": "application/json"}

#         existing_ids = set()

#         # Get ALL board IDs (Dataverse filtering)
#         url = f"{DATAVERSE_BASE}{DATAVERSE_API}/{ENTITY_SET_BOARDS}?$select={F_BOARD_ID}&$top=5000"
#         res = requests.get(url, headers=hdr, timeout=20)

#         if res.ok:
#             for r in res.json().get("value", []):
#                 bid = r.get(F_BOARD_ID)
#                 if bid:
#                     existing_ids.add(bid)

#         # Auto generate
#         num = 1
#         while True:
#             new_id = f"BRD{num:03d}"
#             if new_id not in existing_ids:
#                 return new_id
#             num += 1

#     except Exception as e:
#         current_app.logger.error(f"⚠ Error generating board_id: {e}")
#         return "BRD001"

# # ============================================================
# # 1️⃣ GET ALL BOARDS FOR A PROJECT
# # ============================================================
# @bp.route("/projects/<project_code>/boards", methods=["GET"])
# def get_boards(project_code):
#     """Fetch all boards for a given project."""
#     try:
#         token = get_access_token()
#         hdr = {"Authorization": f"Bearer {token}", "Accept": "application/json"}

#         url = (
#             f"{DATAVERSE_BASE}{DATAVERSE_API}/{ENTITY_SET_BOARDS}"
#             f"?$filter={F_PROJECT_ID} eq '{project_code}'"
#             f"&$select={F_GUID},{F_BOARD_ID},{F_BOARD_NAME},{F_DESC},{F_NO_TASKS},{F_NO_MEMBERS},{F_PROJECT_ID}"
#         )
#         res = requests.get(url, headers=hdr, timeout=20)
#         if not res.ok:
#             return jsonify({"success": False, "error": res.text}), 500

#         boards = []
#         for r in res.json().get("value", []):
#             boards.append({
#                 "guid": r.get(F_GUID),
#                 "board_id": r.get(F_BOARD_ID),
#                 "board_name": r.get(F_BOARD_NAME),
#                 "board_description": r.get(F_DESC),
#                 "no_of_tasks": r.get(F_NO_TASKS, 0),
#                 "no_of_members": r.get(F_NO_MEMBERS, 0),
#                 "project_id": r.get(F_PROJECT_ID),
#             })

#         return jsonify({"success": True, "boards": boards}), 200

#     except Exception as e:
#         current_app.logger.exception("Error fetching boards")
#         return jsonify({"success": False, "error": str(e)}), 500


# # ============================================================
# # 2️⃣ ADD BOARD
# # ============================================================
# @bp.route("/projects/<project_code>/boards", methods=["POST"])
# def add_board(project_code):
#     """Add a board under a specific project."""
#     try:
#         body = request.get_json(force=True) or {}
#         current_app.logger.info(f"Add board for {project_code}: {body}")

#         token = get_access_token()
#         hdr = {
#             "Authorization": f"Bearer {token}",
#             "Accept": "application/json",
#             "Content-Type": "application/json"
#         }

#         # Generate new board id
#         board_id = generate_board_id()

#         payload = {
#             F_BOARD_ID: board_id,
#             F_BOARD_NAME: body.get("board_name"),
#             F_DESC: body.get("board_description", ""),
#             F_NO_TASKS: str(body.get("no_of_tasks", 0)),
#             F_NO_MEMBERS: str(body.get("no_of_members", 0)),
#             F_PROJECT_ID: project_code
#         }

#         payload = {k: v for k, v in payload.items() if v not in (None, "", [])}

#         url = f"{DATAVERSE_BASE}{DATAVERSE_API}/{ENTITY_SET_BOARDS}"
#         res = requests.post(url, headers=hdr, json=payload, timeout=20)

#         if res.status_code in (200, 201, 204):
#             return jsonify({"success": True, "message": "Board added successfully"}), 201
#         else:
#             current_app.logger.error(f"Add board failed: {res.text}")
#             return jsonify({"success": False, "error": res.text}), 400

#     except Exception as e:
#         current_app.logger.exception("Error adding board")
#         return jsonify({"success": False, "error": str(e)}), 500


# # ============================================================
# # 3️⃣ UPDATE BOARD
# # ============================================================
# @bp.route("/boards/<guid>", methods=["PATCH"])
# def update_board(guid):
#     """Update board details by Dataverse GUID."""
#     try:
#         body = request.get_json(force=True)
#         token = get_access_token()
#         hdr = {
#             "Authorization": f"Bearer {token}",
#             "Accept": "application/json",
#             "Content-Type": "application/json"
#         }

#         data = {}
#         if "board_name" in body:
#             data[F_BOARD_NAME] = body["board_name"]
#         if "board_description" in body:
#             data[F_DESC] = body["board_description"]
#         if "no_of_tasks" in body:
#             data[F_NO_TASKS] = str(body["no_of_tasks"])
#         if "no_of_members" in body:
#             data[F_NO_MEMBERS] = str(body["no_of_members"])

#         url = f"{DATAVERSE_BASE}{DATAVERSE_API}/{ENTITY_SET_BOARDS}({guid})"
#         res = requests.patch(url, headers=hdr, json=data, timeout=20)

#         if res.status_code in (200, 204):
#             return jsonify({"success": True, "message": "Board updated"}), 200
#         else:
#             return jsonify({"success": False, "error": res.text}), 400

#     except Exception as e:
#         current_app.logger.exception("Error updating board")
#         return jsonify({"success": False, "error": str(e)}), 500


# # ============================================================
# # 4️⃣ DELETE BOARD
# # ============================================================
# @bp.route("/boards/<guid>", methods=["DELETE"])
# def delete_board(guid):
#     """Delete a board by Dataverse GUID."""
#     try:
#         token = get_access_token()
#         hdr = {"Authorization": f"Bearer {token}", "Accept": "application/json"}

#         url = f"{DATAVERSE_BASE}{DATAVERSE_API}/{ENTITY_SET_BOARDS}({guid})"
#         res = requests.delete(url, headers=hdr, timeout=20)

#         if res.status_code in (200, 204):
#             return jsonify({"success": True, "message": "Board deleted"}), 200
#         else:
#             return jsonify({"success": False, "error": res.text}), 400

#     except Exception as e:
#         current_app.logger.exception("Error deleting board")
#         return jsonify({"success": False, "error": str(e)}), 500
# boards_bp.py
from flask import Blueprint, request, jsonify, current_app
import requests, os, re, traceback
from dotenv import load_dotenv
from dataverse_helper import get_access_token, get_dataverse_session
import urllib.parse

bp = Blueprint("project_boards",  __name__, url_prefix="/api")

load_dotenv()

# ======================
# Dataverse Config
# ======================
DATAVERSE_BASE = os.getenv("RESOURCE")
DATAVERSE_API = os.getenv("DATAVERSE_API", "/api/data/v9.2")
ENTITY_SET_BOARDS = "crc6f_hr_projectdetailses"  # your table for boards
PROJECT_HEADER_ES = "crc6f_hr_projectheaders"

# Field names
F_BOARD_ID = "crc6f_boardid"
F_BOARD_NAME = "crc6f_boardname"
F_DESC = "crc6f_boarddescription"
F_NO_TASKS = "crc6f_nooftasks"
F_NO_MEMBERS = "crc6f_noofmembers"
F_PROJECT_ID = "crc6f_projectid"
F_GUID = "crc6f_hr_projectdetailsid"
F_STATUS = "crc6f_boardstatus"

BOARD_RPT_MAP = {
    F_NO_TASKS: "crc6f_RPT_nooftasks",
    F_NO_MEMBERS: "crc6f_RPT_noofmembers",
}


def _is_missing_column_error(response_obj, column_name):
    """Detect PostgREST missing-column errors for graceful fallback."""
    try:
        if not response_obj:
            return False
        body = response_obj.json() if hasattr(response_obj, "json") else {}
        code = str(body.get("code") or "")
        message = str(body.get("message") or "")
        return code == "PGRST204" and column_name in message
    except Exception:
        return False

def dv_url(path):
    return f"{DATAVERSE_BASE}{DATAVERSE_API}{path}"

def headers():
    token = get_access_token()
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "OData-Version": "4.0",
        "Content-Type": "application/json"
    }

# Auto Generate Board ID (BRD001...)
# ============================================================
def generate_board_id():
    """Generate the next BRD### id using a native Supabase scan.

    $orderby=createdon desc is unreliable through the OData adapter (the
    Supabase table uses created_at, not createdon, and sort silently no-ops),
    so we fetch every existing board id with the prefix and compute the true
    max. This prevents unique-constraint collisions on crc6f_boardid.
    """
    try:
        from supabase_helper import get_supabase
        sb = get_supabase()
        resp = (
            sb.table(ENTITY_SET_BOARDS)
              .select(F_BOARD_ID)
              .ilike(F_BOARD_ID, "BRD%")
              .execute()
        )
        rows = resp.data or []
        max_num = 0
        pat = re.compile(r"^BRD(\d+)$", re.IGNORECASE)
        for r in rows:
            val = str(r.get(F_BOARD_ID) or "").strip().upper()
            m = pat.match(val)
            if m:
                try:
                    n = int(m.group(1))
                    if n > max_num:
                        max_num = n
                except ValueError:
                    continue
        new_id = f"BRD{max_num + 1:03d}"
        current_app.logger.info(f"[generate_board_id] existing={len(rows)}, max={max_num}, new={new_id}")
        return new_id
    except Exception as e:
        current_app.logger.exception(f"generate_board_id failed: {e}")
        import time
        return f"BRD{int(time.time()) % 100000:05d}"

# ============================================================
# 🔒 CHECK DUPLICATE BOARD
# ============================================================
def board_exists(project_code, board_name):
    try:
        token = get_access_token()
        hdr = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
        url = (
            f"{DATAVERSE_BASE}{DATAVERSE_API}/{ENTITY_SET_BOARDS}"
            f"?$filter={F_PROJECT_ID} eq '{project_code}' and "
            f"{F_BOARD_NAME} eq '{board_name}'"
            f"&$select={F_GUID}"
        )
        res = get_dataverse_session().get(url, headers=hdr, timeout=15)

        items = res.json().get("value", [])
        return len(items) > 0
    except:
        return False

# ============================================================
# 1️⃣ GET ALL BOARDS FOR A PROJECT
# ============================================================
@bp.route("/projects/<project_code>/boards", methods=["GET"])
def get_boards(project_code):
    """Fetch all boards for a given project with dynamic task and member counts."""
    try:
        token = get_access_token()
        hdr = {"Authorization": f"Bearer {token}", "Accept": "application/json"}

        # First, fetch all boards for the project
        select_fields = f"{F_GUID},{F_BOARD_ID},{F_BOARD_NAME},{F_DESC},{F_PROJECT_ID},{F_STATUS}"
        url = (
            f"{DATAVERSE_BASE}{DATAVERSE_API}/{ENTITY_SET_BOARDS}"
            f"?$filter={F_PROJECT_ID} eq '{project_code}'"
            f"&$select={select_fields}"
        )
        res = get_dataverse_session().get(url, headers=hdr, timeout=15)
        if (not res.ok) and _is_missing_column_error(res, F_STATUS):
            current_app.logger.warning("[project_boards] %s missing in schema cache; retrying board list without status", F_STATUS)
            fallback_fields = f"{F_GUID},{F_BOARD_ID},{F_BOARD_NAME},{F_DESC},{F_PROJECT_ID}"
            fallback_url = (
                f"{DATAVERSE_BASE}{DATAVERSE_API}/{ENTITY_SET_BOARDS}"
                f"?$filter={F_PROJECT_ID} eq '{project_code}'"
                f"&$select={fallback_fields}"
            )
            res = get_dataverse_session().get(fallback_url, headers=hdr, timeout=15)
        if not res.ok:
            return jsonify({"success": False, "error": res.text}), 500

        boards = []
        board_list = res.json().get("value", [])
        
        # If no boards, return empty list
        if not board_list:
            return jsonify({"success": True, "boards": []}), 200
        
        # Fetch all tasks for the project to count per board
        tasks_url = f"{DATAVERSE_BASE}{DATAVERSE_API}/crc6f_hr_taskdetailses?$select=crc6f_boardid,crc6f_assignedto&$filter=crc6f_projectid eq '{project_code}'"
        tasks_res = get_dataverse_session().get(tasks_url, headers=hdr, timeout=15)
        
        # Initialize task and member counts for each board
        task_counts = {}
        member_counts = {}
        
        if tasks_res.ok:
            tasks = tasks_res.json().get("value", [])
            for task in tasks:
                board_id = task.get("crc6f_boardid")
                assigned_to = task.get("crc6f_assignedto")
                
                if board_id:
                    # Count tasks
                    task_counts[board_id] = task_counts.get(board_id, 0) + 1
                    
                    # Count unique members (assigned_to)
                    if assigned_to and assigned_to.strip():
                        if board_id not in member_counts:
                            member_counts[board_id] = set()
                        member_counts[board_id].add(assigned_to.strip())
        
        # Build boards list with calculated counts
        for r in board_list:
            board_id = r.get(F_BOARD_ID)
            board_guid = r.get(F_GUID)
            
            # Get task count
            no_of_tasks = 0
            if board_id:
                no_of_tasks = task_counts.get(board_id, 0)
            
            # Get member count (count of unique assigned users)
            no_of_members = 0
            if board_id and board_guid in member_counts:
                no_of_members = len(member_counts[board_guid])
            elif board_id and board_id in member_counts:
                no_of_members = len(member_counts[board_id])
            
            boards.append({
                "guid": board_guid,
                "board_id": board_id,
                "board_name": r.get(F_BOARD_NAME),
                "board_description": r.get(F_DESC),
                "status": r.get(F_STATUS) or "Active",
                "no_of_tasks": no_of_tasks,
                "no_of_members": no_of_members,
                "project_id": r.get(F_PROJECT_ID),
            })

        return jsonify({"success": True, "boards": boards}), 200

    except Exception as e:
        current_app.logger.exception("Error fetching boards")
        return jsonify({"success": False, "error": str(e)}), 500


# ADD BOARD (POST) — NOW DUPLICATE SAFE
# ============================================================
@bp.route("/projects/<project_code>/boards", methods=["POST"])
def add_board(project_code):
    try:
        body = request.get_json(force=True)
        name = body.get("board_name")

        # ---- DUPLICATE CHECK ----
        if board_exists(project_code, name):
            return jsonify({
                "success": False,
                "duplicate": True,
                "error": f"Board '{name}' already exists in this project."
            }), 409

        token = get_access_token()
        hdr = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Content-Type": "application/json"
        }

        board_id = generate_board_id()

        payload = {
            F_BOARD_ID: board_id,
            F_BOARD_NAME: name,
            F_DESC: body.get("board_description"),
            F_STATUS: body.get("status") or "Active",
            F_NO_TASKS: str(body.get("no_of_tasks", 0)),
            F_NO_MEMBERS: str(body.get("no_of_members", 0)),
            F_PROJECT_ID: project_code,
        }

        payload = {k: v for k, v in payload.items() if v not in ("", None)}

        url = f"{DATAVERSE_BASE}{DATAVERSE_API}/{ENTITY_SET_BOARDS}"
        res = get_dataverse_session().post(url, headers=hdr, json=payload, timeout=15)
        if (res.status_code not in (200, 201, 204)) and _is_missing_column_error(res, F_STATUS):
            current_app.logger.warning("[project_boards] %s missing in schema cache; retrying board create without status", F_STATUS)
            payload.pop(F_STATUS, None)
            res = get_dataverse_session().post(url, headers=hdr, json=payload, timeout=15)

        if res.status_code in (200, 201, 204):
            return jsonify({"success": True, "message": "Board added"}), 201
        else:
            return jsonify({"success": False, "error": res.text}), 400

    except Exception as e:
        current_app.logger.exception("Error adding board")
        return jsonify({"success": False, "error": str(e)}), 500

# ============================================================
# 3️⃣ UPDATE BOARD
# ============================================================
@bp.route("/boards/<guid>", methods=["PATCH"])
def update_board(guid):
    """Update board details by Dataverse GUID."""
    try:
        body = request.get_json(force=True)
        token = get_access_token()
        hdr = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Content-Type": "application/json"
        }

        data = {}
        if "board_name" in body:
            data[F_BOARD_NAME] = body["board_name"]
        if "board_description" in body:
            data[F_DESC] = body["board_description"]
        if "status" in body:
            data[F_STATUS] = body["status"]
        if "no_of_tasks" in body:
            data[F_NO_TASKS] = str(body["no_of_tasks"])
        if "no_of_members" in body:
            data[F_NO_MEMBERS] = str(body["no_of_members"])

        url = f"{DATAVERSE_BASE}{DATAVERSE_API}/{ENTITY_SET_BOARDS}({guid})"
        res = get_dataverse_session().patch(url, headers=hdr, json=data, timeout=15)
        if (res.status_code not in (200, 204)) and (F_STATUS in data) and _is_missing_column_error(res, F_STATUS):
            current_app.logger.warning("[project_boards] %s missing in schema cache; retrying board update without status", F_STATUS)
            data.pop(F_STATUS, None)
            res = get_dataverse_session().patch(url, headers=hdr, json=data, timeout=15)

        if res.status_code in (200, 204):
            return jsonify({"success": True, "message": "Board updated"}), 200
        else:
            return jsonify({"success": False, "error": res.text}), 400

    except Exception as e:
        current_app.logger.exception("Error updating board")
        return jsonify({"success": False, "error": str(e)}), 500


# ============================================================
# 4️⃣ DELETE BOARD
# ============================================================
@bp.route("/boards/<guid>", methods=["DELETE"])
def delete_board(guid):
    """Delete a board by Dataverse GUID."""
    try:
        token = get_access_token()
        hdr = {"Authorization": f"Bearer {token}", "Accept": "application/json"}

        # 1) Fetch board record to determine board_id + project_id
        board_id = None
        project_id = None
        try:
            sel = f"$select={F_BOARD_ID},{F_PROJECT_ID}"
            get_url = f"{DATAVERSE_BASE}{DATAVERSE_API}/{ENTITY_SET_BOARDS}({guid})?{sel}"
            g = get_dataverse_session().get(get_url, headers=hdr, timeout=15)
            if g.ok:
                payload = g.json() or {}
                board_id = payload.get(F_BOARD_ID)
                project_id = payload.get(F_PROJECT_ID)
        except Exception:
            pass

        # 2) Cascade delete tasks under this board (hard delete)
        #    Tasks store board reference in crc6f_boardid (usually BRDxxx).
        deleted_tasks = 0
        task_errors = 0
        if project_id and (board_id or guid):
            try:
                safe_pid = str(project_id).replace("'", "''")
                safe_bid = str(board_id).replace("'", "''") if board_id else ""
                safe_guid = str(guid).replace("'", "''")
                # Match either board_id (BRD...) or, as fallback, the board guid
                filters = [f"crc6f_projectid eq '{safe_pid}'"]
                ors = []
                if board_id:
                    ors.append(f"crc6f_boardid eq '{safe_bid}'")
                ors.append(f"crc6f_boardid eq '{safe_guid}'")
                if ors:
                    filters.append(f"({' or '.join(ors)})")
                filter_expr = " and ".join(filters)
                filter_q = urllib.parse.quote(filter_expr, safe="()'= $")
                turl = f"{DATAVERSE_BASE}{DATAVERSE_API}/crc6f_hr_taskdetailses?$select=crc6f_hr_taskdetailsid&$filter={filter_q}"
                t_res = get_dataverse_session().get(turl, headers=hdr, timeout=20)
                if t_res.ok:
                    tasks = t_res.json().get("value", [])
                    for t in tasks:
                        tid = t.get("crc6f_hr_taskdetailsid")
                        if not tid:
                            continue
                        del_url = f"{DATAVERSE_BASE}{DATAVERSE_API}/crc6f_hr_taskdetailses({tid})"
                        d = get_dataverse_session().delete(del_url, headers=hdr, timeout=15)
                        if d.status_code in (200, 204):
                            deleted_tasks += 1
                        else:
                            task_errors += 1
            except Exception:
                task_errors += 1

        # 3) Delete the board record
        url = f"{DATAVERSE_BASE}{DATAVERSE_API}/{ENTITY_SET_BOARDS}({guid})"
        res = get_dataverse_session().delete(url, headers=hdr, timeout=15)

        if res.status_code in (200, 204):
            return jsonify({
                "success": True,
                "message": "Board deleted",
                "deleted_tasks": deleted_tasks,
                "task_delete_errors": task_errors,
            }), 200
        return jsonify({"success": False, "error": res.text}), 400

    except Exception as e:
        current_app.logger.exception("Error deleting board")
        return jsonify({"success": False, "error": str(e)}), 500