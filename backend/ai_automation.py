# ai_automation.py - Conversational automation for HR tasks
"""
This module handles multi-step conversational flows for automating HR tasks
like creating employees, applying for leave, etc.
"""
import json
import re
import os
from typing import Dict, Any, Optional, List, Tuple
from datetime import datetime, timedelta

# Backend API base URLs
# - BACKEND_API_URL: public URL (used by frontend or external callers)
# - BACKEND_API_INTERNAL_URL: internal URL for server-to-server calls
BACKEND_API_URL = os.getenv("BACKEND_API_URL", "http://localhost:5000").rstrip("/")
BACKEND_API_INTERNAL_URL = os.getenv("BACKEND_API_INTERNAL_URL") or os.getenv("BACKEND_INTERNAL_URL")
if BACKEND_API_INTERNAL_URL:
    BACKEND_API_INTERNAL_URL = BACKEND_API_INTERNAL_URL.rstrip("/")
else:
    # On deployed environments, use the public URL for internal calls
    # This ensures chat automation works on Render
    BACKEND_API_INTERNAL_URL = BACKEND_API_URL


# ================== AI DATAVERSE TABLE ACCESS ==================
# All Dataverse tables the AI has access to for querying and automation
AI_DATAVERSE_TABLES = {
    # Employee Management
    "employees": {
        "entity": "crc6f_table12s",
        "description": "Employee master table with all employee records",
        "key_fields": ["crc6f_employeeid", "crc6f_firstname", "crc6f_lastname", "crc6f_email", "crc6f_department", "crc6f_designation"]
    },
    # Attendance Tracking
    "attendance": {
        "entity": "crc6f_table13s",
        "description": "Daily attendance records with check-in/check-out times",
        "key_fields": ["crc6f_employeeid", "crc6f_date", "crc6f_checkin", "crc6f_checkout", "crc6f_duration"]
    },
    # Leave Management
    "leave_requests": {
        "entity": "crc6f_table14s",
        "description": "Leave requests submitted by employees",
        "key_fields": ["crc6f_employeeid", "crc6f_leavetype", "crc6f_startdate", "crc6f_enddate", "crc6f_status"]
    },
    "leave_balance": {
        "entity": "crc6f_hr_leavemangements",
        "description": "Leave balance/quota for each employee",
        "key_fields": ["crc6f_employeeid", "crc6f_leavetype", "crc6f_balance"]
    },
    # Project Management
    "projects": {
        "entity": "crc6f_hr_projectheaders",
        "description": "Project headers with project details",
        "key_fields": ["crc6f_projectid", "crc6f_projectname", "crc6f_client", "crc6f_manager", "crc6f_projectstatus", "crc6f_startdate", "crc6f_enddate"]
    },
    "project_contributors": {
        "entity": "crc6f_hr_projectcontributorses",
        "description": "Links employees to projects they contribute to",
        "key_fields": ["crc6f_employeeid", "crc6f_projectid", "crc6f_hourlyrate"]
    },
    "project_boards": {
        "entity": "crc6f_hr_projectboardses",
        "description": "Kanban boards for projects",
        "key_fields": ["crc6f_boardid", "crc6f_projectid", "crc6f_boardname"]
    },
    # Task Management
    "tasks": {
        "entity": "crc6f_hr_taskdetailses",
        "description": "Task details assigned to employees within projects",
        "key_fields": ["crc6f_taskid", "crc6f_taskname", "crc6f_assignedto", "crc6f_projectid", "crc6f_taskstatus", "crc6f_duedate"]
    },
    # Asset Management
    "assets": {
        "entity": "crc6f_hr_assetdetailses",
        "description": "Company assets assigned to employees",
        "key_fields": ["crc6f_assetid", "crc6f_assetname", "crc6f_assignedto", "crc6f_assetstatus"]
    },
    # Client Management
    "clients": {
        "entity": "crc6f_hr_clients",
        "description": "Client/customer records",
        "key_fields": ["crc6f_clientid", "crc6f_clientname", "crc6f_contactemail"]
    },
    # Holiday Calendar
    "holidays": {
        "entity": "crc6f_hr_holidayses",
        "description": "Company holiday calendar",
        "key_fields": ["crc6f_holidaydate", "crc6f_holidayname"]
    },
    # Login/Activity Tracking
    "login_activity": {
        "entity": "crc6f_hr_login_detailses",
        "description": "Login events with location and device info",
        "key_fields": ["crc6f_employeeid", "crc6f_eventtype", "crc6f_timestamp", "crc6f_location"]
    },
    # Hierarchy/Reporting
    "hierarchy": {
        "entity": "crc6f_hr_hierarchies",
        "description": "Employee reporting hierarchy (manager relationships)",
        "key_fields": ["crc6f_employeeid", "crc6f_managerid"]
    },
    # Intern Management
    "interns": {
        "entity": "crc6f_hr_interndetailses",
        "description": "Intern training and probation details",
        "key_fields": ["crc6f_internid", "crc6f_employeeid", "crc6f_paidtrainingstart", "crc6f_probationstart"]
    }
}

ROLE_ORDER = {"L1": 1, "L2": 2, "L3": 3}


def _normalize_role(value: Optional[str]) -> str:
    val = (value or "").strip().upper()
    return val if val in ROLE_ORDER else "L1"


def _user_role_level(user_access: Optional[Dict[str, Any]]) -> int:
    if not user_access:
        return ROLE_ORDER["L1"]
    if user_access.get("is_admin") or user_access.get("is_l3"):
        return ROLE_ORDER["L3"]
    if user_access.get("is_l2") or _normalize_role(user_access.get("access_level")) == "L2":
        return ROLE_ORDER["L2"]
    return ROLE_ORDER["L1"]


def _role_name(level: int) -> str:
    for name, lvl in ROLE_ORDER.items():
        if lvl == level:
            return name
    return "L1"


AUTOMATION_REGISTRY: Dict[str, Dict[str, Any]] = {
    "employee_creation": {"min_role": "L3", "handler": "handle_employee_creation_flow", "description": "Create a new employee record", "audit": "employee.create"},
    "employee_edit": {"min_role": "L3", "handler": "handle_employee_edit_flow", "description": "Edit an existing employee", "audit": "employee.edit"},
    "employee_delete": {"min_role": "L3", "handler": "handle_employee_delete_flow", "description": "Delete an employee", "audit": "employee.delete"},
    "leave_application": {"min_role": "L1", "handler": "handle_leave_application_flow", "description": "Apply for leave", "audit": "leave.apply"},
    "asset_creation": {"min_role": "L3", "handler": "handle_asset_creation_flow", "description": "Create an asset record", "audit": "asset.create"},
    "asset_assignment": {"min_role": "L2", "handler": "handle_asset_assignment_flow", "description": "Assign or reassign an asset", "audit": "asset.assign"},
    "task_creation": {"min_role": "L2", "handler": "handle_task_creation_flow", "description": "Create a new project task", "audit": "task.create"},
    "task_start": {"min_role": "L1", "handler": "handle_task_start_flow", "description": "Start a task timer", "audit": "task.start"},
    "task_stop": {"min_role": "L1", "handler": "handle_task_stop_flow", "description": "Stop a task timer", "audit": "task.stop"},
    "check_in": {"min_role": "L1", "handler": "_handle_check_action", "description": "Check in attendance", "audit": "attendance.checkin"},
    "check_out": {"min_role": "L1", "handler": "_handle_check_action", "description": "Check out attendance", "audit": "attendance.checkout"},
    "attendance_submit": {"min_role": "L1", "handler": "handle_attendance_submission_flow", "description": "Submit attendance report for approval", "audit": "attendance.submit"},
    "attendance_review": {"min_role": "L2", "handler": "handle_attendance_review_flow", "description": "Approve or reject attendance submissions", "audit": "attendance.review"},
    "timesheet_submit": {"min_role": "L1", "handler": "handle_timesheet_submission_flow", "description": "Submit a timesheet entry", "audit": "timesheet.submit"},
    "timesheet_review": {"min_role": "L2", "handler": "handle_timesheet_review_flow", "description": "Approve or reject timesheet entries", "audit": "timesheet.review"},
    "project_view": {"min_role": "L1", "handler": "handle_project_view_flow", "description": "View assigned projects", "audit": "project.view"},
    "project_creation": {"min_role": "L2", "handler": "handle_project_creation_flow", "description": "Create project", "audit": "project.create"},
    "client_view": {"min_role": "L1", "handler": "handle_client_view_flow", "description": "View clients", "audit": "client.view"},
    "client_creation": {"min_role": "L2", "handler": "handle_client_creation_flow", "description": "Create client", "audit": "client.create"},
    "inbox_view": {"min_role": "L1", "handler": "handle_inbox_view_flow", "description": "View inbox approvals", "audit": "inbox.view"},
    "inbox_approve": {"min_role": "L2", "handler": "handle_inbox_approve_flow", "description": "Approve an inbox submission", "audit": "inbox.approve"},
    "inbox_reject": {"min_role": "L2", "handler": "handle_inbox_reject_flow", "description": "Reject an inbox submission", "audit": "inbox.reject"},
    "project_delete": {"min_role": "L2", "handler": "handle_project_delete_flow", "description": "Delete a project", "audit": "project.delete"},
    "project_edit": {"min_role": "L2", "handler": "handle_project_edit_flow", "description": "Edit a project", "audit": "project.edit"},
    "client_delete": {"min_role": "L2", "handler": "handle_client_delete_flow", "description": "Delete a client", "audit": "client.delete"},
    "client_edit": {"min_role": "L2", "handler": "handle_client_edit_flow", "description": "Edit a client", "audit": "client.edit"},
    "chat_send_message": {"min_role": "L1", "handler": "handle_chat_send_message_flow", "description": "Send internal chat", "audit": "chat.send"},
    "chat_read_messages": {"min_role": "L1", "handler": "handle_chat_read_messages_flow", "description": "Read messages", "audit": "chat.read"},
    "chat_read_conversation": {"min_role": "L1", "handler": "handle_chat_read_conversation_flow", "description": "Read conversation", "audit": "chat.conversation"},
    "chat_reply": {"min_role": "L1", "handler": "handle_chat_reply_flow", "description": "Reply to chat", "audit": "chat.reply"},
}


def _is_flow_allowed(flow_name: str, user_access: Optional[Dict[str, Any]]) -> Tuple[bool, str]:
    meta = AUTOMATION_REGISTRY.get(flow_name)
    if not meta:
        return True, "L1"
    required = meta.get("min_role", "L1")
    required_level = ROLE_ORDER.get(required, ROLE_ORDER["L1"])
    user_level = _user_role_level(user_access)
    return user_level >= required_level, required

def get_ai_table_entity(table_name: str) -> str:
    """Get the Dataverse entity name for an AI-accessible table."""
    table_info = AI_DATAVERSE_TABLES.get(table_name.lower())
    if table_info:
        return table_info["entity"]
    return None

def list_ai_accessible_tables() -> List[str]:
    """List all tables the AI can access."""
    return list(AI_DATAVERSE_TABLES.keys())


def _log_automation_event(flow_name: str, user_id: Optional[str], result: Dict[str, Any]):
    try:
        meta = AUTOMATION_REGISTRY.get(flow_name) or {}
        audit_tag = meta.get("audit", flow_name)
        status = "success" if result.get("success", True) else "error"
        print(f"[AI_AUTOMATION] flow={flow_name} audit={audit_tag} status={status} user={user_id} info={result.get('message') or result.get('error')}")
    except Exception as err:
        try:
            print(f"[AI_AUTOMATION] log failed for {flow_name}: {err}")
        except Exception:
            pass


def _validate_project_code(value: str) -> bool:
    value = (value or "").strip()
    return len(value) >= 4 and value.upper().startswith("VTAB")


def _normalize_task_priority(value: str) -> str:
    priorities = {"low": "Low", "medium": "Medium", "high": "High"}
    return priorities.get((value or "").strip().lower(), "Medium")


