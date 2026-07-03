# from flask import Blueprint, request, jsonify, current_app
# import requests, os, uuid
# from dataverse_helper import get_access_token
# from dotenv import load_dotenv

# load_dotenv()

# columns_bp = Blueprint("project_columns", __name__, url_prefix="/api")

# DATAVERSE_BASE = os.getenv("RESOURCE")
# DATAVERSE_API = os.getenv("DATAVERSE_API", "/api/data/v9.2")

# ENTITY_SET = "crc6f_hr_taskstatusboards"

# def dv_url(path):
#     return f"{DATAVERSE_BASE}{DATAVERSE_API}{path}"

# def dv_headers():
#     token = get_access_token()
#     return {
#         "Authorization": f"Bearer {token}",
#         "Content-Type": "application/json",
#         "Accept": "application/json"
#     }

# # -----------------------------------------------------
# # 1️⃣ GET ALL COLUMNS FOR PROJECT + BOARD
# # -----------------------------------------------------
# @columns_bp.route("/projects/<projectId>/columns", methods=["GET"])
# def get_columns(projectId):
#     try:
#         board = request.args.get("board")

#         token = get_access_token()
#         hdrs = dv_headers()

#         # Filter
#         filter_q = f"crc6f_projectid eq '{projectId}'"
#         if board:
#             filter_q += f" and crc6f_boardid eq '{board}'"

#         # Query dataverse
#         url = dv_url(f"/{ENTITY_SET}?$filter={filter_q}")
#         res = requests.get(url, headers=hdrs)

#         if not res.ok:
#             print("❌ GET columns failed:", res.text)
#             return jsonify({"success": False, "error": res.text}), 500

#         value = res.json().get("value", [])
#         columns = []

#         for row in value:
#             col_name = row.get("crc6f_taskstatuscolumns")
#             if col_name:
#                 columns.append({
#                     "id": row.get("crc6f_hr_taskstatusboardid"),
#                     "name": col_name
#                 })

#         return jsonify({"success": True, "columns": columns}), 200

#     except Exception as e:
#         print("❌ Error in get_columns:", e)
#         return jsonify({"success": False, "error": str(e)}), 500


# # -----------------------------------------------------
# # 2️⃣ CREATE NEW COLUMN
# # -----------------------------------------------------
# @columns_bp.route("/projects/<projectId>/columns", methods=["POST"])
# def create_column(projectId):
#     try:
#         body = request.json
#         name = body.get("name")
#         board = body.get("board")

#         if not name:
#             return jsonify({"success": False, "error": "Column name required"}), 400

#         # TSB ID auto-generate
#         tsb_id = f"TSB{uuid.uuid4().hex[:6].upper()}"

#         payload = {
#             "crc6f_projectid": projectId,
#             "crc6f_boardid": board,
#             "crc6f_taskstatuscolumns": name,
#             "crc6f_tsbid": tsb_id
#         }

#         hdrs = dv_headers()
#         url = dv_url(f"/{ENTITY_SET}")
#         res = requests.post(url, headers=hdrs, json=payload)

#         if res.status_code not in (200, 204, 201):
#             print("❌ Column create failed:", res.text)
#             return jsonify({"success": False, "error": res.text}), 500

#         return jsonify({"success": True, "message": "Column added"}), 201

#     except Exception as e:
#         print("❌ Error in create_column:", e)
#         return jsonify({"success": False, "error": str(e)}), 500

# @columns_bp.route("/projects/<project_id>/columns", methods=["PATCH"])
# def rename_column(project_id):
#     try:
#         body = request.json
#         print("🔥 PATCH BODY =>", body)

#         board = body.get("board")
#         old_name = body.get("oldName")
#         new_name = body.get("newName")

#         if not old_name or not new_name:
#             return jsonify({"success": False, "error": "Missing names"}), 400

