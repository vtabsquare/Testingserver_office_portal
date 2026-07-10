const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'pages', 'shared.js');

console.log('🔧 Adding overdue task indication to My Tasks...');

// Read file with latin1 encoding
let content = fs.readFileSync(filePath, 'latin1');

// Find the task row rendering section and add overdue check
const oldTaskRow = `              <td>\${t.due_date || '-'}</td>`;

const newTaskRow = `              <td>
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

if (content.includes(oldTaskRow)) {
    content = content.replace(oldTaskRow, newTaskRow);
    console.log('✅ Added overdue indication to task due date column');
} else {
    console.log('⚠️  Warning: Task row pattern not found');
}

// Add CSS for overdue badge animation
const cssInsertPoint = `document.getElementById('app-content').innerHTML = getPageContentHTML('My Tasks', content);`;

const cssAddition = `
        // Add overdue badge styles
        const style = document.createElement('style');
        style.textContent = \`
            .overdue-badge {
                animation: pulse-red 2s infinite;
            }
            @keyframes pulse-red {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.7; }
            }
            .status-badge.overdue {
                background-color: #ff4757 !important;
                color: white !important;
            }
        \`;
        document.head.appendChild(style);
        
        document.getElementById('app-content').innerHTML = getPageContentHTML('My Tasks', content);`;

if (content.includes(cssInsertPoint)) {
    content = content.replace(cssInsertPoint, cssAddition);
    console.log('✅ Added overdue badge CSS animation');
} else {
    console.log('⚠️  Warning: CSS insertion point not found');
}

// Write back
fs.writeFileSync(filePath, content, 'latin1');

console.log('✅ Frontend overdue indication added successfully!');
console.log('📝 Restart your frontend dev server to see the changes');