def _normalize_optional_date(value: str) -> str:
    text = (value or "").strip().lower()
    if not text or text == "skip":
        return ""
    if text == "today":
        return datetime.now().strftime("%Y-%m-%d")
    if text == "tomorrow":
        return (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d")
    return value.strip()


def _normalize_optional_text(value: str) -> str:
    text = (value or "").strip()
    return "" if text.lower() == "skip" else text


def _normalize_project_status(value: str) -> str:
    lookup = {
        "active": "Active",
        "in progress": "In Progress",
        "completed": "Completed",
        "on hold": "On Hold",
        "hold": "On Hold",
    }
    raw = (value or "").strip().lower()
    if not raw or raw == "skip":
        return "Active"
    return lookup.get(raw, value.strip())


def _normalize_task_field(key: str, value: str) -> Any:
    if key == "project_code":
        return value.strip().upper()
    if key == "board_name":
        return value.strip()
    if key == "task_name":
        return value.strip()
    if key == "task_description":
        return value.strip() if value.strip().lower() != "skip" else ""
    if key == "task_priority":
        return _normalize_task_priority(value)
    if key == "assigned_to":
        return value.strip().upper()
    if key == "due_date":
        return _normalize_optional_date(value)
    return value.strip()


def _build_task_summary(data: Dict[str, Any]) -> str:
    lines = [
        f"• **Project:** {data.get('project_code')}",
        f"• **Board/List:** {data.get('board_name') or 'Not specified'}",
        f"• **Task Name:** {data.get('task_name')}",
        f"• **Description:** {data.get('task_description') or 'Not provided'}",
        f"• **Priority:** {data.get('task_priority', 'Medium')}",
        f"• **Assigned To:** {data.get('assigned_to') or 'Not set'}",
        f"• **Due Date:** {data.get('due_date') or 'Not set'}",
    ]
    return "\n".join(lines)


def _normalize_project_field(key: str, value: str) -> Any:
    if key == "project_id":
        text = _normalize_optional_text(value)
        return text.upper() if text else ""
    if key == "project_name":
        return value.strip()
    if key == "client_name":
        return value.strip()
    if key == "manager":
        return _normalize_optional_text(value)
    if key in {"start_date", "end_date"}:
        return _normalize_optional_date(value)
    if key == "status":
        return _normalize_project_status(value)
    if key == "description":
        return _normalize_optional_text(value)
    return value.strip()


def _normalize_client_field(key: str, value: str) -> Any:
    if key == "client_id":
        text = _normalize_optional_text(value)
        return text.upper() if text else ""
    if key in {"client_name", "company_name", "email", "phone", "country", "address"}:
        return _normalize_optional_text(value)
    return value.strip()


def _normalize_asset_assignment_field(key: str, value: str) -> Any:
    if key == "asset_id":
        return value.strip().upper()
    if key == "employee_id":
        cleaned = value.strip().upper()
        return cleaned if cleaned else ""
    if key == "employee_name":
        return value.strip()
    if key == "asset_status":
        status_map = {
            "in use": "In Use",
            "not use": "Not Use",
            "available": "Not Use",
            "repair": "Repair",
        }
        return status_map.get(value.strip().lower(), "In Use")
    if key == "assigned_on":
        return _normalize_optional_date(value)
    return value.strip()


# ================== EMPLOYEE CREATION FLOW ==================

EMPLOYEE_FIELDS = [
    {
        "key": "first_name",
        "label": "First Name",
        "prompt": "What is the employee's **first name**?",
        "required": True,
        "validate": lambda x: len(x.strip()) >= 2,
        "error": "First name must be at least 2 characters."
    },
    {
        "key": "last_name",
        "label": "Last Name",
        "prompt": "What is the employee's **last name**?",
        "required": True,
        "validate": lambda x: len(x.strip()) >= 1,
        "error": "Last name is required."
    },
    {
        "key": "email",
        "label": "Email",
        "prompt": "What is the employee's **email address**?",
        "required": True,
        "validate": lambda x: re.match(r'^[\w\.-]+@[\w\.-]+\.\w+$', x.strip()) is not None,
        "error": "Please provide a valid email address (e.g., john@company.com)."
    },
    {
        "key": "designation",
        "label": "Designation/Role",
        "prompt": "What is the employee's **designation/role**? (e.g., Software Engineer, HR Manager, Data Analyst)",
        "required": True,
        "validate": lambda x: len(x.strip()) >= 2,
        "error": "Designation must be at least 2 characters."
    },
    {
        "key": "contact_number",
        "label": "Contact Number",
        "prompt": "What is the employee's **contact/mobile number**? (You can type 'skip' to leave blank)",
        "required": False,
        "validate": lambda x: x.lower() == 'skip' or re.match(r'^[\d\s\-\+\(\)]{7,15}$', x.strip()) is not None,
        "error": "Please provide a valid phone number or type 'skip'."
    },
    {
        "key": "doj",
        "label": "Date of Joining",
        "prompt": "What is the **date of joining**? (Format: YYYY-MM-DD, e.g., 2025-01-15, or type 'today' for today's date)",
        "required": True,
        "validate": lambda x: _validate_date(x),
        "error": "Please provide a valid date in YYYY-MM-DD format or type 'today'."
    },
    {
        "key": "employee_flag",
        "label": "Employee Type",
        "prompt": "Is this an **Employee** or **Intern**? (Type 'employee' or 'intern')",
        "required": True,
        "validate": lambda x: x.strip().lower() in ['employee', 'intern'],
        "error": "Please type either 'employee' or 'intern'."
    }
]


def _validate_date(value: str) -> bool:
    """Validate date input."""
    value = value.strip().lower()
    if value == 'today':
        return True
    try:
        datetime.strptime(value, '%Y-%m-%d')
        return True
    except ValueError:
        return False


def _normalize_date(value: str) -> str:
    """Normalize date input to YYYY-MM-DD format."""
    value = value.strip().lower()
    if value == 'today':
        return datetime.now().strftime('%Y-%m-%d')
    return value.strip()


def _normalize_value(key: str, value: str) -> Any:
    """Normalize field values."""
    value = value.strip()
    
    if key == 'doj':
        return _normalize_date(value)
    elif key == 'contact_number':
        if value.lower() == 'skip':
            return ''
        return value
    elif key == 'employee_flag':
        return value.capitalize()  # 'Employee' or 'Intern'
    elif key == 'email':
        return value.lower()
    
    return value


# ================== LEAVE APPLICATION FLOW ==================

LEAVE_TYPE_OPTIONS = ["Casual Leave", "Sick Leave", "Comp Off"]
COMPENSATION_OPTIONS = ["Paid", "Unpaid"]

LEAVE_FIELDS = [
    {
        "key": "leave_type",
        "label": "Leave Type",
        "prompt": "Which **leave type** would you like to apply for?\n\n**1.** Casual Leave\n**2.** Sick Leave\n**3.** Comp Off\n\n_(Type the number or name)_",
        "required": True,
        "options": LEAVE_TYPE_OPTIONS,
        "validate": lambda x: _validate_leave_option(x, LEAVE_TYPE_OPTIONS),
        "error": "Please select a valid leave type: type **1**, **2**, **3** or the leave name (Casual Leave, Sick Leave, Comp Off)."
    },
    {
        "key": "compensation",
        "label": "Compensation Type",
        "prompt": "Should this leave be **Paid** or **Unpaid**?\n\n**1.** Paid\n**2.** Unpaid\n\n_(Type the number or name)_",
        "required": True,
        "options": COMPENSATION_OPTIONS,
        "validate": lambda x: _validate_leave_option(x, COMPENSATION_OPTIONS),
        "error": "Please select: type **1** for Paid or **2** for Unpaid."
    },
    {
        "key": "start_date",
        "label": "Start Date",
        "prompt": "What is the **start date** of your leave? (Format: YYYY-MM-DD, e.g., 2025-01-15, or type 'today' or 'tomorrow')",
        "required": True,
        "validate": lambda x: _validate_leave_date(x),
        "error": "Please provide a valid date in YYYY-MM-DD format, or type 'today' or 'tomorrow'."
    },
    {
        "key": "end_date",
        "label": "End Date",
        "prompt": "What is the **end date** of your leave? (Format: YYYY-MM-DD, or type 'same' for single day leave)",
        "required": True,
        "validate": lambda x: _validate_leave_date(x, allow_same=True),
        "error": "Please provide a valid date in YYYY-MM-DD format, or type 'same' for single day leave."
    },
    {
        "key": "reason",
        "label": "Reason",
        "prompt": "Please provide a brief **reason** for your leave request:",
        "required": True,
        "validate": lambda x: len(x.strip()) >= 3,
        "error": "Please provide a reason (at least 3 characters)."
    }
]


def _validate_leave_option(value: str, options: List[str]) -> bool:
    """Validate option selection by number or name."""
    value = value.strip().lower()
    # Check if it's a number
    if value.isdigit():
        idx = int(value) - 1
        return 0 <= idx < len(options)
    # Check if it matches an option name
    for opt in options:
        if value == opt.lower() or value in opt.lower():
            return True
    return False


def _normalize_leave_option(value: str, options: List[str]) -> str:
    """Normalize option selection to the canonical option name."""
    value = value.strip().lower()
    # Check if it's a number
    if value.isdigit():
        idx = int(value) - 1
        if 0 <= idx < len(options):
            return options[idx]
    # Check if it matches an option name
    for opt in options:
        if value == opt.lower() or value in opt.lower():
            return opt
    return value


def _validate_leave_date(value: str, allow_same: bool = False) -> bool:
    """Validate leave date input."""
    value = value.strip().lower()
    if value in ['today', 'tomorrow']:
        return True
    if allow_same and value == 'same':
        return True
    try:
        datetime.strptime(value, '%Y-%m-%d')
        return True
    except ValueError:
        return False


def _normalize_leave_date(value: str, reference_date: str = None) -> str:
    """Normalize leave date input to YYYY-MM-DD format."""
    from datetime import timedelta
    value = value.strip().lower()
    if value == 'today':
        return datetime.now().strftime('%Y-%m-%d')
    if value == 'tomorrow':
        return (datetime.now() + timedelta(days=1)).strftime('%Y-%m-%d')
    if value == 'same' and reference_date:
        return reference_date
    return value.strip()


def _normalize_leave_value(key: str, value: str, collected_data: Dict[str, Any] = None) -> Any:
    """Normalize leave field values."""
    value = value.strip()
    
    if key == 'leave_type':
        return _normalize_leave_option(value, LEAVE_TYPE_OPTIONS)
    elif key == 'compensation':
        return _normalize_leave_option(value, COMPENSATION_OPTIONS)
    elif key == 'start_date':
        return _normalize_leave_date(value)
    elif key == 'end_date':
        start_date = collected_data.get('start_date') if collected_data else None
        return _normalize_leave_date(value, start_date)
    
    return value


# ================== ATTENDANCE SUBMISSION HELPERS ==================

def _parse_month_year(value: str) -> Optional[Tuple[int, int]]:
    """Parse free-form month/year input (e.g., 'March 2026', '03/2026')."""
    import calendar
    text = (value or "").strip().lower()
    if not text:
        return None

    # Try formats like March 2026
    months = {m.lower(): idx for idx, m in enumerate(calendar.month_name) if m}
    months.update({m.lower(): idx for idx, m in enumerate(calendar.month_abbr) if m})

    parts = text.replace(',', ' ').replace('/', ' ').replace('-', ' ').split()
    year = None
    month = None
    for part in parts:
        if part.isdigit() and len(part) == 4:
            year = int(part)
        elif part.isdigit() and len(part) <= 2 and 1 <= int(part) <= 12:
            month = int(part)
        elif part in months:
            month = months[part]
    if year and month:
        return (year, month)
    return None


def _format_month_name(year: int, month: int) -> str:
    import calendar
    return f"{calendar.month_name[month]} {year}"


def _submit_attendance_report(employee_id: str, year: int, month: int) -> Dict[str, Any]:
    import requests
    payload = {
        "employee_id": employee_id,
        "year": year,
        "month": month,
    }
    submit_url = f"{BACKEND_API_INTERNAL_URL}/api/attendance/submit"
    try:
        resp = requests.post(submit_url, json=payload, timeout=20)
        data = resp.json()
        if resp.status_code == 200 and data.get("success"):
            return {"success": True, "message": data.get("message"), "marker": data.get("marker")}
        return {"success": False, "error": data.get("error") or "Failed to submit attendance."}
    except Exception as err:
        return {"success": False, "error": str(err)}


def _review_attendance_submission(marker_id: str, action: str, reason: str = "") -> Dict[str, Any]:
    import requests
    endpoint = "approve" if action == "approve" else "reject"
    url = f"{BACKEND_API_INTERNAL_URL}/api/attendance/submissions/{marker_id}/{endpoint}"
    body = {"reason": reason} if endpoint == "reject" else {}
    try:
        resp = requests.post(url, json=body, timeout=20)
        data = resp.json()
        if resp.status_code == 200 and data.get("success"):
            return {"success": True, "message": data.get("message")}
        return {"success": False, "error": data.get("error") or "Review action failed."}
    except Exception as err:
        return {"success": False, "error": str(err)}


# ================== ATTENDANCE SUBMISSION FLOW ==================

ATTENDANCE_SUBMISSION_FIELDS = [
    {
        "key": "period",
        "label": "Month",
        "prompt": "Which month should I submit? (e.g., 'March 2026' or '03/2026')",
        "required": True,
    },
]


def handle_attendance_submission_flow(
    user_message: str,
    state: 'ConversationState',
    user_employee_id: Optional[str] = None,
) -> Tuple[str, 'ConversationState', Optional[Dict[str, Any]]]:
    if state.active_flow != "attendance_submit":
        state.active_flow = "attendance_submit"
        state.current_step = 0
        state.collected_data = {}
        return ATTENDANCE_SUBMISSION_FIELDS[0]["prompt"], state, None

    # Support cancel
    if user_message.strip().lower() in {"cancel", "stop", "quit"}:
        state.reset()
        return "Attendance submission cancelled.", state, None

    if state.current_step == 0:
        parsed = _parse_month_year(user_message)
        if not parsed:
            return "Please specify the month and year (e.g., 'March 2026').", state, None
        year, month = parsed
        state.collected_data["year"] = year
        state.collected_data["month"] = month
        state.current_step = 1

        if not user_employee_id:
            return "I couldn't determine your employee ID. Please specify it.", state, None

        result = _submit_attendance_report(user_employee_id, year, month)
        state.reset()
        if result.get("success"):
            period_name = _format_month_name(year, month)
            return f"✅ Attendance report for **{period_name}** has been submitted for approval!", state, None
        return f"❌ Failed to submit attendance: {result.get('error')}", state, None

    state.reset()
    return "I didn't understand that. Please try again.", state, None


def handle_attendance_review_flow(
    user_message: str,
    state: 'ConversationState',
    reviewer_employee_id: Optional[str] = None,
) -> Tuple[str, 'ConversationState', Optional[Dict[str, Any]]]:
    if state.active_flow != "attendance_review":
        state.active_flow = "attendance_review"
        state.current_step = 0
        state.collected_data = {}
        return "Please provide the marker ID (e.g., SUBMIT-EMP001-2026-03).", state, None

    text = user_message.strip()
    if text.lower() in {"cancel", "stop", "quit"}:
        state.reset()
        return "Attendance review cancelled.", state, None

    if state.current_step == 0:
        if not text.upper().startswith("SUBMIT-"):
            return "Marker ID should look like SUBMIT-EMP001-2026-03.", state, None
        state.collected_data["marker_id"] = text.upper()
        state.current_step = 1
        return "Type 'approve' to approve or 'reject: reason' to reject.", state, None

    if state.current_step == 1:
        marker_id = state.collected_data.get("marker_id")
        if text.lower().startswith("approve"):
            result = _review_attendance_submission(marker_id, "approve")
            state.reset()
            if result.get("success"):
                return f"✅ Attendance submission {marker_id} approved!", state, None
            return f"❌ Approval failed: {result.get('error')}", state, None
        if text.lower().startswith("reject"):
            reason = ""
            if ":" in text:
                reason = text.split(":", 1)[1].strip()
            result = _review_attendance_submission(marker_id, "reject", reason)
            state.reset()
            if result.get("success"):
                return f"✅ Attendance submission {marker_id} rejected.", state, None
            return f"❌ Rejection failed: {result.get('error')}", state, None
        return "Please type 'approve' or 'reject: reason'.", state, None

    state.reset()
    return "I didn't understand that input.", state, None


# ================== TASK CREATION FLOW ==================

TASK_CREATION_FIELDS = [
    {
        "key": "project_code",
        "label": "Project Code",
        "prompt": "Which **project code** should this task belong to? (e.g., VTAB001)",
        "required": True,
        "validate": _validate_project_code,
        "error": "Please provide a valid project code such as VTAB001."
    },
    {
        "key": "board_name",
        "label": "Board/List",
        "prompt": "Which board or column should it appear under? (e.g., Development, QA)",
        "required": True,
        "validate": lambda x: len(x.strip()) >= 2,
        "error": "Board name must be at least 2 characters."
    },
    {
        "key": "task_name",
        "label": "Task Name",
        "prompt": "What's the **task name**?",
        "required": True,
        "validate": lambda x: len(x.strip()) >= 3,
        "error": "Task name must be at least 3 characters."
    },
    {
        "key": "task_description",
        "label": "Description",
        "prompt": "Provide a short description (or type 'skip').",
        "required": False,
        "validate": lambda x: True,
        "error": ""
    },
    {
        "key": "task_priority",
        "label": "Priority",
        "prompt": "Priority? (High / Medium / Low)",
        "required": True,
        "validate": lambda x: x.strip().lower() in {"high", "medium", "low"},
        "error": "Priority must be High, Medium, or Low."
    },
    {
        "key": "assigned_to",
        "label": "Assigned To",
        "prompt": "Employee ID to assign (or type 'skip' to leave unassigned)",
        "required": False,
        "validate": lambda x: True,
        "error": ""
    },
    {
        "key": "due_date",
        "label": "Due Date",
        "prompt": "Due date? (YYYY-MM-DD, 'today', 'tomorrow', or 'skip')",
        "required": False,
        "validate": lambda x: True,
        "error": ""
    },
]


def handle_task_creation_flow(
    user_message: str,
    state: 'ConversationState'
) -> Tuple[str, 'ConversationState', Optional[Dict[str, Any]]]:
    if state.active_flow != "task_creation":
        state.active_flow = "task_creation"
        state.current_step = 0
        state.collected_data = {}
        state.awaiting_confirmation = False
        first_field = TASK_CREATION_FIELDS[0]
        return f"Sure, let's create a new task.\n\n**Step 1 of {len(TASK_CREATION_FIELDS)}:** {first_field['prompt']}", state, None

    if user_message.strip().lower() in {"cancel", "stop", "quit"}:
        state.reset()
        return "Task creation cancelled.", state, None

    if state.awaiting_confirmation:
        answer = user_message.strip().lower()
        if answer in {"yes", "y", "confirm", "ok", "proceed"}:
            data = state.collected_data.copy()
            action = {
                "type": "create_project_task",
                "project_code": data.get("project_code"),
                "payload": {
                    "task_name": data.get("task_name"),
                    "task_description": data.get("task_description"),
                    "task_priority": data.get("task_priority"),
                    "task_status": "New",
                    "assigned_to": data.get("assigned_to"),
                    "due_date": data.get("due_date"),
                    "board_id": data.get("board_name"),
                    "board_name": data.get("board_name"),
                }
            }
            state.reset()
            return "✅ Creating the task now...", state, action
        if answer in {"no", "n"}:
            state.awaiting_confirmation = False
            state.current_step = 0
            state.collected_data = {}
            return f"Okay, let's restart.\n\n**Step 1 of {len(TASK_CREATION_FIELDS)}:** {TASK_CREATION_FIELDS[0]['prompt']}", state, None
        return "Please type 'yes' to confirm or 'no' to start over.", state, None

    current_field = TASK_CREATION_FIELDS[state.current_step]
    if current_field.get("required") and not current_field["validate"](user_message):
        return f"❌ {current_field['error']}\n\n{current_field['prompt']}", state, None

    state.collected_data[current_field["key"]] = _normalize_task_field(current_field["key"], user_message)
    state.current_step += 1

    if state.current_step >= len(TASK_CREATION_FIELDS):
        state.awaiting_confirmation = True
        summary = _build_task_summary(state.collected_data)
        return f"Great! Here's a quick summary:\n\n{summary}\n\nType **'yes'** to create it or **'no'** to restart.", state, None

    next_field = TASK_CREATION_FIELDS[state.current_step]
    return f"✓ Got it.\n\n**Step {state.current_step + 1} of {len(TASK_CREATION_FIELDS)}:** {next_field['prompt']}", state, None


# ================== PROJECT / CLIENT / INBOX FLOWS ==================

PROJECT_CREATION_FIELDS = [
    {
        "key": "project_name",
        "label": "Project Name",
        "prompt": "What is the **project name**?",
        "required": True,
        "validate": lambda x: len((x or "").strip()) >= 3,
        "error": "Project name must be at least 3 characters.",
    },
    {
        "key": "client_name",
        "label": "Client",
        "prompt": "Which **client** is this project for?",
        "required": True,
        "validate": lambda x: len((x or "").strip()) >= 2,
        "error": "Please provide a client name.",
    },
    {
        "key": "status",
        "label": "Status",
        "prompt": "Project status? (Active / In Progress / Completed / On Hold, or type 'skip')",
        "required": False,
        "validate": lambda x: True,
        "error": "",
    },
    {
        "key": "start_date",
        "label": "Start Date",
        "prompt": "Start date? (YYYY-MM-DD, 'today', 'tomorrow', or 'skip')",
        "required": False,
        "validate": lambda x: True,
        "error": "",
    },
    {
        "key": "manager",
        "label": "Manager",
        "prompt": "Manager name or employee ID (or 'skip')",
        "required": False,
        "validate": lambda x: True,
        "error": "",
    },
    {
        "key": "description",
        "label": "Description",
        "prompt": "Short project description (or 'skip')",
        "required": False,
        "validate": lambda x: True,
        "error": "",
    },
]

CLIENT_CREATION_FIELDS = [
    {
        "key": "client_name",
        "label": "Client Name",
        "prompt": "What is the **client contact name**?",
        "required": True,
        "validate": lambda x: len((x or "").strip()) >= 2,
        "error": "Client name is required (min 2 characters).",
    },
    {
        "key": "company_name",
        "label": "Company",
        "prompt": "What is the **company name**?",
        "required": True,
        "validate": lambda x: len((x or "").strip()) >= 2,
        "error": "Company name is required (min 2 characters).",
    },
    {
        "key": "email",
        "label": "Email",
        "prompt": "Client email address (or 'skip')",
        "required": False,
        "validate": lambda x: True,
        "error": "",
    },
    {
        "key": "phone",
        "label": "Phone",
        "prompt": "Phone number (or 'skip')",
        "required": False,
        "validate": lambda x: True,
        "error": "",
    },
    {
        "key": "country",
        "label": "Country",
        "prompt": "Country (or 'skip')",
        "required": False,
        "validate": lambda x: True,
        "error": "",
    },
    {
        "key": "address",
        "label": "Address",
        "prompt": "Address (or 'skip')",
        "required": False,
        "validate": lambda x: True,
        "error": "",
    },
]


def handle_project_view_flow(
    user_message: str,
    state: 'ConversationState',
    user_employee_id: Optional[str] = None,
    user_employee_name: Optional[str] = None,
    user_employee_email: Optional[str] = None,
    user_access: Optional[Dict[str, Any]] = None,
) -> Tuple[str, 'ConversationState', Optional[Dict[str, Any]]]:
    """Fetch projects – L1 sees own, L2+ sees all."""
    state.reset()
    role_level = _user_role_level(user_access)
    scope = "all" if role_level >= ROLE_ORDER["L2"] else "mine"
    action = {
        "type": "fetch_my_projects",
        "scope": scope,
        "employee_id": user_employee_id or "",
        "employee_name": user_employee_name or "",
        "employee_email": user_employee_email or "",
    }
    return "📁 Fetching project details…", state, action


def handle_client_view_flow(
    user_message: str,
    state: 'ConversationState',
    user_access: Optional[Dict[str, Any]] = None,
) -> Tuple[str, 'ConversationState', Optional[Dict[str, Any]]]:
    """Fetch client list."""
    state.reset()
    action = {"type": "fetch_clients"}
    return "🏢 Fetching client list…", state, action


def handle_inbox_view_flow(
    user_message: str,
    state: 'ConversationState',
    user_employee_id: Optional[str] = None,
    user_access: Optional[Dict[str, Any]] = None,
) -> Tuple[str, 'ConversationState', Optional[Dict[str, Any]]]:
    """Fetch inbox approvals – L1 sees own, L2+ sees all pending for review."""
    state.reset()
    text = (user_message or "").strip().lower()
    status_filter = "all"
    if "pending" in text:
        status_filter = "pending"
    elif "completed" in text or "accepted" in text or "approved" in text:
        status_filter = "completed"
    elif "rejected" in text:
        status_filter = "rejected"

    role_level = _user_role_level(user_access)
    action = {
        "type": "fetch_inbox_approvals",
        "status_filter": status_filter,
        "employee_id": user_employee_id or "",
        "role_level": role_level,
    }
    return "📥 Fetching inbox approvals…", state, action


def _extract_employee_id_from_text(text: str) -> Optional[str]:
    """Extract an employee ID like EMP001 or emp012 from text."""
    import re as _re
    m = _re.search(r'\b(emp\d{2,})\b', text, _re.IGNORECASE)
    return m.group(1).upper() if m else None


def handle_inbox_approve_flow(
    user_message: str,
    state: 'ConversationState',
    user_employee_id: Optional[str] = None,
) -> Tuple[str, 'ConversationState', Optional[Dict[str, Any]]]:
    """Approve a pending inbox submission (L2+). Extracts employee ID from message."""
    state.reset()
    emp_id = _extract_employee_id_from_text(user_message)
    if not emp_id:
        return "Please specify which employee's submission to approve, e.g. **approve EMP012**.", state, None
    action = {
        "type": "approve_inbox_submission",
        "target_employee_id": emp_id,
        "decided_by": user_employee_id or "",
    }
    return f"✅ Approving submissions for **{emp_id}**…", state, action


def handle_inbox_reject_flow(
    user_message: str,
    state: 'ConversationState',
    user_employee_id: Optional[str] = None,
) -> Tuple[str, 'ConversationState', Optional[Dict[str, Any]]]:
    """Reject a pending inbox submission (L2+). Extracts employee ID from message."""
    state.reset()
    emp_id = _extract_employee_id_from_text(user_message)
    if not emp_id:
        return "Please specify which employee's submission to reject, e.g. **reject EMP012**.", state, None
    # Try to extract a reason after the employee ID
    import re as _re
    reason = ""
    m = _re.search(r'emp\d{2,}\s*[:\-]?\s*(.*)', user_message, _re.IGNORECASE)
    if m:
        reason = m.group(1).strip()
    action = {
        "type": "reject_inbox_submission",
        "target_employee_id": emp_id,
        "decided_by": user_employee_id or "",
        "reason": reason,
    }
    return f"❌ Rejecting submissions for **{emp_id}**…", state, action


def handle_project_delete_flow(
    user_message: str,
    state: 'ConversationState',
) -> Tuple[str, 'ConversationState', Optional[Dict[str, Any]]]:
    """Multi-step project delete: ask for project name/ID, confirm, then delete."""
    if state.active_flow != "project_delete":
        state.active_flow = "project_delete"
        state.current_step = 0
        state.collected_data = {}
        state.awaiting_confirmation = False
        # Try to extract project name from initial message
        cleaned = user_message.strip()
        for prefix in ["delete project", "remove project", "delete a project", "remove a project"]:
            if cleaned.lower().startswith(prefix):
                remainder = cleaned[len(prefix):].strip()
                if remainder:
                    state.collected_data["project_identifier"] = remainder
                    state.current_step = 1
                    state.awaiting_confirmation = True
                    return (
                        f"⚠️ Are you sure you want to delete the project **{remainder}**?\n\n"
                        "Type **'yes'** to confirm or **'no'** to cancel."
                    ), state, None
        return "Okay, which project do you want to delete? Please provide the **Project ID** or **Project Name**.", state, None

    if user_message.strip().lower() in {"cancel", "stop", "quit"}:
        state.reset()
        return "Project deletion cancelled.", state, None

    if state.current_step == 0:
        state.collected_data["project_identifier"] = user_message.strip()
        state.current_step = 1
        state.awaiting_confirmation = True
        return (
            f"⚠️ Are you sure you want to delete the project **{user_message.strip()}**?\n\n"
            "Type **'yes'** to confirm or **'no'** to cancel."
        ), state, None

    if state.awaiting_confirmation:
        answer = user_message.strip().lower()
        if answer in {"yes", "y", "confirm"}:
            action = {
                "type": "delete_project",
                "project_identifier": state.collected_data.get("project_identifier", ""),
            }
            state.reset()
            return "🗑️ Deleting project…", state, action
        if answer in {"no", "n"}:
            state.reset()
            return "Project deletion cancelled.", state, None
        return "Please type **'yes'** to confirm or **'no'** to cancel.", state, None

    return "I didn't understand that. Please try again.", state, None


def handle_project_edit_flow(
    user_message: str,
    state: 'ConversationState',
) -> Tuple[str, 'ConversationState', Optional[Dict[str, Any]]]:
    """Multi-step project edit: project ID → field → new value → confirm."""
    if state.active_flow != "project_edit":
        state.active_flow = "project_edit"
        state.current_step = 0
        state.collected_data = {}
        state.awaiting_confirmation = False
        return (
            "Which project do you want to edit? Please provide the **Project ID** or **Project Name**."
        ), state, None

    if user_message.strip().lower() in {"cancel", "stop", "quit"}:
        state.reset()
        return "Project edit cancelled.", state, None

    if state.current_step == 0:
        state.collected_data["project_identifier"] = user_message.strip()
        state.current_step = 1
        return (
            f"Editing project **{user_message.strip()}**.\n\n"
            "Which field do you want to change?\n"
            "• **name** – Project name\n"
            "• **client** – Client name\n"
            "• **status** – Project status\n"
            "• **manager** – Manager\n"
            "• **description** – Description\n"
            "• **start_date** – Start date\n"
            "• **end_date** – End date"
        ), state, None

    if state.current_step == 1:
        field_map = {
            "name": "crc6f_projectname",
            "project name": "crc6f_projectname",
            "client": "crc6f_client",
            "status": "crc6f_projectstatus",
            "manager": "crc6f_manager",
            "description": "crc6f_projectdescription",
            "start_date": "crc6f_startdate",
            "start date": "crc6f_startdate",
            "end_date": "crc6f_enddate",
            "end date": "crc6f_enddate",
        }
        chosen = user_message.strip().lower()
        dv_field = field_map.get(chosen)
        if not dv_field:
            return "Invalid field. Please choose one of: name, client, status, manager, description, start_date, end_date.", state, None
        state.collected_data["field_name"] = chosen
        state.collected_data["dv_field"] = dv_field
        state.current_step = 2
        return f"What should the new value for **{chosen}** be?", state, None

    if state.current_step == 2:
        state.collected_data["new_value"] = user_message.strip()
        state.current_step = 3
        state.awaiting_confirmation = True
        return (
            f"Update **{state.collected_data['field_name']}** to **{user_message.strip()}** "
            f"for project **{state.collected_data['project_identifier']}**?\n\n"
            "Type **'yes'** to confirm or **'no'** to cancel."
        ), state, None

    if state.awaiting_confirmation:
        answer = user_message.strip().lower()
        if answer in {"yes", "y", "confirm"}:
            action = {
                "type": "edit_project",
                "project_identifier": state.collected_data.get("project_identifier", ""),
                "field": state.collected_data.get("dv_field", ""),
                "value": state.collected_data.get("new_value", ""),
            }
            state.reset()
            return "✏️ Updating project…", state, action
        if answer in {"no", "n"}:
            state.reset()
            return "Project edit cancelled.", state, None
        return "Please type **'yes'** to confirm or **'no'** to cancel.", state, None

    return "I didn't understand that. Please try again.", state, None


def handle_client_delete_flow(
    user_message: str,
    state: 'ConversationState',
) -> Tuple[str, 'ConversationState', Optional[Dict[str, Any]]]:
    """Multi-step client delete: ask for client name/ID, confirm, then delete."""
    if state.active_flow != "client_delete":
        state.active_flow = "client_delete"
        state.current_step = 0
        state.collected_data = {}
        state.awaiting_confirmation = False
        # Try to extract from initial message
        cleaned = user_message.strip()
        for prefix in ["delete client", "remove client", "delete a client", "remove a client"]:
            if cleaned.lower().startswith(prefix):
                remainder = cleaned[len(prefix):].strip()
                if remainder:
                    state.collected_data["client_identifier"] = remainder
                    state.current_step = 1
                    state.awaiting_confirmation = True
                    return (
                        f"⚠️ Are you sure you want to delete the client **{remainder}**?\n\n"
                        "Type **'yes'** to confirm or **'no'** to cancel."
                    ), state, None
        return "Okay, which client do you want to delete? Please provide the **Client ID** or **Client Name**.", state, None

    if user_message.strip().lower() in {"cancel", "stop", "quit"}:
        state.reset()
        return "Client deletion cancelled.", state, None

    if state.current_step == 0:
        state.collected_data["client_identifier"] = user_message.strip()
        state.current_step = 1
        state.awaiting_confirmation = True
        return (
            f"⚠️ Are you sure you want to delete the client **{user_message.strip()}**?\n\n"
            "Type **'yes'** to confirm or **'no'** to cancel."
        ), state, None

    if state.awaiting_confirmation:
        answer = user_message.strip().lower()
        if answer in {"yes", "y", "confirm"}:
            action = {
                "type": "delete_client",
                "client_identifier": state.collected_data.get("client_identifier", ""),
            }
            state.reset()
            return "🗑️ Deleting client…", state, action
        if answer in {"no", "n"}:
            state.reset()
            return "Client deletion cancelled.", state, None
        return "Please type **'yes'** to confirm or **'no'** to cancel.", state, None

    return "I didn't understand that. Please try again.", state, None


def handle_client_edit_flow(
    user_message: str,
    state: 'ConversationState',
) -> Tuple[str, 'ConversationState', Optional[Dict[str, Any]]]:
    """Multi-step client edit: client ID → field → new value → confirm."""
    if state.active_flow != "client_edit":
        state.active_flow = "client_edit"
        state.current_step = 0
        state.collected_data = {}
        state.awaiting_confirmation = False
        return (
            "Which client do you want to edit? Please provide the **Client ID** or **Client Name**."
        ), state, None

    if user_message.strip().lower() in {"cancel", "stop", "quit"}:
        state.reset()
        return "Client edit cancelled.", state, None

    if state.current_step == 0:
        state.collected_data["client_identifier"] = user_message.strip()
        state.current_step = 1
        return (
            f"Editing client **{user_message.strip()}**.\n\n"
            "Which field do you want to change?\n"
            "• **name** – Client name\n"
            "• **company** – Company name\n"
            "• **email** – Email\n"
            "• **phone** – Phone\n"
            "• **country** – Country\n"
            "• **address** – Address"
        ), state, None

    if state.current_step == 1:
        field_map = {
            "name": "crc6f_clientname",
            "client name": "crc6f_clientname",
            "company": "crc6f_companyname",
            "company name": "crc6f_companyname",
            "email": "crc6f_email",
            "phone": "crc6f_phone",
            "country": "crc6f_country",
            "address": "crc6f_address",
        }
        chosen = user_message.strip().lower()
        dv_field = field_map.get(chosen)
        if not dv_field:
            return "Invalid field. Please choose one of: name, company, email, phone, country, address.", state, None
        state.collected_data["field_name"] = chosen
        state.collected_data["dv_field"] = dv_field
        state.current_step = 2
        return f"What should the new value for **{chosen}** be?", state, None

    if state.current_step == 2:
        state.collected_data["new_value"] = user_message.strip()
        state.current_step = 3
        state.awaiting_confirmation = True
        return (
            f"Update **{state.collected_data['field_name']}** to **{user_message.strip()}** "
            f"for client **{state.collected_data['client_identifier']}**?\n\n"
            "Type **'yes'** to confirm or **'no'** to cancel."
        ), state, None

    if state.awaiting_confirmation:
        answer = user_message.strip().lower()
        if answer in {"yes", "y", "confirm"}:
            action = {
                "type": "edit_client",
                "client_identifier": state.collected_data.get("client_identifier", ""),
                "field": state.collected_data.get("dv_field", ""),
                "value": state.collected_data.get("new_value", ""),
            }
            state.reset()
            return "✏️ Updating client…", state, action
        if answer in {"no", "n"}:
            state.reset()
            return "Client edit cancelled.", state, None
        return "Please type **'yes'** to confirm or **'no'** to cancel.", state, None

    return "I didn't understand that. Please try again.", state, None


def handle_project_creation_flow(
    user_message: str,
    state: 'ConversationState',
) -> Tuple[str, 'ConversationState', Optional[Dict[str, Any]]]:
    """Multi-step project creation (L2+)."""
    if state.active_flow != "project_creation":
        state.active_flow = "project_creation"
        state.current_step = 0
        state.collected_data = {}
        state.awaiting_confirmation = False
        first = PROJECT_CREATION_FIELDS[0]
        return f"Let's create a project.\n\n**Step 1 of {len(PROJECT_CREATION_FIELDS)}:** {first['prompt']}", state, None

    if user_message.strip().lower() in {"cancel", "stop", "quit"}:
        state.reset()
        return "Project creation cancelled.", state, None

    if state.awaiting_confirmation:
        answer = user_message.strip().lower()
        if answer in {"yes", "y", "confirm", "ok", "proceed"}:
            action = {
                "type": "create_project",
                "data": state.collected_data.copy(),
            }
            state.reset()
            return "✅ Creating the project…", state, action
        if answer in {"no", "n"}:
            state.awaiting_confirmation = False
            state.current_step = 0
            state.collected_data = {}
            return f"Okay, let's restart.\n\n**Step 1 of {len(PROJECT_CREATION_FIELDS)}:** {PROJECT_CREATION_FIELDS[0]['prompt']}", state, None
        return "Please type **'yes'** to create or **'no'** to restart.", state, None

    field = PROJECT_CREATION_FIELDS[state.current_step]
    if field.get("required") and not field["validate"](user_message):
        return f"❌ {field['error']}\n\n{field['prompt']}", state, None

    state.collected_data[field["key"]] = _normalize_project_field(field["key"], user_message)
    state.current_step += 1

    if state.current_step >= len(PROJECT_CREATION_FIELDS):
        state.awaiting_confirmation = True
        summary = "\n".join([
            f"• **Project:** {state.collected_data.get('project_name')}",
            f"• **Client:** {state.collected_data.get('client_name')}",
            f"• **Status:** {state.collected_data.get('status') or 'Active'}",
            f"• **Start Date:** {state.collected_data.get('start_date') or 'Not set'}",
            f"• **Manager:** {state.collected_data.get('manager') or 'Not set'}",
            f"• **Description:** {state.collected_data.get('description') or 'Not provided'}",
        ])
        return f"Project summary:\n\n{summary}\n\nType **'yes'** to create or **'no'** to restart.", state, None

    nf = PROJECT_CREATION_FIELDS[state.current_step]
    return f"✓ Noted.\n\n**Step {state.current_step + 1} of {len(PROJECT_CREATION_FIELDS)}:** {nf['prompt']}", state, None


def handle_client_creation_flow(
    user_message: str,
    state: 'ConversationState',
) -> Tuple[str, 'ConversationState', Optional[Dict[str, Any]]]:
    """Multi-step client creation (L2+)."""
    if state.active_flow != "client_creation":
        state.active_flow = "client_creation"
        state.current_step = 0
        state.collected_data = {}
        state.awaiting_confirmation = False
        first = CLIENT_CREATION_FIELDS[0]
        return f"Let's create a client.\n\n**Step 1 of {len(CLIENT_CREATION_FIELDS)}:** {first['prompt']}", state, None

    if user_message.strip().lower() in {"cancel", "stop", "quit"}:
        state.reset()
        return "Client creation cancelled.", state, None

    if state.awaiting_confirmation:
        answer = user_message.strip().lower()
        if answer in {"yes", "y", "confirm", "ok", "proceed"}:
            action = {
                "type": "create_client",
                "data": state.collected_data.copy(),
            }
            state.reset()
            return "✅ Creating the client…", state, action
        if answer in {"no", "n"}:
            state.awaiting_confirmation = False
            state.current_step = 0
            state.collected_data = {}
            return f"Okay, let's restart.\n\n**Step 1 of {len(CLIENT_CREATION_FIELDS)}:** {CLIENT_CREATION_FIELDS[0]['prompt']}", state, None
        return "Please type **'yes'** to create or **'no'** to restart.", state, None

    field = CLIENT_CREATION_FIELDS[state.current_step]
    if field.get("required") and not field["validate"](user_message):
        return f"❌ {field['error']}\n\n{field['prompt']}", state, None

    state.collected_data[field["key"]] = _normalize_client_field(field["key"], user_message)
    state.current_step += 1

    if state.current_step >= len(CLIENT_CREATION_FIELDS):
        state.awaiting_confirmation = True
        summary = "\n".join([
            f"• **Client Name:** {state.collected_data.get('client_name')}",
            f"• **Company:** {state.collected_data.get('company_name')}",
            f"• **Email:** {state.collected_data.get('email') or 'Not provided'}",
            f"• **Phone:** {state.collected_data.get('phone') or 'Not provided'}",
            f"• **Country:** {state.collected_data.get('country') or 'Not provided'}",
            f"• **Address:** {state.collected_data.get('address') or 'Not provided'}",
        ])
        return f"Client summary:\n\n{summary}\n\nType **'yes'** to create or **'no'** to restart.", state, None

    nf = CLIENT_CREATION_FIELDS[state.current_step]
    return f"✓ Noted.\n\n**Step {state.current_step + 1} of {len(CLIENT_CREATION_FIELDS)}:** {nf['prompt']}", state, None


# ================== ASSET ASSIGNMENT FLOW ==================

ASSET_ASSIGNMENT_FIELDS = [
    {
        "key": "asset_id",
        "label": "Asset ID",
        "prompt": "What's the asset ID? (e.g., LP-001)",
        "required": True,
        "validate": lambda x: len(x.strip()) >= 3,
        "error": "Asset ID is required."
    },
    {
        "key": "employee_id",
        "label": "Employee ID",
        "prompt": "Employee ID to assign (EMP###).",
        "required": True,
        "validate": lambda x: len(x.strip()) >= 3,
        "error": "Employee ID is required."
    },
    {
        "key": "employee_name",
        "label": "Employee Name",
        "prompt": "Employee name (optional, or type 'skip').",
        "required": False,
        "validate": lambda x: True,
        "error": ""
    },
    {
        "key": "asset_status",
        "label": "Asset Status",
        "prompt": "Status? (In Use / Not Use / Repair)",
        "required": True,
        "validate": lambda x: x.strip().lower() in {"in use", "not use", "available", "repair"},
        "error": "Status must be In Use, Not Use, or Repair."
    },
    {
        "key": "assigned_on",
        "label": "Assigned On",
        "prompt": "Assignment date (YYYY-MM-DD, 'today', 'tomorrow', or 'skip')",
        "required": False,
        "validate": lambda x: True,
        "error": ""
    },
]


def handle_asset_assignment_flow(
    user_message: str,
    state: 'ConversationState'
) -> Tuple[str, 'ConversationState', Optional[Dict[str, Any]]]:
    if state.active_flow != "asset_assignment":
        state.active_flow = "asset_assignment"
        state.current_step = 0
        state.collected_data = {}
        state.awaiting_confirmation = False
        prompt = ASSET_ASSIGNMENT_FIELDS[0]['prompt']
        return f"Let's update the asset assignment.\n\n**Step 1 of {len(ASSET_ASSIGNMENT_FIELDS)}:** {prompt}", state, None

    if user_message.strip().lower() in {"cancel", "stop", "quit"}:
        state.reset()
        return "Asset assignment cancelled.", state, None

    if state.awaiting_confirmation:
        answer = user_message.strip().lower()
        if answer in {"yes", "y", "confirm", "ok", "proceed"}:
            payload = {
                "crc6f_employeeid": state.collected_data.get("employee_id"),
                "crc6f_assignedto": state.collected_data.get("employee_name") or state.collected_data.get("employee_id"),
                "crc6f_assetstatus": state.collected_data.get("asset_status"),
                "crc6f_assignedon": state.collected_data.get("assigned_on"),
            }
            action = {
                "type": "update_asset_assignment",
                "asset_id": state.collected_data.get("asset_id"),
                "data": payload,
            }
            state.reset()
            return "✅ Updating the asset assignment...", state, action
        if answer in {"no", "n"}:
            state.awaiting_confirmation = False
            state.current_step = 0
            state.collected_data = {}
            return f"Okay, let's restart.\n\n**Step 1 of {len(ASSET_ASSIGNMENT_FIELDS)}:** {ASSET_ASSIGNMENT_FIELDS[0]['prompt']}", state, None
        return "Please respond with 'yes' to confirm or 'no' to restart.", state, None

    current_field = ASSET_ASSIGNMENT_FIELDS[state.current_step]
    if current_field.get("required") and not current_field["validate"](user_message):
        return f"❌ {current_field['error']}\n\n{current_field['prompt']}", state, None

    state.collected_data[current_field["key"]] = _normalize_asset_assignment_field(current_field["key"], user_message)
    state.current_step += 1

    if state.current_step >= len(ASSET_ASSIGNMENT_FIELDS):
        state.awaiting_confirmation = True
        summary = "\n".join([
            f"• **Asset:** {state.collected_data.get('asset_id')}",
            f"• **Assigned To:** {state.collected_data.get('employee_id')}",
            f"• **Status:** {state.collected_data.get('asset_status')}",
            f"• **Assigned On:** {state.collected_data.get('assigned_on') or 'Not set'}",
        ])
        return f"Here's the assignment summary:\n\n{summary}\n\nType **'yes'** to update or **'no'** to restart.", state, None

    next_field = ASSET_ASSIGNMENT_FIELDS[state.current_step]
    return f"✓ Noted.\n\n**Step {state.current_step + 1} of {len(ASSET_ASSIGNMENT_FIELDS)}:** {next_field['prompt']}", state, None


# ================== TIMESHEET SUBMISSION FLOW ==================

TIMESHEET_SUBMISSION_FIELDS = [
    {
        "key": "summary",
        "label": "Summary",
        "prompt": "Please list the tasks and hours you'd like to submit (e.g., '2h on VTAB001 frontend, 1h on research').",
        "required": True,
    }
]


def _parse_timesheet_summary(text: str) -> List[Dict[str, Any]]:
    # Very basic parser: split by commas and look for numbers.
    entries = []
    segments = [seg.strip() for seg in (text or "").split(',') if seg.strip()]
    for seg in segments:
        parts = seg.split(' on ')
        if len(parts) < 2:
            continue
        hours_part = parts[0].strip()
        project_part = parts[1].strip()
        hours = 0.0
        for token in hours_part.split():
            try:
                if token.lower().endswith('h'):
                    hours = float(token[:-1])
                else:
                    hours = float(token)
            except Exception:
                continue
        if hours <= 0:
            continue
        entries.append(
            {
                "project_id": project_part.split()[0],
                "project_name": project_part,
                "task_id": "AI-TASK",
                "task_name": project_part,
                "date": datetime.now().strftime("%Y-%m-%d"),
                "seconds": int(hours * 3600),
                "description": seg,
            }
        )
    return entries


def handle_timesheet_submission_flow(
    user_message: str,
    state: 'ConversationState',
    user_employee_id: Optional[str] = None,
    user_employee_name: Optional[str] = None,
) -> Tuple[str, 'ConversationState', Optional[Dict[str, Any]]]:
    if state.active_flow != "timesheet_submit":
        state.active_flow = "timesheet_submit"
        state.current_step = 0
        state.collected_data = {}
        return TIMESHEET_SUBMISSION_FIELDS[0]["prompt"], state, None

    if user_message.strip().lower() in {"cancel", "stop", "quit"}:
        state.reset()
        return "Timesheet submission cancelled.", state, None

    entries = _parse_timesheet_summary(user_message)
    if not entries:
        return "Please describe the work with hours (e.g., '2h on VTAB001 frontend').", state, None

    import requests
    payload = {
        "employee_id": user_employee_id,
        "employee_name": user_employee_name,
        "entries": entries,
    }
    try:
        resp = requests.post(f"{BACKEND_API_INTERNAL_URL}/time-tracker/timesheet/submit", json=payload, timeout=20)
        data = resp.json()
        state.reset()
        if resp.status_code in (200, 201) and data.get("success"):
            return f"✅ Submitted {len(data.get('items') or [])} timesheet entr{'y' if len(entries)==1 else 'ies'} for review!", state, None
        return f"❌ Failed to submit timesheet: {data.get('error') or resp.status_code}", state, None
    except Exception as err:
        state.reset()
        return f"❌ Error submitting timesheet: {err}", state, None


def handle_timesheet_review_flow(
    user_message: str,
    state: 'ConversationState',
    reviewer_employee_id: Optional[str] = None,
) -> Tuple[str, 'ConversationState', Optional[Dict[str, Any]]]:
    if state.active_flow != "timesheet_review":
        state.active_flow = "timesheet_review"
        state.current_step = 0
        state.collected_data = {}
        return "Provide the timesheet entry ID (e.g., TS-1708601234567).", state, None

    text = user_message.strip()
    if text.lower() in {"cancel", "stop", "quit"}:
        state.reset()
        return "Timesheet review cancelled.", state, None

    if state.current_step == 0:
        state.collected_data["entry_id"] = text
        state.current_step = 1
        return "Type 'approve' to approve or 'reject: reason' to reject.", state, None

    entry_id = state.collected_data.get("entry_id")
    if not entry_id:
        state.reset()
        return "Missing entry ID.", state, None

    import requests
    try:
        if text.lower().startswith("approve"):
            resp = requests.post(
                f"{BACKEND_API_INTERNAL_URL}/time-tracker/timesheet/{entry_id}/approve",
                json={"decided_by": reviewer_employee_id},
                timeout=20,
            )
        elif text.lower().startswith("reject"):
            reason = ""
            if ":" in text:
                reason = text.split(":", 1)[1].strip()
            resp = requests.post(
                f"{BACKEND_API_INTERNAL_URL}/time-tracker/timesheet/{entry_id}/reject",
                json={"decided_by": reviewer_employee_id, "comment": reason},
                timeout=20,
            )
        else:
            return "Please type 'approve' or 'reject: reason'.", state, None

        data = resp.json()
        state.reset()
        if resp.status_code == 200 and data.get("success"):
            return f"✅ Timesheet {entry_id} updated successfully!", state, None
        return f"❌ Timesheet review failed: {data.get('error') or resp.status_code}", state, None
    except Exception as err:
        state.reset()
        return f"❌ Timesheet review error: {err}", state, None


# ================== ASSET CREATION FLOW ==================

ASSET_CATEGORY_OPTIONS = ["Laptop", "Monitor", "Charger", "Keyboard", "Headset", "Accessory"]
ASSET_STATUS_OPTIONS = ["In Use", "Not Use", "Repair"]

ASSET_FIELDS = [
    {
        "key": "asset_name",
        "label": "Asset Name",
        "prompt": "What is the **asset name**? (e.g., Dell Laptop, HP Monitor)",
        "required": True,
        "validate": lambda x: len(x.strip()) >= 2,
        "error": "Asset name must be at least 2 characters."
    },
    {
        "key": "serial_number",
        "label": "Serial Number",
        "prompt": "What is the **serial number**? (e.g., SN123456789)",
        "required": True,
        "validate": lambda x: len(x.strip()) >= 3,
        "error": "Serial number must be at least 3 characters."
    },
    {
        "key": "category",
        "label": "Category",
        "prompt": "Please select the **asset category** from the options below:\n\n📱 **1.** Laptop\n🖥️ **2.** Monitor\n🔌 **3.** Charger\n⌨️ **4.** Keyboard\n🎧 **5.** Headset\n🔧 **6.** Accessory\n\n_(Just type the number 1-6 or the category name)_",
        "required": True,
        "options": ASSET_CATEGORY_OPTIONS,
        "validate": lambda x: _validate_asset_option(x, ASSET_CATEGORY_OPTIONS),
        "error": "❌ Invalid selection. Please type a number **1-6** or the category name (Laptop, Monitor, Charger, Keyboard, Headset, Accessory)."
    },
    {
        "key": "location",
        "label": "Location",
        "prompt": "What is the **location** of this asset? (e.g., Office Building A, Floor 2)",
        "required": True,
        "validate": lambda x: len(x.strip()) >= 2,
        "error": "Location must be at least 2 characters."
    },
    {
        "key": "status",
        "label": "Status",
        "prompt": "Please select the **asset status**:\n\n✅ **1.** In Use\n⏸️ **2.** Not Use\n🔧 **3.** Repair\n\n_(Just type the number 1-3 or the status name)_",
        "required": True,
        "options": ASSET_STATUS_OPTIONS,
        "validate": lambda x: _validate_asset_option(x, ASSET_STATUS_OPTIONS),
        "error": "❌ Invalid selection. Please type **1**, **2**, **3** or the status name (In Use, Not Use, Repair)."
    },
    {
        "key": "assigned_to",
        "label": "Assigned To",
        "prompt": "Who is this asset **assigned to**? (Employee name, or type 'skip' if not assigned)",
        "required": False,
        "validate": lambda x: True,  # Optional field
        "error": ""
    },
    {
        "key": "employee_id",
        "label": "Employee ID",
        "prompt": "What is the **Employee ID** of the person this is assigned to? (e.g., EMP001, or type 'skip' if not assigned)",
        "required": False,
        "validate": lambda x: True,  # Optional field
        "error": ""
    },
    {
        "key": "assigned_on",
        "label": "Assigned On",
        "prompt": "When was this asset **assigned**? (Format: YYYY-MM-DD, or type 'today' or 'skip')",
        "required": False,
        "validate": lambda x: _validate_asset_date(x),
        "error": "Please provide a valid date in YYYY-MM-DD format, or type 'today' or 'skip'."
    }
]


def _validate_asset_option(value: str, options: List[str]) -> bool:
    """Validate option selection by number or name for assets."""
    value = value.strip().lower()
    # Check if it's a number
    if value.isdigit():
        idx = int(value) - 1
        return 0 <= idx < len(options)
    # Check if it matches an option name
    for opt in options:
        if value == opt.lower() or value in opt.lower():
            return True
    return False


def _normalize_asset_option(value: str, options: List[str]) -> str:
    """Normalize option selection to the canonical option name for assets."""
    value = value.strip().lower()
    # Check if it's a number
    if value.isdigit():
        idx = int(value) - 1
        if 0 <= idx < len(options):
            return options[idx]
    # Check if it matches an option name
    for opt in options:
        if value == opt.lower() or value in opt.lower():
            return opt
    return value


def _validate_asset_date(value: str) -> bool:
    """Validate asset date input."""
    value = value.strip().lower()
    if value in ['today', 'skip', '']:
        return True
    try:
        datetime.strptime(value, '%Y-%m-%d')
        return True
    except ValueError:
        return False


def _normalize_asset_date(value: str) -> str:
    """Normalize asset date input to YYYY-MM-DD format."""
    value = value.strip().lower()
    if value == 'today':
        return datetime.now().strftime('%Y-%m-%d')
    if value in ['skip', '']:
        return ''
    return value.strip()


def _normalize_asset_value(key: str, value: str) -> Any:
    """Normalize asset field values."""
    value = value.strip()
    
    if key == 'category':
        return _normalize_asset_option(value, ASSET_CATEGORY_OPTIONS)
    elif key == 'status':
        return _normalize_asset_option(value, ASSET_STATUS_OPTIONS)
    elif key == 'assigned_on':
        return _normalize_asset_date(value)
    elif key in ['assigned_to', 'employee_id']:
        if value.lower() == 'skip':
            return ''
        return value
    
    return value


# ================== INTENT DETECTION ==================

AUTOMATION_INTENTS = {
    "create_employee": {
        "keywords": [
            "create employee", "add employee", "new employee", "hire employee",
            "create an employee", "add an employee", "add new employee",
            "onboard employee", "register employee", "employee creation",
            "create a new employee", "add a new employee"
        ],
        "flow": "employee_creation",
        "description": "Create a new employee record"
    },
    "create_asset": {
        "keywords": [
            "add new asset", "create asset", "new asset", "add asset",
            "create an asset", "add an asset", "register asset",
            "asset creation", "create a new asset", "add a new asset",
            "ass new asset"  # Handle typo from user request
        ],
        "flow": "asset_creation",
        "description": "Create a new asset record"
    },
    "edit_employee": {
        "keywords": [
            "edit employee", "update employee", "modify employee", "change employee",
            "edit an employee", "update an employee", "edit employee record",
            "update employee record", "modify employee record", "change employee details",
            "edit employee details", "update employee details"
        ],
        "flow": "employee_edit",
        "description": "Edit/update an existing employee record"
    },
    "delete_employee": {
        "keywords": [
            "delete employee", "remove employee", "delete an employee", "remove an employee",
            "delete employee record", "remove employee record", "terminate employee",
            "delete staff", "remove staff"
        ],
        "flow": "employee_delete",
        "description": "Delete an existing employee record"
    },
    "create_task_record": {
        "keywords": [
            "create task", "create a task", "add new task", "log a task", "open task", "new project task",
            "create project task", "add task card"
        ],
        "flow": "task_creation",
        "description": "Create a project task"
    },
    "apply_leave": {
        "keywords": [
            "apply leave", "apply for leave", "request leave", "take leave",
            "apply leave for me", "i want to apply leave", "i need leave",
            "leave application", "apply for a leave", "submit leave",
            "book leave", "request time off", "apply for time off",
            "i want leave", "need to take leave", "want to take leave"
        ],
        "flow": "leave_application",
        "description": "Apply for leave"
    },
    "check_in": {
        "keywords": [
            "check in", "check-in", "checkin", "start my day",
            "punch in", "clock in", "check in for me", "start work"
        ],
        "flow": "check_in",
        "description": "Check in / start attendance timer"
    },
    "check_out": {
        "keywords": [
            "check out", "checkout", "check-out", "punch out",
            "clock out", "end my day", "check out for me",
            "stop work", "end shift"
        ],
        "flow": "check_out",
        "description": "Check out / stop attendance timer"
    },
    "start_task": {
        "keywords": [
            "start my task", "start task", "start a task", "begin task",
            "start working on task", "show my tasks", "list my tasks",
            "my tasks", "work on task", "resume task", "play task"
        ],
        "flow": "task_start",
        "description": "Start/resume a task timer"
    },
    "stop_task": {
        "keywords": [
            "stop my task", "stop task", "pause task", "end task",
            "stop working on task", "pause my task", "stop the task",
            "stop current task", "pause current task"
        ],
        "flow": "task_stop",
        "description": "Stop/pause the currently running task timer"
    },
    "assign_asset": {
        "keywords": [
            "assign asset", "reassign asset", "update asset owner", "move laptop",
            "transfer asset", "asset assignment"
        ],
        "flow": "asset_assignment",
        "description": "Assign an asset to an employee"
    },
    "submit_attendance": {
        "keywords": [
            "submit attendance", "submit my attendance", "attendance submission",
            "send attendance for approval", "submit attendance report"
        ],
        "flow": "attendance_submit",
        "description": "Submit attendance for review"
    },
    "review_attendance": {
        "keywords": [
            "review attendance", "approve attendance", "reject attendance",
            "attendance approvals", "attendance review"
        ],
        "flow": "attendance_review",
        "description": "Review attendance submissions"
    },
    "submit_timesheet": {
        "keywords": [
            "submit timesheet", "submit my timesheet", "timesheet submission",
            "log timesheet", "add timesheet entry"
        ],
        "flow": "timesheet_submit",
        "description": "Submit timesheet entries"
    },
    "review_timesheet": {
        "keywords": [
            "review timesheet", "approve timesheet", "reject timesheet",
            "timesheet approvals", "timesheet review"
        ],
        "flow": "timesheet_review",
        "description": "Review submitted timesheets"
    },
    # Chat Automation
    "send_message": {
        "keywords": [
            "send message to", "message to", "text to", "dm to",
            "send a message", "message", "ping", "write to",
            "tell", "ask"
        ],
        "flow": "chat_send_message",
        "description": "Send a message to another employee"
    },
    "read_messages": {
        "keywords": [
            "read messages", "show messages", "check messages",
            "unread messages", "new messages", "any messages",
            "my messages", "read my messages"
        ],
        "flow": "chat_read_messages",
        "description": "Read unread messages"
    },
    "read_conversation": {
        "keywords": [
            "read conversation with", "read chat with", "messages from",
            "what did", "conversation with", "chat with"
        ],
        "flow": "chat_read_conversation",
        "description": "Read conversation with a specific person"
    },
    "reply_message": {
        "keywords": [
            "reply to", "respond to", "reply"
        ],
        "flow": "chat_reply",
        "description": "Reply to a message"
    },
    # Project / Client / Inbox Automation
    "view_projects": {
        "keywords": [
            "my projects", "show my projects", "list my projects", "view projects",
            "show projects", "list projects", "project list", "assigned projects",
            "what projects", "which projects"
        ],
        "flow": "project_view",
        "description": "View projects"
    },
    "create_project": {
        "keywords": [
            "create project", "create a project", "new project", "add project",
            "add a project", "add new project", "project creation",
            "create a new project"
        ],
        "flow": "project_creation",
        "description": "Create a new project"
    },
    "view_clients": {
        "keywords": [
            "my clients", "show clients", "list clients", "view clients",
            "client list", "show my clients", "all clients", "who are our clients"
        ],
        "flow": "client_view",
        "description": "View clients"
    },
    "create_client": {
        "keywords": [
            "create client", "create a client", "new client", "add client",
            "add a client", "add new client", "client creation",
            "create a new client"
        ],
        "flow": "client_creation",
        "description": "Create a new client"
    },
    "view_inbox": {
        "keywords": [
            "my inbox", "show inbox", "inbox approvals", "pending approvals",
            "my approvals", "show approvals", "view inbox", "view approvals",
            "completed approvals", "inbox", "approval status",
            "show my approvals", "check approvals", "approval requests"
        ],
        "flow": "inbox_view",
        "description": "View inbox approvals"
    },
    "approve_inbox": {
        "keywords": [
            "approve emp", "approve submission", "accept submission",
            "approve timesheet", "approve attendance", "accept attendance",
            "accept timesheet"
        ],
        "flow": "inbox_approve",
        "description": "Approve an inbox submission"
    },
    "reject_inbox": {
        "keywords": [
            "reject emp", "reject submission", "deny submission",
            "reject timesheet", "reject attendance", "deny attendance",
            "deny timesheet"
        ],
        "flow": "inbox_reject",
        "description": "Reject an inbox submission"
    },
    "delete_project": {
        "keywords": [
            "delete project", "remove project", "delete a project",
            "remove a project"
        ],
        "flow": "project_delete",
        "description": "Delete a project"
    },
    "edit_project": {
        "keywords": [
            "edit project", "update project", "modify project",
            "change project", "edit a project", "update a project"
        ],
        "flow": "project_edit",
        "description": "Edit a project"
    },
    "delete_client": {
        "keywords": [
            "delete client", "remove client", "delete a client",
            "remove a client"
        ],
        "flow": "client_delete",
        "description": "Delete a client"
    },
    "edit_client": {
        "keywords": [
            "edit client", "update client", "modify client",
            "change client", "edit a client", "update a client"
        ],
        "flow": "client_edit",
        "description": "Edit a client"
    },
}


def _keyword_matches_message(message_lower: str, keyword: str) -> bool:
    """Match keyword safely: whole-word match for single terms, substring for phrases."""
    key = (keyword or "").strip().lower()
    if not key:
        return False

    normalized_msg = re.sub(r"\s+", " ", message_lower)
    normalized_key = re.sub(r"\s+", " ", key)

    # Multi-word phrases rely on normalized substring matching.
    if " " in normalized_key:
        return normalized_key in normalized_msg

    # Single tokens should match whole words only (prevents 'ask' matching 'task').
    return re.search(rf"\b{re.escape(normalized_key)}\b", normalized_msg) is not None


def detect_automation_intent(message: str) -> Optional[Dict[str, Any]]:
    """
    Detect if the user message triggers an automation flow.
    Returns the intent config if matched, None otherwise.
    """
    message_lower = message.lower().strip()
    
    for intent_key, intent_config in AUTOMATION_INTENTS.items():
        for keyword in intent_config["keywords"]:
            if _keyword_matches_message(message_lower, keyword):
                return {
                    "intent": intent_key,
                    "flow": intent_config["flow"],
                    "description": intent_config["description"]
                }
    
    return None


# ================== CONVERSATION STATE MANAGEMENT ==================

class ConversationState:
    """Manages the state of a multi-step conversation flow."""
    
    def __init__(self):
        self.active_flow: Optional[str] = None
        self.current_step: int = 0
        self.collected_data: Dict[str, Any] = {}
        self.awaiting_confirmation: bool = False
        self.edit_target: Optional[Dict[str, Any]] = None  # For edit flows: stores the employee being edited
        self.edit_field: Optional[str] = None  # Current field being edited
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "active_flow": self.active_flow,
            "current_step": self.current_step,
            "collected_data": self.collected_data,
            "awaiting_confirmation": self.awaiting_confirmation,
            "edit_target": self.edit_target,
            "edit_field": self.edit_field
        }
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'ConversationState':
        state = cls()
        state.active_flow = data.get("active_flow")
        state.current_step = data.get("current_step", 0)
        state.collected_data = data.get("collected_data", {})
        state.awaiting_confirmation = data.get("awaiting_confirmation", False)
        state.edit_target = data.get("edit_target")
        state.edit_field = data.get("edit_field")
        return state
    
    def reset(self):
        self.active_flow = None
        self.current_step = 0
        self.collected_data = {}
        self.awaiting_confirmation = False
        self.edit_target = None
        self.edit_field = None


