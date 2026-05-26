"""
Overdue Tasks Notification System
Checks for overdue tasks and sends email notifications to L2, L3, and assigned users.
"""

from flask import Blueprint, jsonify
from datetime import datetime, timezone, date
import os
import json
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from dataverse_helper import get_access_token, get_dataverse_session
import traceback

bp_overdue = Blueprint("overdue_tasks", __name__, url_prefix="/api")

# Dataverse config
RESOURCE = os.getenv("RESOURCE")
DV_API = os.getenv("DATAVERSE_API", "/api/data/v9.2")
ENTITY_SET_TASKS = "crc6f_hr_taskdetailses"
ENTITY_SET_EMPLOYEES = "crc6f_table12s"
ENTITY_SET_PROJECTS = "crc6f_hr_projectheaders"

# Email config (using existing MAIL_* variables from id.env)
SMTP_HOST = os.getenv("MAIL_SERVER", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("MAIL_PORT", "587"))
SMTP_USER = os.getenv("MAIL_USERNAME", "")
SMTP_PASSWORD = os.getenv("MAIL_PASSWORD", "")
FROM_EMAIL = os.getenv("MAIL_DEFAULT_SENDER", SMTP_USER)
FRONTEND_BASE_URL = os.getenv("FRONTEND_BASE_URL", "https://officehub360.vtabsquare.com")

# File to track last notification dates (prevent duplicate daily emails)
NOTIFICATION_LOG_FILE = os.path.join(os.path.dirname(__file__), "overdue_notifications.json")


def _load_notification_log():
    """Load the log of when we last notified about each task."""
    try:
        if os.path.exists(NOTIFICATION_LOG_FILE):
            with open(NOTIFICATION_LOG_FILE, 'r') as f:
                return json.load(f)
    except Exception:
        pass
    return {}


def _save_notification_log(log):
    """Save the notification log."""
    try:
        with open(NOTIFICATION_LOG_FILE, 'w') as f:
            json.dump(log, f, indent=2)
    except Exception as e:
        print(f"[OVERDUE] Failed to save notification log: {e}")


def _get_l2_l3_employees(headers):
    """Fetch all L2 and L3 employees from Dataverse."""
    try:
        # Fetch employees with role L2 or L3
        url = f"{RESOURCE}{DV_API}/{ENTITY_SET_EMPLOYEES}?$select=crc6f_employeeid,crc6f_name,crc6f_email,crc6f_role&$filter=(crc6f_role eq 'L2' or crc6f_role eq 'L3')"
        resp = get_dataverse_session().get(url, headers=headers, timeout=30)
        if resp.ok:
            employees = resp.json().get("value", [])
            return [
                {
                    "id": e.get("crc6f_employeeid"),
                    "name": e.get("crc6f_name"),
                    "email": e.get("crc6f_email"),
                    "role": e.get("crc6f_role")
                }
                for e in employees if e.get("crc6f_email")
            ]
    except Exception as e:
        print(f"[OVERDUE] Failed to fetch L2/L3 employees: {e}")
    return []


def _get_employee_by_id(emp_id, headers):
    """Fetch employee details by ID."""
    try:
        url = f"{RESOURCE}{DV_API}/{ENTITY_SET_EMPLOYEES}?$select=crc6f_employeeid,crc6f_name,crc6f_email&$filter=crc6f_employeeid eq '{emp_id}'"
        resp = get_dataverse_session().get(url, headers=headers, timeout=15)
        if resp.ok:
            employees = resp.json().get("value", [])
            if employees:
                e = employees[0]
                return {
                    "id": e.get("crc6f_employeeid"),
                    "name": e.get("crc6f_name"),
                    "email": e.get("crc6f_email")
                }
    except Exception as e:
        print(f"[OVERDUE] Failed to fetch employee {emp_id}: {e}")
    return None


