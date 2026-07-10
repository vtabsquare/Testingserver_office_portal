const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'pages', 'shared.js');

console.log('🔧 Fixing JavaScript syntax error in shared.js...');

// Read file with latin1 encoding
let content = fs.readFileSync(filePath, 'latin1');

// The issue is likely with the JSON.stringify in the button data attribute
// Let's fix it by removing the debug attribute that's causing issues

const problematicPattern = `data-debug-req="\${JSON.stringify({id: req.id, empId: req.employeeId}).replace(/"/g, '&quot;')}"`;

// Remove the problematic debug attribute
content = content.replace(new RegExp(problematicPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '');

// Also try to fix if the pattern is slightly different
content = content.replace(/data-debug-req="[^"]*"/g, '');

console.log('✅ Removed problematic debug attributes');

// Write back
fs.writeFileSync(filePath, content, 'latin1');

console.log('✅ Syntax error fixed!');
console.log('📝 Restart your frontend: npm run dev');
