from flask import Blueprint, request, jsonify
from datetime import datetime, timezone, timedelta
import os, json, traceback, re
from dataverse_helper import get_access_token, update_record, create_record, get_employee_name, get_employee_email, get_l2_l3_emails, get_dataverse_session
from mail_app import send_email
import requests
import urllib.parse

bp_time = Blueprint("time_tracking", __name__, url_prefix="/api")

# Dataverse config
RESOURCE = os.getenv("RESOURCE")
DV_API = os.getenv("DATAVERSE_API", "/api/data/v9.2")
ENTITY_SET_TASKS = "crc6f_hr_taskdetailses"

# Dataverse entity set for project headers
ENTITY_SET_PROJECTS = "crc6f_hr_projectheaders"


def _dv_formatted(rec: dict, field: str):
    try:
        return rec.get(f"{field}@OData.Community.Display.V1.FormattedValue")
    except Exception:
        return None


def _normalize_status(val: str) -> str:
    s = (val or "").strip()
    if not s:
        return s
    low = s.lower()
    if low in ("canceled", "cancelled"):
        return "Cancelled"
    if low == "inactive":
        return "Inactive"
    if low == "completed":
        return "Completed"
    return s


def _fetch_projects_index(project_ids, headers):
    """Return (existing_ids_set, status_by_id, inactive_ids_set)."""
    pids = [str(x).strip() for x in (project_ids or []) if str(x).strip()]
    if not pids:
        return set(), {}, set()

    # Dataverse has URL/query length limits; chunk the filter.
    existing = set()
    status_by_id = {}
    inactive = set()

    chunk_size = 25
    for i in range(0, len(pids), chunk_size):
        chunk = pids[i : i + chunk_size]
        # Build OR filter: (crc6f_projectid eq 'P1' or crc6f_projectid eq 'P2' ...)
        ors = []
        for pid in chunk:
            safe = pid.replace("'", "''")
            ors.append(f"crc6f_projectid eq '{safe}'")
        filter_expr = " or ".join(ors)
        filter_q = urllib.parse.quote(filter_expr, safe="()'= $")
        select = "crc6f_projectid,crc6f_projectstatus,statecode,statuscode"
        url = f"{RESOURCE}{DV_API}/{ENTITY_SET_PROJECTS}?$select={select}&$filter={filter_q}"
        resp = get_dataverse_session().get(url, headers=headers, timeout=30)
        if not resp.ok:
            # If project lookup fails, do not hide tasks (safer). Caller will treat as unknown.
            continue
        vals = resp.json().get("value", [])
        for p in vals:
            pid = (p.get("crc6f_projectid") or "").strip()
            if not pid:
                continue
            existing.add(pid)
            # Prefer formatted labels if present
            proj_status = _dv_formatted(p, "crc6f_projectstatus") or p.get("crc6f_projectstatus")
            if proj_status is not None:
                status_by_id[pid] = _normalize_status(str(proj_status))
            try:
                if int(p.get("statecode") or 0) != 0:
                    inactive.add(pid)
            except Exception:
                pass
    return existing, status_by_id, inactive

TIMESHEET_RPT_MAP = {
    "createdon": "crc6f_RPT_createdon",
    "modifiedon": "crc6f_RPT_modifiedon",
    "statecode": "crc6f_RPT_statecode",
    "statuscode": "crc6f_RPT_statuscode",
    "importsequencenumber": "crc6f_RPT_importsequencenumber",
    "overriddencreatedon": "crc6f_RPT_overriddencreatedon",
    "timezoneruleversionnumber": "crc6f_RPT_timezoneruleversionnumber",
    "utcconversiontimezonecode": "crc6f_RPT_utcconversiontimezonecode",
    "crc6f_workdate": "crc6f_RPT_workdate",
}

# Simple file-based store for time entries to persist across restarts
DATA_DIR = os.path.join(os.path.dirname(__file__), "_data")
ENTRIES_FILE = os.path.join(DATA_DIR, "time_entries.json")
LOGS_FILE = os.path.join(DATA_DIR, "timesheet_logs.json")
TS_ENTRIES_FILE = os.path.join(DATA_DIR, "timesheet_entries.json")

os.makedirs(DATA_DIR, exist_ok=True)