# ================== EDITABLE FIELDS FOR UPDATE ==================

EDITABLE_FIELDS = [
    {"key": "first_name", "label": "First Name", "number": "1"},
    {"key": "last_name", "label": "Last Name", "number": "2"},
    {"key": "email", "label": "Email", "number": "3"},
    {"key": "designation", "label": "Designation", "number": "4"},
    {"key": "contact_number", "label": "Contact Number", "number": "5"},
    {"key": "doj", "label": "Date of Joining", "number": "6"},
    {"key": "employee_flag", "label": "Employee Type", "number": "7"},
]


# ================== FLOW HANDLERS ==================

def handle_employee_creation_flow(
    user_message: str,
    state: ConversationState
) -> Tuple[str, ConversationState, Optional[Dict[str, Any]]]:
    """
    Handle the employee creation conversation flow.
    
    Returns:
        - response: The AI response message
        - state: Updated conversation state
        - action: Optional action to execute (e.g., {"type": "create_employee", "data": {...}})
    """
    
    # Starting the flow
    if state.active_flow != "employee_creation":
        state.active_flow = "employee_creation"
        state.current_step = 0
        state.collected_data = {}
        state.awaiting_confirmation = False
        
        # Return the first question
        first_field = EMPLOYEE_FIELDS[0]
        response = f"""Great! I'll help you create a new employee record. 📝

I'll need to collect some information. You can type **'cancel'** at any time to stop.

**Step 1 of {len(EMPLOYEE_FIELDS)}:** {first_field['prompt']}"""
        return response, state, None
    
    # Check for cancel
    if user_message.strip().lower() in ['cancel', 'stop', 'quit', 'exit', 'nevermind']:
        state.reset()
        return "No problem! Employee creation cancelled. Let me know if you need anything else. 👋", state, None
    
    # Handle confirmation step
    if state.awaiting_confirmation:
        answer = user_message.strip().lower()
        if answer in ['yes', 'y', 'confirm', 'create', 'ok', 'proceed']:
            # Execute the creation
            action = {
                "type": "create_employee",
                "data": state.collected_data.copy()
            }
            state.reset()
            return "✅ Creating the employee record now...", state, action
        elif answer in ['no', 'n', 'cancel', 'edit', 'change']:
            state.awaiting_confirmation = False
            state.current_step = 0
            state.collected_data = {}
            return f"""Okay, let's start over.

**Step 1 of {len(EMPLOYEE_FIELDS)}:** {EMPLOYEE_FIELDS[0]['prompt']}""", state, None
        else:
            return "Please type **'yes'** to confirm and create the employee, or **'no'** to start over.", state, None
    
    # Collecting field data
    current_field = EMPLOYEE_FIELDS[state.current_step]
    
    # Validate the input
    if not current_field['validate'](user_message):
        return f"❌ {current_field['error']}\n\n{current_field['prompt']}", state, None
    
    # Store the normalized value
    normalized_value = _normalize_value(current_field['key'], user_message)
    state.collected_data[current_field['key']] = normalized_value
    
    # Move to next step
    state.current_step += 1
    
    # Check if we've collected all fields
    if state.current_step >= len(EMPLOYEE_FIELDS):
        # Show summary and ask for confirmation
        state.awaiting_confirmation = True
        
        summary = _build_employee_summary(state.collected_data)
        response = f"""Perfect! Here's the employee information I've collected:

{summary}

**Does this look correct?** Type **'yes'** to create the employee or **'no'** to start over."""
        return response, state, None
    
    # Ask for the next field
    next_field = EMPLOYEE_FIELDS[state.current_step]
    response = f"✓ Got it!\n\n**Step {state.current_step + 1} of {len(EMPLOYEE_FIELDS)}:** {next_field['prompt']}"
    return response, state, None