#         token = get_access_token()
#         headers = {
#             "Authorization": f"Bearer {token}",
#             "Content-Type": "application/json"
#         }

#         # Step 1: Find the column record
#         filter_query = (
#             f"crc6f_projectid eq '{project_id}' "
#             f"and crc6f_taskstatuscolumns eq '{old_name}' "
#         )
#         if board:
#             filter_query += f"and crc6f_boardid eq '{board}' "

#         url = f"{DATAVERSE_BASE}{DATAVERSE_API}/crc6f_hr_taskstatusboards?$filter={filter_query}"
#         res = requests.get(url, headers=headers)
#         data = res.json()

#         if not data.get("value"):
#             return jsonify({"success": False, "error": "Column not found"}), 404

#         col_guid = data["value"][0]["crc6f_hr_taskstatusboardid"]

#         # Step 2: Rename the column
#         patch_url = f"{DATAVERSE_BASE}{DATAVERSE_API}/crc6f_hr_taskstatusboards({col_guid})"
#         patch_body = {
#             "crc6f_taskstatuscolumns": new_name
#         }
#         patch_res = requests.patch(patch_url, headers=headers, json=patch_body)

#         if patch_res.status_code not in (200, 204):
#             return jsonify({"success": False, "error": "Dataverse update error"}), 500

#         # ----------------------------------------------------------------
#         # Step 3: Update ALL tasks that were using old status → new status
#         # ----------------------------------------------------------------
#         task_filter = (
#             f"crc6f_projectid eq '{project_id}' "
#             f"and crc6f_taskstatus eq '{old_name}'"
#         )

#         task_url = f"{DATAVERSE_BASE}{DATAVERSE_API}/crc6f_hr_taskdetailses?$filter={task_filter}"
#         task_res = requests.get(task_url, headers=headers)
#         tasks = task_res.json().get("value", [])

#         for t in tasks:
#             task_guid = t["crc6f_hr_taskdetailsid"]

#             patch_task_url = (
#                 f"{DATAVERSE_BASE}{DATAVERSE_API}/crc6f_hr_taskdetailses({task_guid})"
#             )

#             requests.patch(
#                 patch_task_url,
#                 headers=headers,
#                 json={"crc6f_taskstatus": new_name}
#             )

#         return jsonify({"success": True, "message": "Column renamed + Tasks updated"})

#     except Exception as e:
#         return jsonify({"success": False, "error": str(e)}), 500


# @columns_bp.route("/projects/<project_id>/columns", methods=["DELETE"])
# def delete_column(project_id):
#     try:
#         body = request.json
#         print("🔥 DELETE BODY =>", body)

#         board = body.get("board")
#         name = body.get("name")

#         if not name:
#             return jsonify({"success": False, "error": "Missing column name"}), 400

#         token = get_access_token()
#         headers = {
#             "Authorization": f"Bearer {token}",
#             "Content-Type": "application/json"
#         }

#         # ------------------------------------------------------------
#         # 1️⃣ Check if ANY tasks exist with this status → DO NOT DELETE
#         # ------------------------------------------------------------
#         task_filter = (
#             f"crc6f_projectid eq '{project_id}' "
#             f"and crc6f_taskstatus eq '{name}'"
#         )

#         task_url = f"{DATAVERSE_BASE}{DATAVERSE_API}/crc6f_hr_taskdetailses?$filter={task_filter}"
#         t_res = requests.get(task_url, headers=headers)
#         tasks = t_res.json().get("value", [])

#         if len(tasks) > 0:
#             return jsonify({
#                 "success": False,
#                 "error": "Cannot delete. Tasks exist inside this column."
#             }), 400

#         # ------------------------------------------------------------
#         # 2️⃣ Find the column record
#         # ------------------------------------------------------------
#         filter_query = (
#             f"crc6f_projectid eq '{project_id}' "
#             f"and crc6f_taskstatuscolumns eq '{name}' "
#         )
#         if board:
#             filter_query += f"and crc6f_boardid eq '{board}' "

