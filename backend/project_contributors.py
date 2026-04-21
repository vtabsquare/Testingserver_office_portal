# contributors_bp.py
from flask import Blueprint, request, jsonify, current_app
import requests, os, uuid, re, traceback
from dotenv import load_dotenv
from dataverse_helper import get_access_token, get_dataverse_session

bp = Blueprint("project_contributors", __name__, url_prefix="/api")

load_dotenv()

# ======================
# Dataverse Config
# ======================
DATAVERSE_BASE = os.getenv("RESOURCE")
DATAVERSE_API = os.getenv("DATAVERSE_API", "/api/data/v9.2")
ENTITY_SET_contributors = "crc6f_hr_projectcontributorses"

# Field names
F_EMP_ID = "crc6f_employeeid"
F_EMP_NAME = "crc6f_employeename"
F_BILLING = "crc6f_billingtype"
F_ASSIGNED = "crc6f_assigneddate"
F_PROJECT_ID = "crc6f_projectid"
F_RECORD_ID = "crc6f_recordid"
F_GUID = "crc6f_hr_projectcontributorsid"
F_RATE = "crc6f_hourlyrate"


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

PROJECT_HEADER_ES = "crc6f_hr_projectheaders"

def extract_guid_from_response(res):
    """Extract the Dataverse GUID from OData-EntityId response header."""
    entity_uri = res.headers.get("OData-EntityId")
    if entity_uri and "(" in entity_uri and ")" in entity_uri:
        return entity_uri.split("(")[-1].split(")")[0]
    return None

def generate_record_id():
    """Generate next REC### id using a native Supabase scan.

    $orderby=createdon desc is unreliable through the OData adapter because
    Supabase tables use created_at (not createdon), so sort silently no-ops
    and the first row returned is arbitrary, producing colliding REC001 ids
    and FK/unique-constraint violations.
    """
    try:
        from supabase_helper import get_supabase
        sb = get_supabase()
        resp = (
            sb.table(ENTITY_SET_contributors)
              .select("crc6f_recordid")
              .ilike("crc6f_recordid", "REC%")
              .execute()
        )
        rows = resp.data or []
        max_num = 0
        pat = re.compile(r"^REC(\d+)$", re.IGNORECASE)
        for r in rows:
            val = str(r.get("crc6f_recordid") or "").strip().upper()
            m = pat.match(val)
            if m:
                try:
                    n = int(m.group(1))
                    if n > max_num:
                        max_num = n
                except ValueError:
                    continue
        new_id = f"REC{max_num + 1:03d}"
        current_app.logger.info(f"[generate_record_id] existing={len(rows)}, max={max_num}, new={new_id}")
        return new_id
    except Exception as e:
        current_app.logger.exception(f"generate_record_id failed: {e}")
        import time
        return f"REC{int(time.time()) % 100000:05d}"


def contributor_exists(project_code, employeeId):
    try:
        token = get_access_token()
        hdr = {"Authorization": f"Bearer {token}", "Accept": "application/json"}

        url = (
            f"{DATAVERSE_BASE}{DATAVERSE_API}/{ENTITY_SET_contributors}"
            f"?$filter={F_PROJECT_ID} eq '{project_code}' and "
            f"{F_EMP_ID} eq '{employeeId}'"
            f"&$select={F_GUID}"
        )

        res = get_dataverse_session().get(url, headers=hdr, timeout=15)
        items = res.json().get("value", [])

        return len(items) > 0
    except:
        return False


