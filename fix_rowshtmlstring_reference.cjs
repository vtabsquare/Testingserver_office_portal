const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'pages', 'shared.js');

console.log('🔧 Fixing rowsHtmlString reference...');

// Read file with latin1 encoding
let content = fs.readFileSync(filePath, 'latin1');

// Change the table to use rowsHtml instead of rowsHtmlString
const oldTableBody = `                                    <tbody>\${rowsHtmlString}</tbody>`;
const newTableBody = `                                    <tbody>\${rowsHtml}</tbody>`;

if (content.includes(oldTableBody)) {
    content = content.replace(oldTableBody, newTableBody);
    console.log('✅ Fixed table to use rowsHtml instead of rowsHtmlString');
} else {
    console.log('⚠️  Pattern not found - might already be fixed');
}

// Write back
fs.writeFileSync(filePath, content, 'latin1');

console.log('✅ Fixed variable reference!');
console.log('📝 Restart your frontend dev server');