def _read_entries():
    try:
        with open(ENTRIES_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def _write_entries(entries):
    tmp = ENTRIES_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(entries, f)
    os.replace(tmp, ENTRIES_FILE)


def stop_active_task_entries_for_user(user_id, stop_iso=None):
    """Force-stop all active task entries for a user (best-effort helper)."""
    uid = str(user_id or "").strip().upper()
    if not uid:
        return {"stopped": 0}

    entries = _read_entries()
    stopped = 0
    stop_value = stop_iso or _now_iso()

    for rec in entries:
        rec_uid = str(rec.get("user_id") or "").strip().upper()
        if rec_uid == uid and not rec.get("end"):
            rec["end"] = stop_value
            stopped += 1

    if stopped:
        _write_entries(entries)

    return {"stopped": stopped}


def _read_logs():
    try:
        with open(LOGS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def _write_logs(logs):
    tmp = LOGS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(logs, f)
    os.replace(tmp, LOGS_FILE)


def _read_ts_entries():
    """Read high-level timesheet submissions (for approval workflow)."""
    try:
        with open(TS_ENTRIES_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def _write_ts_entries(entries):
    tmp = TS_ENTRIES_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(entries, f)
    os.replace(tmp, TS_ENTRIES_FILE)


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _timesheet_week_start(value):
    raw = str(value or "").strip()[:10]
    if not raw:
        return ""
    try:
        d = datetime.fromisoformat(raw)
        return (d - timedelta(days=d.weekday())).strftime("%Y-%m-%d")
    except Exception:
        return ""


def _best_week_submission_status(entries, employee_id, week_start):
    emp = str(employee_id or "").strip().upper()
    ws = str(week_start or "").strip()
    if not emp or not ws:
        return ""
    status_priority = {"accepted": 3, "pending": 2, "rejected": 1}
    best_status = ""
    best_priority = 0
    for rec in entries:
        rec_emp = str(rec.get("employee_id") or "").strip().upper()
        if rec_emp != emp:
            continue
        rec_week = _timesheet_week_start(rec.get("date"))
        if rec_week != ws:
            continue
        status = str(rec.get("status") or "").strip().lower()
        priority = status_priority.get(status, 0)
        if priority > best_priority:
            best_priority = priority
            best_status = status
    return best_status


def _remove_weekly_entries(entries, employee_id, week_start, statuses=None):
    emp = str(employee_id or "").strip().upper()
    ws = str(week_start or "").strip()
    status_filter = {str(s or "").strip().lower() for s in (statuses or []) if str(s or "").strip()}
    kept = []
    for rec in entries:
        rec_emp = str(rec.get("employee_id") or "").strip().upper()
        rec_week = _timesheet_week_start(rec.get("date"))
        rec_status = str(rec.get("status") or "").strip().lower()
        matches_week = rec_emp == emp and rec_week == ws
        matches_status = not status_filter or rec_status in status_filter
        if matches_week and matches_status:
            continue
        kept.append(rec)
    return kept


def _sum_seconds_for_task(entries, task_guid, user_id=None):
    total = 0
    now = datetime.now(timezone.utc)
    for e in entries:
        if e.get("task_guid") != task_guid:
            continue
        if user_id and e.get("user_id") != user_id:
            continue
        start = datetime.fromisoformat(e["start"]) if e.get("start") else None
        if not start:
            continue
        if e.get("end"):
            end = datetime.fromisoformat(e["end"])
        else:
            end = now
        total += int((end - start).total_seconds())
    return total


def _format_hms(seconds: int) -> str:
    h = seconds // 3600
    m = (seconds % 3600) // 60
    s = seconds % 60
    return f"{h}h {m:02d}m {s:02d}s"


def _safe_date_part(value):
    """Return YYYY-MM-DD part from date/datetime-like strings."""
    return str(value or "").strip()[:10]


def _task_identity_candidates(task_guid=None, task_id=None):
    out = []
    g = str(task_guid or "").strip().upper()
    t = str(task_id or "").strip().upper()
    if g:
        out.append(g)
    if t:
        out.append(t)
    return out


def _same_task_identity(left_guid=None, left_id=None, right_guid=None, right_id=None):
    left = set(_task_identity_candidates(left_guid, left_id))
    right = set(_task_identity_candidates(right_guid, right_id))
    if not left or not right:
        return False
    return bool(left.intersection(right))


def _coalesce_logs(records):
    """
    Merge logs that represent the same logical task/day row.

    Key: employee + work_date + project + canonical task identity.
    Canonical identity prefers task_id; falls back to task_guid.
    """
    if not isinstance(records, list) or not records:
        return []

    # Learn task_id from rows that already contain both guid and task_id.
    guid_to_task_id = {}
    for rec in records:
        g = str(rec.get("task_guid") or "").strip().upper()
        t = str(rec.get("task_id") or "").strip()
        if g and t:
            guid_to_task_id[g] = t

    merged = {}
    order = []

    for rec in records:
        employee = str(rec.get("employee_id") or "").strip().upper()
        work_date = _safe_date_part(rec.get("work_date"))
        project_id = str(rec.get("project_id") or "").strip()
        task_guid = str(rec.get("task_guid") or "").strip()
        task_id = str(rec.get("task_id") or "").strip()

        mapped_task_id = guid_to_task_id.get(task_guid.upper(), "") if task_guid else ""
        canonical_task_id = task_id or mapped_task_id
        identity = f"ID:{canonical_task_id.upper()}" if canonical_task_id else f"GUID:{task_guid.upper()}"

        key = (employee, work_date, project_id, identity)
        if key not in merged:
            row = dict(rec)
            if mapped_task_id and not row.get("task_id"):
                row["task_id"] = mapped_task_id
            merged[key] = row
            order.append(key)
            continue

        dst = merged[key]
        try:
            dst_secs = int(dst.get("seconds") or 0)
        except Exception:
            dst_secs = 0
        try:
            src_secs = int(rec.get("seconds") or 0)
        except Exception:
            src_secs = 0
        dst["seconds"] = dst_secs + src_secs

        if not dst.get("task_guid") and task_guid:
            dst["task_guid"] = task_guid
        if not dst.get("task_id") and canonical_task_id:
            dst["task_id"] = canonical_task_id
        if not dst.get("task_name") and rec.get("task_name"):
            dst["task_name"] = rec.get("task_name")
        if not dst.get("description") and rec.get("description"):
            dst["description"] = rec.get("description")

        dst["manual"] = bool(dst.get("manual")) or bool(rec.get("manual"))

    return [merged[k] for k in order]


def _hoursworked_to_seconds(raw_value, formatted_value=None):
    """
    Convert Dataverse crc6f_hoursworked variants to seconds.

    Supports:
    - Decimal hours (e.g. 0.5, "1.25")
    - Duration-like strings (e.g. "00:30", "01:15:00")
    - Minute-formatted values (e.g. formatted "30 minutes" or integer 30)
    """

    def _parse_float(v):
        if v is None:
            return None
        if isinstance(v, (int, float)):
            return float(v)
        s = str(v).strip()
        if not s:
            return None
        try:
            return float(s)
        except Exception:
            return None

    def _parse_hhmm_like(v):
        s = str(v or "").strip()
        m = re.match(r"^(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?$", s)
        if not m:
            return None
        h = int(m.group(1) or 0)
        mm = int(m.group(2) or 0)
        ss = int(m.group(3) or 0)
        if mm >= 60 or ss >= 60:
            return None
        return (h * 3600) + (mm * 60) + ss

    def _parse_minutes_from_text(v):
        s = str(v or "").strip().lower()
        if "minute" not in s:
            return None
        m = re.search(r"-?\d+(?:\.\d+)?", s)
        if not m:
            return None
        try:
            mins = float(m.group(0))
            return max(0, int(round(mins * 60)))
        except Exception:
            return None

    # 1) Prefer explicit minute-format hints from Dataverse formatted value
    mins_from_fmt = _parse_minutes_from_text(formatted_value)
    if mins_from_fmt is not None:
        return mins_from_fmt

    # 2) Handle HH:MM / HH:MM:SS strings directly
    hhmm_raw = _parse_hhmm_like(raw_value)
    if hhmm_raw is not None:
        return hhmm_raw
    hhmm_fmt = _parse_hhmm_like(formatted_value)
    if hhmm_fmt is not None:
        return hhmm_fmt

    # 3) Numeric conversion with safe heuristics
    num = _parse_float(raw_value)
    if num is None:
        num = _parse_float(formatted_value)
    if num is None:
        return 0

    # Heuristic: large whole numbers are usually minute-based legacy values.
    # Example: 30 (minutes) should render as 00:30, not 30:00.
    if float(num).is_integer() and num > 24:
        return max(0, int(num * 60))

    # Default: decimal hours
    return max(0, int(round(num * 3600)))


def _split_session_by_day(start_ms: int, end_ms: int, tz_offset_minutes: int = 0):
    """
    Split a session (ms timestamps) into per-day segments in the client's local timezone.
    Returns list of (work_date_str, seconds) tuples.
    """
    if start_ms is None or end_ms is None:
        return []
    if end_ms < start_ms:
        start_ms, end_ms = end_ms, start_ms

    # Convert ms to datetime in UTC, then adjust to client local by offset minutes
    def to_local(ms):
        dt_utc = datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
        return dt_utc - timedelta(minutes=tz_offset_minutes)

    start_local = to_local(start_ms)
    end_local = to_local(end_ms)

    segments = []
    cursor = start_local
    while cursor < end_local:
        end_of_day = (cursor.replace(hour=23, minute=59, second=59, microsecond=999999))
        segment_end = min(end_local, end_of_day)
        seconds = int((segment_end - cursor).total_seconds())
        if seconds > 0:
            work_date = cursor.date().isoformat()
            segments.append((work_date, seconds))
        cursor = segment_end + timedelta(microseconds=1)
    return segments


# ---------- Tasks proxy for My Tasks (Dataverse) ----------
@bp_time.route("/tasks", methods=["GET"])
def proxy_tasks():
    """
    GET /api/tasks
    Optional filters:
      - assigned_to: substring match against crc6f_assignedto
      - project_id: exact match against crc6f_projectid
    """
    try:
        assigned_to = (request.args.get("assigned_to") or "").strip().lower()
        project_id = (request.args.get("project_id") or "").strip()

        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-Version": "4.0",
            "Content-Type": "application/json",
            "Prefer": 'odata.include-annotations="*"',
        }
        url = f"{RESOURCE}{DV_API}/{ENTITY_SET_TASKS}?$select=crc6f_hr_taskdetailsid,crc6f_taskid,crc6f_taskname,crc6f_taskdescription,crc6f_taskpriority,crc6f_taskstatus,crc6f_assignedto,crc6f_assigneddate,crc6f_duedate,crc6f_projectid,crc6f_boardid,statecode,statuscode"
        resp = get_dataverse_session().get(url, headers=headers, timeout=30)
        if not resp.ok:
            return jsonify({"success": False, "error": resp.text}), resp.status_code
        values = resp.json().get("value", [])

        items = []
        for t in values:
            guid = t.get("crc6f_hr_taskdetailsid")
            if not guid:
                continue
            rec = {
                "guid": guid,
                "task_id": t.get("crc6f_taskid"),
                "task_name": t.get("crc6f_taskname"),
                "task_description": t.get("crc6f_taskdescription"),
                "task_priority": t.get("crc6f_taskpriority"),
                "task_status": _normalize_status(str(_dv_formatted(t, "crc6f_taskstatus") or t.get("crc6f_taskstatus") or "")),
                "assigned_to": t.get("crc6f_assignedto"),
                "assigned_date": t.get("crc6f_assigneddate"),
                "due_date": t.get("crc6f_duedate"),
                "project_id": t.get("crc6f_projectid"),
                "board_id": t.get("crc6f_boardid"),
                "_task_statecode": t.get("statecode"),
                "_task_statuscode": t.get("statuscode"),
            }
            if assigned_to:
                ass = (rec.get("assigned_to") or "").lower()
                if assigned_to not in ass:
                    continue
            if project_id and str(rec.get("project_id") or "").strip() != project_id:
                continue
            items.append(rec)
        return jsonify({"success": True, "tasks": items}), 200
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@bp_time.route("/time-tracker/logs/row", methods=["DELETE"])
def delete_logs_row():
    """
    Delete all logs for one timesheet row in a date range.
    Body: {
      employee_id, project_id?, task_guid?, task_id?, start_date, end_date
    }
    """
    b = request.get_json(force=True) or {}
    employee_id = (b.get("employee_id") or "").strip()
    project_id = (b.get("project_id") or "").strip()
    task_guid = (b.get("task_guid") or "").strip()
    task_id = (b.get("task_id") or "").strip()
    start_date = _safe_date_part(b.get("start_date"))
    end_date = _safe_date_part(b.get("end_date"))

    if not employee_id:
        return jsonify({"success": False, "error": "employee_id required"}), 400
    if not (task_guid or task_id):
        return jsonify({"success": False, "error": "task_guid or task_id required"}), 400
    if not start_date or not end_date:
        return jsonify({"success": False, "error": "start_date and end_date required"}), 400

    dataverse_deleted = 0
    dataverse_errors = []

    # Dataverse deletion (best effort)
    try:
        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-Version": "4.0",
        }

        safe_emp = employee_id.replace("'", "''")
        parts = [
            f"crc6f_employeeid eq '{safe_emp}'",
            f"crc6f_workdate ge '{start_date}'",
            f"crc6f_workdate le '{end_date}'",
        ]
        if project_id:
            safe_project = project_id.replace("'", "''")
            parts.append(f"crc6f_projectid eq '{safe_project}'")
        if task_guid and task_id:
            safe_task_guid = task_guid.replace("'", "''")
            safe_task_id = task_id.replace("'", "''")
            parts.append(f"(crc6f_taskguid eq '{safe_task_guid}' or crc6f_taskid eq '{safe_task_id}')")
        elif task_guid:
            safe_task_guid = task_guid.replace("'", "''")
            parts.append(f"crc6f_taskguid eq '{safe_task_guid}'")
        else:
            safe_task_id = task_id.replace("'", "''")
            parts.append(f"crc6f_taskid eq '{safe_task_id}'")

        filter_q = " and ".join(parts)
        list_url = (
            f"{RESOURCE}{DV_API}/crc6f_hr_timesheetlogs"
            f"?$filter={filter_q}&$select=crc6f_hr_timesheetlogid&$top=5000"
        )
        list_resp = get_dataverse_session().get(list_url, headers=headers, timeout=30)
        if list_resp.status_code == 200:
            rows = list_resp.json().get("value", [])
            for row in rows:
                rid = row.get("crc6f_hr_timesheetlogid")
                if not rid:
                    continue
                del_url = f"{RESOURCE}{DV_API}/crc6f_hr_timesheetlogs({rid})"
                del_resp = get_dataverse_session().delete(del_url, headers=headers, timeout=30)
                if del_resp.status_code in (200, 204):
                    dataverse_deleted += 1
                else:
                    dataverse_errors.append(f"{rid}:{del_resp.status_code}")
        else:
            dataverse_errors.append(f"lookup_failed:{list_resp.status_code}")
    except Exception as dv_err:
        dataverse_errors.append(str(dv_err))

    # Local deletion fallback/cleanup
    logs = _read_logs()
    before = len(logs)

    def _in_range(work_date):
        d = _safe_date_part(work_date)
        return bool(d) and start_date <= d <= end_date

    filtered = []
    for r in logs:
        same_emp = str(r.get("employee_id") or "") == employee_id
        same_project = (not project_id) or str(r.get("project_id") or "") == project_id
        same_task = _same_task_identity(
            r.get("task_guid"),
            r.get("task_id"),
            task_guid,
            task_id,
        )
        same_window = _in_range(r.get("work_date"))
        if same_emp and same_project and same_task and same_window:
            continue
        filtered.append(r)

    _write_logs(filtered)
    local_deleted = before - len(filtered)

    return jsonify({
        "success": True,
        "deleted": max(dataverse_deleted, local_deleted),
        "dataverse_deleted": dataverse_deleted,
        "local_deleted": local_deleted,
        "warnings": dataverse_errors,
    }), 200


@bp_time.route("/time-tracker/logs/exact", methods=["PUT"])
def set_exact_log():
    ENTITY = "crc6f_hr_timesheetlogs"
    try:
        b = request.get_json(force=True) or {}
        employee_id = (b.get("employee_id") or "").strip()
        project_id = (b.get("project_id") or "").strip()
        task_guid = (b.get("task_guid") or "").strip()
        task_id = (b.get("task_id") or "").strip()
        work_date = (b.get("work_date") or "").strip()
        description = (b.get("description") or "").strip()
        role = (b.get("role") or "l1").lower()
        editor_id = (b.get("editor_id") or "").strip()
        dv_id = (b.get("dv_id") or "").strip() or None
        if dv_id:
            dv_id = dv_id.strip("{}")

        task_guid_norm = str(task_guid or "").strip()
        task_id_norm = str(task_id or "").strip()
        project_id_norm = str(project_id or "").strip()
        task_keys = {k.lower() for k in [task_guid_norm, task_id_norm] if k}

        def _row_matches_exact_target(row):
            row_project = str(row.get("crc6f_projectid") or "").strip()
            if project_id_norm and row_project and row_project.lower() != project_id_norm.lower():
                return False
            if not task_keys:
                return True
            row_task_keys = {
                str(row.get("crc6f_taskguid") or "").strip().lower(),
                str(row.get("crc6f_taskid") or "").strip().lower(),
            }
            row_task_keys.discard("")
            return bool(row_task_keys.intersection(task_keys))

        try:
            seconds = int(float(b.get("seconds", 0)))
        except (ValueError, TypeError):
            seconds = 0

        print(f"[TEAM_TS_EDIT] emp={employee_id} date={work_date} secs={seconds} dv_id={dv_id} task_id={task_id} project={project_id} role={role}")

        if not employee_id or not work_date or seconds < 0:
            return jsonify({"success": False, "error": "employee_id, work_date required; seconds>=0"}), 400
        if role == "l1":
            return jsonify({"success": False, "error": "forbidden"}), 403

        hours_worked = round(seconds / 3600, 2)
        hours_worked_val = hours_worked
        manual_marker = "[MANUAL]"
        desc_for_save = description
        if manual_marker not in desc_for_save:
            desc_for_save = f"{desc_for_save} {manual_marker}".strip()

        # If no dv_id from frontend, search Dataverse for existing record
        if not dv_id:
            try:
                token = get_access_token()
                headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
                safe_emp = employee_id.replace("'", "''")
                safe_date = work_date.replace("'", "''")
                fq = f"crc6f_employeeid eq '{safe_emp}' and crc6f_workdate ge '{safe_date}' and crc6f_workdate le '{safe_date}'"
                url = f"{RESOURCE}/api/data/v9.2/{ENTITY}?$filter={fq}&$top=50"
                print(f"[TEAM_TS_EDIT] Searching: {url}")
                resp = get_dataverse_session().get(url, headers=headers, timeout=30)
                print(f"[TEAM_TS_EDIT] Search status: {resp.status_code}")
                rows = []
                if resp.status_code == 200:
                    rows = resp.json().get("value", [])
                    print(f"[TEAM_TS_EDIT] Found {len(rows)} records")
                else:
                    print(f"[TEAM_TS_EDIT] Search failed: {resp.status_code} {resp.text[:200]}")
                # DateTime fallback in case workdate stores timestamp
                if not rows:
                    try:
                        d0 = datetime.strptime(work_date, "%Y-%m-%d")
                        d1 = d0 + timedelta(days=1)
                        start_iso = d0.strftime("%Y-%m-%dT00:00:00Z")
                        end_iso = d1.strftime("%Y-%m-%dT00:00:00Z")
                        fq2 = (
                            f"crc6f_employeeid eq '{safe_emp}' and "
                            f"crc6f_workdate ge '{start_iso}' and crc6f_workdate lt '{end_iso}'"
                        )
                        url2 = f"{RESOURCE}/api/data/v9.2/{ENTITY}?$filter={fq2}&$top=50"
                        print(f"[TEAM_TS_EDIT] DateTime fallback search: {url2}")
                        resp2 = get_dataverse_session().get(url2, headers=headers, timeout=30)
                        if resp2.status_code == 200:
                            rows = resp2.json().get("value", [])
                            print(f"[TEAM_TS_EDIT] DateTime fallback found {len(rows)} records")
                    except Exception as dt_err:
                        print(f"[TEAM_TS_EDIT] DateTime fallback error: {dt_err}")

                task_key = (task_guid or task_id or "").strip()
                if task_key and rows:
                    matched_rows = [r for r in rows if _row_matches_exact_target(r)]
                    if matched_rows:
                        dv_id = (matched_rows[0].get("crc6f_hr_timesheetlogid") or "").strip() or None
                # Important: when task identity is provided but no match is found,
                # do NOT fall back to an arbitrary row from the same date. That
                # would overwrite another task's log instead of creating a new one.
                if not dv_id and rows and not task_key:
                    dv_id = (rows[0].get("crc6f_hr_timesheetlogid") or "").strip() or None
                if dv_id:
                    dv_id = dv_id.strip("{}")
                print(f"[TEAM_TS_EDIT] Resolved dv_id: {dv_id}")
            except Exception as se:
                print(f"[TEAM_TS_EDIT] Search error: {se}")

        if dv_id:
            # Use proven update_record helper from dataverse_helper.py
            update_data = {"crc6f_hoursworked": hours_worked_val, "crc6f_workdescription": desc_for_save}
            if b.get("task_name"):
                update_data["crc6f_taskname"] = str(b.get("task_name")).strip()
            print(f"[TEAM_TS_EDIT] Updating {dv_id} with {update_data}")
            try:
                update_record(ENTITY, dv_id, update_data)
                print(f"[TEAM_TS_EDIT] Updated OK")
            except Exception as update_err:
                # Fallback to create if update fails (stale/invalid id, transient Dataverse error)
                print(f"[TEAM_TS_EDIT] Update failed for {dv_id}, falling back to create: {update_err}")
                dv_id = None

        if not dv_id:
            # Use proven create_record helper from dataverse_helper.py
            create_data = {
                "crc6f_employeeid": employee_id,
                "crc6f_workdate": work_date,
                "crc6f_hoursworked": hours_worked_val,
                "crc6f_workdescription": desc_for_save,
                "crc6f_approvalstatus": "Pending",
            }
            if project_id:
                create_data["crc6f_projectid"] = project_id
            if task_id:
                create_data["crc6f_taskid"] = task_id
            if task_guid:
                create_data["crc6f_taskguid"] = task_guid
            if b.get("task_name"):
                create_data["crc6f_taskname"] = str(b.get("task_name")).strip()
            print(f"[TEAM_TS_EDIT] Creating new record: {create_data}")
            created = None
            create_candidate = dict(create_data)
            last_create_err = None
            for attempt in range(1, 6):
                try:
                    created = create_record(ENTITY, create_candidate)
                    last_create_err = None
                    break
                except Exception as create_err:
                    last_create_err = create_err
                    err_msg = str(create_err or "")
                    print(f"[TEAM_TS_EDIT] Create attempt {attempt} failed: {err_msg}")

                    # Adaptive fallback: drop invalid fields reported by Dataverse.
                    bad_field = None
                    m = re.search(r"Invalid property '([^']+)'", err_msg, re.IGNORECASE)
                    if m:
                        bad_field = m.group(1)
                    if not bad_field:
                        m2 = re.search(r"property named '([^']+)'", err_msg, re.IGNORECASE)
                        if m2:
                            bad_field = m2.group(1)
                    if bad_field and bad_field in create_candidate:
                        print(f"[TEAM_TS_EDIT] Retrying create without field: {bad_field}")
                        create_candidate.pop(bad_field, None)
                        continue

                    # Common compatibility fallbacks seen across environments.
                    if "crc6f_approvalstatus" in create_candidate:
                        print("[TEAM_TS_EDIT] Retrying create without crc6f_approvalstatus")
                        create_candidate.pop("crc6f_approvalstatus", None)
                        continue
                    if "crc6f_taskguid" in create_candidate:
                        print("[TEAM_TS_EDIT] Retrying create without crc6f_taskguid")
                        create_candidate.pop("crc6f_taskguid", None)
                        continue

                    break

            if created is None:
                raise last_create_err or Exception("Error creating record: unknown create failure")
            dv_id = created.get("crc6f_hr_timesheetlogid")
            print(f"[TEAM_TS_EDIT] Created OK: {dv_id}")

        # Keep exact semantics: remove extra same-day rows for this task/project.
        # This avoids additive leftovers (e.g., existing 00:01 + edited 01:09 showing as 01:10).
        if dv_id:
            try:
                token = get_access_token()
                headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
                safe_emp = employee_id.replace("'", "''")
                safe_date = work_date.replace("'", "''")
                fq = f"crc6f_employeeid eq '{safe_emp}' and crc6f_workdate ge '{safe_date}' and crc6f_workdate le '{safe_date}'"
                url = f"{RESOURCE}/api/data/v9.2/{ENTITY}?$filter={fq}&$top=100"
                resp = get_dataverse_session().get(url, headers=headers, timeout=30)
                rows = resp.json().get("value", []) if resp.status_code == 200 else []

                keep_id = str(dv_id).strip("{}")
                deleted = 0
                for row in rows:
                    row_id = str(row.get("crc6f_hr_timesheetlogid") or "").strip().strip("{}")
                    if not row_id or row_id == keep_id:
                        continue
                    if not _row_matches_exact_target(row):
                        continue
                    del_url = f"{RESOURCE}/api/data/v9.2/{ENTITY}({row_id})"
                    del_resp = get_dataverse_session().delete(del_url, headers=headers, timeout=30)
                    if del_resp.status_code in (200, 204):
                        deleted += 1
                if deleted:
                    print(f"[TEAM_TS_EDIT] Removed {deleted} duplicate row(s) for exact update")
            except Exception as cleanup_err:
                print(f"[TEAM_TS_EDIT] Duplicate cleanup warning: {cleanup_err}")

        # Remove stale local-cache rows for this exact day/task so list_logs merge
        # does not add old seconds back on top of the exact Dataverse value.
        if task_keys:
            try:
                logs = _read_logs()
                before = len(logs)
                up_emp = str(employee_id or "").strip().upper()
                target_date = _safe_date_part(work_date)
                target_project = str(project_id or "").strip()
                filtered = []
                for r in logs:
                    r_emp = str(r.get("employee_id") or "").strip().upper()
                    r_date = _safe_date_part(r.get("work_date"))
                    r_project = str(r.get("project_id") or "").strip()
                    same_emp = (r_emp == up_emp)
                    same_date = (r_date == target_date)
                    same_project = (not target_project) or (r_project == target_project)
                    same_task = _same_task_identity(task_guid, task_id, r.get("task_guid"), r.get("task_id"))
                    if same_emp and same_date and same_project and same_task:
                        continue
                    filtered.append(r)
                if len(filtered) != before:
                    _write_logs(filtered)
                    print(f"[TEAM_TS_EDIT] Cleared {before - len(filtered)} stale local cache row(s) for exact update")
            except Exception as local_cleanup_err:
                print(f"[TEAM_TS_EDIT] Local cache cleanup warning: {local_cleanup_err}")

        return jsonify({
            "success": True,
            "log": {
                "employee_id": employee_id,
                "project_id": project_id,
                "task_id": task_id,
                "task_guid": task_guid,
                "work_date": work_date,
                "seconds": seconds,
                "description": description,
                "dv_id": dv_id,
                "manual": True,
            }
        }), 200
    except Exception as e:
        tb = traceback.format_exc()
        print(f"[ERROR] set_exact_log: {e}\n{tb}")
        msg = str(e)
        if "Error updating record:" in msg or "Error creating record:" in msg:
            return jsonify({"success": False, "error": msg}), 400
        return jsonify({"success": False, "error": str(e)}), 500


# ---------- My Tasks listing (RBAC filtering) ----------
@bp_time.route("/my-tasks", methods=["GET"])
def list_my_tasks():
    """
    Query params:
      - user_id: EMP0001
      - user_name: display name (optional, used for matching assigned_to if needed)
      - role: l1|l2|l3
    Returns tasks from Dataverse with computed timeSpent for the given user.
    L1: only tasks assigned to the user (by name or id substring match)
    L2/L3: all tasks
    """
    try:
        user_id = (request.args.get("user_id") or "").strip()
        user_name = (request.args.get("user_name") or "").strip()
        user_email = (request.args.get("user_email") or "").strip()
        role = (request.args.get("role") or "l1").lower()

        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-Version": "4.0",
            "Content-Type": "application/json",
        }

        # Fetch all tasks (could be optimized with paging if needed)
        url = f"{RESOURCE}{DV_API}/{ENTITY_SET_TASKS}?$select=crc6f_hr_taskdetailsid,crc6f_taskid,crc6f_taskname,crc6f_taskdescription,crc6f_taskpriority,crc6f_taskstatus,crc6f_assignedto,crc6f_assigneddate,crc6f_duedate,crc6f_duetime,crc6f_projectid,crc6f_boardid"
        resp = get_dataverse_session().get(url, headers=headers, timeout=30)
        if not resp.ok:
            return jsonify({"success": False, "error": resp.text}), resp.status_code
        values = resp.json().get("value", [])

        # Filter tasks so that all roles only see tasks assigned to them
        out = []
        uid_lc = (user_id or "").lower()
        uname_lc = (user_name or "").lower()
        uemail_lc = (user_email or "").lower()

        for t in values:
            rec = {
                "guid": t.get("crc6f_hr_taskdetailsid"),
                "task_id": t.get("crc6f_taskid"),
                "task_name": t.get("crc6f_taskname"),
                "task_description": t.get("crc6f_taskdescription"),
                "task_priority": t.get("crc6f_taskpriority"),
                "task_status": t.get("crc6f_taskstatus"),
                "assigned_to": t.get("crc6f_assignedto"),
                "assigned_date": t.get("crc6f_assigneddate"),
                "due_date": t.get("crc6f_duedate"),
                "due_time": t.get("crc6f_duetime"),
                "project_id": t.get("crc6f_projectid"),
                "board_id": t.get("crc6f_boardid"),
            }

            # Require at least one identifier; otherwise we can't safely match
            if not (uid_lc or uname_lc or uemail_lc):
                continue

            ass = (rec.get("assigned_to") or "").lower()
            if not ass:
                continue

            if (
                (uid_lc and uid_lc in ass)
                or (uname_lc and uname_lc in ass)
                or (uemail_lc and uemail_lc in ass)
            ):
                out.append(rec)

        # Resolve project availability/status. If a project record is missing (deleted),
        # remove its tasks from My Tasks.
        project_ids = list({str(r.get("project_id") or "").strip() for r in out if str(r.get("project_id") or "").strip()})
        existing_projects, project_status_by_id, inactive_projects = _fetch_projects_index(project_ids, headers)

        filtered = []
        for rec in out:
            # Filter out completed tasks FIRST before any status overrides
            task_status = str(rec.get("task_status") or "").strip().lower()
            if task_status == "completed":
                continue

            pid = str(rec.get("project_id") or "").strip()
            if pid:
                # If we were able to fetch projects and this pid isn't present, treat as deleted.
                if existing_projects and pid not in existing_projects:
                    continue

                proj_status = project_status_by_id.get(pid)
                if proj_status:
                    low_proj_status = proj_status.lower()
                    # Cancelled/completed projects must not appear in My Tasks.
                    if low_proj_status in ("cancelled", "canceled", "completed"):
                        continue

                    # If project is inactive, keep task visible but surface project status.
                    # Only override if task is not already completed (already filtered above).
                    if pid in inactive_projects or low_proj_status == "inactive":
                        rec["task_status"] = proj_status

            # If task record is inactive, reflect it in task_status (but do not remove).
            try:
                if int(rec.get("_task_statecode") or 0) != 0:
                    rec["task_status"] = _normalize_status(rec.get("task_status") or "Inactive") or "Inactive"
            except Exception:
                pass

            # Remove internal fields
            rec.pop("_task_statecode", None)
            rec.pop("_task_statuscode", None)
            filtered.append(rec)

        out = filtered

        # Attach time totals for the requesting user
        entries = _read_entries()
        for rec in out:
            secs = _sum_seconds_for_task(entries, rec.get("guid"), user_id=user_id)
            rec["time_spent_seconds"] = secs
            rec["time_spent_text"] = _format_hms(secs)
        return jsonify({"success": True, "tasks": out}), 200
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ---------- Timer controls ----------
@bp_time.route("/time-entries/status", methods=["GET"])
def timer_status():
    user_id = (request.args.get("user_id") or "").strip()
    if not user_id:
        return jsonify({"success": False, "error": "user_id required"}), 400
    entries = _read_entries()
    now = datetime.now(timezone.utc)
    for e in entries:
        if e.get("user_id") == user_id and not e.get("end"):
            start = datetime.fromisoformat(e["start"]) if e.get("start") else now
            elapsed = int((now - start).total_seconds())
            return jsonify({
                "success": True,
                "active": True,
                "task_guid": e.get("task_guid"),
                "start": e.get("start"),
                "elapsed_seconds": elapsed,
            })
    return jsonify({"success": True, "active": False})