# ---------- Helpers: recount contributors and update project header ----------
def recount_project_contributors(project_code):
    """
    Count contributors for project_code and update project header crc6f_noofcontributors.
    Returns the new count (int) or None on failure.
    """
    from unified_server import get_access_token
    token = get_access_token()
    headers_local = {"Authorization": f"Bearer {token}", "Accept": "application/json"}

    try:
        count_url = (
            f"{DATAVERSE_BASE}{DATAVERSE_API}/{ENTITY_SET_contributors}"
            f"?$filter=crc6f_projectid eq '{project_code}'&$count=true&$top=1"
        )
        cr = get_dataverse_session().get(count_url, headers=headers_local, timeout=15)
        if not cr.ok:
            current_app.logger.error("recount_project_contributors: count request failed: %s", cr.text)
            return None

        cnt = 0
        j = cr.json()
        if isinstance(j, dict) and '@odata.count' in j:
            cnt = int(j.get('@odata.count', 0))
        else:
            cnt = len(j.get('value', [])) if isinstance(j.get('value', []), list) else 0

        current_app.logger.info("recount_project_contributors: project %s has %d contributors", project_code, cnt)

        proj_q = (
            f"{DATAVERSE_BASE}{DATAVERSE_API}/{PROJECT_HEADER_ES}"
            f"?$filter=crc6f_projectid eq '{project_code}'&$select=crc6f_hr_projectheaderid"
        )
        rp = get_dataverse_session().get(proj_q, headers=headers_local, timeout=15)
        if not rp.ok:
            current_app.logger.error("recount_project_contributors: failed to fetch project header: %s", rp.text)
            return cnt

        proj_items = rp.json().get("value", [])
        if not proj_items:
            current_app.logger.warning("recount_project_contributors: project header not found for %s", project_code)
            return cnt

        proj_rec_id = proj_items[0].get("crc6f_hr_projectheaderid")
        if not proj_rec_id:
            current_app.logger.error("recount_project_contributors: header id missing for %s", project_code)
            return cnt

        update_url = f"{DATAVERSE_BASE}{DATAVERSE_API}/{PROJECT_HEADER_ES}({proj_rec_id})"
        patch_body = {"crc6f_noofcontributors": str(cnt)}
        rpatch = get_dataverse_session().patch(update_url, headers={**headers_local, "Content-Type": "application/json"}, json=patch_body, timeout=15)
        if not rpatch.ok:
            current_app.logger.error("recount_project_contributors: failed to patch project header: %s", rpatch.text)
            return cnt

        current_app.logger.info("recount_project_contributors: updated project %s header to %d", project_code, cnt)
        return cnt

    except Exception as ex:
        current_app.logger.exception("recount_project_contributors error")
        return None

