const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'pages', 'projects.js');

console.log('🔧 Adding Due Time field to task creation form...');

// Read file with latin1 encoding
let content = fs.readFileSync(filePath, 'latin1');

// Find the due date field and add due time field after it
const oldDueDateField = `            <div class="form-field">
              <label class="form-label" for="tk-due">Due Date</label>
              <input class="input-control" type="date" id="tk-due" />
            </div>`;

const newDueDateFields = `            <div class="form-field">
              <label class="form-label" for="tk-due">Due Date</label>
              <input class="input-control" type="date" id="tk-due" />
            </div>

            <div class="form-field">
              <label class="form-label" for="tk-duetime">Due Time</label>
              <input class="input-control" type="time" id="tk-duetime" />
            </div>`;

if (content.includes(oldDueDateField)) {
    content = content.replace(oldDueDateField, newDueDateFields);
    console.log('✅ Added Due Time field to task form');
} else {
    console.log('⚠️  Warning: Due Date field pattern not found');
}

// Add due_time to the payload
const oldPayload = `    const payload = {
      task_name: document.getElementById("tk-name").value.trim(),
      task_description: document.getElementById("tk-desc").value.trim(),
      task_type: selectedWorkItemType,
      task_priority: document.getElementById("tk-priority").value,
      task_status: defaultStatus,
      assigned_to: assignedTo, // ✅ FIXED
      assigned_date: startDate,
      due_date: dueDate,`;

const newPayload = `    const payload = {
      task_name: document.getElementById("tk-name").value.trim(),
      task_description: document.getElementById("tk-desc").value.trim(),
      task_type: selectedWorkItemType,
      task_priority: document.getElementById("tk-priority").value,
      task_status: defaultStatus,
      assigned_to: assignedTo, // ✅ FIXED
      assigned_date: startDate,
      due_date: dueDate,
      due_time: document.getElementById("tk-duetime").value || null,`;

if (content.includes(oldPayload)) {
    content = content.replace(oldPayload, newPayload);
    console.log('✅ Added due_time to task payload');
} else {
    console.log('⚠️  Warning: Payload pattern not found');
}

// Write back
fs.writeFileSync(filePath, content, 'latin1');

console.log('✅ Due Time field added to frontend successfully!');
console.log('📝 Restart your frontend dev server to see the changes');
