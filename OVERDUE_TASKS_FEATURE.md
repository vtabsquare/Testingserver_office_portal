# Overdue Tasks Feature Implementation

## Overview
This feature adds visual indication for overdue tasks in the "My Tasks" page and sends automated email notifications to L2, L3 managers, and assigned users when tasks become overdue.

## Features Implemented

### 1. Visual Indication (Frontend)
- **Overdue Badge**: Tasks past their due date display a red "OVERDUE" badge next to the due date
- **Pulsing Animation**: The badge has a subtle pulsing animation to draw attention
- **Smart Detection**: Only shows for active tasks (excludes completed/cancelled)
- **Location**: `pages/shared.js` - My Tasks page

### 2. Backend API Endpoints

#### `/api/tasks/check-overdue` (GET)
Checks for overdue tasks and optionally sends email notifications.

**Query Parameters:**
- `send_email` (default: true) - Whether to send email notifications
- `force` (default: false) - Force send even if already notified today

**Response:**
```json
{
  "success": true,
  "overdue_count": 5,
  "overdue_tasks": [...],
  "notifications_sent": 3
}
```

#### `/api/tasks/overdue-summary` (GET)
Get a quick summary of overdue tasks without sending notifications.

**Response:**
```json
{
  "success": true,
  "overdue_count": 5,
  "check_date": "2026-05-26"
}
```

### 3. Email Notification System

**Recipients:**
- **Assigned Users**: Employees assigned to the overdue task
- **L2 Managers**: All employees with role "L2"
- **L3 Managers**: All employees with role "L3"

**Email Content:**
- Professional HTML template with gradient header
- Table showing all overdue tasks with:
  - Task ID and Name
  - Project Name
  - Assigned To
  - Due Date (highlighted in red)
  - Days Overdue
- Direct link to "My Tasks" page
- Responsive design

**Smart Notifications:**
- Prevents duplicate emails (once per day per user)
- Logs notification history in `overdue_notifications.json`
- Groups tasks by assigned user for personalized emails

### 4. Daily Scheduler

**Schedule:** Runs automatically every day at **9:00 AM**

**How it Works:**
- Background daemon thread (no external dependencies)
- Calls `/api/tasks/check-overdue` endpoint
- Logs results to console
- Auto-restarts on errors

**Files:**
- `backend/overdue_scheduler.py` - Scheduler implementation
- Registered in `backend/unified_server.py`

## Configuration

### Email Settings (Environment Variables)

**Good news!** The system uses your **existing email configuration** from `backend/id.env`:

```bash
# EMAIL CONFIG (Already configured in your id.env)
MAIL_SERVER=smtp.gmail.com
MAIL_PORT=587
MAIL_USERNAME=hrtool.vtab@gmail.com
MAIL_PASSWORD=tfdvknkxhvpmtuzh
MAIL_DEFAULT_SENDER=hrtool.vtab@gmail.com

# Frontend URL for email links (already configured)
FRONTEND_BASE_URL=https://officehub360.vtabsquare.com
```

**No additional configuration needed!** The overdue tasks notifier will automatically use these existing settings.

### Email Variables Used:
- `MAIL_SERVER` → SMTP host
- `MAIL_PORT` → SMTP port
- `MAIL_USERNAME` → SMTP username
- `MAIL_PASSWORD` → SMTP password (Gmail app password)
- `MAIL_DEFAULT_SENDER` → From email address
- `FRONTEND_BASE_URL` → Link in emails to My Tasks page

## Testing

### Test Overdue Visual Indication (Frontend)

1. **Restart frontend dev server:**
   ```bash
   npm run dev
   ```

2. **Create a test task with past due date:**
   - Go to Projects → Select a project → Add Task
   - Set due date to yesterday or earlier
   - Assign to yourself

3. **Check My Tasks page:**
   - Navigate to Time Tracker → My Tasks
   - You should see the red "OVERDUE" badge next to the due date

### Test Email Notifications (Backend)

1. **Configure email settings** in `backend/id.env`

2. **Manual test (immediate):**
   ```bash
   # From backend directory
   python overdue_scheduler.py
   ```