# ======================
# 1️⃣ GET CONTRIBUTORS
# ======================
@bp.route("/projects/<project_code>/contributors", methods=["GET"])
def get_contributors(project_code):
    try:
        url = dv_url(f"/{ENTITY_SET_contributors}")
        res = get_dataverse_session().get(url, headers=headers(), timeout=15)
        res.raise_for_status()
        data = res.json().get("value", [])

        current_app.logger.info("=== ALL CONTRIBUTORS IN DATAVERSE ===")

        contributors = [
            {
                "guid": r.get("crc6f_hr_projectcontributorsid"),
                "record_id": r.get(F_RECORD_ID),
                "employee_id": r.get(F_EMP_ID),
                "employee_name": r.get(F_EMP_NAME),
                "billing_type": r.get(F_BILLING),
                "assigned_date": r.get(F_ASSIGNED),
                "project_id": r.get(F_PROJECT_ID),
            }
            for r in data
            if r.get(F_PROJECT_ID) == project_code
        ]

        # fetch employee master designations once
        token = get_access_token()
        emp_entity = "crc6f_table12s"
        emp_url = f"{DATAVERSE_BASE}{DATAVERSE_API}/{emp_entity}?$select=crc6f_employeeid,crc6f_designation&$top=5000"
        emp_res = get_dataverse_session().get(emp_url, headers={"Authorization": f"Bearer {token}", "Accept": "application/json"}, timeout=15)

        emp_designations = {}
        if emp_res.ok:
            for emp in emp_res.json().get("value", []):
                emp_designations[emp.get("crc6f_employeeid")] = emp.get("crc6f_designation", "N/A")

        for c in contributors:
            emp_id = c.get("employee_id")
            c["designation"] = emp_designations.get(emp_id, "N/A")

        current_app.logger.info("=== END OF LIST ===")

        return jsonify({"ok": True, "contributors": contributors}), 200

    except Exception as e:
        current_app.logger.exception("Error fetching contributors")
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.route("/employees/<employee_id>/projects", methods=["GET"])
def get_employee_projects(employee_id):
    """Return list of projects (and tasks) assigned to a given employee ID."""
    try:
        token = get_access_token()
        hdr = {"Authorization": f"Bearer {token}", "Accept": "application/json"}

        safe_emp = str(employee_id).replace("'", "''")

        # 1) Fetch contributor rows for this employee to discover project IDs
        contrib_url = (
            f"{DATAVERSE_BASE}{DATAVERSE_API}/{ENTITY_SET_contributors}"
            f"?$select={F_PROJECT_ID},{F_ASSIGNED}&$filter={F_EMP_ID} eq '{safe_emp}'"
        )
        cres = get_dataverse_session().get(contrib_url, headers=hdr, timeout=15)
        if not cres.ok:
            current_app.logger.error(
                "get_employee_projects: contributor query failed: %s", cres.text
            )
            return jsonify({"success": False, "error": cres.text}), cres.status_code

        contrib_rows = cres.json().get("value", [])
        project_map = {}
        for r in contrib_rows:
            pid = r.get(F_PROJECT_ID)
            if not pid:
                continue
            assigned = r.get(F_ASSIGNED)
            entry = project_map.get(pid) or {"project_id": pid, "assigned_date": assigned}
            # Keep earliest assigned date if we see multiple rows
            if assigned and (not entry.get("assigned_date") or assigned < entry["assigned_date"]):
                entry["assigned_date"] = assigned
            project_map[pid] = entry

        if not project_map:
            return jsonify({"success": True, "employee_id": employee_id, "projects": []}), 200

        projects = []
        # 2) For each project, fetch project header and tasks assigned to this employee
        for pid, info in project_map.items():
            safe_pid = str(pid).replace("'", "''")

            # Project header
            try:
                proj_url = (
                    f"{DATAVERSE_BASE}{DATAVERSE_API}/{PROJECT_HEADER_ES}"
                    f"?$select=crc6f_projectid,crc6f_projectname,crc6f_projectstatus"
                    f"&$filter=crc6f_projectid eq '{safe_pid}'&$top=1"
                )
                pres = get_dataverse_session().get(proj_url, headers=hdr, timeout=15)
                if pres.ok:
                    vals = pres.json().get("value", [])
                    if vals:
                        rec = vals[0]
                        info["project_name"] = rec.get("crc6f_projectname")
                        info["project_status"] = rec.get("crc6f_projectstatus")
            except Exception as proj_err:
                current_app.logger.error(
                    "get_employee_projects: failed to fetch project %s header: %s", pid, proj_err
                )

            # Tasks for this project (do not over-filter by assigned_to because
            # crc6f_assignedto may contain names instead of employee IDs)
            tasks = []
            try:
                tasks_url = (
                    f"{DATAVERSE_BASE}{DATAVERSE_API}/crc6f_hr_taskdetailses"
                    f"?$select=crc6f_taskid,crc6f_taskname,crc6f_taskstatus,crc6f_duedate,crc6f_assignedto"
                    f"&$filter=crc6f_projectid eq '{safe_pid}'"
                )
                tres = get_dataverse_session().get(tasks_url, headers=hdr, timeout=15)
                if tres.ok:
                    for t in tres.json().get("value", []):
                        tasks.append(
                            {
                                "task_id": t.get("crc6f_taskid"),
                                "task_name": t.get("crc6f_taskname"),
                                "task_status": t.get("crc6f_taskstatus"),
                                "due_date": t.get("crc6f_duedate"),
                                "assigned_to": t.get("crc6f_assignedto"),
                            }
                        )
            except Exception as task_err:
                current_app.logger.error(
                    "get_employee_projects: failed to fetch tasks for %s: %s", pid, task_err
                )

            info["tasks"] = tasks
            projects.append(info)

        return jsonify({"success": True, "employee_id": employee_id, "projects": projects}), 200

    except Exception as e:
        current_app.logger.exception("Error fetching projects for employee")
        return jsonify({"success": False, "error": str(e)}), 500


# ======================
# 2️⃣ ADD CONTRIBUTOR
# ======================

