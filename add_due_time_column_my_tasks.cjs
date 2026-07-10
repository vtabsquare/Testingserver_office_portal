const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'pages', 'shared.js');

console.log('🔧 Adding Due Time column to My Tasks table...');

// Read file with latin1 encoding
let content = fs.readFileSync(filePath, 'latin1');

// 1. Add "Due Time" column header after "Due date"
const oldHeader = `                                <th>Due date</th>
                                <th>Priority</th>`;

const newHeader = `                                <th>Due date</th>
                                <th>Due Time</th>
                                <th>Priority</th>`;

if (content.includes(oldHeader)) {
    content = content.replace(oldHeader, newHeader);
    console.log('✅ Added "Due Time" column header');
} else {
    console.log('⚠️  Warning: Header pattern not found');
}

// 2. Add due time cell in the table row (after the due date cell with overdue badge)
// Find the pattern where due date is displayed with overdue badge
const oldDueDateCell = `              <td>
                \${t.due_date || '-'}
                \${t.due_time ? \` <span style="color:#666; font-size:12px;">@ \${t.due_time}</span>\` : ''}
                \${(() => {
                  if (!t.due_date) return '';
                  const now = new Date();
                  const taskStatus = (t.task_status || '').toLowerCase();
                  if (['completed', 'cancelled', 'canceled'].includes(taskStatus)) return '';
                  
                  let isOverdue = false;
                  if (t.due_time) {
                    // Check date + time
                    const dueDatetime = new Date(\`\${t.due_date}T\${t.due_time}\`);
                    isOverdue = dueDatetime < now;
                  } else {
                    // Check date only
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    const dueDate = new Date(t.due_date);
                    dueDate.setHours(0, 0, 0, 0);
                    isOverdue = dueDate < today;
                  }
                  
                  return isOverdue ? '<span class="overdue-badge" style="margin-left:8px; padding:2px 8px; background:#ff4757; color:white; border-radius:4px; font-size:11px; font-weight:600;">OVERDUE</span>' : '';
                })()}
              </td>
              <td>\${t.task_priority || '-'}</td>`;

const newDueDateCells = `              <td>
                \${t.due_date || '-'}
                \${(() => {
                  if (!t.due_date) return '';
                  const now = new Date();
                  const taskStatus = (t.task_status || '').toLowerCase();
                  if (['completed', 'cancelled', 'canceled'].includes(taskStatus)) return '';
                  
                  let isOverdue = false;
                  if (t.due_time) {
                    // Check date + time
                    const dueDatetime = new Date(\`\${t.due_date}T\${t.due_time}\`);
                    isOverdue = dueDatetime < now;
                  } else {
                    // Check date only
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    const dueDate = new Date(t.due_date);
                    dueDate.setHours(0, 0, 0, 0);
                    isOverdue = dueDate < today;
                  }
                  
                  return isOverdue ? '<span class="overdue-badge" style="margin-left:8px; padding:2px 8px; background:#ff4757; color:white; border-radius:4px; font-size:11px; font-weight:600;">OVERDUE</span>' : '';
                })()}
              </td>
              <td>
                \${t.due_time ? \`<span style="color:#4338ca; font-weight:500;"><i class="fa-solid fa-clock" style="font-size:10px; margin-right:4px;"></i>\${t.due_time}</span>\` : '-'}
              </td>
              <td>\${t.task_priority || '-'}</td>`;

if (content.includes(oldDueDateCell)) {
    content = content.replace(oldDueDateCell, newDueDateCells);
    console.log('✅ Added due time cell to table row');
} else {
    console.log('⚠️  Warning: Due date cell pattern not found');
}

// 3. Update the skeleton/placeholder colspan from 7 to 8 (since we added a column)
content = content.replace(
    /<td colspan="7" class="placeholder-text">No tasks assigned\.<\/td>/g,
    '<td colspan="8" class="placeholder-text">No tasks assigned.</td>'
);
console.log('✅ Updated placeholder colspan');

// Write back
fs.writeFileSync(filePath, content, 'latin1');

console.log('✅ Due Time column added to My Tasks table successfully!');
console.log('📝 Restart your frontend dev server to see the changes');
