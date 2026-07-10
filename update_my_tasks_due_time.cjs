const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'pages', 'shared.js');

console.log('🔧 Updating My Tasks to display due time and check overdue with time...');

// Read file with latin1 encoding
let content = fs.readFileSync(filePath, 'latin1');

// Find the due date column and update to include time
const oldDueDateColumn = `              <td>
                \${t.due_date || '-'}
                \${(() => {
                  if (!t.due_date) return '';
                  const today = new Date();
                  today.setHours(0, 0, 0, 0);
                  const dueDate = new Date(t.due_date);
                  dueDate.setHours(0, 0, 0, 0);
                  const isOverdue = dueDate < today && !['completed', 'cancelled', 'canceled'].includes((t.task_status || '').toLowerCase());
                  return isOverdue ? '<span class="overdue-badge" style="margin-left:8px; padding:2px 8px; background:#ff4757; color:white; border-radius:4px; font-size:11px; font-weight:600;">OVERDUE</span>' : '';
                })()}
              </td>`;

const newDueDateColumn = `              <td>
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
              </td>`;

if (content.includes(oldDueDateColumn)) {
    content = content.replace(oldDueDateColumn, newDueDateColumn);
    console.log('✅ Updated due date column to include time and check overdue with time');
} else {
    console.log('⚠️  Warning: Due date column pattern not found');
}

// Write back
fs.writeFileSync(filePath, content, 'latin1');

console.log('✅ My Tasks updated successfully!');
console.log('📝 Restart your frontend dev server to see the changes');