def _parse_assigned_to(assigned_to_str):
    """Extract employee IDs from assigned_to string (e.g., 'EMP001, EMP002')."""
    if not assigned_to_str:
        return []
    # Split by comma and extract employee IDs
    parts = [p.strip() for p in str(assigned_to_str).split(',')]
    emp_ids = []
    for part in parts:
        # Extract EMP### pattern
        if part.upper().startswith('EMP'):
            emp_ids.append(part.upper())
    return emp_ids


def _get_project_name(project_id, headers):
    """Fetch project name by ID."""
    try:
        url = f"{RESOURCE}{DV_API}/{ENTITY_SET_PROJECTS}?$select=crc6f_projectid,crc6f_projectname&$filter=crc6f_projectid eq '{project_id}'"
        resp = get_dataverse_session().get(url, headers=headers, timeout=15)
        if resp.ok:
            projects = resp.json().get("value", [])
            if projects:
                return projects[0].get("crc6f_projectname", project_id)
    except Exception:
        pass
    return project_id


def _send_email(to_emails, subject, body_html):
    """Send an email notification."""
    if not SMTP_USER or not SMTP_PASSWORD:
        print("[OVERDUE] Email not configured. Skipping email send.")
        return False
    
    if not to_emails:
        print("[OVERDUE] No recipient emails provided.")
        return False
    
    try:
        msg = MIMEMultipart('alternative')
        msg['From'] = FROM_EMAIL
        msg['To'] = ', '.join(to_emails)
        msg['Subject'] = subject
        
        html_part = MIMEText(body_html, 'html')
        msg.attach(html_part)
        
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
            server.starttls()
            server.login(SMTP_USER, SMTP_PASSWORD)
            server.send_message(msg)
        
        print(f"[OVERDUE] Email sent to: {', '.join(to_emails)}")
        return True
    except Exception as e:
        print(f"[OVERDUE] Failed to send email: {e}")
        traceback.print_exc()
        return False


