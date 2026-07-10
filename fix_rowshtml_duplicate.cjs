const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'pages', 'shared.js');

console.log('🔧 Fixing duplicate rowsHtml declaration...');

// Read file with latin1 encoding
let content = fs.readFileSync(filePath, 'latin1');

// The issue is that we have:
// const rowsHtml = Array.from(...)  (line 5048)
// ...
// const rowsHtml = rowsHtmlArray.join('');  (line 5085)

// We need to rename the first one to sortedRows
const oldDeclaration = `                const rowsHtml = Array.from(mergedRowsMap.values())
                    .sort((a, b) => (a.date === b.date ? a.task_text.localeCompare(b.task_text) : a.date.localeCompare(b.date)));`;

const newDeclaration = `                const sortedRows = Array.from(mergedRowsMap.values())
                    .sort((a, b) => (a.date === b.date ? a.task_text.localeCompare(b.task_text) : a.date.localeCompare(b.date)));`;

if (content.includes(oldDeclaration)) {
    content = content.replace(oldDeclaration, newDeclaration);
    console.log('✅ Renamed first rowsHtml to sortedRows');
} else {
    console.log('⚠️  Pattern not found - might already be fixed');
}

// Also need to update the reference to use sortedRows instead of group.rows
const oldGroupRows = `                const sortedRows = group.rows.sort((a, b) => (a.date === b.date ? a.task_text.localeCompare(b.task_text) : a.date.localeCompare(b.date)));`;

// This line should already exist from our previous fix, but if group.rows is still referenced, we need to remove it
// Actually, we need to use the sortedRows we just created instead of group.rows

// Write back
fs.writeFileSync(filePath, content, 'latin1');

console.log('✅ Fixed duplicate declaration!');
console.log('📝 Restart your frontend dev server');