@bp_time.route("/admin/active-tasks", methods=["GET"])
def admin_active_tasks_snapshot():
    """Return organization-wide currently running tasks (one active task per employee)."""
    try:
        requester_employee_id = str(request.args.get("requester_employee_id") or "").strip().upper()
        requester_email = str(request.args.get("requester_email") or "").strip().lower()

        def _normalize_access_level(value):
            level = str(value or "").strip().upper()
            if level in ("L1", "L2", "L3", "L4"):
                return level
            return ""

        def _resolve_admin_access(headers):
            admin_emp_ids = {"EMP001"}
            admin_emails = {"bala.t@vtab.com"}
            if requester_employee_id in admin_emp_ids or requester_email in admin_emails:
                return True

            if not requester_employee_id and not requester_email:
                return False

            login_table_candidates = [
                "crc6f_hr_login_detailses",
                "crc6f_hr_login_details",
                "crc6f_hr_logindetails",
                "crc6f_hr_login_details_tb",
            ]

            def _fetch_level(filter_expr):
                if not filter_expr:
                    return ""
                safe_filter = urllib.parse.quote(filter_expr, safe="()'= $")
                for table in login_table_candidates:
                    url = (
                        f"{RESOURCE}{DV_API}/{table}"
                        f"?$top=1&$select=crc6f_accesslevel"
                        f"&$filter={safe_filter}"
                    )
                    resp = get_dataverse_session().get(url, headers=headers, timeout=20)
                    if resp.status_code == 404:
                        continue
                    if resp.status_code != 200:
                        return ""
                    values = resp.json().get("value", [])
                    if values:
                        return _normalize_access_level(values[0].get("crc6f_accesslevel"))
                return ""

            if requester_email:
                safe_email = requester_email.replace("'", "''")
                level = _fetch_level(f"crc6f_username eq '{safe_email}'")
                if level in ("L3", "L4"):
                    return True

            if requester_employee_id:
                safe_emp = requester_employee_id.replace("'", "''")
                level = _fetch_level(f"crc6f_userid eq '{safe_emp}'")
                if level in ("L3", "L4"):
                    return True

            return False

        now_utc = datetime.now(timezone.utc)
        entries = _read_entries()

        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-Version": "4.0",
            "Content-Type": "application/json",
            "Prefer": 'odata.include-annotations="*"',
        }

        if not _resolve_admin_access(headers):
            return jsonify({"success": False, "error": "Admin access required", "items": []}), 403

        MAX_ACTIVE_HOURS = 16
        stale_cutoff = now_utc - timedelta(hours=MAX_ACTIVE_HOURS)
        stale_stopped = False

        latest_by_user = {}
        for rec in entries:
            if rec.get("end"):
                continue

            user_id = str(rec.get("user_id") or "").strip().upper()
            task_guid = str(rec.get("task_guid") or "").strip()
            if not user_id or not task_guid:
                continue

            start_raw = rec.get("start")
            try:
                start_dt = datetime.fromisoformat(str(start_raw)) if start_raw else now_utc
            except Exception:
                start_dt = now_utc

            if getattr(start_dt, "tzinfo", None) is None:
                start_dt = start_dt.replace(tzinfo=timezone.utc)

            if start_dt < stale_cutoff:
                rec["end"] = now_utc.isoformat()
                stale_stopped = True
                continue

            existing = latest_by_user.get(user_id)
            if (not existing) or (start_dt > existing["_start_dt"]):
                latest_by_user[user_id] = {
                    "user_id": user_id,
                    "task_guid": task_guid,
                    "start": start_raw,
                    "_start_dt": start_dt,
                }

        if stale_stopped:
            _write_entries(entries)

        active_rows = list(latest_by_user.values())
        if not active_rows:
            return jsonify({"success": True, "count": 0, "timestamp_utc": now_utc.isoformat(), "items": []}), 200

        # Fetch active task details
        task_map = {}
        project_ids = set()
        for row in active_rows:
            safe_guid = row["task_guid"].replace("'", "''")
            url = (
                f"{RESOURCE}{DV_API}/{ENTITY_SET_TASKS}"
                f"?$select=crc6f_hr_taskdetailsid,crc6f_taskid,crc6f_taskname,crc6f_projectid"
                f"&$filter=crc6f_hr_taskdetailsid eq '{safe_guid}'&$top=1"
            )
            resp = get_dataverse_session().get(url, headers=headers, timeout=20)
            if not resp.ok:
                continue
            values = resp.json().get("value", [])
            if not values:
                continue
            rec = values[0]
            guid = str(rec.get("crc6f_hr_taskdetailsid") or "").strip()
            if not guid:
                continue
            pid = str(rec.get("crc6f_projectid") or "").strip()
            if pid:
                project_ids.add(pid)
            task_map[guid] = {
                "task_id": rec.get("crc6f_taskid"),
                "task_name": rec.get("crc6f_taskname"),
                "project_id": pid,
            }

        # Fetch project names for active project IDs
        project_name_map = {}
        for pid in sorted(project_ids):
            safe_pid = pid.replace("'", "''")
            p_url = (
                f"{RESOURCE}{DV_API}/{ENTITY_SET_PROJECTS}"
                f"?$select=crc6f_projectid,crc6f_projectname"
                f"&$filter=crc6f_projectid eq '{safe_pid}'&$top=1"
            )
            p_resp = get_dataverse_session().get(p_url, headers=headers, timeout=20)
            if not p_resp.ok:
                continue
            p_vals = p_resp.json().get("value", [])
            if not p_vals:
                continue
            p_rec = p_vals[0]
            p_id = str(p_rec.get("crc6f_projectid") or "").strip()
            if p_id:
                project_name_map[p_id] = p_rec.get("crc6f_projectname") or p_id

        employee_name_cache = {}
        items = []
        for row in sorted(active_rows, key=lambda r: (r.get("user_id") or "", r.get("task_guid") or "")):
            task_guid = row.get("task_guid")
            task_meta = task_map.get(task_guid, {})
            project_id = task_meta.get("project_id") or ""

            user_id = row.get("user_id")
            if user_id not in employee_name_cache:
                try:
                    employee_name_cache[user_id] = get_employee_name(user_id) or user_id
                except Exception:
                    employee_name_cache[user_id] = user_id

            start_dt = row.get("_start_dt") or now_utc
            if getattr(start_dt, "tzinfo", None) is None:
                start_dt = start_dt.replace(tzinfo=timezone.utc)
            elapsed_seconds = max(0, int((now_utc - start_dt).total_seconds()))

            items.append({
                "employee_id": user_id,
                "employee_name": employee_name_cache.get(user_id) or user_id,
                "task_guid": task_guid,
                "task_id": task_meta.get("task_id") or task_guid,
                "task_name": task_meta.get("task_name") or task_meta.get("task_id") or task_guid,
                "project_id": project_id,
                "project_name": project_name_map.get(project_id) or project_id,
                "started_at_utc": start_dt.astimezone(timezone.utc).isoformat(),
                "elapsed_seconds": elapsed_seconds,
            })

        return jsonify({
            "success": True,
            "count": len(items),
            "timestamp_utc": now_utc.isoformat(),
            "items": items,
        }), 200
    except Exception as e:
        return jsonify({"success": False, "error": str(e), "items": []}), 500