def _generate_email_body(overdue_tasks):
    """Generate HTML email body for overdue tasks."""
    task_rows = ""
    for task in overdue_tasks:
        due_display = task['due_date']
        if task.get('due_time'):
            due_display += f" @ {task['due_time']}"
        
        overdue_display = f"{task['days_overdue']} days"
        if task.get('hours_overdue') and task['days_overdue'] == 0:
            overdue_display = f"{task['hours_overdue']} hours"
        
        task_rows += f"""
        <tr>
            <td style="padding: 12px; border-bottom: 1px solid #e0e0e0;">{task['task_id']}</td>
            <td style="padding: 12px; border-bottom: 1px solid #e0e0e0;">{task['task_name']}</td>
            <td style="padding: 12px; border-bottom: 1px solid #e0e0e0;">{task['project_name']}</td>
            <td style="padding: 12px; border-bottom: 1px solid #e0e0e0;">{task['assigned_to']}</td>
            <td style="padding: 12px; border-bottom: 1px solid #e0e0e0; color: #ff4757; font-weight: 600;">{due_display}</td>
            <td style="padding: 12px; border-bottom: 1px solid #e0e0e0;">{overdue_display}</td>
        </tr>
        """
    
    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            body {{ font-family: Arial, sans-serif; line-height: 1.6; color: #333; }}
            .container {{ max-width: 800px; margin: 0 auto; padding: 20px; }}
            .header {{ background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 8px 8px 0 0; }}
            .content {{ background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }}
            table {{ width: 100%; border-collapse: collapse; background: white; margin-top: 20px; }}
            th {{ background: #667eea; color: white; padding: 12px; text-align: left; }}
            .footer {{ margin-top: 30px; padding-top: 20px; border-top: 2px solid #e0e0e0; color: #666; font-size: 12px; }}
            .btn {{ display: inline-block; padding: 12px 24px; background: #667eea; color: white; text-decoration: none; border-radius: 4px; margin-top: 20px; }}
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1 style="margin: 0;">⚠️ Overdue Tasks Alert</h1>
                <p style="margin: 10px 0 0 0;">You have {len(overdue_tasks)} task(s) that are past their due date</p>
            </div>
            <div class="content">
                <p>The following tasks are overdue and require immediate attention:</p>
                
                <table>
                    <thead>
                        <tr>
                            <th>Task ID</th>
                            <th>Task Name</th>
                            <th>Project</th>
                            <th>Assigned To</th>
                            <th>Due Date</th>
                            <th>Days Overdue</th>
                        </tr>
                    </thead>
                    <tbody>
                        {task_rows}
                    </tbody>
                </table>
                
                <a href="{FRONTEND_BASE_URL}/#/time-my-tasks" class="btn">View My Tasks</a>
                
                <div class="footer">
                    <p>This is an automated notification from OfficeHub360. Please do not reply to this email.</p>
                    <p>If you have any questions, please contact your project manager.</p>
                </div>
            </div>
        </div>
    </body>
    </html>
    """
    return html


@bp_overdue.route("/tasks/check-overdue", methods=["GET"])
def check_overdue_tasks():
    """
    Check for overdue tasks and send email notifications.
    This endpoint can be called manually or by a cron job.
    
    Query params:
      - send_email: true/false (default: true)
      - force: true/false (default: false) - Force send even if already notified today
    """
    try:
        send_email_param = request.args.get("send_email", "true").lower() == "true"
        force = request.args.get("force", "false").lower() == "true"
        
        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-Version": "4.0",
            "Content-Type": "application/json",
        }
        
        # Fetch all active tasks
        url = f"{RESOURCE}{DV_API}/{ENTITY_SET_TASKS}?$select=crc6f_hr_taskdetailsid,crc6f_taskid,crc6f_taskname,crc6f_taskstatus,crc6f_assignedto,crc6f_duedate,crc6f_duetime,crc6f_projectid"
        resp = get_dataverse_session().get(url, headers=headers, timeout=30)
        if not resp.ok:
            return jsonify({"success": False, "error": "Failed to fetch tasks"}), resp.status_code
        
        tasks = resp.json().get("value", [])
        
        # Filter overdue tasks
        now = datetime.now()
        today = now.date()
        overdue_tasks = []
        
        for task in tasks:
            task_status = (task.get("crc6f_taskstatus") or "").lower()
            due_date_str = task.get("crc6f_duedate")
            due_time_str = task.get("crc6f_duetime")
            
            # Skip completed/cancelled tasks
            if task_status in ["completed", "cancelled", "canceled"]:
                continue
            
            if not due_date_str:
                continue
            
            try:
                # Parse due date (format: YYYY-MM-DD)
                due_date = datetime.fromisoformat(due_date_str.split('T')[0]).date()
                
                # Check if overdue based on date and time
                is_overdue = False
                days_overdue = 0
                hours_overdue = 0
                
                if due_time_str:
                    # If due time is specified, check date + time
                    try:
                        # Combine date and time
                        due_datetime = datetime.combine(due_date, datetime.fromisoformat(due_time_str).time())
                        if due_datetime < now:
                            is_overdue = True
                            time_diff = now - due_datetime
                            days_overdue = time_diff.days
                            hours_overdue = time_diff.seconds // 3600
                    except Exception:
                        # If time parsing fails, fall back to date-only check
                        if due_date < today:
                            is_overdue = True
                            days_overdue = (today - due_date).days
                else:
                    # No due time specified, check date only
                    if due_date < today:
                        is_overdue = True
                        days_overdue = (today - due_date).days
                
                if is_overdue:
                    project_name = _get_project_name(task.get("crc6f_projectid"), headers)
                    
                    overdue_tasks.append({
                        "guid": task.get("crc6f_hr_taskdetailsid"),
                        "task_id": task.get("crc6f_taskid"),
                        "task_name": task.get("crc6f_taskname"),
                        "task_status": task.get("crc6f_taskstatus"),
                        "assigned_to": task.get("crc6f_assignedto"),
                        "due_date": due_date_str.split('T')[0],
                        "due_time": due_time_str,
                        "days_overdue": days_overdue,
                        "hours_overdue": hours_overdue,
                        "project_id": task.get("crc6f_projectid"),
                        "project_name": project_name
                    })
            except Exception as e:
                print(f"[OVERDUE] Error processing task {task.get('crc6f_taskid')}: {e}")
                continue
        
        print(f"[OVERDUE] Found {len(overdue_tasks)} overdue tasks")
        
        # Send email notifications if requested
        notifications_sent = 0
        if send_email_param and overdue_tasks:
            notification_log = _load_notification_log()
            today_str = today.isoformat()
            
            # Get L2/L3 employees
            l2_l3_employees = _get_l2_l3_employees(headers)
            l2_l3_emails = [e["email"] for e in l2_l3_employees if e.get("email")]
            
            # Group tasks by assigned user
            tasks_by_user = {}
            for task in overdue_tasks:
                emp_ids = _parse_assigned_to(task["assigned_to"])
                for emp_id in emp_ids:
                    if emp_id not in tasks_by_user:
                        tasks_by_user[emp_id] = []
                    tasks_by_user[emp_id].append(task)
            
            # Send emails to assigned users
            for emp_id, user_tasks in tasks_by_user.items():
                # Check if we already notified this user today
                log_key = f"{emp_id}_{today_str}"
                if not force and log_key in notification_log:
                    print(f"[OVERDUE] Already notified {emp_id} today. Skipping.")
                    continue
                
                employee = _get_employee_by_id(emp_id, headers)
                if employee and employee.get("email"):
                    # Send to assigned user + L2/L3
                    recipient_emails = list(set([employee["email"]] + l2_l3_emails))
                    
                    subject = f"⚠️ You have {len(user_tasks)} overdue task(s)"
                    body = _generate_email_body(user_tasks)
                    
                    if _send_email(recipient_emails, subject, body):
                        notification_log[log_key] = {
                            "date": today_str,
                            "task_count": len(user_tasks),
                            "sent_to": recipient_emails
                        }
                        notifications_sent += 1
            
            # Save notification log
            _save_notification_log(notification_log)
        
        return jsonify({
            "success": True,
            "overdue_count": len(overdue_tasks),
            "overdue_tasks": overdue_tasks,
            "notifications_sent": notifications_sent
        }), 200
        
    except Exception as e:
        print(f"[OVERDUE] Error checking overdue tasks: {e}")
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


@bp_overdue.route("/tasks/overdue-summary", methods=["GET"])
def get_overdue_summary():
    """Get a summary of overdue tasks without sending notifications."""
    try:
        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-Version": "4.0",
        }
        
        url = f"{RESOURCE}{DV_API}/{ENTITY_SET_TASKS}?$select=crc6f_taskid,crc6f_taskname,crc6f_taskstatus,crc6f_duedate"
        resp = get_dataverse_session().get(url, headers=headers, timeout=30)
        if not resp.ok:
            return jsonify({"success": False, "error": "Failed to fetch tasks"}), resp.status_code
        
        tasks = resp.json().get("value", [])
        today = date.today()
        overdue_count = 0
        
        for task in tasks:
            task_status = (task.get("crc6f_taskstatus") or "").lower()
            due_date_str = task.get("crc6f_duedate")
            
            if task_status in ["completed", "cancelled", "canceled"] or not due_date_str:
                continue
            
            try:
                due_date = datetime.fromisoformat(due_date_str.split('T')[0]).date()
                if due_date < today:
                    overdue_count += 1
            except Exception:
                continue
        
        return jsonify({
            "success": True,
            "overdue_count": overdue_count,
            "check_date": today.isoformat()
        }), 200
        
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500