def _build_employee_summary(data: Dict[str, Any]) -> str:
    """Build a formatted summary of collected employee data."""
    lines = []
    
    field_labels = {f['key']: f['label'] for f in EMPLOYEE_FIELDS}
    
    for key, value in data.items():
        label = field_labels.get(key, key.replace('_', ' ').title())
        display_value = value if value else "(not provided)"
        lines.append(f"• **{label}:** {display_value}")
    
    return "\n".join(lines)


# ================== ASSET CREATION FLOW HANDLER ==================

def handle_asset_creation_flow(
    user_message: str,
    state: ConversationState
) -> Tuple[str, ConversationState, Optional[Dict[str, Any]]]:
    """
    Handle the asset creation conversation flow.
    
    Returns:
        - response: The AI response message
        - state: Updated conversation state
        - action: Optional action to execute (e.g., {"type": "create_asset", "data": {...}})
    """
    
    # Starting the flow
    if state.active_flow != "asset_creation":
        state.active_flow = "asset_creation"
        state.current_step = 0
        state.collected_data = {}
        state.awaiting_confirmation = False
        
        # Return the first question
        first_field = ASSET_FIELDS[0]
        response = f"""Great! I'll help you create a new asset record. 📦

I'll need to collect some information. You can type **'cancel'** at any time to stop.

**Step 1 of {len(ASSET_FIELDS)}:** {first_field['prompt']}"""
        return response, state, None
    
    # Check for cancel
    if user_message.strip().lower() in ['cancel', 'stop', 'quit', 'exit', 'nevermind']:
        state.reset()
        return "No problem! Asset creation cancelled. Let me know if you need anything else. 👋", state, None
    
    # Handle confirmation step
    if state.awaiting_confirmation:
        answer = user_message.strip().lower()
        if answer in ['yes', 'y', 'confirm', 'create', 'ok', 'proceed']:
            # Execute the creation
            action = {
                "type": "create_asset",
                "data": state.collected_data.copy()
            }
            state.reset()
            return "✅ Creating the asset record now...", state, action
        elif answer in ['no', 'n', 'cancel', 'edit', 'change']:
            state.awaiting_confirmation = False
            state.current_step = 0
            state.collected_data = {}
            return f"""Okay, let's start over.

**Step 1 of {len(ASSET_FIELDS)}:** {ASSET_FIELDS[0]['prompt']}""", state, None
        else:
            return "Please type **'yes'** to confirm and create the asset, or **'no'** to start over.", state, None
    
    # Collecting field data
    current_field = ASSET_FIELDS[state.current_step]
    
    # Validate the input
    if not current_field['validate'](user_message):
        return f"❌ {current_field['error']}\n\n{current_field['prompt']}", state, None
    
    # Store the normalized value
    normalized_value = _normalize_asset_value(current_field['key'], user_message)
    state.collected_data[current_field['key']] = normalized_value
    
    # Move to next step
    state.current_step += 1
    
    # Check if we've collected all fields
    if state.current_step >= len(ASSET_FIELDS):
        # Show summary and ask for confirmation
        state.awaiting_confirmation = True
        
        summary = _build_asset_summary(state.collected_data)
        response = f"""Perfect! Here's the asset information I've collected:

{summary}

**Does this look correct?** Type **'yes'** to create the asset or **'no'** to start over."""
        return response, state, None
    
    # Ask for the next field
    next_field = ASSET_FIELDS[state.current_step]
    response = f"✓ Got it!\n\n**Step {state.current_step + 1} of {len(ASSET_FIELDS)}:** {next_field['prompt']}"
    return response, state, None


def _build_asset_summary(data: Dict[str, Any]) -> str:
    """Build a formatted summary of collected asset data."""
    lines = []
    
    field_labels = {f['key']: f['label'] for f in ASSET_FIELDS}
    
    for key, value in data.items():
        label = field_labels.get(key, key.replace('_', ' ').title())
        display_value = value if value else "(not provided)"
        lines.append(f"• **{label}:** {display_value}")
    
    return "\n".join(lines)


# ================== EMPLOYEE EDIT FLOW ==================

def handle_employee_edit_flow(
    user_message: str,
    state: ConversationState
) -> Tuple[str, ConversationState, Optional[Dict[str, Any]]]:
    """
    Handle the employee edit/update conversation flow.
    
    Flow:
    1. Ask for employee ID or email to find the employee
    2. Show current details and ask which field to edit
    3. Get new value for the field
    4. Confirm and update
    """
    
    # Starting the flow - ask for employee identifier
    if state.active_flow != "employee_edit":
        state.active_flow = "employee_edit"
        state.current_step = 0
        state.collected_data = {}
        state.awaiting_confirmation = False
        state.edit_target = None
        state.edit_field = None
        
        response = """I'll help you edit an employee record. 📝

Please provide the **Employee ID** or **Email** of the employee you want to edit.

(Type **'cancel'** at any time to stop.)"""
        return response, state, None
    
    # Check for cancel
    if user_message.strip().lower() in ['cancel', 'stop', 'quit', 'exit', 'nevermind']:
        state.reset()
        return "No problem! Edit cancelled. Let me know if you need anything else. 👋", state, None
    
    # Handle confirmation FIRST (before other checks)
    if state.awaiting_confirmation:
        answer = user_message.strip().lower()
        if answer in ['yes', 'y', 'confirm', 'save', 'ok']:
            # Execute the update
            action = {
                "type": "update_employee",
                "employee_id": state.edit_target.get("employee_id"),
                "record_guid": state.edit_target.get("record_guid"),
                "updates": state.collected_data.get("updates", {})
            }
            state.reset()
            return "✅ Updating employee record...", state, action
        elif answer in ['no', 'n', 'cancel']:
            state.reset()
            return "Update cancelled. Let me know if you need anything else! 👋", state, None
        else:
            return "Please type **'yes'** to confirm the update, or **'no'** to cancel.", state, None
    
    # Step 0: Looking up the employee
    if state.current_step == 0 and state.edit_target is None:
        # User provided employee ID or email - we need to look them up
        # Store the search term and signal that we need to look up
        search_term = user_message.strip()
        state.collected_data["search_term"] = search_term
        state.current_step = 1
        
        # Return action to search for employee
        action = {
            "type": "search_employee",
            "search_term": search_term
        }
        return "🔍 Searching for employee...", state, action
    
    # Step 1: Employee found, show details and ask which field to edit
    if state.current_step == 1 and state.edit_target:
        # Check if user selected a field number or 'done'
        user_input = user_message.strip().lower()
        
        if user_input in ['done', 'finish', 'save', 'update', 'confirm']:
            if not state.collected_data.get("updates"):
                return "You haven't made any changes yet. Please select a field number to edit, or type **'cancel'** to exit.", state, None
            
            # Show summary and confirm
            state.awaiting_confirmation = True
            updates_summary = _build_updates_summary(state.collected_data.get("updates", {}))
            response = f"""Here are the changes you want to make:

{updates_summary}

**Confirm update?** Type **'yes'** to save changes or **'no'** to cancel."""
            return response, state, None
        
        # Check if it's a field number
        field_map = {f["number"]: f for f in EDITABLE_FIELDS}
        if user_input in field_map:
            field = field_map[user_input]
            state.edit_field = field["key"]
            state.current_step = 2
            
            current_value = state.edit_target.get(field["key"], "(not set)")
            response = f"""Editing **{field['label']}**

Current value: **{current_value}**

Enter the new value (or type **'skip'** to keep current):"""
            return response, state, None
        
        # Invalid input - show menu again
        return _build_edit_menu(state.edit_target), state, None
    
    # Step 2: Getting new value for a field
    if state.current_step == 2 and state.edit_field:
        user_input = user_message.strip()
        
        if user_input.lower() != 'skip':
            # Validate the input based on field type
            field_config = next((f for f in EMPLOYEE_FIELDS if f["key"] == state.edit_field), None)
            
            if field_config and not field_config.get("validate", lambda x: True)(user_input):
                return f"❌ {field_config.get('error', 'Invalid input')}. Please try again:", state, None
            
            # Store the update
            if "updates" not in state.collected_data:
                state.collected_data["updates"] = {}
            
            normalized = _normalize_value(state.edit_field, user_input)
            state.collected_data["updates"][state.edit_field] = normalized
        
        # Go back to field selection
        state.current_step = 1
        state.edit_field = None
        
        response = f"✓ Got it!\n\n{_build_edit_menu(state.edit_target, state.collected_data.get('updates', {}))}"
        return response, state, None
    
    # Fallback
    return "I didn't understand that. Please try again or type **'cancel'** to exit.", state, None


def _build_edit_menu(employee: Dict[str, Any], pending_updates: Dict[str, Any] = None) -> str:
    """Build the field selection menu for editing."""
    pending_updates = pending_updates or {}
    
    name = f"{employee.get('first_name', '')} {employee.get('last_name', '')}".strip()
    emp_id = employee.get('employee_id', 'Unknown')
    
    lines = [
        f"**Employee:** {name} ({emp_id})",
        "",
        "Select a field to edit (enter the number):",
        ""
    ]
    
    for field in EDITABLE_FIELDS:
        current = employee.get(field["key"], "(not set)")
        pending = pending_updates.get(field["key"])
        
        if pending:
            lines.append(f"**{field['number']}.** {field['label']}: ~~{current}~~ → **{pending}** ✏️")
        else:
            lines.append(f"**{field['number']}.** {field['label']}: {current}")
    
    lines.append("")
    lines.append("Type **'done'** when finished to save all changes.")
    
    return "\n".join(lines)


def _build_updates_summary(updates: Dict[str, Any]) -> str:
    """Build a summary of pending updates."""
    lines = []
    field_labels = {f["key"]: f["label"] for f in EDITABLE_FIELDS}
    
    for key, value in updates.items():
        label = field_labels.get(key, key.replace('_', ' ').title())
        lines.append(f"• **{label}:** {value}")
    
    return "\n".join(lines)


# ================== EMPLOYEE DELETE FLOW ==================

def handle_employee_delete_flow(
    user_message: str,
    state: ConversationState
) -> Tuple[str, ConversationState, Optional[Dict[str, Any]]]:
    """
    Handle the employee delete conversation flow.
    
    Flow:
    1. Ask for employee ID or email to find the employee
    2. Show employee details and ask for strong confirmation
    3. Delete the employee
    """
    
    # Starting the flow - ask for employee identifier
    if state.active_flow != "employee_delete":
        state.active_flow = "employee_delete"
        state.current_step = 0
        state.collected_data = {}
        state.awaiting_confirmation = False
        state.edit_target = None
        
        response = """⚠️ I'll help you delete an employee record. **This action cannot be undone.**

Please provide the **Employee ID** or **Email** of the employee you want to delete.

(Type **'cancel'** at any time to stop.)"""
        return response, state, None
    
    # Check for cancel
    if user_message.strip().lower() in ['cancel', 'stop', 'quit', 'exit', 'nevermind']:
        state.reset()
        return "No problem! Delete cancelled. Let me know if you need anything else. 👋", state, None
    
    # Handle confirmation FIRST (before other checks)
    if state.awaiting_confirmation:
        answer = user_message.strip()
        expected_confirm = state.collected_data.get("confirm_text", "")
        
        if answer == expected_confirm:
            # Execute the delete
            action = {
                "type": "delete_employee",
                "employee_id": state.edit_target.get("employee_id"),
                "record_guid": state.edit_target.get("record_guid"),
                "confirmed": True,
            }
            state.reset()
            return "🗑️ Deleting employee record...", state, action
        elif answer.lower() in ['no', 'n', 'cancel']:
            state.reset()
            return "Delete cancelled. The employee record was NOT deleted. 👋", state, None
        else:
            return f"To confirm deletion, please type exactly: **{expected_confirm}**\n\nOr type **'cancel'** to abort.", state, None
    
    # Step 0: Looking up the employee
    if state.current_step == 0 and state.edit_target is None:
        search_term = user_message.strip()
        state.collected_data["search_term"] = search_term
        state.current_step = 1
        
        # Return action to search for employee
        action = {
            "type": "search_employee_for_delete",
            "search_term": search_term
        }
        return "🔍 Searching for employee...", state, action
    
    # Step 1: Employee found, show details and ask for confirmation
    if state.current_step == 1 and state.edit_target:
        # Show employee details and ask for strong confirmation
        emp = state.edit_target
        emp_id = emp.get("employee_id", "Unknown")
        name = f"{emp.get('first_name', '')} {emp.get('last_name', '')}".strip()
        email = emp.get("email", "N/A")
        designation = emp.get("designation", "N/A")
        
        # Set the confirmation text
        confirm_text = f"DELETE {emp_id}"
        state.collected_data["confirm_text"] = confirm_text
        state.awaiting_confirmation = True
        
        response = f"""⚠️ **WARNING: You are about to delete this employee:**

• **Employee ID:** {emp_id}
• **Name:** {name}
• **Email:** {email}
• **Designation:** {designation}

**This action is permanent and cannot be undone.**

To confirm, type exactly: **{confirm_text}**

Or type **'cancel'** to abort."""
        return response, state, None
    
    # Fallback
    return "I didn't understand that. Please try again or type **'cancel'** to exit.", state, None


# ================== LEAVE APPLICATION FLOW HANDLER ==================

def _build_leave_summary(data: Dict[str, Any], employee_id: str = None) -> str:
    """Build a summary of the leave application for confirmation."""
    lines = [
        "📋 **Leave Application Summary**",
        "",
        f"• **Employee ID:** {employee_id or 'Will be auto-detected'}",
        f"• **Leave Type:** {data.get('leave_type', 'N/A')}",
        f"• **Compensation:** {data.get('compensation', 'N/A')}",
        f"• **Start Date:** {data.get('start_date', 'N/A')}",
        f"• **End Date:** {data.get('end_date', 'N/A')}",
        f"• **Reason:** {data.get('reason', 'N/A')}",
        "",
        "Is this correct? Type **'yes'** to submit or **'no'** to start over."
    ]
    return "\n".join(lines)


def handle_leave_application_flow(
    user_message: str,
    state: 'ConversationState',
    user_employee_id: str = None
) -> Tuple[str, 'ConversationState', Optional[Dict[str, Any]]]:
    """
    Handle the leave application conversation flow.
    
    Flow:
    1. Ask for leave type (dropdown: Casual Leave, Sick Leave, Comp Off)
    2. Ask for compensation type (dropdown: Paid, Unpaid)
    3. Ask for start date
    4. Ask for end date
    5. Ask for reason
    6. Show summary and confirm
    7. Submit leave application
    
    Args:
        user_message: The user's message
        state: Current conversation state
        user_employee_id: The logged-in user's employee ID (auto-fetched)
    
    Returns:
        Tuple of (response, updated_state, action_to_execute)
    """
    
    # Starting the flow
    if state.active_flow != "leave_application":
        state.active_flow = "leave_application"
        state.current_step = 0
        state.collected_data = {}
        state.awaiting_confirmation = False
        
        # Store the employee ID if provided
        if user_employee_id:
            state.collected_data["employee_id"] = user_employee_id
        
        # Ask for the first field (leave type)
        field = LEAVE_FIELDS[0]
        response = f"""🏖️ I'll help you apply for leave!

{field['prompt']}

_(Type **'cancel'** at any time to stop.)_"""
        return response, state, None
    
    # Check for cancel
    if user_message.strip().lower() in ['cancel', 'stop', 'quit', 'exit', 'nevermind']:
        state.reset()
        return "No problem! Leave application cancelled. Let me know if you need anything else. 👋", state, None
    
    # Handle confirmation
    if state.awaiting_confirmation:
        answer = user_message.strip().lower()
        if answer in ['yes', 'y', 'confirm', 'submit', 'ok']:
            # Submit the leave application
            action = {
                "type": "apply_leave",
                "data": state.collected_data
            }
            state.reset()
            return "📤 Submitting your leave application...", state, action
        elif answer in ['no', 'n', 'restart', 'start over']:
            state.current_step = 0
            state.collected_data = {"employee_id": state.collected_data.get("employee_id")}
            state.awaiting_confirmation = False
            field = LEAVE_FIELDS[0]
            return f"No problem, let's start over.\n\n{field['prompt']}", state, None
        else:
            return "Please type **'yes'** to submit or **'no'** to start over.", state, None
    
    # Process current field
    current_step = state.current_step
    if current_step < len(LEAVE_FIELDS):
        field = LEAVE_FIELDS[current_step]
        
        # Validate input
        if not field["validate"](user_message):
            return f"❌ {field['error']}\n\n{field['prompt']}", state, None
        
        # Normalize and store value
        normalized_value = _normalize_leave_value(field["key"], user_message, state.collected_data)
        state.collected_data[field["key"]] = normalized_value
        state.current_step += 1
        
        # Check if we have more fields
        if state.current_step < len(LEAVE_FIELDS):
            next_field = LEAVE_FIELDS[state.current_step]
            step_info = f"_(Step {state.current_step + 1} of {len(LEAVE_FIELDS)})_"
            return f"✅ Got it!\n\n{next_field['prompt']}\n\n{step_info}", state, None
        else:
            # All fields collected, show summary and ask for confirmation
            state.awaiting_confirmation = True
            employee_id = state.collected_data.get("employee_id", "Auto-detected from login")
            summary = _build_leave_summary(state.collected_data, employee_id)
            return f"✅ Great! Here's your leave application:\n\n{summary}", state, None
    
    # Fallback
    return "I didn't understand that. Please try again or type **'cancel'** to exit.", state, None


# ================== CHECK-IN/CHECK-OUT HANDLER ==================

def _handle_check_action(
    action_type: str,
    state: 'ConversationState',
    user_employee_id: str = None,
    user_timezone: str = "UTC",
    user_timezone_offset_minutes: Optional[int] = None,
) -> Tuple[str, 'ConversationState', Optional[Dict[str, Any]]]:
    """
    Handle check-in or check-out action.
    This is a single-step action - no multi-step flow needed.
    
    Args:
        action_type: 'check_in' or 'check_out'
        state: Current conversation state
        user_employee_id: The logged-in user's employee ID
    
    Returns:
        Tuple of (response, updated_state, action_to_execute)
    """
    # Reset any active flow since this is a one-shot action
    state.reset()
    
    if not user_employee_id:
        return "❌ I couldn't identify your employee ID. Please make sure you're logged in.", state, None
    
    if action_type == "check_in":
        action = {
            "type": "check_in",
            "employee_id": user_employee_id,
            "timezone": user_timezone or "UTC",
            "timezone_offset_minutes": user_timezone_offset_minutes,
        }
        return "⏰ Checking you in...", state, action
    elif action_type == "check_out":
        action = {
            "type": "check_out",
            "employee_id": user_employee_id,
            "timezone": user_timezone or "UTC",
            "timezone_offset_minutes": user_timezone_offset_minutes,
        }
        return "⏰ Checking you out...", state, action
    
    return "I didn't understand that action.", state, None