@bp_time.route("/time-entries/start", methods=["POST"])
def start_timer():
    data = request.get_json(force=True) or {}
    task_guid = (data.get("task_guid") or "").strip()
    user_id = (data.get("user_id") or "").strip()
    if not task_guid or not user_id:
        return jsonify({"success": False, "error": "task_guid and user_id required"}), 400

    entries = _read_entries()
    # stop any other active entries for this user (single active guard)
    changed = False
    now_iso = _now_iso()
    for e in entries:
        if e.get("user_id") == user_id and not e.get("end"):
            e["end"] = now_iso
            changed = True
    new_entry = {
        "id": f"TE-{int(datetime.now().timestamp()*1000)}",
        "task_guid": task_guid,
        "user_id": user_id,
        "start": now_iso,
        "end": None,
    }
    entries.append(new_entry)
    _write_entries(entries)
    return jsonify({"success": True, "entry": new_entry})


@bp_time.route("/time-entries/stop", methods=["POST"])
def stop_timer():
    data = request.get_json(force=True) or {}
    task_guid = (data.get("task_guid") or "").strip()
    user_id = (data.get("user_id") or "").strip()
    if not task_guid or not user_id:
        return jsonify({"success": False, "error": "task_guid and user_id required"}), 400

    entries = _read_entries()
    now_iso = _now_iso()
    stopped = None
    for e in entries:
        if e.get("user_id") == user_id and e.get("task_guid") == task_guid and not e.get("end"):
            e["end"] = now_iso
            stopped = e
            break
    if not stopped:
        return jsonify({"success": False, "error": "No active timer for this task"}), 400
    _write_entries(entries)
    return jsonify({"success": True, "entry": stopped})