#         url = f"{DATAVERSE_BASE}{DATAVERSE_API}/crc6f_hr_taskstatusboards?$filter={filter_query}"
#         res = requests.get(url, headers=headers)
#         data = res.json()

#         if not data.get("value"):
#             return jsonify({"success": False, "error": "Column not found"}), 404

#         col_guid = data["value"][0]["crc6f_hr_taskstatusboardid"]

#         # ------------------------------------------------------------
#         # 3️⃣ SAFE DELETE (no tasks exist)
#         # ------------------------------------------------------------
#         delete_url = f"{DATAVERSE_BASE}{DATAVERSE_API}/crc6f_hr_taskstatusboards({col_guid})"
#         del_res = requests.delete(delete_url, headers=headers)

#         if del_res.status_code not in (200, 204):
#             return jsonify({"success": False, "error": "Dataverse delete error"}), 500

#         return jsonify({"success": True, "message": "Column deleted"})

#     except Exception as e:
#         return jsonify({"success": False, "error": str(e)}), 500


# Replace existing functions for columns endpoints with this block
from flask import Blueprint, request, jsonify, current_app
import requests, os, uuid, urllib.parse
from dataverse_helper import get_access_token, get_dataverse_session
from dotenv import load_dotenv

load_dotenv()

columns_bp = Blueprint("project_columns", __name__, url_prefix="/api")

DATAVERSE_BASE = os.getenv("RESOURCE")
DATAVERSE_API = os.getenv("DATAVERSE_API", "/api/data/v9.2")
ENTITY_SET = "crc6f_hr_projectcolumns"
TASK_ENTITY = "crc6f_hr_taskdetailses"

TASKSTATUS_RPT_MAP = {
    "createdon": "crc6f_RPT_createdon",
    "modifiedon": "crc6f_RPT_modifiedon",
    "statecode": "crc6f_RPT_statecode",
    "statuscode": "crc6f_RPT_statuscode",
    "importsequencenumber": "crc6f_RPT_importsequencenumber",
    "overriddencreatedon": "crc6f_RPT_overriddencreatedon",
    "timezoneruleversionnumber": "crc6f_RPT_timezoneruleversionnumber",
    "utcconversiontimezonecode": "crc6f_RPT_utcconversiontimezonecode",
}

def dv_url(path):
    return f"{DATAVERSE_BASE}{DATAVERSE_API}{path}"

def dv_headers():
    token = get_access_token()
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json"
    }

# ---------------- GET columns ----------------
@columns_bp.route("/projects/<project_id>/columns", methods=["GET"])
def get_columns(project_id):
    try:
        board = request.args.get("board")
        hdrs = dv_headers()

        filter_q = f"crc6f_boardid eq '{board}'" if board else ""
        if not filter_q:
            return jsonify({"success": True, "columns": []}), 200

        url = f"{DATAVERSE_BASE}{DATAVERSE_API}/{ENTITY_SET}?$filter={urllib.parse.quote(filter_q, safe='')}"
        res = get_dataverse_session().get(url, headers=hdrs, timeout=15)

        if not res.ok:
            return jsonify({"success": False, "error": res.text}), 500

        value = res.json().get("value", [])
        cols = []

        for r in value:
            cols.append({
                "id": r.get("crc6f_hr_projectcolumnid"),
                "name": r.get("crc6f_columnname"),
                "color": (r.get("crc6f_color") or "").strip()
            })

        return jsonify({"success": True, "columns": cols}), 200

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

