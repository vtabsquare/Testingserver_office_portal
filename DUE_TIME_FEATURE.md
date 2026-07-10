# Due Time Feature Implementation

## Overview
Added **Due Time** field alongside **Due Date** for tasks. The overdue detection now checks both date and time for more precise deadline tracking.

## Features Implemented

### 1. Task Creation Form (Frontend)
- **New Field**: "Due Time" input (time picker)
- **Location**: Projects → Add Task form
- **File**: `pages/projects.js`
- **Format**: HH:MM (24-hour format)

### 2. Backend API Updates

#### Task Creation (`POST /api/projects/<project_code>/tasks`)
- Accepts `due_time` in request body
- Stores in Dataverse field: `crc6f_duetime`

#### Task Retrieval (`GET /api/projects/<project_code>/tasks`)
- Returns `due_time` for each task

#### Task Update (`PATCH /api/tasks/<guid>`)
- Allows updating `due_time`

#### My Tasks API (`GET /api/my-tasks`)
- Includes `due_time` in response

### 3. Overdue Detection Logic

**Previous Behavior:**
- Checked only due date (date-only comparison)
- Task overdue if `due_date < today`

**New Behavior:**
- **If due_time is set**: Checks date + time
  - Task overdue if `due_datetime < now`
  - Example: Due on 2026-05-26 at 14:00, current time 15:00 → **OVERDUE**
- **If due_time is NOT set**: Falls back to date-only check
  - Task overdue if `due_date < today`

**Implementation:**
```python
if due_time_str:
    # Combine date and time
    due_datetime = datetime.combine(due_date, datetime.fromisoformat(due_time_str).time())
    if due_datetime < now:
        is_overdue = True
else:
    # Date-only check
    if due_date < today:
        is_overdue = True
```

### 4. My Tasks Display

**Due Date Column:**
- Shows: `2026-05-26 @ 14:00` (if time is set)
- Shows: `2026-05-26` (if time is not set)
- **OVERDUE badge** appears based on date+time check

**Example:**
```
Due Date                    Status
2026-05-26 @ 14:00 OVERDUE  In Progress
2026-05-27                  New
```

### 5. Email Notifications

**Updated Email Template:**
- Due date column shows time if available
- Overdue duration shows hours if less than 1 day
  - Example: "3 hours" (if overdue by 3 hours)
  - Example: "2 days" (if overdue by 2+ days)

## Database Schema

### Dataverse Field
- **Field Name**: `crc6f_duetime`
- **Type**: String (stores time in HH:MM format)
- **Example Values**:
  - `"14:30"` (2:30 PM)
  - `"09:00"` (9:00 AM)
  - `null` (no time set)

**Note**: You need to add this field to your Dataverse `crc6f_hr_taskdetailses` entity if it doesn't exist.

## Testing

### Test Due Time in Task Creation

1. **Create a task with due time:**
   - Go to Projects → Select Project → Add Task
   - Set Due Date: Tomorrow
   - Set Due Time: 14:00
   - Save Task

2. **Verify in My Tasks:**
   - Navigate to Time Tracker → My Tasks
   - Task should show: `2026-05-27 @ 14:00`

3. **Test overdue with time:**
   - Create a task with:
     - Due Date: Today
     - Due Time: 1 hour ago (e.g., if now is 15:00, set 14:00)
   - Go to My Tasks
   - Task should show **OVERDUE** badge

### Test Overdue Email with Time

```bash
# Create a task with past due time, then run:
curl "http://localhost:5000/api/tasks/check-overdue?send_email=true&force=true"
```

Email should show:
- Due date with time: `2026-05-26 @ 14:00`
- Overdue duration: `3 hours` (if less than 24 hours)

## Files Modified

### Frontend:
- `pages/projects.js` - Added due time field and payload

### Backend:
- `backend/project_tasks.py` - Added due_time to create/update/get endpoints
- `backend/time_tracking.py` - Added due_time to My Tasks API
- `backend/overdue_tasks_notifier.py` - Updated overdue logic and email template

### Frontend (My Tasks):
- `pages/shared.js` - Updated due date column to show time and check overdue with time

## How It Works

### Overdue Check Flow

```
Task has due_time?
    ├─ YES → Combine date + time
    │         Check if due_datetime < now
    │         If yes → OVERDUE
    │
    └─ NO  → Check date only
              Check if due_date < today
              If yes → OVERDUE
```

### Example Scenarios

| Due Date   | Due Time | Current DateTime      | Overdue? | Reason                          |
|------------|----------|-----------------------|----------|---------------------------------|
| 2026-05-26 | 14:00    | 2026-05-26 15:00      | ✅ Yes   | Past due time (1 hour overdue)  |
| 2026-05-26 | 16:00    | 2026-05-26 15:00      | ❌ No    | Due time not reached yet        |
| 2026-05-26 | (none)   | 2026-05-27 10:00      | ✅ Yes   | Past due date                   |
| 2026-05-27 | (none)   | 2026-05-26 23:00      | ❌ No    | Due date not passed yet         |
| 2026-05-25 | 14:00    | 2026-05-26 10:00      | ✅ Yes   | Past due date + time (1 day)    |

## Production Deployment

### Step 1: Add Dataverse Field (if not exists)

1. Go to Dataverse → `crc6f_hr_taskdetailses` entity
2. Add new field:
   - **Name**: `crc6f_duetime`
   - **Type**: Single Line of Text
   - **Max Length**: 5
3. Save and publish

### Step 2: Deploy Code

```bash
# Push changes
git add .
git commit -m "Add due time field to tasks with time-based overdue detection"
git push

# On production server:
pm2 restart office-backend
npm run build
```

### Step 3: Test

1. Create a task with due time
2. Verify it appears in My Tasks with time
3. Test overdue detection
4. Check email notifications

## Backward Compatibility

✅ **Fully backward compatible!**

- Existing tasks without `due_time` will continue to work
- Overdue detection falls back to date-only check if time is not set
- No migration needed for existing tasks

## Future Enhancements

- [ ] Time zone support (currently uses server time)
- [ ] Recurring tasks with due time
- [ ] Due time reminders (e.g., 1 hour before due)
- [ ] Calendar view with time slots
- [ ] Due time validation (prevent past times)

## Troubleshooting

### Due time not showing in My Tasks
- Clear browser cache
- Restart frontend dev server
- Check backend logs for `due_time` in API response

### Overdue badge not appearing for time-based tasks
- Verify task has both `due_date` and `due_time`
- Check browser console for JavaScript errors
- Ensure time format is HH:MM

### Email shows wrong overdue duration
- Check server timezone settings
- Verify `due_time` is stored correctly in Dataverse
- Check backend logs for overdue calculation

## API Examples

### Create task with due time
```bash
curl -X POST http://localhost:5000/api/projects/VTAB006/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "task_name": "Fix bug",
    "task_priority": "High",
    "task_status": "New",
    "due_date": "2026-05-27",
    "due_time": "14:30",
    "assigned_to": "EMP001"
  }'
```

### Update task due time
```bash
curl -X PATCH http://localhost:5000/api/tasks/{guid} \
  -H "Content-Type: application/json" \
  -d '{
    "due_time": "16:00"
  }'
```

### Get tasks with due time
```bash
curl http://localhost:5000/api/projects/VTAB006/tasks
```

Response:
```json
{
  "success": true,
  "tasks": [
    {
      "task_id": "TASK001",
      "task_name": "Fix bug",
      "due_date": "2026-05-27",
      "due_time": "14:30",
      ...
    }
  ]
}
```

## Support

For issues or questions, check the backend logs for detailed error messages or contact the development team.