@bp_time.route("/time-entries/active/<user_id>", methods=["GET"])
def get_active_timer(user_id):
    """Get active timer entry for a user (for cross-device sync)"""
    uid = (user_id or "").strip()
    if not uid:
        return jsonify({"success": False, "error": "user_id required"}), 400
    
    entries = _read_entries()
    active_entry = None
    for e in entries:
        if e.get("user_id") == uid and not e.get("end"):
            active_entry = e
            break
    
    if not active_entry:
        return jsonify({"success": True, "active_timer": None})
    
    return jsonify({"success": True, "active_timer": active_entry})


# ---------- Timesheet logs (create/read/delete) - Dataverse Integration ----------
@bp_time.route("/time-tracker/task-log", methods=["POST"])
def create_task_log():
    """
    Body: { employee_id, project_id, task_guid, task_id, task_name, seconds, work_date, description }
    Optional: session_start_ms, session_end_ms, tz_offset_minutes to split across days
    Stores in Dataverse table: crc6f_hr_timesheetlog
    """
    try:
        b = request.get_json(force=True) or {}
        employee_id = (b.get("employee_id") or "").strip()
        seconds = int(b.get("seconds") or 0)
        work_date = (b.get("work_date") or "").strip()  # YYYY-MM-DD (fallback)
        project_id = (b.get("project_id") or "").strip()
        task_id = (b.get("task_id") or "").strip()
        task_guid = (b.get("task_guid") or "").strip()
        session_start_ms = b.get("session_start_ms")
        session_end_ms = b.get("session_end_ms")
        tz_offset_minutes = int(b.get("tz_offset_minutes") or 0)
        
        print(f"[TIME_TRACKER] POST /time-tracker/task-log - employee_id={employee_id}, task_id={task_id}, seconds={seconds}, work_date={work_date}")
        
        if not employee_id or seconds <= 0:
            print(f"[TIME_TRACKER] Validation failed: employee_id={employee_id}, seconds={seconds}")
            return jsonify({"success": False, "error": "employee_id and seconds>0 required"}), 400

        # Build per-day segments
        segments = []
        if session_start_ms is not None and session_end_ms is not None:
            segments = _split_session_by_day(int(session_start_ms), int(session_end_ms), tz_offset_minutes)
        # Fallback to provided work_date
        if not segments:
            if not work_date:
                work_date = datetime.utcnow().date().isoformat()
            segments = [(work_date, seconds)]

        if not segments:
            return jsonify({"success": False, "error": "No time segments to log"}), 400
        
        def upsert_segment(seg_work_date: str, seg_seconds: int):
            # Convert seconds to hours (decimal)
            hours_worked = round(seg_seconds / 3600, 4)
            task_name = (b.get("task_name") or "").strip()
            work_desc = (b.get("description") or task_name or "").strip()

            payload = {
                "crc6f_employeeid": employee_id,
                "crc6f_projectid": project_id,
                "crc6f_taskid": task_id,
                "crc6f_taskguid": task_guid,
                "crc6f_taskname": task_name,
                "crc6f_hoursworked": round(hours_worked, 4),
                "crc6f_workdescription": work_desc,
                "crc6f_approvalstatus": "Pending",
                # Dataverse work date field (Date Only)
                "crc6f_workdate": seg_work_date if seg_work_date else None
            }
            # Remove None values
            payload = {k: v for k, v in payload.items() if v is not None}

            token = get_access_token()
            headers = {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "OData-Version": "4.0",
            }

            logs = _read_logs()
            dv_id = None
            dataverse_saved = False
            dataverse_error = ""

            # Dataverse UPSERT by employee + date + task identity (+project if available)
            try:
                safe_emp = employee_id.replace("'", "''")
                safe_date = seg_work_date.replace("'", "''")
                filter_parts = [
                    f"crc6f_employeeid eq '{safe_emp}'",
                    f"crc6f_workdate ge '{safe_date}'",
                    f"crc6f_workdate le '{safe_date}'",
                ]
                if project_id:
                    safe_project = project_id.replace("'", "''")
                    filter_parts.append(f"crc6f_projectid eq '{safe_project}'")
                # Prefer task_id in lookup to avoid schema-specific failures where
                # crc6f_taskguid may not exist in some Dataverse environments.
                if task_id:
                    safe_task_id = task_id.replace("'", "''")
                    filter_parts.append(f"crc6f_taskid eq '{safe_task_id}'")
                elif task_guid:
                    safe_task_guid = task_guid.replace("'", "''")
                    filter_parts.append(f"crc6f_taskguid eq '{safe_task_guid}'")

                lookup_q = " and ".join(filter_parts)
                lookup_url = (
                    f"{RESOURCE}{DV_API}/crc6f_hr_timesheetlogs"
                    f"?$filter={lookup_q}&$select=crc6f_hr_timesheetlogid,crc6f_hoursworked&$top=1"
                )
                lookup_resp = get_dataverse_session().get(lookup_url, headers=headers, timeout=30)
                existing_rows = []
                if lookup_resp.status_code == 200:
                    existing_rows = lookup_resp.json().get("value", [])
                else:
                    # Lookup errors should not block create attempts.
                    print(f"[TIME_TRACKER] Dataverse lookup warning ({lookup_resp.status_code}): {lookup_resp.text[:250]}")

                if existing_rows:
                    row = existing_rows[0]
                    dv_id = row.get("crc6f_hr_timesheetlogid")
                    prev_hours = 0.0
                    try:
                        prev_hours = float(row.get("crc6f_hoursworked") or 0)
                    except Exception:
                        prev_hours = 0.0
                    merged_hours = round(prev_hours + hours_worked, 4)
                    update_payload = {
                        "crc6f_hoursworked": round(merged_hours, 4),
                        "crc6f_workdescription": work_desc,
                    }
                    patch_url = f"{RESOURCE}{DV_API}/crc6f_hr_timesheetlogs({dv_id})"
                    patch_resp = get_dataverse_session().patch(patch_url, headers=headers, json=update_payload, timeout=30)
                    print(f"[TIME_TRACKER] Dataverse PATCH status: {patch_resp.status_code}")
                    if patch_resp.status_code not in (200, 204):
                        raise Exception(f"Dataverse PATCH failed ({patch_resp.status_code}): {patch_resp.text[:250]}")
                    dataverse_saved = True
                else:
                    post_url = f"{RESOURCE}{DV_API}/crc6f_hr_timesheetlogs"
                    create_candidate = dict(payload)
                    create_error = "Dataverse POST failed"
                    for idx in range(1, 9):
                        resp = get_dataverse_session().post(post_url, headers=headers, json=create_candidate, timeout=30)
                        print(f"[TIME_TRACKER] Dataverse POST attempt {idx} status: {resp.status_code}")
                        if resp.status_code in (200, 201, 204):
                            dataverse_saved = True
                            try:
                                ent = resp.headers.get('OData-EntityId') or resp.headers.get('odata-entityid')
                                if ent and ent.endswith(')') and '(' in ent:
                                    dv_id = ent.split('(')[-1].strip(')')
                            except Exception:
                                dv_id = None
                            break
                        create_error = f"attempt {idx} failed ({resp.status_code}): {resp.text[:250]}"

                        # Adaptive fallback: if Dataverse says a field is invalid/missing,
                        # drop only that field and retry without losing other data.
                        err_text = (resp.text or "")
                        bad_field = None
                        m = re.search(r"Invalid property '([^']+)'", err_text, re.IGNORECASE)
                        if m:
                            bad_field = m.group(1)
                        if not bad_field:
                            m2 = re.search(r"property named '([^']+)'", err_text, re.IGNORECASE)
                            if m2:
                                bad_field = m2.group(1)

                        if bad_field and bad_field in create_candidate:
                            print(f"[TIME_TRACKER] Retrying create without field: {bad_field}")
                            create_candidate.pop(bad_field, None)
                            continue

                        # Common fallback for environments with strict option-set/field configs
                        if idx == 1 and "crc6f_approvalstatus" in create_candidate:
                            print("[TIME_TRACKER] Retrying create without crc6f_approvalstatus")
                            create_candidate.pop("crc6f_approvalstatus", None)
                            continue

                        # Last conservative fallback before failing hard
                        if idx == 2 and "crc6f_taskguid" in create_candidate:
                            print("[TIME_TRACKER] Retrying create without crc6f_taskguid")
                            create_candidate.pop("crc6f_taskguid", None)
                            continue

                        # Unknown failure: stop retry loop and return clear error upstream.
                        break
                    if not dataverse_saved:
                        raise Exception(create_error)
            except Exception as dv_err:
                dataverse_error = str(dv_err)
                print(f"[TIME_TRACKER] Dataverse UPSERT failed; keeping local pending copy: {dataverse_error}")

            # UPSERT local log by employee + task + work_date
            idx = None
            for i, r in enumerate(logs):
                if (
                    r.get("employee_id") == employee_id
                    and _same_task_identity(
                        r.get("task_guid"),
                        r.get("task_id"),
                        task_guid,
                        task_id,
                    )
                    and r.get("work_date") == seg_work_date
                ):
                    idx = i
                    break
            if idx is not None:
                prev = logs[idx]
                new_secs = (int(prev.get("seconds") or 0) + int(seg_seconds))
                logs[idx] = {
                    **prev,
                    "seconds": new_secs,
                    "description": work_desc or prev.get("description") or "",
                    "dv_id": dv_id or prev.get("dv_id"),
                    "sync_pending": not dataverse_saved,
                    "last_sync_error": dataverse_error if not dataverse_saved else "",
                }
                rec_local = logs[idx]
                print(f"[TIME_TRACKER] Upserted local log (aggregate): {employee_id} {task_id} {seg_work_date} -> {new_secs}s")
            else:
                rec_local = {
                    "id": f"LOG-{int(datetime.now().timestamp()*1000)}",
                    "employee_id": employee_id,
                    "project_id": project_id,
                    "task_guid": task_guid or None,
                    "task_id": task_id or None,
                    "task_name": task_name,
                    "seconds": seg_seconds,
                    "work_date": seg_work_date,
                    "description": work_desc,
                    "dv_id": dv_id,
                    "sync_pending": not dataverse_saved,
                    "last_sync_error": dataverse_error if not dataverse_saved else "",
                    "created_at": _now_iso(),
                }
                logs.append(rec_local)
                print(f"[TIME_TRACKER] Inserted new local log: {employee_id} {task_id} {seg_work_date} -> {seg_seconds}s")
            _write_logs(logs)
            
            return rec_local, dataverse_saved, dataverse_error

        recs = []
        dataverse_failures = []
        for seg_date, seg_seconds in segments:
            rec_local, seg_saved, seg_error = upsert_segment(seg_date, seg_seconds)
            recs.append(rec_local)
            if not seg_saved:
                dataverse_failures.append({
                    "work_date": seg_date,
                    "seconds": seg_seconds,
                    "error": seg_error,
                })

        if dataverse_failures:
            return jsonify({
                "success": False,
                "error": "Dataverse save failed for one or more segments; preserved in local pending cache",
                "logs": recs,
                "dataverse_saved": False,
                "pending_sync": len(dataverse_failures),
                "failures": dataverse_failures,
            }), 502

        return jsonify({"success": True, "logs": recs, "dataverse_saved": True, "pending_sync": 0}), 201
            
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@bp_time.route("/time-tracker/logs", methods=["GET"])
def list_logs():
    """
    Fetch timesheet logs from Dataverse with fallback to local JSON
    Query params: employee_id (required), start_date, end_date
    """
    employee_id = (request.args.get("employee_id") or "").strip()
    start_date = (request.args.get("start_date") or "").strip()  # YYYY-MM-DD
    end_date = (request.args.get("end_date") or "").strip()
    
    print(f"[TIME_TRACKER] GET /time-tracker/logs - employee_id={employee_id}, start_date={start_date}, end_date={end_date}")
    
    if not employee_id:
        return jsonify({"success": False, "error": "employee_id required"}), 400
    
    # Try fetching from Dataverse first
    try:
        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-Version": "4.0",
            "Prefer": 'odata.include-annotations="*"',
        }
        
        # Build OData filter
        if employee_id.upper() == "ALL":
            # For team timesheet, fetch all employees within date range
            filter_parts = []
            if start_date:
                filter_parts.append(f"crc6f_workdate ge '{start_date}'")
            if end_date:
                filter_parts.append(f"crc6f_workdate le '{end_date}'")
        else:
            # For individual timesheet
            safe_emp = employee_id.replace("'", "''")
            filter_parts = [f"crc6f_employeeid eq '{safe_emp}'"]
            if start_date:
                filter_parts.append(f"crc6f_workdate ge '{start_date}'")
            if end_date:
                filter_parts.append(f"crc6f_workdate le '{end_date}'")
        
        filter_query = " and ".join(filter_parts) if filter_parts else ""
        url = f"{RESOURCE}{DV_API}/crc6f_hr_timesheetlogs"
        if filter_query:
            url += f"?$filter={filter_query}&$top=5000&$orderby=crc6f_workdate desc"
        else:
            url += "?$top=5000&$orderby=crc6f_workdate desc"
        
        print(f"[TIME_TRACKER] Fetching from Dataverse URL: {url}")
        print(f"[TIME_TRACKER] Filter query: {filter_query}")
        
        resp = get_dataverse_session().get(url, headers=headers, timeout=30)
        print(f"[TIME_TRACKER] Dataverse response status: {resp.status_code}")
        
        if resp.status_code == 200:
            data = resp.json()
            records = data.get("value", [])
            
            # Transform Dataverse records to frontend format
            out = []
            for r in records:
                # Skip if work_date is in the future
                work_date = r.get("crc6f_workdate", "")
                if work_date:
                    try:
                        # Parse date and check if it's not in the future
                        work_dt = datetime.strptime(work_date[:10], '%Y-%m-%d').date()
                        today = datetime.now().date()
                        if work_dt > today:
                            continue
                    except:
                        pass
                
                raw_description = r.get("crc6f_workdescription", "") or ""
                is_manual = "[MANUAL]" in raw_description
                clean_description = raw_description.replace("[MANUAL]", "").strip()
                seconds_value = _hoursworked_to_seconds(
                    r.get("crc6f_hoursworked", 0),
                    r.get("crc6f_hoursworked@OData.Community.Display.V1.FormattedValue"),
                )

                log_entry = {
                    "id": r.get("crc6f_hr_timesheetlogid"),
                    "employee_id": r.get("crc6f_employeeid"),
                    "project_id": r.get("crc6f_projectid"),
                    "task_guid": r.get("crc6f_taskguid"),
                    "task_id": r.get("crc6f_taskid"),
                    "task_name": r.get("crc6f_taskname") or clean_description.split(" - ")[0] if clean_description else "",
                    "seconds": seconds_value,
                    "work_date": work_date[:10] if work_date else "",  # Ensure YYYY-MM-DD format
                    "description": clean_description,
                    "approval_status": r.get("crc6f_approvalstatus", "Pending"),
                    "created_at": r.get("createdon", ""),
                    "manual": is_manual,
                }
                
                # Apply additional date filtering in case Dataverse filtering didn't work
                if start_date and log_entry.get("work_date", "") < start_date:
                    continue
                if end_date and log_entry.get("work_date", "") > end_date:
                    continue
                    
                out.append(log_entry)
            
            # Merge local logs that may not yet exist in Dataverse (best effort).
            # This prevents missing same-day entries in team/my timesheet when Dataverse
            # upsert is delayed or fails but local fallback write succeeded.
            merged_count = 0
            try:
                local_logs = _read_logs()

                def _merge_identity_candidates(rec):
                    cands = []
                    tg = str(rec.get("task_guid") or "").strip().upper()
                    tid = str(rec.get("task_id") or "").strip().upper()
                    if tg:
                        cands.append(f"GUID:{tg}")
                    if tid:
                        cands.append(f"ID:{tid}")
                    if not cands:
                        cands.append("NONE")
                    return cands

                existing_keys = set()
                for rec in out:
                    base = (
                        str(rec.get("employee_id") or "").upper(),
                        str(rec.get("work_date") or "")[:10],
                        str(rec.get("project_id") or ""),
                    )
                    for ident in _merge_identity_candidates(rec):
                        existing_keys.add(base + (ident,))

                for r in local_logs:
                    # Match current request scope
                    if employee_id != "ALL" and str(r.get("employee_id") or "") != employee_id:
                        continue

                    local_date = str(r.get("work_date") or "")[:10]
                    if start_date and local_date < start_date:
                        continue
                    if end_date and local_date > end_date:
                        continue

                    local_base = (
                        str(r.get("employee_id") or "").upper(),
                        local_date,
                        str(r.get("project_id") or ""),
                    )
                    local_idents = _merge_identity_candidates(r)
                    if any((local_base + (ident,)) in existing_keys for ident in local_idents):
                        continue

                    out.append(r)
                    for ident in local_idents:
                        existing_keys.add(local_base + (ident,))
                    merged_count += 1

                if merged_count:
                    print(f"[TIME_TRACKER] Merged {merged_count} local logs not present in Dataverse response")
            except Exception as merge_err:
                print(f"[TIME_TRACKER] Local merge warning: {merge_err}")

            out = _coalesce_logs(out)

            source_label = "dataverse+local" if merged_count else "dataverse"
            print(f"[TIME_TRACKER] Successfully fetched {len(out)} logs from {source_label}")
            return jsonify({"success": True, "logs": out, "source": source_label, "pending_sync": merged_count}), 200
        else:
            print(f"[TIME_TRACKER] Dataverse returned {resp.status_code}: {resp.text}")
            raise Exception(f"Dataverse returned {resp.status_code}")
            
    except Exception as e:
        # Fallback to local JSON storage only if Dataverse fails
        print(f"[TIME_TRACKER] Dataverse fetch failed, using local fallback: {e}")
        try:
            logs = _read_logs()
            print(f"[TIME_TRACKER] Read {len(logs)} logs from local storage")
            out = []
            for r in logs:
                # Support "ALL" to fetch all employees' logs (for team timesheet)
                if employee_id != "ALL" and r.get("employee_id") != employee_id:
                    continue
                if start_date and r.get("work_date", "") < start_date:
                    continue
                if end_date and r.get("work_date", "") > end_date:
                    continue
                out.append(r)

            out = _coalesce_logs(out)
            
            if employee_id == "ALL":
                print(f"[TIME_TRACKER] Filtered to {len(out)} logs for ALL employees")
            else:
                print(f"[TIME_TRACKER] Filtered to {len(out)} logs for employee {employee_id}")
            
            return jsonify({"success": True, "logs": out, "source": "local"}), 200
        except Exception as e2:
            print(f"[TIME_TRACKER] Error reading logs: {e2}")
            return jsonify({"success": False, "error": str(e2)}), 500