# ---------------- CREATE column ----------------
@columns_bp.route("/projects/<project_id>/columns", methods=["POST"])
def create_column(project_id):
    try:
        body = request.get_json(force=True) or {}
        name = (body.get("column_name") or body.get("name") or "").strip()
        board = body.get("board_id") or body.get("board")
        color = body.get("column_color") or body.get("color") or "#e5e7eb"

        if not name:
            return jsonify({"success": False, "error": "Column name required"}), 400

        hdrs = dv_headers()

        # Prevent duplicate names for same board
        dup_filter = f"crc6f_boardid eq '{board}' and crc6f_columnname eq '{name}'" if board else f"crc6f_columnname eq '{name}'"

        dup_url = f"{DATAVERSE_BASE}{DATAVERSE_API}/{ENTITY_SET}?$filter={urllib.parse.quote(dup_filter, safe='')}"

        dup_res = get_dataverse_session().get(dup_url, headers=hdrs, timeout=15)

        if dup_res.ok and dup_res.json().get("value"):
            return jsonify({"success": False, "error": "Column already exists"}), 400

        col_id = f"COL{uuid.uuid4().hex[:6].upper()}"

        payload = {
            "crc6f_columnname": name,
            "crc6f_columnid": col_id
        }

        if board:
            payload["crc6f_boardid"] = board

        # Save color
        if color:
            payload["crc6f_color"] = color.strip()

        for base_key, rpt_key in TASKSTATUS_RPT_MAP.items():
            if base_key in body:
                payload[rpt_key] = body.get(base_key)

        # Create record
        url = f"{DATAVERSE_BASE}{DATAVERSE_API}/{ENTITY_SET}"
        res = get_dataverse_session().post(url, headers=hdrs, json=payload, timeout=15)

        if res.status_code not in (200, 201, 204):
            return jsonify({"success": False, "error": res.text}), 500

        return jsonify({
            "success": True, 
            "message": "Column added successfully",
            "column": {
                "name": name,
                "color": color
            }
        }), 201

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500
# ---------------- RENAME (PATCH) ----------------
@columns_bp.route("/projects/<project_id>/columns", methods=["PATCH"])
def rename_column(project_id):
    try:
        body = request.get_json(force=True) or {}
        current_app.logger.info("PATCH BODY => %s", body)
        board = body.get("board")
        old_name = (body.get("oldName") or body.get("old") or "").strip()
        new_name = (body.get("newName") or body.get("new") or "").strip()

        if not old_name or not new_name:
            return jsonify({"success": False, "error": "Missing names"}), 400

        hdrs = dv_headers()

        # find the column record
        filter_query = f"crc6f_boardid eq '{board}' and crc6f_columnname eq '{old_name}'" if board else f"crc6f_columnname eq '{old_name}'"

        url = f"{DATAVERSE_BASE}{DATAVERSE_API}/{ENTITY_SET}?$filter={urllib.parse.quote(filter_query, safe='')}"
        res = get_dataverse_session().get(url, headers=hdrs, timeout=15)
        if not res.ok:
            current_app.logger.error("Lookup failed: %s", res.text)
            return jsonify({"success": False, "error": "Lookup failed"}), 500

        items = res.json().get("value", [])
        if not items:
            return jsonify({"success": False, "error": "Column not found"}), 404

        rec = items[0]
        rec_guid = rec.get("crc6f_hr_projectcolumnid")

        # patch the column record with new name
        patch_url = f"{DATAVERSE_BASE}{DATAVERSE_API}/{ENTITY_SET}({rec_guid})"
        patch_body = {"crc6f_columnname": new_name}
        for base_key, rpt_key in TASKSTATUS_RPT_MAP.items():
            if base_key in body:
                patch_body[rpt_key] = body.get(base_key)
        patch_res = get_dataverse_session().patch(patch_url, headers=hdrs, json=patch_body, timeout=15)
        if patch_res.status_code not in (200, 204):
            current_app.logger.error("Rename failed: %s", patch_res.text)
            return jsonify({"success": False, "error": "Dataverse rename failed"}), 500

        # update tasks that referenced old status -> new status (same project, same board)
        task_filter = f"crc6f_projectid eq '{project_id}' and crc6f_taskstatus eq '{old_name}'"
        if board:
            task_filter += f" and crc6f_boardid eq '{board}'"

        t_url = f"{DATAVERSE_BASE}{DATAVERSE_API}/{TASK_ENTITY}?$filter={urllib.parse.quote(task_filter, safe='')}"
        t_res = get_dataverse_session().get(t_url, headers=hdrs, timeout=20)
        if t_res.ok:
            tasks = t_res.json().get("value", [])
            for t in tasks:
                tid = t.get("crc6f_hr_taskdetailsid")
                if tid:
                    task_patch_url = f"{DATAVERSE_BASE}{DATAVERSE_API}/{TASK_ENTITY}({tid})"
                    try:
                        get_dataverse_session().patch(task_patch_url, headers=hdrs, json={"crc6f_taskstatus": new_name}, timeout=15)
                    except Exception as ex:
                        current_app.logger.warning("Failed updating task %s: %s", tid, ex)

        return jsonify({"success": True, "message": "Column renamed & tasks updated"}), 200

    except Exception as e:
        current_app.logger.exception("Error in rename_column")
        return jsonify({"success": False, "error": str(e)}), 500

