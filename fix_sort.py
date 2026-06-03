import re

file_path = r"c:\Users\91733\Documents\Office_portal-dynamic settings\Testingserver_office_portal\pages\shared.js"

with open(file_path, "r", encoding="utf-8", errors="surrogateescape") as f:
    content = f.read()

# 1. Update leaves sorting
old_leaves_sort = """        // Sort leaves by start_date descending (latest first)
        leaves.sort((a, b) => {
            const dateA = new Date(a.start_date || '1900-01-01');
            const dateB = new Date(b.start_date || '1900-01-01');
            return dateB - dateA; // Descending order (newest first)
        });"""

new_leaves_sort = """        // Sort leaves descending (latest first)
        leaves.sort((a, b) => {
            const getSortDate = (item) => new Date(item.createdon || item.createdAt || item.created_at || item.submitted_on || item.start_date || '1900-01-01');
            return getSortDate(b) - getSortDate(a); // Descending order
        });"""

if old_leaves_sort in content:
    content = content.replace(old_leaves_sort, new_leaves_sort)

# 2. Add sorting to attendance if missing
# Need to find where markers are mapped or if they are sorted
attendance_sort_regex = r"(const markerCards = markers\.map\(marker => \{)"
new_attendance_sort = """        // Sort markers descending (latest first)
        markers.sort((a, b) => {
            const getSortDate = (item) => new Date(item.createdon || item.createdAt || item.created_at || item.submitted_on || item.date || item.dateWorked || '1900-01-01');
            return getSortDate(b) - getSortDate(a); // Descending order
        });
        
        \\1"""

if "Sort markers descending" not in content:
    content = re.sub(attendance_sort_regex, new_attendance_sort, content)

# 3. Add sorting to timesheets if missing
timesheet_sort_regex = r"(const groupedCards = Object\.entries\(groupedTimesheets\)\.map\(\(\[key, entries\]\) => \{)"
new_timesheet_sort = """        // Sort timesheets descending (latest first)
        timesheets.sort((a, b) => {
            const getSortDate = (item) => new Date(item.createdon || item.createdAt || item.created_at || item.submitted_on || item.dateWorked || item.date || '1900-01-01');
            return getSortDate(b) - getSortDate(a); // Descending order
        });
        
        \\1"""

if "Sort timesheets descending" not in content:
    content = re.sub(timesheet_sort_regex, new_timesheet_sort, content)

with open(file_path, "w", encoding="utf-8", errors="surrogateescape") as f:
    f.write(content)

print("Updated sorting in shared.js")