@bp_time.route("/time-tracker/logs", methods=["DELETE"])
def delete_logs():
    """
    Delete timesheet log from Dataverse
    Body: { log_id } or { employee_id, work_date, project_id/task_id }
    """
    b = request.get_json(force=True) or {}
    log_id = (b.get("log_id") or "").strip()
    
    try:
        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-Version": "4.0",
        }
        
        if log_id:
            # Direct delete by ID
            url = f"{RESOURCE}{DV_API}/crc6f_hr_timesheetlogs({log_id})"
            resp = get_dataverse_session().delete(url, headers=headers, timeout=30)
            
            if resp.status_code in (200, 204):
                # Also delete from local cache
                logs = _read_logs()
                logs = [
                    r for r in logs
                    if str(r.get("id") or "") != log_id and str(r.get("dv_id") or "") != log_id
                ]
                _write_logs(logs)
                return jsonify({"success": True, "deleted": 1, "source": "dataverse"}), 200
            else:
                return jsonify({"success": False, "error": f"Dataverse delete failed: {resp.status_code}"}), 400
        else:
            # Fallback to local deletion if no log_id
            employee_id = (b.get("employee_id") or "").strip()
            project_id = (b.get("project_id") or "").strip()
            task_guid = (b.get("task_guid") or "").strip()
            work_date = (b.get("work_date") or "").strip()
            
            if not employee_id or not work_date:
                return jsonify({"success": False, "error": "log_id or (employee_id and work_date) required"}), 400
            
            logs = _read_logs()
            before = len(logs)
            logs = [r for r in logs if not (
                r.get("employee_id") == employee_id and r.get("work_date") == work_date and
                ((project_id and r.get("project_id") == project_id) or (task_guid and r.get("task_guid") == task_guid))
            )]
            _write_logs(logs)
            return jsonify({"success": True, "deleted": before - len(logs), "source": "local"}), 200
            
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