# ---------------- DELETE column ----------------
@columns_bp.route("/projects/<project_id>/columns", methods=["DELETE"])
def delete_column(project_id):
    try:
        body = request.get_json(force=True) or {}
        current_app.logger.info("DELETE BODY => %s", body)
        board = body.get("board")
        name = (body.get("name") or "").strip()

        if not name:
            return jsonify({"success": False, "error": "Missing column name"}), 400

        hdrs = dv_headers()

        # Check if any tasks exist with that status for this project (and board)
        task_filter = f"crc6f_projectid eq '{project_id}' and crc6f_taskstatus eq '{name}'"
        if board:
            task_filter += f" and crc6f_boardid eq '{board}'"

        t_url = f"{DATAVERSE_BASE}{DATAVERSE_API}/{TASK_ENTITY}?$select=crc6f_hr_taskdetailsid&$filter={urllib.parse.quote(task_filter, safe='')}"
        t_res = get_dataverse_session().get(t_url, headers=hdrs, timeout=15)
        if not t_res.ok:
            current_app.logger.error("Task lookup failed: %s", t_res.text)
            return jsonify({"success": False, "error": "Task lookup failed"}), 500

        if t_res.json().get("value"):
            # tasks exist — do not delete
            return jsonify({"success": False, "error": "Column has tasks, cannot delete"}), 400

        # find column record
        filter_query = f"crc6f_boardid eq '{board}' and crc6f_columnname eq '{name}'" if board else f"crc6f_columnname eq '{name}'"

        url = f"{DATAVERSE_BASE}{DATAVERSE_API}/{ENTITY_SET}?$filter={urllib.parse.quote(filter_query, safe='')}"
        res = get_dataverse_session().get(url, headers=hdrs, timeout=15)
        if not res.ok:
            current_app.logger.error("Lookup failed: %s", res.text)
            return jsonify({"success": False, "error": "Lookup failed"}), 500

        items = res.json().get("value", [])
        if not items:
            return jsonify({"success": False, "error": "Column not found"}), 404

        rec_guid = items[0].get("crc6f_hr_projectcolumnid")
        delete_url = f"{DATAVERSE_BASE}{DATAVERSE_API}/{ENTITY_SET}({rec_guid})"
        del_res = get_dataverse_session().delete(delete_url, headers=hdrs, timeout=15)

        if del_res.status_code not in (200, 204):
            current_app.logger.error("Delete failed: %s", del_res.text)
            return jsonify({"success": False, "error": "Dataverse delete error"}), 500

        return jsonify({"success": True, "message": "Column deleted successfully"}), 200

    except Exception as e:
        current_app.logger.exception("Error in delete_column")
        return jsonify({"success": False, "error": str(e)}), 500