@bp.route("/projects/<project_code>/contributors", methods=["POST"])
def add_contributor(project_code):
    """Add a contributor to a specific project (no max contributor restriction)."""
    try:
        from unified_server import get_access_token  # lazy import
        body = request.get_json(force=True) or {}
        current_app.logger.info("Add contributor called for project %s with payload: %s", project_code, body)

        employee_id = (body.get("employeeId") or "").strip()
        if not employee_id:
            return jsonify({"error": "employeeId is required"}), 400

        # ID-only dedupe check: same employee cannot be added twice for the same project
        # NOTE: contributor_exists signature is (project_code, employeeId) - fix arg order
        if contributor_exists(project_code, employee_id):
            return jsonify({"success": False, "error": "Contributor with this employeeId already exists for this project"}), 400

        token = get_access_token()
        headers_local = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Content-Type": "application/json"
        }

        # Generate record_id (custom REC###)
        try:
            generated_recordid = generate_record_id()
            current_app.logger.info("Auto-generated record id: %s", generated_recordid)
        except Exception:
            generated_recordid = None
            current_app.logger.exception("Error generating record id")

        dv_payload = {
            "crc6f_employeeid": employee_id,
            "crc6f_employeename": body.get("employeeName"),
            "crc6f_billingtype": body.get("billingType"),
            "crc6f_assigneddate": body.get("assignedDate"),
            "crc6f_projectid": project_code,
            "crc6f_recordid": generated_recordid,
        }
        dv_payload = {k: v for k, v in dv_payload.items() if v not in (None, "", [])}

        create_url = f"{DATAVERSE_BASE}{DATAVERSE_API}/{ENTITY_SET_contributors}"
        res = get_dataverse_session().post(create_url, headers=headers_local, json=dv_payload, timeout=15)
        current_app.logger.info("Dataverse create response: %s", res.status_code)

        if res.status_code in (200, 201, 204):
            try:
                new_count = recount_project_contributors(project_code)
                current_app.logger.info("After create, recount result for %s = %s", project_code, new_count)
            except Exception:
                current_app.logger.exception("Recount after create failed for %s", project_code)

            return jsonify({"success": True, "message": "Contributor added", "record_id": generated_recordid}), 201
        else:
            current_app.logger.error("Dataverse create failed: %s", res.text)
            return jsonify({"error": "Dataverse create failed", "details": res.text}), 400

    except Exception as e:
        current_app.logger.exception("Error in add_contributor")
        return jsonify({"error": str(e)}), 500



# =========================================
# EDIT (PATCH) CONTRIBUTOR
# =========================================
@bp.route("/contributors/<guid>", methods=["PATCH"])
def update_contributor(guid):
    try:
        body = request.get_json(force=True)
        current_app.logger.info(f"✏ Updating contributor {guid}")
        current_app.logger.info(body)

        token = get_access_token()
        headers_local = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "OData-Version": "4.0",
            "Accept": "application/json",
        }

        data = {}
        if "employeeId" in body: data["crc6f_employeeid"] = body["employeeId"]
        if "employeeName" in body: data["crc6f_employeename"] = body["employeeName"]
        if "billingType" in body: data["crc6f_billingtype"] = body["billingType"]
        if "assignedDate" in body: data["crc6f_assigneddate"] = body["assignedDate"]
        url = f"{DATAVERSE_BASE}{DATAVERSE_API}/{ENTITY_SET_contributors}({guid})"
        res = get_dataverse_session().patch(url, headers=headers_local, json=data, timeout=15)

        current_app.logger.info(f"🔸 PATCH response {res.status_code}: {res.text}")

        if res.status_code in (200, 204):
            return jsonify({"success": True, "message": "Contributor updated"}), 200
        else:
            return jsonify({"error": "Dataverse update failed", "details": res.text}), 400

    except Exception as e:
        current_app.logger.exception("❌ Error updating contributor")
        return jsonify({"error": str(e)}), 500


@bp.route("/contributors/<guid>", methods=["DELETE"])
def delete_contributor(guid):
    try:
        token = get_access_token()
        headers_local = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
        current_app.logger.info("🗑 Delete contributor called for GUID %s", guid)

        get_url = f"{DATAVERSE_BASE}{DATAVERSE_API}/{ENTITY_SET_contributors}({guid})?$select=crc6f_projectid"
        gres = get_dataverse_session().get(get_url, headers=headers_local, timeout=15)
        project_id = None
        if gres.ok:
            project_id = gres.json().get("crc6f_projectid")

        del_url = f"{DATAVERSE_BASE}{DATAVERSE_API}/{ENTITY_SET_contributors}({guid})"
        dres = get_dataverse_session().delete(del_url, headers=headers_local, timeout=15)
        current_app.logger.info("Dataverse delete response: %s", dres.status_code)

        if dres.status_code in (200, 204):
            if project_id:
                try:
                    new_count = recount_project_contributors(project_id)
                    current_app.logger.info("After delete, recount result for %s = %s", project_id, new_count)
                except Exception:
                    current_app.logger.exception("Recount after delete failed for %s", project_id)
            return jsonify({"success": True, "message": "Contributor deleted"}), 200
        else:
            current_app.logger.error("Dataverse delete failed: %s", dres.text)
            return jsonify({"error": "Dataverse delete failed", "details": dres.text}), 400

    except Exception as e:
        current_app.logger.exception("Error in delete_contributor")
        return jsonify({"error": str(e)}), 500