# ================== TASK START/STOP FLOW HANDLER ==================

def handle_task_start_flow(
    user_message: str,
    state: 'ConversationState',
    user_employee_id: str = None,
    user_employee_name: str = None,
    user_employee_email: str = None
) -> Tuple[str, 'ConversationState', Optional[Dict[str, Any]]]:
    """
    Handle the task start flow:
    1. Fetch user's tasks
    2. Display numbered list
    3. User selects a task number
    4. Start the timer for that task
    """
    # Check for cancel
    if user_message.strip().lower() in ['cancel', 'stop', 'quit', 'exit', 'nevermind']:
        state.reset()
        return "No problem! Task selection cancelled. Let me know if you need anything else. 👋", state, None
    
    # Starting the flow - fetch tasks and show list
    if state.active_flow != "task_start":
        state.active_flow = "task_start"
        state.current_step = 0
        state.collected_data = {}
        state.awaiting_confirmation = False
        
        # Return action to fetch tasks
        action = {
            "type": "fetch_my_tasks",
            "employee_id": user_employee_id,
            "employee_name": user_employee_name or "",
            "employee_email": user_employee_email or ""
        }
        return "📋 Fetching your tasks...", state, action
    
    # User is selecting a task number
    if state.current_step == 1:
        tasks = state.collected_data.get("tasks", [])
        if not tasks:
            state.reset()
            return "❌ No tasks available. Please try again later.", state, None
        
        # Parse user selection
        user_input = user_message.strip()
        
        # Check if user typed a number
        try:
            selection = int(user_input)
            if 1 <= selection <= len(tasks):
                selected_task = tasks[selection - 1]
                state.reset()
                
                action = {
                    "type": "start_task_timer",
                    "employee_id": user_employee_id,
                    "task_guid": selected_task.get("guid"),
                    "task_id": selected_task.get("task_id"),
                    "task_name": selected_task.get("task_name"),
                    "project_id": selected_task.get("project_id")
                }
                return f"▶️ Starting timer for **{selected_task.get('task_name', 'Task')}**...", state, action
            else:
                return f"❌ Please enter a number between 1 and {len(tasks)}.", state, None
        except ValueError:
            # Check if user typed task name or ID
            user_lower = user_input.lower()
            for task in tasks:
                task_name = (task.get("task_name") or "").lower()
                task_id = (task.get("task_id") or "").lower()
                if user_lower in task_name or user_lower == task_id:
                    state.reset()
                    action = {
                        "type": "start_task_timer",
                        "employee_id": user_employee_id,
                        "task_guid": task.get("guid"),
                        "task_id": task.get("task_id"),
                        "task_name": task.get("task_name"),
                        "project_id": task.get("project_id")
                    }
                    return f"▶️ Starting timer for **{task.get('task_name', 'Task')}**...", state, action
            
            return f"❌ I couldn't find that task. Please enter a number (1-{len(tasks)}) or the task name.", state, None
    
    return "I didn't understand that. Please select a task number.", state, None


def handle_task_stop_flow(
    user_message: str,
    state: 'ConversationState',
    user_employee_id: str = None
) -> Tuple[str, 'ConversationState', Optional[Dict[str, Any]]]:
    """
    Handle stopping the currently running task.
    This is a single-step action.
    """
    state.reset()
    
    if not user_employee_id:
        return "❌ I couldn't identify your employee ID. Please make sure you're logged in.", state, None
    
    action = {
        "type": "stop_task_timer",
        "employee_id": user_employee_id
    }
    return "⏹️ Stopping your current task timer...", state, action


# ================== CHAT AUTOMATION FLOWS ==================

def _extract_name_from_message(message: str) -> Optional[str]:
    """Extract a person's name from a chat command message."""
    import re
    
    # Patterns to extract names
    patterns = [
        r"(?:send|message|text|dm|ping|write to|tell|ask)\s+(?:a\s+)?(?:message\s+)?(?:to\s+)?([a-zA-Z]+(?:\s+[a-zA-Z]+)?)",
        r"(?:reply|respond)\s+(?:to\s+)?([a-zA-Z]+(?:\s+[a-zA-Z]+)?)",
        r"(?:conversation|chat|messages?)\s+(?:with|from)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)",
        r"(?:what did|what has)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)\s+(?:say|send|write)",
    ]
    
    message_lower = message.lower().strip()
    
    for pattern in patterns:
        match = re.search(pattern, message_lower, re.IGNORECASE)
        if match:
            name = match.group(1).strip()
            # Filter out common words that aren't names
            stop_words = ['a', 'the', 'my', 'to', 'for', 'with', 'from', 'message', 'messages']
            if name.lower() not in stop_words:
                return name
    
    return None


def handle_chat_send_message_flow(
    user_message: str,
    state: 'ConversationState',
    user_employee_id: str = None
) -> Tuple[str, 'ConversationState', Optional[Dict[str, Any]]]:
    """
    Handle the send message conversation flow.
    
    Flow:
    1. Extract or ask for recipient name
    2. Search for matching employee
    3. Ask for message content
    4. Send the message
    """
    
    # Starting the flow
    if state.active_flow != "chat_send_message":
        state.active_flow = "chat_send_message"
        state.current_step = 0
        state.collected_data = {}
        state.awaiting_confirmation = False
        
        # Try to extract name from initial message
        target_name = _extract_name_from_message(user_message)
        
        if target_name:
            state.collected_data["target_name"] = target_name
            state.current_step = 1
            
            # Return action to search for employee
            action = {
                "type": "chat_search_employee",
                "name": target_name,
                "sender_id": user_employee_id
            }
            return f"🔍 Searching for **{target_name}**...", state, action
        else:
            return """📨 **Send a Message**

Who would you like to message? Please provide the **employee's name**.

_(Type **'cancel'** at any time to stop.)_""", state, None
    
    # Check for cancel
    if user_message.strip().lower() in ['cancel', 'stop', 'quit', 'exit', 'nevermind']:
        state.reset()
        return "No problem! Message cancelled. Let me know if you need anything else. 👋", state, None
    
    # Step 0: Get recipient name
    if state.current_step == 0:
        target_name = user_message.strip()
        state.collected_data["target_name"] = target_name
        state.current_step = 1
        
        action = {
            "type": "chat_search_employee",
            "name": target_name,
            "sender_id": user_employee_id
        }
        return f"🔍 Searching for **{target_name}**...", state, action
    
    # Step 1: Employee found, ask for message
    if state.current_step == 1:
        # Check if we have a confirmed target
        if state.collected_data.get("target_employee_id"):
            # User is providing the message content
            message_text = user_message.strip()
            
            if len(message_text) < 1:
                return "Please enter a message to send.", state, None
            
            state.collected_data["message_text"] = message_text
            state.current_step = 2
            state.awaiting_confirmation = True
            
            target_name = state.collected_data.get("target_name", "the recipient")
            return f"""📝 **Message Preview:**

**To:** {target_name}
**Message:** {message_text}

**Send this message?** Type **'yes'** to send or **'no'** to cancel.""", state, None
        else:
            # User might be selecting from multiple matches
            # This is handled by the action result in unified_server.py
            return "Please select a recipient or type a name.", state, None
    
    # Step 2: Confirmation
    if state.current_step == 2 and state.awaiting_confirmation:
        answer = user_message.strip().lower()
        
        if answer in ['yes', 'y', 'send', 'ok', 'confirm']:
            action = {
                "type": "chat_send_message",
                "sender_id": user_employee_id,
                "target_employee_id": state.collected_data.get("target_employee_id"),
                "message": state.collected_data.get("message_text")
            }
            state.reset()
            return "📤 Sending message...", state, action
        elif answer in ['no', 'n', 'cancel']:
            state.reset()
            return "Message cancelled. Let me know if you need anything else! 👋", state, None
        else:
            return "Please type **'yes'** to send or **'no'** to cancel.", state, None
    
    return "I didn't understand that. Please try again.", state, None


def handle_chat_read_messages_flow(
    user_message: str,
    state: 'ConversationState',
    user_employee_id: str = None
) -> Tuple[str, 'ConversationState', Optional[Dict[str, Any]]]:
    """
    Handle reading unread messages.
    This is a single-step action.
    """
    state.reset()
    
    if not user_employee_id:
        return "❌ I couldn't identify your employee ID. Please make sure you're logged in.", state, None
    
    action = {
        "type": "chat_get_unread",
        "user_id": user_employee_id
    }
    return "📬 Fetching your messages...", state, action


def handle_chat_read_conversation_flow(
    user_message: str,
    state: 'ConversationState',
    user_employee_id: str = None
) -> Tuple[str, 'ConversationState', Optional[Dict[str, Any]]]:
    """
    Handle reading conversation with a specific person.
    """
    
    # Starting the flow
    if state.active_flow != "chat_read_conversation":
        state.active_flow = "chat_read_conversation"
        state.current_step = 0
        state.collected_data = {}
        
        # Try to extract name from initial message
        target_name = _extract_name_from_message(user_message)
        
        if target_name:
            state.reset()
            action = {
                "type": "chat_read_conversation",
                "user_id": user_employee_id,
                "target_name": target_name
            }
            return f"📖 Reading conversation with **{target_name}**...", state, action
        else:
            return """📖 **Read Conversation**

Whose conversation would you like to read? Please provide the **employee's name**.

_(Type **'cancel'** at any time to stop.)_""", state, None
    
    # Check for cancel
    if user_message.strip().lower() in ['cancel', 'stop', 'quit', 'exit']:
        state.reset()
        return "Cancelled. Let me know if you need anything else! 👋", state, None
    
    # Get the name and fetch conversation
    target_name = user_message.strip()
    state.reset()
    
    action = {
        "type": "chat_read_conversation",
        "user_id": user_employee_id,
        "target_name": target_name
    }
    return f"📖 Reading conversation with **{target_name}**...", state, action


def handle_chat_reply_flow(
    user_message: str,
    state: 'ConversationState',
    user_employee_id: str = None
) -> Tuple[str, 'ConversationState', Optional[Dict[str, Any]]]:
    """
    Handle replying to a message.
    
    Flow:
    1. Extract or ask for recipient name
    2. Ask for reply content
    3. Send the reply
    """
    
    # Starting the flow
    if state.active_flow != "chat_reply":
        state.active_flow = "chat_reply"
        state.current_step = 0
        state.collected_data = {}
        
        # Try to extract name from initial message
        target_name = _extract_name_from_message(user_message)
        
        if target_name:
            state.collected_data["target_name"] = target_name
            state.current_step = 1
            return f"💬 **Reply to {target_name}**\n\nWhat would you like to say?", state, None
        else:
            return """💬 **Reply to Message**

Who would you like to reply to? Please provide the **employee's name**.

_(Type **'cancel'** at any time to stop.)_""", state, None
    
    # Check for cancel
    if user_message.strip().lower() in ['cancel', 'stop', 'quit', 'exit']:
        state.reset()
        return "Reply cancelled. Let me know if you need anything else! 👋", state, None
    
    # Step 0: Get recipient name
    if state.current_step == 0:
        target_name = user_message.strip()
        state.collected_data["target_name"] = target_name
        state.current_step = 1
        return f"💬 **Reply to {target_name}**\n\nWhat would you like to say?", state, None
    
    # Step 1: Get reply content and send
    if state.current_step == 1:
        reply_text = user_message.strip()
        
        if len(reply_text) < 1:
            return "Please enter your reply message.", state, None
        
        target_name = state.collected_data.get("target_name")
        state.reset()
        
        action = {
            "type": "chat_reply",
            "user_id": user_employee_id,
            "target_name": target_name,
            "message": reply_text
        }
        return f"📤 Sending reply to **{target_name}**...", state, action
    
    return "I didn't understand that. Please try again.", state, None