def _update_timesheet_status(entry_id, new_status, comment=None, decided_by=None):
    """Helper to update status of a timesheet submission in TS_ENTRIES_FILE.
    
    Updates all entries for the same employee+week as the target entry to ensure
    the entire weekly submission moves together (from Pending to Accepted/Rejected).
    """
    entries = _read_ts_entries()
    updated = None
    target_employee = None
    target_week_start = None
    
    # First pass: find the target entry and extract employee+week
    for rec in entries:
        if str(rec.get("id")) == str(entry_id):
            updated = rec
            target_employee = str(rec.get("employee_id") or "").strip()
            date_str = str(rec.get("date") or "")
            if date_str and target_employee:
                try:
                    from datetime import datetime
                    d = datetime.fromisoformat(date_str[:10])
                    day = d.weekday()
                    delta = -day  # Monday is 0
                    week_start = (d + timedelta(days=delta)).strftime("%Y-%m-%d")
                    target_week_start = week_start
                except Exception:
                    pass
            break
    
    if not updated or not target_employee or not target_week_start:
        return None, entries
    
    # Second pass: update all entries for the same employee+week
    now_iso = _now_iso()
    for rec in entries:
        emp = str(rec.get("employee_id") or "").strip()
        if emp != target_employee:
            continue
        
        date_str = str(rec.get("date") or "")
        if not date_str:
            continue
        
        try:
            from datetime import datetime
            d = datetime.fromisoformat(date_str[:10])
            day = d.weekday()
            delta = -day
            week_start = (d + timedelta(days=delta)).strftime("%Y-%m-%d")
            
            if week_start == target_week_start:
                rec["status"] = new_status
                rec["decided_at"] = now_iso
                if decided_by:
                    rec["decided_by"] = decided_by
                if comment is not None:
                    rec["reject_comment"] = comment
        except Exception:
            continue
    
    _write_ts_entries(entries)
    return updated, entries


@bp_time.route("/admin/timesheet-monitor", methods=["GET", "POST"])
def admin_timesheet_monitor():
    """Return per-employee, per-week submission status + hours logged for a month.

    Accepts employee list from POST body (preferred) or fetches from Dataverse.
    Query params:
      - month (1-12, default current)
      - year  (e.g. 2026, default current)
    POST body (optional JSON):
      - employees: [{ "employee_id": "EMP001", "name": "First Last" }, ...]
    """
    import calendar
    try:
        now = datetime.now()
        month = int(request.args.get("month") or now.month)
        year = int(request.args.get("year") or now.year)
        if month < 1 or month > 12:
            month = now.month

        # ── 1. Compute weeks (Mon-Sun) that overlap with the month ──
        first_day = datetime(year, month, 1).date()
        last_day = datetime(year, month, calendar.monthrange(year, month)[1]).date()

        # Go back to Monday of the week containing the 1st
        start = first_day - timedelta(days=first_day.weekday())  # weekday(): Mon=0
        weeks = []
        while start <= last_day:
            end = start + timedelta(days=6)
            weeks.append({
                "start": start.isoformat(),
                "end": end.isoformat(),
                "label": f"Week {len(weeks) + 1}",
            })
            start = start + timedelta(days=7)

        month_start = weeks[0]["start"] if weeks else first_day.isoformat()
        month_end = weeks[-1]["end"] if weeks else last_day.isoformat()

        # ── 2. Get employees from POST body (sent by frontend) ──
        employees = []
        body = {}
        try:
            body = request.get_json(force=True, silent=True) or {}
        except Exception:
            pass

        raw_emps = body.get("employees") or []
        for e in raw_emps:
            eid = str(e.get("employee_id") or e.get("id") or "").strip()
            if not eid:
                continue
            name = str(e.get("name") or e.get("employee_name") or "").strip()
            if not name:
                fn = str(e.get("first_name") or "").strip()
                ln = str(e.get("last_name") or "").strip()
                name = f"{fn} {ln}".strip() or eid
            employees.append({"id": eid, "name": name})

        if not employees:
            return jsonify({"success": True, "weeks": weeks, "employees": [], "month": month, "year": year}), 200

        emp_ids = {e["id"].upper() for e in employees}

        # ── 3. Read timesheet submissions (local JSON) ──
        submissions = _read_ts_entries()

        # Build a mapping: employee_id (upper) -> week_start -> best status
        # Priority: Accepted > Rejected > Pending > (nothing)
        status_priority = {"accepted": 3, "rejected": 2, "pending": 1}
        sub_map = {}  # { "EMP001": { "2026-03-30": "Pending" } }
        for s in submissions:
            eid = str(s.get("employee_id") or "").strip().upper()
            if eid not in emp_ids:
                continue
            date_str = str(s.get("date") or "")[:10]
            if not date_str:
                continue
            try:
                d = datetime.strptime(date_str, "%Y-%m-%d").date()
            except Exception:
                continue
            # Find week_start (Monday)
            ws = (d - timedelta(days=d.weekday())).isoformat()

            status_raw = str(s.get("status") or "").strip()
            status_lc = status_raw.lower()

            if eid not in sub_map:
                sub_map[eid] = {}
            existing = sub_map[eid].get(ws, "")
            existing_pri = status_priority.get(existing.lower(), 0)
            new_pri = status_priority.get(status_lc, 0)
            if new_pri > existing_pri:
                sub_map[eid][ws] = status_raw.capitalize() if status_raw else ""

        # ── 4. Fetch timesheet logs for the full month range (Dataverse) ──
        hours_map = {}  # { "EMP001": { "2026-03-30": total_seconds } }
        try:
            token = get_access_token()
            headers = {
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "OData-Version": "4.0",
                "Prefer": 'odata.include-annotations="*"',
            }
            filter_q = f"crc6f_workdate ge '{month_start}' and crc6f_workdate le '{month_end}'"
            logs_url = (
                f"{RESOURCE}{DV_API}/crc6f_hr_timesheetlogs"
                f"?$filter={filter_q}"
                "&$select=crc6f_employeeid,crc6f_workdate,crc6f_hoursworked"
                "&$top=5000"
            )
            logs_resp = get_dataverse_session().get(logs_url, headers=headers, timeout=30)
            if logs_resp.status_code == 200:
                for r in logs_resp.json().get("value", []):
                    eid = str(r.get("crc6f_employeeid") or "").strip().upper()
                    wd = str(r.get("crc6f_workdate") or "")[:10]
                    if not eid or not wd:
                        continue
                    try:
                        d = datetime.strptime(wd, "%Y-%m-%d").date()
                    except Exception:
                        continue
                    ws = (d - timedelta(days=d.weekday())).isoformat()
                    secs = _hoursworked_to_seconds(
                        r.get("crc6f_hoursworked", 0),
                        r.get("crc6f_hoursworked@OData.Community.Display.V1.FormattedValue"),
                    )
                    if eid not in hours_map:
                        hours_map[eid] = {}
                    hours_map[eid][ws] = hours_map[eid].get(ws, 0) + secs
        except Exception as log_err:
            print(f"[TS-MONITOR] Log fetch error: {log_err}")

        # Also merge local logs as fallback
        try:
            local_logs = _read_logs()
            for r in local_logs:
                eid = str(r.get("employee_id") or "").strip().upper()
                wd = str(r.get("work_date") or "")[:10]
                if not eid or not wd or eid not in emp_ids:
                    continue
                try:
                    d = datetime.strptime(wd, "%Y-%m-%d").date()
                except Exception:
                    continue
                if d < datetime.strptime(month_start, "%Y-%m-%d").date() or d > datetime.strptime(month_end, "%Y-%m-%d").date():
                    continue
                ws = (d - timedelta(days=d.weekday())).isoformat()
                secs = int(r.get("seconds") or 0)
                if secs <= 0:
                    continue
                # Only add if not already covered by Dataverse
                if eid in hours_map and ws in hours_map[eid]:
                    continue
                if eid not in hours_map:
                    hours_map[eid] = {}
                hours_map[eid][ws] = hours_map[eid].get(ws, 0) + secs
        except Exception:
            pass

        # ── 5. Build response ──
        week_starts = [w["start"] for w in weeks]
        result_employees = []
        for emp in employees:
            eid_up = emp["id"].upper()
            emp_weeks = []
            for ws in week_starts:
                status = (sub_map.get(eid_up) or {}).get(ws, "Not Submitted")
                seconds = (hours_map.get(eid_up) or {}).get(ws, 0)
                hours = round(seconds / 3600, 2) if seconds else 0
                emp_weeks.append({
                    "week_start": ws,
                    "status": status,
                    "hours": hours,
                    "seconds": seconds,
                })
            result_employees.append({
                "employee_id": emp["id"],
                "employee_name": emp["name"],
                "weeks": emp_weeks,
            })

        return jsonify({
            "success": True,
            "month": month,
            "year": year,
            "weeks": weeks,
            "employees": result_employees,
        }), 200

    except Exception as e:
        print(f"[TS-MONITOR] Error: {e}")
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