3. **Test via API:**
   ```bash
   curl "http://localhost:5000/api/tasks/check-overdue?send_email=true&force=true"
   ```

4. **Check logs:**
   - Look for `[OVERDUE]` prefixed messages
   - Verify email sent successfully

5. **Check email inbox:**
   - Assigned user should receive email
   - L2/L3 managers should receive email
   - Email should list all overdue tasks

### Test Daily Scheduler

1. **Start backend server:**
   ```bash
   python backend/unified_server.py
   ```

2. **Check console logs:**
   ```
   [OVERDUE-SCHEDULER] Started. Will check overdue tasks daily at 09:00
   [OVERDUE-SCHEDULER] Next check scheduled for: 2026-05-27 09:00:00
   ```

3. **Wait for 9:00 AM or modify `CHECK_TIME_HOUR` in `overdue_scheduler.py` for testing**

## Files Modified/Created

### Created:
- `backend/overdue_tasks_notifier.py` - Email notification system
- `backend/overdue_scheduler.py` - Daily scheduler
- `backend/overdue_notifications.json` - Notification log (auto-created)
- `fix_my_tasks_overdue.cjs` - Frontend patch script
- `OVERDUE_TASKS_FEATURE.md` - This documentation

### Modified:
- `pages/shared.js` - Added overdue badge to My Tasks
- `backend/unified_server.py` - Registered blueprints and scheduler

## How It Works

### Overdue Detection Logic

A task is considered overdue if:
1. `due_date < today`
2. `task_status` is NOT "Completed", "Cancelled", or "Canceled"

### Notification Flow

```
Daily at 9:00 AM
    ↓
Scheduler calls /api/tasks/check-overdue
    ↓
Backend fetches all active tasks from Dataverse
    ↓
Filters tasks where due_date < today
    ↓
Groups tasks by assigned user
    ↓
For each user with overdue tasks:
    ├─ Check if already notified today (skip if yes)
    ├─ Fetch user email from employee table
    ├─ Fetch L2/L3 manager emails
    ├─ Generate HTML email with task details
    ├─ Send email to [user + L2 + L3]
    └─ Log notification to prevent duplicates
```

## Troubleshooting

### Overdue badge not showing
- Clear browser cache and hard reload (Ctrl+Shift+R)
- Restart frontend dev server
- Check browser console for errors

### Emails not sending
- Verify SMTP credentials in `backend/id.env`
- Check backend logs for `[OVERDUE]` error messages
- Test SMTP connection manually
- Ensure firewall allows outbound SMTP (port 587)

### Scheduler not running
- Check backend startup logs for scheduler initialization
- Verify no errors in `[OVERDUE-SCHEDULER]` logs
- Ensure backend server is running continuously

### Duplicate emails
- Notification log prevents duplicates within same day
- Use `force=false` (default) to respect notification log
- Use `force=true` only for testing

## Production Deployment

1. **Update environment variables** in production `id.env`
2. **Restart backend server:**
   ```bash
   pm2 restart office-backend
   ```
3. **Rebuild frontend:**
   ```bash
   npm run build
   ```
4. **Verify scheduler started:**
   ```bash
   pm2 logs office-backend | grep OVERDUE-SCHEDULER
   ```

## Future Enhancements

- [ ] Configurable notification time (currently 9:00 AM)
- [ ] Escalation emails (e.g., 3 days overdue → notify higher management)
- [ ] In-app notifications (browser notifications)
- [ ] Weekly summary reports
- [ ] Customizable email templates
- [ ] Slack/Teams integration
- [ ] Task priority-based notification urgency

## API Usage Examples

### Get overdue summary (no emails)
```bash
curl http://localhost:5000/api/tasks/overdue-summary
```

### Check and send notifications
```bash
curl "http://localhost:5000/api/tasks/check-overdue?send_email=true"
```

### Force send (ignore notification log)
```bash
curl "http://localhost:5000/api/tasks/check-overdue?send_email=true&force=true"
```

### Check only (no emails)
```bash
curl "http://localhost:5000/api/tasks/check-overdue?send_email=false"
```

## Support

For issues or questions, contact the development team or check the backend logs for detailed error messages.
