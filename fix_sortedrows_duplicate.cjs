const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'pages', 'shared.js');

console.log('🔧 Fixing duplicate sortedRows declaration...');

// Read file with latin1 encoding
let content = fs.readFileSync(filePath, 'latin1');

// Remove the duplicate sortedRows line that references group.rows
// We already have sortedRows from the mergedRowsMap
const duplicateLine = `                const sortedRows = group.rows.sort((a, b) => (a.date === b.date ? a.task_text.localeCompare(b.task_text) : a.date.localeCompare(b.date)));`;

if (content.includes(duplicateLine)) {
    content = content.replace(duplicateLine, '');
    console.log('✅ Removed duplicate sortedRows declaration');
} else {
    console.log('⚠️  Duplicate line not found - might already be fixed');
}

// Write back
fs.writeFileSync(filePath, content, 'latin1');

console.log('✅ Fixed all duplicate declarations!');
console.log('📝 Restart your frontend dev server');