def process_automation(
    user_message: str,
    conversation_state: Optional[Dict[str, Any]] = None,
    user_employee_id: Optional[str] = None,
    user_employee_name: Optional[str] = None,
    user_employee_email: Optional[str] = None,
    user_access: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Main entry point for processing automation flows.
    
    Args:
        user_message: The user's message
        conversation_state: Optional existing conversation state (from frontend)
        user_employee_id: Employee ID of the logged-in user
        user_employee_name: Name of the logged-in user
        user_employee_email: Email of the logged-in user
    
    Returns:
        Dict with:
            - is_automation: bool - Whether this is an automation flow
            - response: str - The response message (if automation)
            - state: dict - Updated conversation state
            - action: Optional dict - Action to execute
    """
    
    # Restore or create state
    if conversation_state:
        state = ConversationState.from_dict(conversation_state)
    else:
        state = ConversationState()
    
    def _deny_flow(flow_name: str, required_role: str) -> Dict[str, Any]:
        human_name = flow_name.replace("_", " ").title()
        state.reset()
        return {
            "is_automation": True,
            "response": f"⚠️ The automation '{human_name}' requires {required_role} access. Please contact an L{required_role[-1]} approver.",
            "state": state.to_dict(),
            "action": None,
        }

    def _ensure_flow(flow_name: str) -> Optional[Dict[str, Any]]:
        allowed, required = _is_flow_allowed(flow_name, user_access)
        if not allowed:
            return _deny_flow(flow_name, required)
        return None

    # If there's an active flow, continue it
    if state.active_flow:
        if state.active_flow == "employee_creation":
            denied = _ensure_flow("employee_creation")
            if denied:
                return denied
            response, state, action = handle_employee_creation_flow(user_message, state)
            _log_automation_event("employee_creation", user_employee_id, {"success": True, "message": response})
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif state.active_flow == "employee_edit":
            denied = _ensure_flow("employee_edit")
            if denied:
                return denied
            response, state, action = handle_employee_edit_flow(user_message, state)
            _log_automation_event("employee_edit", user_employee_id, {"success": True, "message": response})
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif state.active_flow == "employee_delete":
            denied = _ensure_flow("employee_delete")
            if denied:
                return denied
            response, state, action = handle_employee_delete_flow(user_message, state)
            _log_automation_event("employee_delete", user_employee_id, {"success": True, "message": response})
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif state.active_flow == "leave_application":
            denied = _ensure_flow("leave_application")
            if denied:
                return denied
            response, state, action = handle_leave_application_flow(user_message, state, user_employee_id)
            _log_automation_event("leave_application", user_employee_id, {"success": True, "message": response})
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif state.active_flow == "asset_creation":
            denied = _ensure_flow("asset_creation")
            if denied:
                return denied
            response, state, action = handle_asset_creation_flow(user_message, state)
            _log_automation_event("asset_creation", user_employee_id, {"success": True, "message": response})
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif state.active_flow == "asset_assignment":
            denied = _ensure_flow("asset_assignment")
            if denied:
                return denied
            response, state, action = handle_asset_assignment_flow(user_message, state)
            _log_automation_event("asset_assignment", user_employee_id, {"success": True, "message": response})
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif state.active_flow == "task_start":
            denied = _ensure_flow("task_start")
            if denied:
                return denied
            response, state, action = handle_task_start_flow(user_message, state, user_employee_id, user_employee_name, user_employee_email)
            _log_automation_event("task_start", user_employee_id, {"success": True, "message": response})
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif state.active_flow == "task_creation":
            denied = _ensure_flow("task_creation")
            if denied:
                return denied
            response, state, action = handle_task_creation_flow(user_message, state)
            _log_automation_event("task_creation", user_employee_id, {"success": True, "message": response})
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif state.active_flow == "attendance_submit":
            denied = _ensure_flow("attendance_submit")
            if denied:
                return denied
            response, state, action = handle_attendance_submission_flow(user_message, state, user_employee_id)
            _log_automation_event("attendance_submit", user_employee_id, {"success": True, "message": response})
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action,
            }
        elif state.active_flow == "attendance_review":
            denied = _ensure_flow("attendance_review")
            if denied:
                return denied
            response, state, action = handle_attendance_review_flow(user_message, state, user_employee_id)
            _log_automation_event("attendance_review", user_employee_id, {"success": True, "message": response})
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action,
            }
        elif state.active_flow == "timesheet_submit":
            denied = _ensure_flow("timesheet_submit")
            if denied:
                return denied
            response, state, action = handle_timesheet_submission_flow(user_message, state, user_employee_id, user_employee_name)
            _log_automation_event("timesheet_submit", user_employee_id, {"success": True, "message": response})
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action,
            }
        elif state.active_flow == "timesheet_review":
            denied = _ensure_flow("timesheet_review")
            if denied:
                return denied
            response, state, action = handle_timesheet_review_flow(user_message, state, user_employee_id)
            _log_automation_event("timesheet_review", user_employee_id, {"success": True, "message": response})
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action,
            }
        # Chat automation flows
        elif state.active_flow == "chat_send_message":
            denied = _ensure_flow("chat_send_message")
            if denied:
                return denied
            response, state, action = handle_chat_send_message_flow(user_message, state, user_employee_id)
            _log_automation_event("chat_send_message", user_employee_id, {"success": True, "message": response})
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif state.active_flow == "chat_read_conversation":
            denied = _ensure_flow("chat_read_conversation")
            if denied:
                return denied
            response, state, action = handle_chat_read_conversation_flow(user_message, state, user_employee_id)
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif state.active_flow == "chat_reply":
            denied = _ensure_flow("chat_reply")
            if denied:
                return denied
            response, state, action = handle_chat_reply_flow(user_message, state, user_employee_id)
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        # Project / Client / Inbox flows
        elif state.active_flow == "project_creation":
            denied = _ensure_flow("project_creation")
            if denied:
                return denied
            response, state, action = handle_project_creation_flow(user_message, state)
            _log_automation_event("project_creation", user_employee_id, {"success": True, "message": response})
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action,
            }
        elif state.active_flow == "client_creation":
            denied = _ensure_flow("client_creation")
            if denied:
                return denied
            response, state, action = handle_client_creation_flow(user_message, state)
            _log_automation_event("client_creation", user_employee_id, {"success": True, "message": response})
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action,
            }
        elif state.active_flow == "project_delete":
            denied = _ensure_flow("project_delete")
            if denied:
                return denied
            response, state, action = handle_project_delete_flow(user_message, state)
            _log_automation_event("project_delete", user_employee_id, {"success": True, "message": response})
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action,
            }
        elif state.active_flow == "project_edit":
            denied = _ensure_flow("project_edit")
            if denied:
                return denied
            response, state, action = handle_project_edit_flow(user_message, state)
            _log_automation_event("project_edit", user_employee_id, {"success": True, "message": response})
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action,
            }
        elif state.active_flow == "client_delete":
            denied = _ensure_flow("client_delete")
            if denied:
                return denied
            response, state, action = handle_client_delete_flow(user_message, state)
            _log_automation_event("client_delete", user_employee_id, {"success": True, "message": response})
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action,
            }
        elif state.active_flow == "client_edit":
            denied = _ensure_flow("client_edit")
            if denied:
                return denied
            response, state, action = handle_client_edit_flow(user_message, state)
            _log_automation_event("client_edit", user_employee_id, {"success": True, "message": response})
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action,
            }
    
    # Check for new automation intent
    intent = detect_automation_intent(user_message)
    if intent:
        if intent["flow"] == "employee_creation":
            denied = _ensure_flow("employee_creation")
            if denied:
                return denied
            response, state, action = handle_employee_creation_flow(user_message, state)
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif intent["flow"] == "employee_edit":
            denied = _ensure_flow("employee_edit")
            if denied:
                return denied
            response, state, action = handle_employee_edit_flow(user_message, state)
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif intent["flow"] == "employee_delete":
            denied = _ensure_flow("employee_delete")
            if denied:
                return denied
            response, state, action = handle_employee_delete_flow(user_message, state)
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif intent["flow"] == "leave_application":
            denied = _ensure_flow("leave_application")
            if denied:
                return denied
            response, state, action = handle_leave_application_flow(user_message, state, user_employee_id)
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif intent["flow"] == "asset_creation":
            denied = _ensure_flow("asset_creation")
            if denied:
                return denied
            response, state, action = handle_asset_creation_flow(user_message, state)
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif intent["flow"] == "asset_assignment":
            denied = _ensure_flow("asset_assignment")
            if denied:
                return denied
            response, state, action = handle_asset_assignment_flow(user_message, state)
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif intent["flow"] == "check_in":
            denied = _ensure_flow("check_in")
            if denied:
                return denied
            response, state, action = _handle_check_action(
                "check_in",
                state,
                user_employee_id,
                (user_access or {}).get("timezone", "UTC"),
                (user_access or {}).get("timezone_offset_minutes"),
            )
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif intent["flow"] == "check_out":
            denied = _ensure_flow("check_out")
            if denied:
                return denied
            response, state, action = _handle_check_action(
                "check_out",
                state,
                user_employee_id,
                (user_access or {}).get("timezone", "UTC"),
                (user_access or {}).get("timezone_offset_minutes"),
            )
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif intent["flow"] == "task_start":
            denied = _ensure_flow("task_start")
            if denied:
                return denied
            response, state, action = handle_task_start_flow(user_message, state, user_employee_id, user_employee_name, user_employee_email)
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif intent["flow"] == "task_stop":
            denied = _ensure_flow("task_stop")
            if denied:
                return denied
            response, state, action = handle_task_stop_flow(user_message, state, user_employee_id)
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif intent["flow"] == "task_creation":
            denied = _ensure_flow("task_creation")
            if denied:
                return denied
            response, state, action = handle_task_creation_flow(user_message, state)
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif intent["flow"] == "attendance_submit":
            denied = _ensure_flow("attendance_submit")
            if denied:
                return denied
            response, state, action = handle_attendance_submission_flow(user_message, state, user_employee_id)
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action,
            }
        elif intent["flow"] == "attendance_review":
            denied = _ensure_flow("attendance_review")
            if denied:
                return denied
            response, state, action = handle_attendance_review_flow(user_message, state, user_employee_id)
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action,
            }
        elif intent["flow"] == "timesheet_submit":
            denied = _ensure_flow("timesheet_submit")
            if denied:
                return denied
            response, state, action = handle_timesheet_submission_flow(user_message, state, user_employee_id, user_employee_name)
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action,
            }
        elif intent["flow"] == "timesheet_review":
            denied = _ensure_flow("timesheet_review")
            if denied:
                return denied
            response, state, action = handle_timesheet_review_flow(user_message, state, user_employee_id)
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action,
            }
        # Chat automation intents
        elif intent["flow"] == "chat_send_message":
            denied = _ensure_flow("chat_send_message")
            if denied:
                return denied
            response, state, action = handle_chat_send_message_flow(user_message, state, user_employee_id)
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif intent["flow"] == "chat_read_messages":
            denied = _ensure_flow("chat_read_messages")
            if denied:
                return denied
            response, state, action = handle_chat_read_messages_flow(user_message, state, user_employee_id)
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif intent["flow"] == "chat_read_conversation":
            denied = _ensure_flow("chat_read_conversation")
            if denied:
                return denied
            response, state, action = handle_chat_read_conversation_flow(user_message, state, user_employee_id)
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif intent["flow"] == "chat_reply":
            denied = _ensure_flow("chat_reply")
            if denied:
                return denied
            response, state, action = handle_chat_reply_flow(user_message, state, user_employee_id)
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        # Project / Client / Inbox intents
        elif intent["flow"] == "project_view":
            denied = _ensure_flow("project_view")
            if denied:
                return denied
            response, state, action = handle_project_view_flow(user_message, state, user_employee_id, user_employee_name, user_employee_email, user_access)
            _log_automation_event("project_view", user_employee_id, {"success": True, "message": response})
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action,
            }
        elif intent["flow"] == "project_creation":
            denied = _ensure_flow("project_creation")
            if denied:
                return denied
            response, state, action = handle_project_creation_flow(user_message, state)
            _log_automation_event("project_creation", user_employee_id, {"success": True, "message": response})
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action,
            }
        elif intent["flow"] == "client_view":
            denied = _ensure_flow("client_view")
            if denied:
                return denied
            response, state, action = handle_client_view_flow(user_message, state, user_access)
            _log_automation_event("client_view", user_employee_id, {"success": True, "message": response})
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action,
            }
        elif intent["flow"] == "client_creation":
            denied = _ensure_flow("client_creation")
            if denied:
                return denied
            response, state, action = handle_client_creation_flow(user_message, state)
            _log_automation_event("client_creation", user_employee_id, {"success": True, "message": response})
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action,
            }
        elif intent["flow"] == "inbox_view":
            denied = _ensure_flow("inbox_view")
            if denied:
                return denied
            response, state, action = handle_inbox_view_flow(user_message, state, user_employee_id, user_access)
            _log_automation_event("inbox_view", user_employee_id, {"success": True, "message": response})
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action,
            }
        elif intent["flow"] == "inbox_approve":
            denied = _ensure_flow("inbox_approve")
            if denied:
                return denied
            response, state, action = handle_inbox_approve_flow(user_message, state, user_employee_id)
            _log_automation_event("inbox_approve", user_employee_id, {"success": True, "message": response})
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action,
            }
        elif intent["flow"] == "inbox_reject":
            denied = _ensure_flow("inbox_reject")
            if denied:
                return denied
            response, state, action = handle_inbox_reject_flow(user_message, state, user_employee_id)
            _log_automation_event("inbox_reject", user_employee_id, {"success": True, "message": response})
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action,
            }
        elif intent["flow"] == "project_delete":
            denied = _ensure_flow("project_delete")
            if denied:
                return denied
            response, state, action = handle_project_delete_flow(user_message, state)
            _log_automation_event("project_delete", user_employee_id, {"success": True, "message": response})
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action,
            }
        elif intent["flow"] == "project_edit":
            denied = _ensure_flow("project_edit")
            if denied:
                return denied
            response, state, action = handle_project_edit_flow(user_message, state)
            _log_automation_event("project_edit", user_employee_id, {"success": True, "message": response})
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action,
            }
        elif intent["flow"] == "client_delete":
            denied = _ensure_flow("client_delete")
            if denied:
                return denied
            response, state, action = handle_client_delete_flow(user_message, state)
            _log_automation_event("client_delete", user_employee_id, {"success": True, "message": response})
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action,
            }
        elif intent["flow"] == "client_edit":
            denied = _ensure_flow("client_edit")
            if denied:
                return denied
            response, state, action = handle_client_edit_flow(user_message, state)
            _log_automation_event("client_edit", user_employee_id, {"success": True, "message": response})
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action,
            }
    
    # Not an automation flow
    return {
        "is_automation": False,
        "response": None,
        "state": state.to_dict(),
        "action": None
    }


def execute_automation_action(action: Dict[str, Any], token: str) -> Dict[str, Any]:
    """
    Execute an automation action (e.g., create employee).
    
    Args:
        action: The action to execute
        token: Dataverse access token
    
    Returns:
        Dict with success status and result/error
    """
    import requests
    from dataverse_helper import create_record
    
    if action["type"] == "create_employee":
        try:
            data = action["data"]
            
            # The create_employee endpoint handles all the logic
            # We'll call it internally or replicate the logic here
            from unified_server import (
                get_employee_entity_set, get_field_map, generate_employee_id,
                create_record, BASE_URL, LEAVE_BALANCE_ENTITY,
                calculate_experience, get_leave_allocation_by_experience,
                get_login_table, _hash_password, determine_access_level,
                generate_user_id, send_login_credentials_email,
            )
            import os
            
            entity_set = get_employee_entity_set(token)
            field_map = get_field_map(entity_set)

            first_name = data.get('first_name', '')
            last_name = data.get('last_name', '')
            email = data.get('email', '')
            designation = data.get('designation', '')
            doj = data.get('doj', '')
            contact_number = data.get('contact_number', '')
            employee_flag = data.get('employee_flag', 'Employee')

            # ==================== DUPLICATE CHECKS (same as /api/employees) ====================
            headers_check = {"Authorization": f"Bearer {token}"}

            if email:
                safe_email = email.strip().replace("'", "''")
                check_url = f"{BASE_URL}/{entity_set}?$filter=crc6f_email eq '{safe_email}'"
                resp_email = requests.get(check_url, headers=headers_check)
                if resp_email.status_code == 200:
                    existing = resp_email.json().get('value', [])
                    if existing:
                        return {
                            "success": False,
                            "error": f"Employee with email {email} already exists",
                        }

            if contact_number:
                safe_contact = contact_number.strip().replace("'", "''")
                check_url = f"{BASE_URL}/{entity_set}?$filter=crc6f_contactnumber eq '{safe_contact}'"
                resp_contact = requests.get(check_url, headers=headers_check)
                if resp_contact.status_code == 200:
                    existing = resp_contact.json().get('value', [])
                    if existing:
                        return {
                            "success": False,
                            "error": f"Employee with contact number {contact_number} already exists",
                        }

            # ==================== EMPLOYEE CREATION ====================

            # Generate employee ID (always auto-generated in automation flow)
            employee_id = generate_employee_id()
            
            # Build payload
            payload = {}
            
            if field_map['id']:
                payload[field_map['id']] = employee_id

            # Handle name fields
            if field_map['fullname']:
                payload[field_map['fullname']] = f"{first_name} {last_name}".strip()
            else:
                if field_map['firstname']:
                    payload[field_map['firstname']] = first_name
                if field_map['lastname']:
                    payload[field_map['lastname']] = last_name
            
            if field_map['email']:
                payload[field_map['email']] = email
            if field_map['contact'] and contact_number:
                payload[field_map['contact']] = contact_number
            if field_map['designation']:
                payload[field_map['designation']] = designation
            if field_map['doj']:
                payload[field_map['doj']] = doj
            if field_map['active']:
                payload[field_map['active']] = True
            if field_map.get('employee_flag'):
                payload[field_map['employee_flag']] = employee_flag
            
            # Calculate experience
            if field_map.get('experience') and doj:
                experience = calculate_experience(doj)
                payload[field_map['experience']] = str(experience)
            
            if field_map.get('quota_hours'):
                payload[field_map['quota_hours']] = 9.0
            
            # Create the employee record
            created = create_record(entity_set, payload)
            
            # ==================== LOGIN CREATION + EMAIL ====================
            if email:
                try:
                    login_table = get_login_table(token)
                    access_level = determine_access_level(designation)
                    user_id = generate_user_id(employee_id, first_name)
                    default_password = os.getenv("DEFAULT_USER_PASSWORD", "Temp@123")
                    
                    login_payload = {
                        "crc6f_username": email,
                        "crc6f_password": _hash_password(default_password),
                        "crc6f_accesslevel": access_level,
                        "crc6f_userid": user_id,
                        "crc6f_employeename": f"{first_name} {last_name}".strip(),
                        "crc6f_user_status": "Active",
                        "crc6f_loginattempts": 0
                    }
                    create_record(login_table, login_payload)

                    # Send login credentials email (same as external upload path)
                    try:
                        credentials = {
                            "username": email,
                            "password": default_password,
                        }
                        employee_data = {
                            "email": email,
                            "firstname": first_name,
                            "lastname": last_name,
                            "employee_id": employee_id,
                        }
                        send_login_credentials_email(employee_data, credentials)
                    except Exception as mail_err:
                        print(f"[WARN] Failed to send login credentials email: {mail_err}")

                except Exception as e:
                    print(f"[WARN] Failed to create login: {e}")
            
            # ==================== LEAVE BALANCE CREATION ====================
            try:
                experience = calculate_experience(doj) if doj else 0
                cl, sl, total, allocation_type = get_leave_allocation_by_experience(experience)
                actual_total = cl + sl
                
                leave_payload = {
                    "crc6f_employeeid": employee_id,
                    "crc6f_cl": str(cl),
                    "crc6f_sl": str(sl),
                    "crc6f_compoff": "0",
                    "crc6f_total": str(total),
                    "crc6f_actualtotal": str(actual_total),
                    "crc6f_leaveallocationtype": allocation_type
                }
                create_record(LEAVE_BALANCE_ENTITY, leave_payload)
            except Exception as e:
                print(f"[WARN] Failed to create leave balance: {e}")
            
            return {
                "success": True,
                "message": f"Employee **{first_name} {last_name}** created successfully!",
                "employee_id": employee_id,
                "data": {
                    "employee_id": employee_id,
                    "name": f"{first_name} {last_name}",
                    "email": email,
                    "designation": designation
                }
            }
            
        except Exception as e:
            return {
                "success": False,
                "error": str(e)
            }
    
    # ==================== SEARCH EMPLOYEE (for edit flow) ====================
    if action["type"] == "search_employee":
        try:
            from unified_server import (
                get_employee_entity_set, get_field_map, BASE_URL
            )
            
            search_term = action.get("search_term", "").strip()
            entity_set = get_employee_entity_set(token)
            field_map = get_field_map(entity_set)
            
            headers = {"Authorization": f"Bearer {token}"}
            
            # Try to find by employee ID first, then by email
            employee = None
            
            # Search by employee ID
            if search_term.upper().startswith("EMP") or search_term.isdigit():
                id_field = field_map.get('id', 'crc6f_employeeid')
                safe_term = search_term.strip().replace("'", "''")
                url = f"{BASE_URL}/{entity_set}?$filter={id_field} eq '{safe_term}'"
                resp = requests.get(url, headers=headers)
                if resp.status_code == 200:
                    results = resp.json().get('value', [])
                    if results:
                        employee = results[0]
            
            # Search by email if not found
            if not employee and '@' in search_term:
                email_field = field_map.get('email', 'crc6f_email')
                safe_email = search_term.lower().strip().replace("'", "''")
                url = f"{BASE_URL}/{entity_set}?$filter={email_field} eq '{safe_email}'"
                resp = requests.get(url, headers=headers)
                if resp.status_code == 200:
                    results = resp.json().get('value', [])
                    if results:
                        employee = results[0]
            
            # Try contains search as fallback
            if not employee:
                id_field = field_map.get('id', 'crc6f_employeeid')
                safe_term = search_term.strip().replace("'", "''")
                url = f"{BASE_URL}/{entity_set}?$filter=contains({id_field}, '{safe_term}')"
                resp = requests.get(url, headers=headers)
                if resp.status_code == 200:
                    results = resp.json().get('value', [])
                    if results:
                        employee = results[0]
            
            if not employee:
                return {
                    "success": False,
                    "error": f"No employee found with ID or email: **{search_term}**. Please check and try again."
                }
            
            # Extract employee data
            if field_map.get('fullname'):
                fullname = employee.get(field_map['fullname'], '')
                parts = fullname.split(' ', 1)
                first_name = parts[0] if parts else ''
                last_name = parts[1] if len(parts) > 1 else ''
            else:
                first_name = employee.get(field_map.get('firstname', ''), '')
                last_name = employee.get(field_map.get('lastname', ''), '')
            
            employee_data = {
                "employee_id": employee.get(field_map.get('id')),
                "record_guid": employee.get(field_map.get('primary')),
                "first_name": first_name,
                "last_name": last_name,
                "email": employee.get(field_map.get('email', ''), ''),
                "designation": employee.get(field_map.get('designation', ''), ''),
                "contact_number": employee.get(field_map.get('contact', ''), ''),
                "doj": employee.get(field_map.get('doj', ''), ''),
                "employee_flag": employee.get(field_map.get('employee_flag', ''), ''),
            }
            
            return {
                "success": True,
                "employee": employee_data,
                "message": f"Found employee: {first_name} {last_name}"
            }
            
        except Exception as e:
            return {
                "success": False,
                "error": f"Error searching for employee: {str(e)}"
            }
    
    # ==================== UPDATE EMPLOYEE ====================
    if action["type"] == "update_employee":
        try:
            from unified_server import (
                get_employee_entity_set, get_field_map, BASE_URL
            )
            
            employee_id = action.get("employee_id")
            record_guid = action.get("record_guid")
            updates = action.get("updates", {})
            
            if not updates:
                return {
                    "success": False,
                    "error": "No updates provided"
                }
            
            entity_set = get_employee_entity_set(token)
            field_map = get_field_map(entity_set)
            
            # Build the update payload
            payload = {}
            
            for key, value in updates.items():
                if key == "first_name":
                    if field_map.get('firstname'):
                        payload[field_map['firstname']] = value
                    elif field_map.get('fullname'):
                        # Need to update fullname - get last name first
                        payload[field_map['fullname']] = f"{value} {updates.get('last_name', '')}".strip()
                elif key == "last_name":
                    if field_map.get('lastname'):
                        payload[field_map['lastname']] = value
                    elif field_map.get('fullname') and 'first_name' not in updates:
                        # Need to preserve first name
                        payload[field_map['fullname']] = f"{updates.get('first_name', '')} {value}".strip()
                elif key == "email" and field_map.get('email'):
                    payload[field_map['email']] = value
                elif key == "designation" and field_map.get('designation'):
                    payload[field_map['designation']] = value
                elif key == "contact_number" and field_map.get('contact'):
                    payload[field_map['contact']] = value
                elif key == "doj" and field_map.get('doj'):
                    payload[field_map['doj']] = value
                    if field_map.get('rpt_doj'):
                        payload[field_map['rpt_doj']] = value
                elif key == "employee_flag" and field_map.get('employee_flag'):
                    payload[field_map['employee_flag']] = value
            
            if not payload:
                return {
                    "success": False,
                    "error": "Could not map any fields for update"
                }
            
            # Perform the PATCH request
            primary_key = field_map.get('primary', 'crc6f_table12id')
            url = f"{BASE_URL}/{entity_set}({record_guid})"
            
            headers = {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "OData-MaxVersion": "4.0",
                "OData-Version": "4.0",
                "If-Match": "*"
            }
            
            resp = requests.patch(url, headers=headers, json=payload)
            
            if resp.status_code in [200, 204]:
                updated_fields = ", ".join([f"**{k}**" for k in updates.keys()])
                return {
                    "success": True,
                    "message": f"Employee **{employee_id}** updated successfully! Changed: {updated_fields}",
                    "employee_id": employee_id
                }
            else:
                return {
                    "success": False,
                    "error": f"Failed to update employee: {resp.status_code} - {resp.text[:200]}"
                }
            
        except Exception as e:
            return {
                "success": False,
                "error": f"Error updating employee: {str(e)}"
            }
    
    # ==================== SEARCH EMPLOYEE FOR DELETE ====================
    if action["type"] == "search_employee_for_delete":
        # Reuse the same search logic as edit flow
        try:
            from unified_server import (
                get_employee_entity_set, get_field_map, BASE_URL
            )
            
            search_term = action.get("search_term", "").strip()
            entity_set = get_employee_entity_set(token)
            field_map = get_field_map(entity_set)
            
            headers = {"Authorization": f"Bearer {token}"}
            
            employee = None
            
            # Search by employee ID
            if search_term.upper().startswith("EMP") or search_term.isdigit():
                id_field = field_map.get('id', 'crc6f_employeeid')
                safe_term = search_term.strip().replace("'", "''")
                url = f"{BASE_URL}/{entity_set}?$filter={id_field} eq '{safe_term}'"
                resp = requests.get(url, headers=headers)
                if resp.status_code == 200:
                    results = resp.json().get('value', [])
                    if results:
                        employee = results[0]
            
            # Search by email if not found
            if not employee and '@' in search_term:
                email_field = field_map.get('email', 'crc6f_email')
                safe_email = search_term.lower().strip().replace("'", "''")
                url = f"{BASE_URL}/{entity_set}?$filter={email_field} eq '{safe_email}'"
                resp = requests.get(url, headers=headers)
                if resp.status_code == 200:
                    results = resp.json().get('value', [])
                    if results:
                        employee = results[0]
            
            # Try contains search as fallback
            if not employee:
                id_field = field_map.get('id', 'crc6f_employeeid')
                safe_term = search_term.strip().replace("'", "''")
                url = f"{BASE_URL}/{entity_set}?$filter=contains({id_field}, '{safe_term}')"
                resp = requests.get(url, headers=headers)
                if resp.status_code == 200:
                    results = resp.json().get('value', [])
                    if results:
                        employee = results[0]
            
            if not employee:
                return {
                    "success": False,
                    "error": f"No employee found with ID or email: **{search_term}**. Please check and try again."
                }
            
            # Extract employee data
            if field_map.get('fullname'):
                fullname = employee.get(field_map['fullname'], '')
                parts = fullname.split(' ', 1)
                first_name = parts[0] if parts else ''
                last_name = parts[1] if len(parts) > 1 else ''
            else:
                first_name = employee.get(field_map.get('firstname', ''), '')
                last_name = employee.get(field_map.get('lastname', ''), '')
            
            employee_data = {
                "employee_id": employee.get(field_map.get('id')),
                "record_guid": employee.get(field_map.get('primary')),
                "first_name": first_name,
                "last_name": last_name,
                "email": employee.get(field_map.get('email', ''), ''),
                "designation": employee.get(field_map.get('designation', ''), ''),
            }
            
            return {
                "success": True,
                "employee": employee_data,
                "message": f"Found employee: {first_name} {last_name}",
                "for_delete": True
            }
            
        except Exception as e:
            return {
                "success": False,
                "error": f"Error searching for employee: {str(e)}"
            }
    
    # ==================== DELETE EMPLOYEE ====================
    if action["type"] == "delete_employee":
        try:
            from unified_server import (
                get_employee_entity_set, get_field_map, BASE_URL, _extract_record_id
            )
            from dataverse_helper import delete_record
            
            employee_id = action.get("employee_id")
            record_guid = action.get("record_guid")
            
            if not record_guid:
                return {
                    "success": False,
                    "error": "Missing record GUID for deletion"
                }
            
            entity_set = get_employee_entity_set(token)
            
            # Perform the DELETE request
            delete_record(entity_set, record_guid)
            
            return {
                "success": True,
                "message": f"Employee **{employee_id}** has been permanently deleted.",
                "employee_id": employee_id
            }
            
        except Exception as e:
            return {
                "success": False,
                "error": f"Error deleting employee: {str(e)}"
            }
    
    # ==================== APPLY LEAVE ====================
    if action["type"] == "apply_leave":
        try:
            from unified_server import (
                generate_leave_id, calculate_leave_days, format_employee_id,
                create_record, LEAVE_ENTITY, BASE_URL, get_access_token,
                _fetch_leave_balance, _ensure_leave_balance_row,
                _get_available_days, _decrement_leave_balance,
                get_employee_name, send_email
            )
            import os
            from datetime import timedelta
            
            data = action["data"]
            
            leave_type = data.get('leave_type', '')
            compensation = data.get('compensation', 'Paid')
            start_date = data.get('start_date', '')
            end_date = data.get('end_date', '')
            reason = data.get('reason', '')
            employee_id = data.get('employee_id', '')
            
            # Format employee ID if needed
            if employee_id:
                if employee_id.isdigit():
                    employee_id = format_employee_id(int(employee_id))
                elif employee_id.upper().startswith("EMP"):
                    employee_id = employee_id.upper()
            
            if not employee_id:
                return {
                    "success": False,
                    "error": "Employee ID is required. Please ensure you are logged in."
                }
            
            # Validate required fields
            if not all([leave_type, start_date, end_date]):
                return {
                    "success": False,
                    "error": "Missing required fields: leave type, start date, and end date are required."
                }
            
            # Generate leave ID and calculate days
            leave_id = generate_leave_id()
            leave_days = calculate_leave_days(start_date, end_date)
            
            # Get leave balance
            balance_row = None
            try:
                balance_row = _fetch_leave_balance(token, employee_id)
            except Exception as bal_err:
                print(f"[WARN] Could not fetch leave balance for {employee_id}: {bal_err}")
            
            paid_flag = (compensation or "").lower() == "paid"
            lt_norm = (leave_type or "").strip().lower()
            
            # Handle Casual Leave and Sick Leave with auto-split logic
            if paid_flag and lt_norm in ("casual leave", "sick leave"):
                if not balance_row:
                    balance_row = _ensure_leave_balance_row(token, employee_id)
                available = _get_available_days(balance_row, leave_type)
                print(f"🔎 Available days for {leave_type} = {available}, requested = {leave_days}")
                paid_days = min(float(available or 0), float(leave_days or 0))
                unpaid_days = max(0.0, float(leave_days or 0) - paid_days)
                
                created_records = []
                primary_leave_id = None
                
                start_dt = datetime.strptime(start_date, "%Y-%m-%d")
                end_dt = datetime.strptime(end_date, "%Y-%m-%d")
                
                # Create paid leave record
                if paid_days > 0:
                    paid_leave_id = leave_id
                    paid_end_dt = start_dt + timedelta(days=int(paid_days) - 1)
                    record_data_paid = {
                        "crc6f_leaveid": paid_leave_id,
                        "crc6f_leavetype": leave_type,
                        "crc6f_startdate": start_dt.date().isoformat(),
                        "crc6f_enddate": paid_end_dt.date().isoformat(),
                        "crc6f_paidunpaid": "Paid",
                        "crc6f_status": "Pending",
                        "crc6f_totaldays": str(int(paid_days)),
                        "crc6f_employeeid": employee_id,
                        "crc6f_approvedby": "",
                    }
                    print(f"📦 Creating Paid leave record: {record_data_paid}")
                    created_paid = create_record(LEAVE_ENTITY, record_data_paid)
                    created_records.append(created_paid)
                    primary_leave_id = paid_leave_id
                    
                    # Decrement leave balance
                    try:
                        if paid_days > 0:
                            _decrement_leave_balance(token, balance_row, leave_type, paid_days)
                    except Exception as dec_err:
                        print(f"[WARN] Failed to decrement leave balance: {dec_err}")
                
                # Create unpaid leave record if needed
                if unpaid_days > 0:
                    unpaid_leave_id = generate_leave_id()
                    unpaid_start_dt = start_dt + timedelta(days=int(paid_days))
                    record_data_unpaid = {
                        "crc6f_leaveid": unpaid_leave_id,
                        "crc6f_leavetype": leave_type,
                        "crc6f_startdate": unpaid_start_dt.date().isoformat(),
                        "crc6f_enddate": end_dt.date().isoformat(),
                        "crc6f_paidunpaid": "Unpaid",
                        "crc6f_status": "Pending",
                        "crc6f_totaldays": str(int(unpaid_days)),
                        "crc6f_employeeid": employee_id,
                        "crc6f_approvedby": "",
                    }
                    print(f"📦 Creating Unpaid leave record: {record_data_unpaid}")
                    created_unpaid = create_record(LEAVE_ENTITY, record_data_unpaid)
                    created_records.append(created_unpaid)
                    if primary_leave_id is None:
                        primary_leave_id = unpaid_leave_id
                
                # Fetch updated balances
                latest_row = None
                try:
                    latest_row = _fetch_leave_balance(token, employee_id) or balance_row
                except Exception:
                    latest_row = balance_row
                balances = {
                    "Casual Leave": float((latest_row or {}).get("crc6f_cl", 0) or 0),
                    "Sick Leave": float((latest_row or {}).get("crc6f_sl", 0) or 0),
                    "Comp Off": float((latest_row or {}).get("crc6f_compoff", 0) or 0),
                }
                balances["Total"] = balances["Casual Leave"] + balances["Sick Leave"] + balances["Comp Off"]
                
                # Send notification email
                try:
                    admin_email = os.getenv("ADMIN_EMAIL")
                    employee_name = get_employee_name(employee_id)
                    if admin_email:
                        send_email(
                            subject=f"[AI Assistant] New Leave Request from {employee_id}",
                            recipients=[admin_email],
                            body=f"""
Employee {employee_name} ({employee_id}) has applied for {leave_type} leave via AI Assistant
from {start_date} to {end_date} ({leave_days} days).

Paid: {paid_days} day(s)
Unpaid: {unpaid_days} day(s)

Reason: {reason or 'Not provided'}

Please review in HR Tool.
""")
                except Exception as mail_err:
                    print(f"[WARN] Failed to send notification email: {mail_err}")
                
                split_msg = ""
                if unpaid_days > 0:
                    split_msg = f"\n\n📊 **Split:** {int(paid_days)} day(s) Paid + {int(unpaid_days)} day(s) Unpaid (insufficient balance)"
                
                return {
                    "success": True,
                    "message": f"Leave applied successfully!{split_msg}",
                    "leave_id": primary_leave_id,
                    "leave_days": leave_days,
                    "balances": balances,
                    "split": {
                        "paid_days": paid_days,
                        "unpaid_days": unpaid_days,
                    }
                }
            
            # Handle other leave types (Comp Off) or Unpaid leaves
            if paid_flag:
                if not balance_row:
                    balance_row = _ensure_leave_balance_row(token, employee_id)
                available = _get_available_days(balance_row, leave_type)
                print(f"🔎 Available days for {leave_type} = {available}, requested = {leave_days}")
                if float(available) < float(leave_days):
                    return {
                        "success": False,
                        "error": f"Insufficient {leave_type} balance. Available: {available}, requested: {leave_days}. Please choose Unpaid or adjust dates.",
                        "available": available,
                        "requested": leave_days,
                        "leave_type": leave_type
                    }
            
            # Create single leave record
            record_data = {
                "crc6f_leaveid": leave_id,
                "crc6f_leavetype": leave_type,
                "crc6f_startdate": start_date,
                "crc6f_enddate": end_date,
                "crc6f_paidunpaid": compensation,
                "crc6f_status": "Pending",
                "crc6f_totaldays": str(leave_days),
                "crc6f_employeeid": employee_id,
                "crc6f_approvedby": "",
            }
            
            print(f"📦 Creating leave record: {record_data}")
            created_record = create_record(LEAVE_ENTITY, record_data)
            
            # Decrement balance if paid
            try:
                if paid_flag and leave_days > 0:
                    _decrement_leave_balance(token, balance_row, leave_type, leave_days)
            except Exception as dec_err:
                print(f"[WARN] Failed to decrement leave balance: {dec_err}")
            
            # Fetch updated balances
            latest_row = None
            try:
                latest_row = _fetch_leave_balance(token, employee_id) or balance_row
            except Exception:
                latest_row = balance_row
            balances = {
                "Casual Leave": float((latest_row or {}).get("crc6f_cl", 0) or 0),
                "Sick Leave": float((latest_row or {}).get("crc6f_sl", 0) or 0),
                "Comp Off": float((latest_row or {}).get("crc6f_compoff", 0) or 0),
            }
            balances["Total"] = balances["Casual Leave"] + balances["Sick Leave"] + balances["Comp Off"]
            
            # Send notification email
            try:
                admin_email = os.getenv("ADMIN_EMAIL")
                employee_name = get_employee_name(employee_id)
                if admin_email:
                    send_email(
                        subject=f"[AI Assistant] New Leave Request from {employee_id}",
                        recipients=[admin_email],
                        body=f"""
Employee {employee_name} ({employee_id}) has applied for {leave_type} leave via AI Assistant
from {start_date} to {end_date} ({leave_days} days).

Compensation: {compensation}
Reason: {reason or 'Not provided'}

Please review in HR Tool.
""")
            except Exception as mail_err:
                print(f"[WARN] Failed to send notification email: {mail_err}")
            
            return {
                "success": True,
                "message": f"Leave applied successfully for {employee_id}!",
                "leave_id": leave_id,
                "leave_days": leave_days,
                "balances": balances
            }
            
        except Exception as e:
            import traceback
            traceback.print_exc()
            return {
                "success": False,
                "error": f"Error applying leave: {str(e)}"
            }
    
    # ==================== CHECK-IN ====================
    def _normalize_emp_for_attendance(raw_value: Optional[str]) -> str:
        value = str(raw_value or "").strip().upper()
        if not value:
            return ""
        if value.isdigit():
            return f"EMP{int(value):03d}"
        return value

    def _format_local_display_time(utc_iso: str, display_time: str, tz_name: str, tz_offset_minutes: Optional[int]) -> str:
        """Best-effort conversion to client-local HH:MM:SS for chat messages."""
        dt_utc = None
        try:
            if utc_iso:
                dt_utc = datetime.fromisoformat(str(utc_iso).replace("Z", "+00:00"))
        except Exception:
            dt_utc = None

        if dt_utc is not None:
            if tz_offset_minutes is not None:
                try:
                    offset = int(tz_offset_minutes)
                    # JS getTimezoneOffset semantics: local = utc - offset_minutes
                    return (dt_utc - timedelta(minutes=offset)).strftime("%H:%M:%S")
                except Exception:
                    pass

            try:
                from zoneinfo import ZoneInfo
                if tz_name:
                    return dt_utc.astimezone(ZoneInfo(tz_name)).strftime("%H:%M:%S")
            except Exception:
                pass

            return dt_utc.strftime("%H:%M:%S")

        return str(display_time or "")

    def _invoke_attendance_v2(
        action_type: str,
        employee_id: str,
        tz_name: str = "UTC",
        tz_offset_minutes: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Invoke attendance v2 handlers via Flask request context for consistent behavior."""
        from unified_server import app
        from attendance_service_v2 import checkin_v2, checkout_v2

        normalized_emp = _normalize_emp_for_attendance(employee_id)
        if not normalized_emp:
            return {
                "success": False,
                "error": "Employee ID is required.",
            }

        is_checkin = action_type == "check_in"
        endpoint = "/api/v2/attendance/checkin" if is_checkin else "/api/v2/attendance/checkout"
        handler = checkin_v2 if is_checkin else checkout_v2
        payload = {
            "employee_id": normalized_emp,
            "timezone": tz_name or "UTC",
            "timezone_offset_minutes": tz_offset_minutes,
        }

        with app.test_request_context(endpoint, method="POST", json=payload):
            raw_response = handler()

        status_code = 200
        response_obj = raw_response
        if isinstance(raw_response, tuple):
            response_obj = raw_response[0]
            if len(raw_response) > 1 and isinstance(raw_response[1], int):
                status_code = raw_response[1]
        elif hasattr(raw_response, "status_code"):
            status_code = int(raw_response.status_code)

        body = response_obj.get_json(silent=True) if hasattr(response_obj, "get_json") else None
        body = body or {}

        if not body.get("success") or status_code >= 400:
            err = (body.get("error") or "").strip()
            if err == "NO_ACTIVE_SESSION":
                return {
                    "success": False,
                    "error": "❌ No active check-in found for today. If you already checked in from another device/session, refresh and try again.",
                }
            if err == "MISSING_EMPLOYEE_ID":
                return {
                    "success": False,
                    "error": "Employee ID is required for attendance action.",
                }
            return {
                "success": False,
                "error": err or "Attendance action failed.",
            }

        display = body.get("display") or {}
        total_seconds = int(body.get("total_seconds_today") or 0)
        total_hours = round(total_seconds / 3600.0, 2)

        if is_checkin:
            checkin_time = _format_local_display_time(
                body.get("checkin_utc"),
                display.get("checkin_local") or display.get("checkin"),
                tz_name,
                tz_offset_minutes,
            )
            msg_time = f" at **{checkin_time}**" if checkin_time else ""
            return {
                "success": True,
                "message": f"✅ Checked in successfully{msg_time}.",
                "checkin_time": checkin_time,
                "total_seconds_today": total_seconds,
                "total_hours": total_hours,
            }

        checkout_time = _format_local_display_time(
            body.get("checkout_utc"),
            display.get("checkout_local") or display.get("checkout"),
            tz_name,
            tz_offset_minutes,
        )
        duration_text = display.get("duration_text") or display.get("session_text") or ""
        msg_time = f" at **{checkout_time}**" if checkout_time else ""
        msg_duration = f"\n\n📊 **Today's total:** {duration_text}" if duration_text else ""
        return {
            "success": True,
            "message": f"✅ Checked out successfully{msg_time}.{msg_duration}",
            "checkout_time": checkout_time,
            "duration": duration_text,
            "total_seconds_today": total_seconds,
            "total_hours": total_hours,
        }

    if action["type"] == "check_in":
        try:
            employee_id = action.get("employee_id", "")
            tz_name = action.get("timezone", "UTC")
            tz_offset_minutes = action.get("timezone_offset_minutes")
            return _invoke_attendance_v2("check_in", employee_id, tz_name, tz_offset_minutes)
        except Exception as e:
            import traceback
            traceback.print_exc()
            return {
                "success": False,
                "error": f"Check-in failed: {str(e)}"
            }
    
    # ==================== CHECK-OUT ====================
    if action["type"] == "check_out":
        try:
            employee_id = action.get("employee_id", "")
            tz_name = action.get("timezone", "UTC")
            tz_offset_minutes = action.get("timezone_offset_minutes")
            return _invoke_attendance_v2("check_out", employee_id, tz_name, tz_offset_minutes)
        except Exception as e:
            import traceback
            traceback.print_exc()
            return {
                "success": False,
                "error": f"Check-out failed: {str(e)}"
            }
    
    # ==================== CREATE ASSET ====================
    if action["type"] == "create_asset":
        try:
            import requests as req
            from unified_server import (
                RESOURCE, get_access_token, create_record
            )
            
            data = action["data"]
            
            asset_name = data.get('asset_name', '')
            serial_number = data.get('serial_number', '')
            category = data.get('category', '')
            location = data.get('location', '')
            status = data.get('status', 'In Use')
            assigned_to = data.get('assigned_to', '')
            employee_id = data.get('employee_id', '')
            assigned_on = data.get('assigned_on', '')
            
            # Asset entity name
            ASSET_ENTITY = "crc6f_hr_assetdetailses"
            API_BASE = f"{RESOURCE}/api/data/v9.2"
            
            # Generate asset ID based on category
            category_prefix_map = {
                "Laptop": "LP",
                "Monitor": "MO",
                "Charger": "CH",
                "Keyboard": "KB",
                "Headset": "HS",
                "Accessory": "AC",
            }
            prefix = category_prefix_map.get(category, "GEN")
            
            # Count existing assets in this category to generate unique ID
            headers = {"Authorization": f"Bearer {token}"}
            try:
                filter_url = f"{API_BASE}/{ASSET_ENTITY}?$filter=crc6f_assetcategory eq '{category}'&$count=true"
                resp = req.get(filter_url, headers=headers, timeout=20)
                if resp.status_code == 200:
                    existing_count = len(resp.json().get('value', []))
                else:
                    existing_count = 0
            except Exception:
                existing_count = 0
            
            asset_id = f"{prefix}-{existing_count + 1}"
            
            # Check for duplicate asset ID (just in case)
            try:
                check_url = f"{API_BASE}/{ASSET_ENTITY}?$filter=crc6f_assetid eq '{asset_id}'"
                resp = req.get(check_url, headers=headers, timeout=20)
                if resp.status_code == 200:
                    existing = resp.json().get('value', [])
                    if existing:
                        # Generate a unique ID with timestamp
                        import time
                        asset_id = f"{prefix}-{existing_count + 1}-{int(time.time()) % 10000}"
            except Exception:
                pass
            
            # Build the payload for Dataverse
            payload = {
                "crc6f_assetid": asset_id,
                "crc6f_assetname": asset_name,
                "crc6f_serialnumber": serial_number,
                "crc6f_assetcategory": category,
                "crc6f_location": location,
                "crc6f_assetstatus": status,
            }
            
            # Add optional fields if provided
            if assigned_to:
                payload["crc6f_assignedto"] = assigned_to
            if employee_id:
                payload["crc6f_employeeid"] = employee_id
            if assigned_on:
                payload["crc6f_assignedon"] = assigned_on
            
            # Create the asset record
            created = create_record(ASSET_ENTITY, payload)
            
            return {
                "success": True,
                "message": f"Asset **{asset_name}** (ID: {asset_id}) created successfully! 📦",
                "asset_id": asset_id,
                "data": {
                    "asset_id": asset_id,
                    "asset_name": asset_name,
                    "serial_number": serial_number,
                    "category": category,
                    "location": location,
                    "status": status,
                    "assigned_to": assigned_to,
                    "employee_id": employee_id,
                    "assigned_on": assigned_on
                }
            }
            
        except Exception as e:
            import traceback
            traceback.print_exc()
            return {
                "success": False,
                "error": f"Failed to create asset: {str(e)}"
            }
    
    # ==================== FETCH MY TASKS ====================
    if action["type"] == "fetch_my_tasks":
        try:
            import requests as req
            import os as _os
            from dataverse_helper import get_access_token
            
            employee_id = action.get("employee_id", "")
            employee_name = action.get("employee_name") or ""
            employee_email = action.get("employee_email") or ""
            
            if not employee_id:
                return {
                    "success": False,
                    "error": "Employee ID is required to fetch tasks."
                }
            
            # Normalize employee ID
            emp_id_upper = employee_id.upper()
            emp_id_lower = employee_id.lower()
            emp_name_lower = employee_name.lower() if employee_name else ""
            emp_email_lower = employee_email.lower() if employee_email else ""
            
            token = get_access_token()
            headers = {
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "OData-Version": "4.0",
            }
            
            dv_resource = _os.getenv("RESOURCE", "")
            dv_api = "/api/data/v9.2"
            
            all_tasks = []
            
            # ========== 1. Fetch tasks from HR_TaskDetails table ==========
            # This matches what the My Tasks page shows
            try:
                tasks_url = f"{dv_resource}{dv_api}/crc6f_hr_taskdetailses?$select=crc6f_hr_taskdetailsid,crc6f_taskid,crc6f_taskname,crc6f_taskdescription,crc6f_taskpriority,crc6f_taskstatus,crc6f_assignedto,crc6f_assigneddate,crc6f_duedate,crc6f_projectid,crc6f_boardid"
                tasks_resp = req.get(tasks_url, headers=headers, timeout=30)
                if tasks_resp.ok:
                    tasks_data = tasks_resp.json().get("value", [])
                    for t in tasks_data:
                        assigned_to = (t.get("crc6f_assignedto") or "").lower()
                        # Match by employee ID, name, or email
                        if (emp_id_lower and emp_id_lower in assigned_to) or \
                           (emp_name_lower and emp_name_lower in assigned_to) or \
                           (emp_email_lower and emp_email_lower in assigned_to):
                            all_tasks.append({
                                "guid": t.get("crc6f_hr_taskdetailsid"),
                                "task_id": t.get("crc6f_taskid"),
                                "task_name": t.get("crc6f_taskname"),
                                "task_description": t.get("crc6f_taskdescription"),
                                "task_priority": t.get("crc6f_taskpriority"),
                                "task_status": t.get("crc6f_taskstatus"),
                                "assigned_to": t.get("crc6f_assignedto"),
                                "assigned_date": t.get("crc6f_assigneddate"),
                                "due_date": t.get("crc6f_duedate"),
                                "project_id": t.get("crc6f_projectid"),
                                "board_id": t.get("crc6f_boardid"),
                                "source": "tasks_table"
                            })
            except Exception as te:
                print(f"[AI] Error fetching from tasks table: {te}")
            
            # ========== 2. If no tasks found, fetch projects where user is a contributor ==========
            # Only show projects if user has no tasks assigned
            if len(all_tasks) == 0:
                try:
                    # First get project IDs where user is a contributor
                    contrib_url = f"{dv_resource}{dv_api}/crc6f_hr_projectcontributorses?$filter=crc6f_employeeid eq '{emp_id_upper}'&$select=crc6f_projectid,crc6f_hr_projectcontributorsid"
                    contrib_resp = req.get(contrib_url, headers=headers, timeout=30)
                    
                    user_project_ids = set()
                    if contrib_resp.ok:
                        contrib_data = contrib_resp.json().get("value", [])
                        for c in contrib_data:
                            pid = c.get("crc6f_projectid")
                            if pid:
                                user_project_ids.add(pid)
                    
                    # Also check projects where user is the manager
                    projects_url = f"{dv_resource}{dv_api}/crc6f_hr_projectheaders?$select=crc6f_projectid,crc6f_projectname,crc6f_manager,crc6f_projectstatus,crc6f_startdate,crc6f_enddate,crc6f_hr_projectheaderid"
                    projects_resp = req.get(projects_url, headers=headers, timeout=30)
                    
                    if projects_resp.ok:
                        projects_data = projects_resp.json().get("value", [])
                        for p in projects_data:
                            pid = p.get("crc6f_projectid")
                            manager = (p.get("crc6f_manager") or "").lower()
                            
                            # Include if user is contributor OR manager
                            is_contributor = pid in user_project_ids
                            is_manager = (emp_id_lower and emp_id_lower in manager) or \
                                        (emp_name_lower and emp_name_lower in manager) or \
                                        (emp_email_lower and emp_email_lower in manager)
                            
                            if is_contributor or is_manager:
                                # Add project as a "task" so user can start timer on it
                                all_tasks.append({
                                    "guid": p.get("crc6f_hr_projectheaderid"),
                                    "task_id": pid,
                                    "task_name": p.get("crc6f_projectname") or pid,
                                    "task_description": f"Project: {p.get('crc6f_projectname')}",
                                    "task_priority": "Normal",
                                    "task_status": p.get("crc6f_projectstatus") or "Active",
                                    "assigned_to": employee_id,
                                    "assigned_date": p.get("crc6f_startdate"),
                                    "due_date": p.get("crc6f_enddate"),
                                    "project_id": pid,
                                    "board_id": None,
                                    "source": "projects_table",
                                    "is_project": True
                                })
                except Exception as pe:
                    print(f"[AI] Error fetching from projects table: {pe}")
            
            # Deduplicate by guid
            seen_guids = set()
            unique_tasks = []
            for t in all_tasks:
                guid = t.get("guid")
                if guid and guid not in seen_guids:
                    seen_guids.add(guid)
                    unique_tasks.append(t)
            
            return {
                "success": True,
                "tasks": unique_tasks,
                "message": f"Found {len(unique_tasks)} task(s)."
            }
            
        except Exception as e:
            import traceback
            traceback.print_exc()
            return {
                "success": False,
                "error": f"Error fetching tasks: {str(e)}"
            }
    
    # ==================== START TASK TIMER ====================
    if action["type"] == "start_task_timer":
        try:
            employee_id = action.get("employee_id", "")
            task_guid = action.get("task_guid", "")
            task_id = action.get("task_id", "")
            task_name = action.get("task_name", "")
            project_id = action.get("project_id", "")
            
            if not employee_id or not task_guid:
                return {
                    "success": False,
                    "error": "Employee ID and task GUID are required."
                }
            
            return {
                "success": True,
                "message": f"Timer started for **{task_name or task_id}**! ▶️",
                "task_guid": task_guid,
                "task_id": task_id,
                "task_name": task_name,
                "project_id": project_id,
                "employee_id": employee_id,
                "action": "start_timer"
            }
        except Exception as e:
            import traceback
            traceback.print_exc()
            return {
                "success": False,
                "error": f"Error starting task timer: {str(e)}"
            }
    
    # ==================== STOP TASK TIMER ====================
    if action["type"] == "stop_task_timer":
        try:
            employee_id = action.get("employee_id", "")
            
            if not employee_id:
                return {
                    "success": False,
                    "error": "Employee ID is required."
                }
            
            return {
                "success": True,
                "message": "Task timer stopped! ⏹️",
                "employee_id": employee_id,
                "action": "stop_timer"
            }
        except Exception as e:
            import traceback
            traceback.print_exc()
            return {
                "success": False,
                "error": f"Error stopping task timer: {str(e)}"
            }
    
    # ==================== CHAT AUTOMATION ACTIONS ====================
    # These call chat functions directly to avoid HTTP timeout issues on single-worker servers
    
    # Search employee for chat
    if action["type"] == "chat_search_employee":
        try:
            from chats import fuzzy_match_name, dataverse_get, EMPLOYEE_ENTITY_SET
            
            name = action.get("name", "")
            sender_id = action.get("sender_id", "")
            
            # Get all employees
            employees = dataverse_get(EMPLOYEE_ENTITY_SET).get("value", [])
            
            best_match, all_matches = fuzzy_match_name(name, employees)
            
            if not best_match:
                return {
                    "success": False,
                    "error": f"No employee found matching '{name}'"
                }
            
            # Format best match
            emp_id = best_match.get("crc6f_employeeid", "")
            first_name = best_match.get("crc6f_firstname", "") or ""
            last_name = best_match.get("crc6f_lastname", "") or ""
            full_name = f"{first_name} {last_name}".strip()
            
            return {
                "success": True,
                "employee": {
                    "employee_id": emp_id,
                    "name": full_name,
                    "first_name": first_name,
                    "last_name": last_name
                },
                "all_matches": [
                    {
                        "employee_id": m["employee"].get("crc6f_employeeid"),
                        "name": m["name"],
                        "score": m["score"]
                    } for m in all_matches
                ],
                "message": f"Found: **{full_name}** ({emp_id})"
            }
        except Exception as e:
            import traceback
            traceback.print_exc()
            return {
                "success": False,
                "error": f"Error searching employee: {str(e)}"
            }
    
    # Send message via chat
    if action["type"] == "chat_send_message":
        try:
            from chats import (
                get_or_create_conversation, send_message_to_user,
                build_employee_name_map
            )
            
            sender_id = action.get("sender_id", "")
            target_employee_id = action.get("target_employee_id", "")
            message = action.get("message", "")
            
            if not sender_id or not target_employee_id or not message:
                return {
                    "success": False,
                    "error": "Sender ID, target ID, and message are required"
                }
            
            # Get or create conversation
            conversation_id, is_new = get_or_create_conversation(sender_id, target_employee_id)
            
            if not conversation_id:
                return {
                    "success": False,
                    "error": "Failed to create conversation"
                }
            
            # Send the message
            result = send_message_to_user(sender_id, conversation_id, message)
            
            if result.get("success"):
                emp_map = build_employee_name_map()
                recipient_name = emp_map.get(target_employee_id, target_employee_id)
                
                return {
                    "success": True,
                    "message": f"✅ Message sent to **{recipient_name}**!",
                    "message_id": result.get("message_id"),
                    "conversation_id": conversation_id,
                    "recipient_name": recipient_name
                }
            else:
                return {
                    "success": False,
                    "error": result.get("error", "Failed to send message")
                }
        except Exception as e:
            import traceback
            traceback.print_exc()
            return {
                "success": False,
                "error": f"Error sending message: {str(e)}"
            }
    
    # Get unread messages
    if action["type"] == "chat_get_unread":
        try:
            from chats import get_unread_messages_for_user
            
            user_id = action.get("user_id", "")
            
            if not user_id:
                return {
                    "success": False,
                    "error": "User ID is required"
                }
            
            messages = get_unread_messages_for_user(user_id)
            total = len(messages)
            
            if total == 0:
                return {
                    "success": True,
                    "message": "📭 You have no new messages!",
                    "total_unread": 0
                }
            
            # Group by sender
            by_sender = {}
            for msg in messages:
                sender = msg.get("sender_id")
                if sender not in by_sender:
                    by_sender[sender] = {
                        "sender_id": sender,
                        "sender_name": msg.get("sender_name", "Unknown"),
                        "count": 0,
                        "messages": []
                    }
                by_sender[sender]["count"] += 1
                by_sender[sender]["messages"].append(msg)
            
            by_sender_list = list(by_sender.values())
            
            # Format message summary
            lines = [f"📬 **You have {total} message(s):**\n"]
            for sender in by_sender_list[:5]:
                count = sender.get("count", 0)
                name = sender.get("sender_name", "Unknown")
                latest_msg = sender.get("messages", [{}])[0].get("message_text", "")[:50]
                lines.append(f"• **{name}** ({count} message{'s' if count > 1 else ''}): \"{latest_msg}...\"")
            
            if len(by_sender_list) > 5:
                lines.append(f"\n_...and {len(by_sender_list) - 5} more sender(s)_")
            
            return {
                "success": True,
                "message": "\n".join(lines),
                "total_unread": total,
                "by_sender": by_sender_list
            }
        except Exception as e:
            import traceback
            traceback.print_exc()
            return {
                "success": False,
                "error": f"Error fetching messages: {str(e)}"
            }
    
    # Read conversation with specific person
    if action["type"] == "chat_read_conversation":
        try:
            from chats import (
                fuzzy_match_name, get_or_create_conversation,
                dataverse_get, EMPLOYEE_ENTITY_SET, MSG_ENTITY_SET,
                build_employee_name_map
            )
            
            user_id = action.get("user_id", "")
            target_name = action.get("target_name", "")
            
            if not user_id or not target_name:
                return {
                    "success": False,
                    "error": "User ID and target name are required"
                }
            
            # Find target employee
            employees = dataverse_get(EMPLOYEE_ENTITY_SET).get("value", [])
            best_match, _ = fuzzy_match_name(target_name, employees)
            
            if not best_match:
                return {
                    "success": False,
                    "error": f"No employee found matching '{target_name}'"
                }
            
            target_id = best_match.get("crc6f_employeeid")
            target_full_name = f"{best_match.get('crc6f_firstname', '')} {best_match.get('crc6f_lastname', '')}".strip()
            
            # Get conversation
            conversation_id, _ = get_or_create_conversation(user_id, target_id)
            
            if not conversation_id:
                return {
                    "success": True,
                    "message": f"📭 No conversation found with **{target_full_name}**."
                }
            
            # Get messages
            mq = f"$filter=crc6f_conversation_id eq '{conversation_id}'&$orderby=createdon asc&$top=20"
            messages_raw = dataverse_get(MSG_ENTITY_SET, mq).get("value", [])
            
            if not messages_raw:
                return {
                    "success": True,
                    "message": f"📭 No messages found with **{target_full_name}**."
                }
            
            emp_map = build_employee_name_map()
            
            # Format messages
            messages = []
            for msg in messages_raw:
                sender_id = msg.get("crc6f_sender_id")
                is_me = sender_id == user_id
                messages.append({
                    "sender_id": sender_id,
                    "sender_name": emp_map.get(sender_id, sender_id),
                    "message_text": msg.get("crc6f_message_text", ""),
                    "is_me": is_me,
                    "created_on": msg.get("createdon")
                })
            
            # Format conversation
            lines = [f"📖 **Conversation with {target_full_name}:**\n"]
            for msg in messages[-10:]:
                sender = "You" if msg.get("is_me") else msg.get("sender_name", "Them")
                text = msg.get("message_text", "")[:100]
                lines.append(f"**{sender}:** {text}")
            
            return {
                "success": True,
                "message": "\n".join(lines),
                "messages": messages,
                "target_name": target_full_name
            }
        except Exception as e:
            import traceback
            traceback.print_exc()
            return {
                "success": False,
                "error": f"Error reading conversation: {str(e)}"
            }
    
    # Reply to message
    if action["type"] == "chat_reply":
        try:
            from chats import (
                fuzzy_match_name, get_or_create_conversation, send_message_to_user,
                dataverse_get, EMPLOYEE_ENTITY_SET, build_employee_name_map
            )
            
            user_id = action.get("user_id", "")
            target_name = action.get("target_name", "")
            message = action.get("message", "")
            
            if not user_id or not target_name or not message:
                return {
                    "success": False,
                    "error": "User ID, target name, and message are required"
                }
            
            # Find target employee
            employees = dataverse_get(EMPLOYEE_ENTITY_SET).get("value", [])
            best_match, _ = fuzzy_match_name(target_name, employees)
            
            if not best_match:
                return {
                    "success": False,
                    "error": f"No employee found matching '{target_name}'"
                }
            
            target_id = best_match.get("crc6f_employeeid")
            target_full_name = f"{best_match.get('crc6f_firstname', '')} {best_match.get('crc6f_lastname', '')}".strip()
            
            # Get or create conversation
            conversation_id, _ = get_or_create_conversation(user_id, target_id)
            
            if not conversation_id:
                return {
                    "success": False,
                    "error": "Failed to find or create conversation"
                }
            
            # Send reply
            result = send_message_to_user(user_id, conversation_id, message)
            
            if result.get("success"):
                return {
                    "success": True,
                    "message": f"✅ Reply sent to **{target_full_name}**!",
                    "message_id": result.get("message_id"),
                    "recipient_name": target_full_name
                }
            else:
                return {
                    "success": False,
                    "error": result.get("error", "Failed to send reply")
                }
        except Exception as e:
            import traceback
            traceback.print_exc()
            return {
                "success": False,
                "error": f"Error sending reply: {str(e)}"
            }
    
    if action["type"] == "create_project_task":
        try:
            project_code = action.get("project_code")
            payload = action.get("payload") or {}
            if not project_code:
                return {"success": False, "error": "Project code is required."}
            url = f"{BACKEND_API_INTERNAL_URL}/api/projects/{project_code}/tasks"
            resp = requests.post(url, json=payload, timeout=30)
            data = resp.json() if resp.content else {}
            if resp.status_code in (200, 201) and data.get("success", True):
                return {
                    "success": True,
                    "message": data.get("message") or f"Task **{payload.get('task_name')}** created under {project_code}.",
                    "task_id": data.get("task_id") or payload.get("task_name"),
                }
            return {
                "success": False,
                "error": data.get("error") or resp.text or "Task creation failed"
            }
        except Exception as e:
            return {"success": False, "error": f"Error creating task: {e}"}

    if action["type"] == "update_asset_assignment":
        try:
            asset_id = action.get("asset_id")
            payload = {k: v for k, v in (action.get("data") or {}).items() if v not in (None, "")}
            if not asset_id:
                return {"success": False, "error": "Asset ID is required."}
            url = f"{BACKEND_API_INTERNAL_URL}/api/assets/update/{asset_id}"
            resp = requests.patch(url, json=payload, timeout=20)
            data = resp.json() if resp.content else {}
            if resp.status_code == 200 and (data.get("success") or data.get("message")):
                return {
                    "success": True,
                    "message": data.get("message") or f"Asset {asset_id} updated successfully.",
                }
            return {
                "success": False,
                "error": data.get("error") or resp.text or "Asset update failed"
            }
        except Exception as e:
            return {"success": False, "error": f"Error updating asset: {e}"}

    # ==================== FETCH MY PROJECTS ====================
    if action["type"] == "fetch_my_projects":
        try:
            import requests as req
            import os as _os
            from dataverse_helper import get_access_token

            scope = action.get("scope", "mine")
            employee_id = action.get("employee_id", "")
            employee_name = action.get("employee_name", "")
            employee_email = action.get("employee_email", "")

            tk = get_access_token()
            headers = {
                "Authorization": f"Bearer {tk}",
                "Accept": "application/json",
                "OData-Version": "4.0",
            }
            dv = _os.getenv("RESOURCE", "")
            api = "/api/data/v9.2"

            project_url = (
                f"{dv}{api}/crc6f_hr_projectheaders?"
                "$select=crc6f_projectid,crc6f_projectname,crc6f_client,crc6f_manager,"
                "crc6f_projectstatus,crc6f_startdate,crc6f_enddate,crc6f_hr_projectheaderid"
            )
            resp = req.get(project_url, headers=headers, timeout=30)
            projects_data = resp.json().get("value", []) if resp.ok else []

            if scope == "mine" and employee_id:
                emp_lower = employee_id.lower()
                name_lower = (employee_name or "").lower()
                email_lower = (employee_email or "").lower()

                # Also fetch contributor memberships
                contrib_url = f"{dv}{api}/crc6f_hr_projectcontributorses?$filter=crc6f_employeeid eq '{employee_id.upper()}'&$select=crc6f_projectid"
                try:
                    cr = req.get(contrib_url, headers=headers, timeout=30)
                    contrib_pids = {c.get("crc6f_projectid") for c in (cr.json().get("value", []) if cr.ok else [])}
                except Exception:
                    contrib_pids = set()

                filtered = []
                for p in projects_data:
                    pid = p.get("crc6f_projectid") or ""
                    manager = (p.get("crc6f_manager") or "").lower()
                    is_mine = (
                        pid in contrib_pids
                        or (emp_lower and emp_lower in manager)
                        or (name_lower and name_lower in manager)
                        or (email_lower and email_lower in manager)
                    )
                    if is_mine:
                        filtered.append(p)
                projects_data = filtered

            items = []
            for p in projects_data[:30]:
                items.append({
                    "project_id": p.get("crc6f_projectid"),
                    "project_name": p.get("crc6f_projectname"),
                    "client": p.get("crc6f_client"),
                    "manager": p.get("crc6f_manager"),
                    "status": p.get("crc6f_projectstatus"),
                    "start_date": p.get("crc6f_startdate"),
                    "end_date": p.get("crc6f_enddate"),
                    "guid": p.get("crc6f_hr_projectheaderid"),
                })

            if not items:
                return {"success": True, "message": "📁 No projects found.", "projects": []}

            lines = [f"📁 **Projects ({len(items)}):**\n"]
            for i, proj in enumerate(items, 1):
                name = proj.get("project_name") or proj.get("project_id") or "Unnamed"
                status = proj.get("status") or ""
                client = proj.get("client") or ""
                lines.append(f"**{i}.** {name} — {client} ({status})")

            return {
                "success": True,
                "message": "\n".join(lines),
                "projects": items,
            }
        except Exception as e:
            import traceback; traceback.print_exc()
            return {"success": False, "error": f"Error fetching projects: {e}"}

    # ==================== FETCH CLIENTS ====================
    if action["type"] == "fetch_clients":
        try:
            import requests as req
            import os as _os
            from dataverse_helper import get_access_token

            tk = get_access_token()
            headers = {
                "Authorization": f"Bearer {tk}",
                "Accept": "application/json",
                "OData-Version": "4.0",
            }
            dv = _os.getenv("RESOURCE", "")
            api = "/api/data/v9.2"

            client_url = (
                f"{dv}{api}/crc6f_hr_clients?"
                "$select=crc6f_clientid,crc6f_clientname,crc6f_companyname,"
                "crc6f_email,crc6f_phone,crc6f_country,crc6f_address,crc6f_hr_clientid"
                "&$top=100"
            )
            resp = req.get(client_url, headers=headers, timeout=30)
            clients_data = resp.json().get("value", []) if resp.ok else []

            items = []
            for c in clients_data:
                items.append({
                    "client_id": c.get("crc6f_clientid"),
                    "client_name": c.get("crc6f_clientname"),
                    "company_name": c.get("crc6f_companyname"),
                    "email": c.get("crc6f_email"),
                    "phone": c.get("crc6f_phone"),
                    "country": c.get("crc6f_country"),
                    "guid": c.get("crc6f_hr_clientid"),
                })

            if not items:
                return {"success": True, "message": "🏢 No clients found.", "clients": []}

            lines = [f"🏢 **Clients ({len(items)}):**\n"]
            for i, cl in enumerate(items, 1):
                name = cl.get("client_name") or cl.get("company_name") or "Unnamed"
                company = cl.get("company_name") or ""
                lines.append(f"**{i}.** {name} — {company}")

            return {
                "success": True,
                "message": "\n".join(lines),
                "clients": items,
            }
        except Exception as e:
            import traceback; traceback.print_exc()
            return {"success": False, "error": f"Error fetching clients: {e}"}

    # ==================== FETCH INBOX APPROVALS ====================
    if action["type"] == "fetch_inbox_approvals":
        try:
            import requests as req

            employee_id = action.get("employee_id", "")
            status_filter = action.get("status_filter", "all")
            role_level = action.get("role_level", 1)

            # Timesheet submissions
            ts_params = {}
            if role_level < ROLE_ORDER["L2"]:
                ts_params["employee_id"] = employee_id
            if status_filter and status_filter != "all":
                mapped = {"completed": "accepted", "pending": "pending", "rejected": "rejected"}
                ts_params["status"] = mapped.get(status_filter, status_filter)

            ts_items = []
            try:
                ts_resp = req.get(
                    f"{BACKEND_API_INTERNAL_URL}/time-tracker/timesheet/submissions",
                    params=ts_params, timeout=20,
                )
                if ts_resp.ok:
                    ts_items = ts_resp.json().get("items", [])
            except Exception:
                pass

            # Attendance submissions
            att_items = []
            try:
                att_resp = req.get(
                    f"{BACKEND_API_INTERNAL_URL}/api/attendance/submissions",
                    params=ts_params, timeout=20,
                )
                if att_resp.ok:
                    att_items = att_resp.json().get("items", [])
            except Exception:
                pass

            all_items = []
            for t in ts_items:
                all_items.append({
                    "type": "Timesheet",
                    "id": t.get("id") or t.get("entry_id"),
                    "employee_id": t.get("employee_id"),
                    "status": t.get("status"),
                    "submitted_at": t.get("submitted_at"),
                    "details": t.get("description") or t.get("project_id") or "",
                })
            for a in att_items:
                all_items.append({
                    "type": "Attendance",
                    "id": a.get("id") or a.get("marker_id"),
                    "employee_id": a.get("employee_id"),
                    "status": a.get("status"),
                    "submitted_at": a.get("submitted_at"),
                    "details": a.get("month") or "",
                })

            if not all_items:
                return {"success": True, "message": "📥 No inbox approvals found.", "approvals": []}

            pending_count = sum(1 for i in all_items if (i.get("status") or "").lower() == "pending")
            accepted_count = sum(1 for i in all_items if (i.get("status") or "").lower() in ("accepted", "approved"))
            rejected_count = sum(1 for i in all_items if (i.get("status") or "").lower() == "rejected")

            lines = [f"📥 **Inbox Approvals ({len(all_items)} total):**\n"]
            lines.append(f"• Pending: **{pending_count}**")
            lines.append(f"• Accepted: **{accepted_count}**")
            lines.append(f"• Rejected: **{rejected_count}**\n")

            shown = all_items[:15]
            for i, item in enumerate(shown, 1):
                typ = item.get("type", "")
                status = item.get("status", "")
                emp = item.get("employee_id", "")
                details = item.get("details", "")
                lines.append(f"**{i}.** [{typ}] {emp} — {status} {details}")

            if len(all_items) > 15:
                lines.append(f"\n_…and {len(all_items) - 15} more_")

            return {
                "success": True,
                "message": "\n".join(lines),
                "approvals": all_items,
                "pending_count": pending_count,
                "accepted_count": accepted_count,
                "rejected_count": rejected_count,
            }
        except Exception as e:
            import traceback; traceback.print_exc()
            return {"success": False, "error": f"Error fetching inbox: {e}"}

    # ==================== CREATE PROJECT ====================
    if action["type"] == "create_project":
        try:
            import requests as req
            import os as _os
            import time
            from dataverse_helper import get_access_token, create_record as dv_create

            data = action.get("data") or {}
            project_name = (data.get("project_name") or "").strip()
            client_name = (data.get("client_name") or "").strip()
            if not project_name or not client_name:
                return {"success": False, "error": "Project name and client are required."}

            # Auto-generate project ID
            prefix = "".join(c for c in project_name[:4].upper() if c.isalpha()) or "PROJ"
            project_id = f"{prefix}{int(time.time()) % 100000}"

            entity = "crc6f_hr_projectheaders"
            payload = {
                "crc6f_projectid": project_id,
                "crc6f_projectname": project_name,
                "crc6f_client": client_name,
                "crc6f_projectstatus": data.get("status") or "Active",
            }
            if data.get("start_date"):
                payload["crc6f_startdate"] = data["start_date"]
            if data.get("manager"):
                payload["crc6f_manager"] = data["manager"]
            if data.get("description"):
                payload["crc6f_projectdescription"] = data["description"]

            dv_create(entity, payload)

            return {
                "success": True,
                "message": f"📁 Project **{project_name}** (ID: {project_id}) created successfully!",
                "project_id": project_id,
            }
        except Exception as e:
            import traceback; traceback.print_exc()
            return {"success": False, "error": f"Error creating project: {e}"}

    # ==================== CREATE CLIENT ====================
    if action["type"] == "create_client":
        try:
            import time
            from dataverse_helper import create_record as dv_create

            data = action.get("data") or {}
            client_name = (data.get("client_name") or "").strip()
            company_name = (data.get("company_name") or "").strip()
            if not client_name or not company_name:
                return {"success": False, "error": "Client name and company are required."}

            prefix = "".join(c for c in company_name[:3].upper() if c.isalpha()) or "CLI"
            client_id = f"{prefix}{int(time.time()) % 100000}"

            entity = "crc6f_hr_clients"
            payload = {
                "crc6f_clientid": client_id,
                "crc6f_clientname": client_name,
                "crc6f_companyname": company_name,
            }
            if data.get("email"):
                payload["crc6f_email"] = data["email"]
            if data.get("phone"):
                payload["crc6f_phone"] = data["phone"]
            if data.get("country"):
                payload["crc6f_country"] = data["country"]
            if data.get("address"):
                payload["crc6f_address"] = data["address"]

            dv_create(entity, payload)

            return {
                "success": True,
                "message": f"🏢 Client **{client_name}** ({company_name}, ID: {client_id}) created successfully!",
                "client_id": client_id,
            }
        except Exception as e:
            import traceback; traceback.print_exc()
            return {"success": False, "error": f"Error creating client: {e}"}

    # ==================== DELETE PROJECT ====================
    if action["type"] == "delete_project":
        try:
            import requests as req
            import os as _os
            from dataverse_helper import get_access_token

            identifier = (action.get("project_identifier") or "").strip()
            if not identifier:
                return {"success": False, "error": "Project identifier is required."}

            tk = get_access_token()
            headers = {
                "Authorization": f"Bearer {tk}",
                "Accept": "application/json",
                "OData-Version": "4.0",
            }
            dv = _os.getenv("RESOURCE", "")
            api = "/api/data/v9.2"

            safe_id = identifier.replace("'", "''")
            search_url = (
                f"{dv}{api}/crc6f_hr_projectheaders?"
                f"$filter=crc6f_projectid eq '{safe_id}' or crc6f_projectname eq '{safe_id}'"
                "&$select=crc6f_hr_projectheaderid,crc6f_projectid,crc6f_projectname"
                "&$top=1"
            )
            resp = req.get(search_url, headers=headers, timeout=30)
            records = resp.json().get("value", []) if resp.ok else []
            if not records:
                return {"success": False, "error": f"Project '{identifier}' not found."}

            record_id = records[0].get("crc6f_hr_projectheaderid")
            proj_name = records[0].get("crc6f_projectname") or identifier

            del_resp = req.delete(
                f"{BACKEND_API_INTERNAL_URL}/api/projects/{record_id}",
                timeout=20,
            )
            if del_resp.ok:
                return {"success": True, "message": f"🗑️ Project **{proj_name}** deleted successfully."}
            return {"success": False, "error": del_resp.text or "Delete failed"}
        except Exception as e:
            import traceback; traceback.print_exc()
            return {"success": False, "error": f"Error deleting project: {e}"}

    # ==================== EDIT PROJECT ====================
    if action["type"] == "edit_project":
        try:
            import requests as req
            import os as _os
            from dataverse_helper import get_access_token

            identifier = (action.get("project_identifier") or "").strip()
            field = action.get("field", "")
            value = action.get("value", "")
            if not identifier or not field:
                return {"success": False, "error": "Project identifier and field are required."}

            tk = get_access_token()
            headers = {
                "Authorization": f"Bearer {tk}",
                "Accept": "application/json",
                "OData-Version": "4.0",
            }
            dv = _os.getenv("RESOURCE", "")
            api = "/api/data/v9.2"

            safe_id = identifier.replace("'", "''")
            search_url = (
                f"{dv}{api}/crc6f_hr_projectheaders?"
                f"$filter=crc6f_projectid eq '{safe_id}' or crc6f_projectname eq '{safe_id}'"
                "&$select=crc6f_hr_projectheaderid,crc6f_projectid,crc6f_projectname"
                "&$top=1"
            )
            resp = req.get(search_url, headers=headers, timeout=30)
            records = resp.json().get("value", []) if resp.ok else []
            if not records:
                return {"success": False, "error": f"Project '{identifier}' not found."}

            record_id = records[0].get("crc6f_hr_projectheaderid")
            proj_name = records[0].get("crc6f_projectname") or identifier

            patch_resp = req.patch(
                f"{BACKEND_API_INTERNAL_URL}/api/projects/{record_id}",
                json={field: value},
                timeout=20,
            )
            if patch_resp.ok:
                return {"success": True, "message": f"✏️ Project **{proj_name}** updated successfully."}
            return {"success": False, "error": patch_resp.text or "Update failed"}
        except Exception as e:
            import traceback; traceback.print_exc()
            return {"success": False, "error": f"Error editing project: {e}"}

    # ==================== DELETE CLIENT ====================
    if action["type"] == "delete_client":
        try:
            import requests as req
            import os as _os
            from dataverse_helper import get_access_token

            identifier = (action.get("client_identifier") or "").strip()
            if not identifier:
                return {"success": False, "error": "Client identifier is required."}

            tk = get_access_token()
            headers = {
                "Authorization": f"Bearer {tk}",
                "Accept": "application/json",
                "OData-Version": "4.0",
            }
            dv = _os.getenv("RESOURCE", "")
            api = "/api/data/v9.2"

            safe_id = identifier.replace("'", "''")
            search_url = (
                f"{dv}{api}/crc6f_hr_clients?"
                f"$filter=crc6f_clientid eq '{safe_id}' or crc6f_clientname eq '{safe_id}'"
                "&$select=crc6f_hr_clientid,crc6f_clientid,crc6f_clientname"
                "&$top=1"
            )
            resp = req.get(search_url, headers=headers, timeout=30)
            records = resp.json().get("value", []) if resp.ok else []
            if not records:
                return {"success": False, "error": f"Client '{identifier}' not found."}

            record_id = records[0].get("crc6f_hr_clientid")
            cl_name = records[0].get("crc6f_clientname") or identifier

            del_resp = req.delete(
                f"{BACKEND_API_INTERNAL_URL}/api/clients/{record_id}",
                timeout=20,
            )
            if del_resp.ok:
                return {"success": True, "message": f"🗑️ Client **{cl_name}** deleted successfully."}
            return {"success": False, "error": del_resp.text or "Delete failed"}
        except Exception as e:
            import traceback; traceback.print_exc()
            return {"success": False, "error": f"Error deleting client: {e}"}

    # ==================== EDIT CLIENT ====================
    if action["type"] == "edit_client":
        try:
            import requests as req
            import os as _os
            from dataverse_helper import get_access_token

            identifier = (action.get("client_identifier") or "").strip()
            field = action.get("field", "")
            value = action.get("value", "")
            if not identifier or not field:
                return {"success": False, "error": "Client identifier and field are required."}

            tk = get_access_token()
            headers = {
                "Authorization": f"Bearer {tk}",
                "Accept": "application/json",
                "OData-Version": "4.0",
            }
            dv = _os.getenv("RESOURCE", "")
            api = "/api/data/v9.2"

            safe_id = identifier.replace("'", "''")
            search_url = (
                f"{dv}{api}/crc6f_hr_clients?"
                f"$filter=crc6f_clientid eq '{safe_id}' or crc6f_clientname eq '{safe_id}'"
                "&$select=crc6f_hr_clientid,crc6f_clientid,crc6f_clientname"
                "&$top=1"
            )
            resp = req.get(search_url, headers=headers, timeout=30)
            records = resp.json().get("value", []) if resp.ok else []
            if not records:
                return {"success": False, "error": f"Client '{identifier}' not found."}

            record_id = records[0].get("crc6f_hr_clientid")
            cl_name = records[0].get("crc6f_clientname") or identifier

            patch_resp = req.patch(
                f"{BACKEND_API_INTERNAL_URL}/api/clients/{record_id}",
                json={field: value},
                timeout=20,
            )
            if patch_resp.ok:
                return {"success": True, "message": f"✏️ Client **{cl_name}** updated successfully."}
            return {"success": False, "error": patch_resp.text or "Update failed"}
        except Exception as e:
            import traceback; traceback.print_exc()
            return {"success": False, "error": f"Error editing client: {e}"}

    # ==================== APPROVE INBOX SUBMISSION ====================
    if action["type"] == "approve_inbox_submission":
        try:
            import requests as req
            target_emp = action.get("target_employee_id", "")
            decided_by = action.get("decided_by", "")
            if not target_emp:
                return {"success": False, "error": "Target employee ID is required."}

            approved_count = 0
            errors = []

            # Approve timesheet submissions
            try:
                ts_resp = req.get(
                    f"{BACKEND_API_INTERNAL_URL}/time-tracker/timesheet/submissions",
                    params={"employee_id": target_emp, "status": "pending"},
                    timeout=20,
                )
                if ts_resp.ok:
                    for item in ts_resp.json().get("items", []):
                        entry_id = item.get("id") or item.get("entry_id")
                        if entry_id:
                            r = req.post(
                                f"{BACKEND_API_INTERNAL_URL}/time-tracker/timesheet/{entry_id}/approve",
                                json={"decided_by": decided_by},
                                timeout=15,
                            )
                            if r.ok and r.json().get("success"):
                                approved_count += 1
                            else:
                                errors.append(f"Timesheet {entry_id}: {r.text}")
            except Exception as te:
                errors.append(f"Timesheet error: {te}")

            # Approve attendance submissions
            try:
                att_resp = req.get(
                    f"{BACKEND_API_INTERNAL_URL}/api/attendance/submissions",
                    params={"employee_id": target_emp, "status": "pending"},
                    timeout=20,
                )
                if att_resp.ok:
                    for item in att_resp.json().get("items", []):
                        marker_id = item.get("id") or item.get("marker_id")
                        if marker_id:
                            r = req.post(
                                f"{BACKEND_API_INTERNAL_URL}/api/attendance/submissions/{marker_id}/approve",
                                json={},
                                timeout=15,
                            )
                            if r.ok and r.json().get("success"):
                                approved_count += 1
                            else:
                                errors.append(f"Attendance {marker_id}: {r.text}")
            except Exception as ae:
                errors.append(f"Attendance error: {ae}")

            if approved_count == 0 and errors:
                return {"success": False, "error": f"Could not approve submissions for {target_emp}. {'; '.join(errors)}"}
            if approved_count == 0:
                return {"success": True, "message": f"📥 No pending submissions found for **{target_emp}**."}
            msg = f"✅ Approved **{approved_count}** submission(s) for **{target_emp}**."
            if errors:
                msg += f"\n⚠️ Some failed: {'; '.join(errors)}"
            return {"success": True, "message": msg}
        except Exception as e:
            import traceback; traceback.print_exc()
            return {"success": False, "error": f"Error approving submissions: {e}"}

    # ==================== REJECT INBOX SUBMISSION ====================
    if action["type"] == "reject_inbox_submission":
        try:
            import requests as req
            target_emp = action.get("target_employee_id", "")
            decided_by = action.get("decided_by", "")
            reason = action.get("reason", "")
            if not target_emp:
                return {"success": False, "error": "Target employee ID is required."}

            rejected_count = 0
            errors = []

            # Reject timesheet submissions
            try:
                ts_resp = req.get(
                    f"{BACKEND_API_INTERNAL_URL}/time-tracker/timesheet/submissions",
                    params={"employee_id": target_emp, "status": "pending"},
                    timeout=20,
                )
                if ts_resp.ok:
                    for item in ts_resp.json().get("items", []):
                        entry_id = item.get("id") or item.get("entry_id")
                        if entry_id:
                            r = req.post(
                                f"{BACKEND_API_INTERNAL_URL}/time-tracker/timesheet/{entry_id}/reject",
                                json={"decided_by": decided_by, "comment": reason},
                                timeout=15,
                            )
                            if r.ok and r.json().get("success"):
                                rejected_count += 1
                            else:
                                errors.append(f"Timesheet {entry_id}: {r.text}")
            except Exception as te:
                errors.append(f"Timesheet error: {te}")

            # Reject attendance submissions
            try:
                att_resp = req.get(
                    f"{BACKEND_API_INTERNAL_URL}/api/attendance/submissions",
                    params={"employee_id": target_emp, "status": "pending"},
                    timeout=20,
                )
                if att_resp.ok:
                    for item in att_resp.json().get("items", []):
                        marker_id = item.get("id") or item.get("marker_id")
                        if marker_id:
                            r = req.post(
                                f"{BACKEND_API_INTERNAL_URL}/api/attendance/submissions/{marker_id}/reject",
                                json={"reason": reason},
                                timeout=15,
                            )
                            if r.ok and r.json().get("success"):
                                rejected_count += 1
                            else:
                                errors.append(f"Attendance {marker_id}: {r.text}")
            except Exception as ae:
                errors.append(f"Attendance error: {ae}")

            if rejected_count == 0 and errors:
                return {"success": False, "error": f"Could not reject submissions for {target_emp}. {'; '.join(errors)}"}
            if rejected_count == 0:
                return {"success": True, "message": f"📥 No pending submissions found for **{target_emp}**."}
            msg = f"❌ Rejected **{rejected_count}** submission(s) for **{target_emp}**."
            if errors:
                msg += f"\n⚠️ Some failed: {'; '.join(errors)}"
            return {"success": True, "message": msg}
        except Exception as e:
            import traceback; traceback.print_exc()
            return {"success": False, "error": f"Error rejecting submissions: {e}"}

    return {
        "success": False,
        "error": f"Unknown action type: {action.get('type')}"
    }