@bp_time.route("/time-tracker/timesheet/submit", methods=["POST"])
def submit_timesheet():
    """Create Pending timesheet submissions from the My Timesheet page.

    Body: {
      "employee_id": "EMP001",
      "employee_name": "John Doe",  # optional
      "entries": [
        {
          "date": "2025-11-17",
          "project_id": "VTAB004",
          "project_name": "Amber - Fidelity",
          "task_id": "TASK003",
          "task_guid": "...",
          "task_name": "Backend work",
          "seconds": 3600,
          "hours_worked": 1.0,
          "description": ""
        },
        ...
      ]
    }
    """
    try:
        body = request.get_json(force=True) or {}
        employee_id = (body.get("employee_id") or "").strip()
        employee_name = (body.get("employee_name") or "").strip()
        raw_entries = body.get("entries") or []
        normalized_entries = []
        week_starts = set()

        if not employee_id or not raw_entries:
            return jsonify({"success": False, "error": "employee_id and entries required"}), 400

        entries = _read_ts_entries()
        created = []
        base_ts = int(datetime.now().timestamp() * 1000)

        for item in raw_entries:
            date = (item.get("date") or "").strip()
            if not date:
                continue
            seconds = int(item.get("seconds") or 0)
            if seconds <= 0:
                continue
            week_start = _timesheet_week_start(date)
            if not week_start:
                continue
            normalized_entries.append(item)
            week_starts.add(week_start)

        if not normalized_entries:
            return jsonify({"success": False, "error": "No valid entries to submit"}), 400

        if len(week_starts) != 1:
            return jsonify({"success": False, "error": "All submitted entries must belong to the same week"}), 400

        target_week_start = next(iter(week_starts))
        current_status = _best_week_submission_status(entries, employee_id, target_week_start)
        if current_status == "pending":
            return jsonify({"success": False, "error": "This week's timesheet is already pending approval"}), 400
        if current_status == "accepted":
            return jsonify({"success": False, "error": "This week's timesheet has already been approved"}), 400
        if current_status == "rejected":
            entries = _remove_weekly_entries(entries, employee_id, target_week_start, statuses={"rejected"})

        for idx, item in enumerate(normalized_entries):
            date = (item.get("date") or "").strip()
            if not date:
                continue
            seconds = int(item.get("seconds") or 0)
            if seconds <= 0:
                continue
            hours = item.get("hours_worked")
            try:
                hours_val = float(hours) if hours is not None else round(seconds / 3600, 2)
            except Exception:
                hours_val = round(seconds / 3600, 2)

            rec = {
                "id": f"TS-{base_ts + idx}",
                "employee_id": employee_id,
                "employee_name": employee_name,
                "date": date,
                "project_id": (item.get("project_id") or "").strip(),
                "project_name": item.get("project_name") or "",
                "task_id": (item.get("task_id") or "").strip(),
                "task_guid": (item.get("task_guid") or "").strip(),
                "task_name": item.get("task_name") or "",
                "seconds": seconds,
                "hours_worked": hours_val,
                "description": item.get("description") or "",
                "status": "Pending",
                "submitted_at": _now_iso(),
                "decided_at": None,
                "decided_by": None,
                "reject_comment": "",
            }
            entries.append(rec)
            created.append(rec)

        _write_ts_entries(entries)
        return jsonify({"success": True, "items": created, "count": len(created)}), 201
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500
    finally:
        # Send notification to L2/L3
        try:
            if created:
                # all entries belong to the same week_start based on the validation above
                target_week_start = next(iter(week_starts))
                emp_name = employee_name or get_employee_name(employee_id) or employee_id
                l2_l3_recipients = get_l2_l3_emails()
                if l2_l3_recipients:
                    recipient_emails = [r["email"] for r in l2_l3_recipients if r.get("email")]
                    if recipient_emails:
                        total_secs = sum(item.get("seconds", 0) for item in created)
                        total_hrs = round(total_secs / 3600, 2)
                        send_email(
                            subject=f"Timesheet Submission: {emp_name} ({employee_id}) - Week {target_week_start}",
                            recipients=recipient_emails,
                            body=f"Employee {emp_name} ({employee_id}) has submitted their timesheet for the week of {target_week_start}. Total Hours: {total_hrs}. Please review in HR Tool.",
                            html=f"""
                            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
                                <h2 style="color:#1a73e8;">📋 Timesheet Submission</h2>
                                <table style="width:100%;border-collapse:collapse;">
                                    <tr><td style="padding:8px;font-weight:bold;">Employee</td><td style="padding:8px;">{emp_name} ({employee_id})</td></tr>
                                    <tr style="background:#f8f9fa;"><td style="padding:8px;font-weight:bold;">Week of</td><td style="padding:8px;">{target_week_start}</td></tr>
                                    <tr><td style="padding:8px;font-weight:bold;">Total Hours</td><td style="padding:8px;">{total_hrs}</td></tr>
                                </table>
                                <p style="margin-top:16px;color:#5f6368;">Please review this timesheet in the HR Tool.</p>
                            </div>
                            """,
                            async_send=True
                        )
                        print(f"[MAIL] Timesheet submission notification sent to {len(recipient_emails)} L2/L3 recipients")
        except Exception as mail_err:
            print(f"[WARN] Failed to send timesheet notification: {mail_err}")


@bp_time.route("/time-tracker/timesheet/submissions", methods=["GET"])
def list_timesheet_submissions():
    """List timesheet submissions for admin or employee inbox.

    Query params:
      - employee_id: filter by employee (optional)
      - status: pending|accepted|rejected|all (optional, default all)
    """
    try:
        employee_id = (request.args.get("employee_id") or "").strip()
        status = (request.args.get("status") or "").strip().lower()

        entries = _read_ts_entries()
        out = []
        for rec in entries:
            if employee_id and str(rec.get("employee_id") or "").strip().upper() != employee_id.upper():
                continue
            if status and status != "all":
                s = str(rec.get("status") or "").strip().lower()
                if status == "pending" and s != "pending":
                    continue
                if status == "accepted" and s != "accepted":
                    continue
                if status == "rejected" and s != "rejected":
                    continue
            out.append(rec)

        try:
            out.sort(key=lambda r: r.get("submitted_at") or "", reverse=True)
        except Exception:
            pass

        return jsonify({"success": True, "items": out}), 200
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@bp_time.route("/time-tracker/timesheet/<entry_id>/approve", methods=["POST"])
def approve_timesheet(entry_id):
    """Approve a pending timesheet submission."""
    try:
        body = request.get_json(force=True) or {}
        decided_by = (body.get("decided_by") or "").strip()
        updated, _entries = _update_timesheet_status(entry_id, "Accepted", comment=None, decided_by=decided_by)
        if not updated:
            return jsonify({"success": False, "error": "Entry not found"}), 404
        return jsonify({"success": True, "item": updated}), 200
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500
    finally:
        # Send approval email to employee
        try:
            if updated:
                emp_id = updated.get("employee_id")
                week_start = updated.get("date", "")[:10]
                if emp_id:
                    emp_email = get_employee_email(emp_id)
                    emp_name = get_employee_name(emp_id) or emp_id
                    if emp_email and isinstance(emp_email, str):
                        send_email(
                            subject=f"Timesheet Approved: Week of {week_start}",
                            recipients=[emp_email],
                            body=f"Hello {emp_name} ({emp_id}), your timesheet submission for the week of {week_start} has been approved.",
                            html=f"""
                            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
                                <h2 style="color:#15803d;">✅ Timesheet Approved</h2>
                                <p>Hello <strong>{emp_name}</strong> ({emp_id}),</p>
                                <p>Your timesheet submission for the week of <strong>{week_start}</strong> has been <strong style="color:#15803d;">approved</strong>.</p>
                                <table style="width:100%;border-collapse:collapse;">
                                    <tr style="background:#f8f9fa;"><td style="padding:8px;font-weight:bold;">Approved By</td><td style="padding:8px;">{decided_by or 'Admin'}</td></tr>
                                </table>
                            </div>
                            """,
                            async_send=True
                        )
                        print(f"[MAIL] Timesheet approval notification sent to {emp_email}")
        except Exception as mail_err:
            print(f"[WARN] Failed to send timesheet approval email: {mail_err}")


@bp_time.route("/time-tracker/timesheet/<entry_id>/reject", methods=["POST"])
def reject_timesheet(entry_id):
    """Reject a pending timesheet submission with optional comment."""
    try:
        body = request.get_json(force=True) or {}
        decided_by = (body.get("decided_by") or "").strip()
        comment = body.get("comment")
        updated, _entries = _update_timesheet_status(entry_id, "Rejected", comment=comment, decided_by=decided_by)
        if not updated:
            return jsonify({"success": False, "error": "Entry not found"}), 404
        return jsonify({"success": True, "item": updated}), 200
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500
    finally:
        # Send rejection email to employee
        try:
            if updated:
                emp_id = updated.get("employee_id")
                week_start = updated.get("date", "")[:10]
                if emp_id:
                    emp_email = get_employee_email(emp_id)
                    emp_name = get_employee_name(emp_id) or emp_id
                    if emp_email and isinstance(emp_email, str):
                        send_email(
                            subject=f"Timesheet Rejected: Week of {week_start}",
                            recipients=[emp_email],
                            body=f"Hello {emp_name} ({emp_id}), your timesheet submission for the week of {week_start} has been rejected.{f' Reason: {comment}' if comment else ''}",
                            html=f"""
                            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
                                <h2 style="color:#b91c1c;">❌ Timesheet Rejected</h2>
                                <p>Hello <strong>{emp_name}</strong> ({emp_id}),</p>
                                <p>Your timesheet submission for the week of <strong>{week_start}</strong> has been <strong style="color:#b91c1c;">rejected</strong>.</p>
                                <table style="width:100%;border-collapse:collapse;">
                                    <tr><td style="padding:8px;font-weight:bold;">Rejected By</td><td style="padding:8px;">{decided_by or 'Admin'}</td></tr>
                                    {f'<tr style="background:#f8f9fa;"><td style="padding:8px;font-weight:bold;">Reason</td><td style="padding:8px;">{comment}</td></tr>' if comment else ''}
                                </table>
                            </div>
                            """,
                            async_send=True
                        )
                        print(f"[MAIL] Timesheet rejection notification sent to {emp_email}")
        except Exception as mail_err:
            print(f"[WARN] Failed to send timesheet rejection email: {mail_err}")
