const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'pages', 'shared.js');

console.log('🔧 Fixing comp-off detection logic...');

let content = fs.readFileSync(filePath, 'latin1');

// Replace the broken isCompOff check
// Only treat as comp-off if explicitly marked via _source or request_type
// Regular leaves with leave_type="Comp Off" are leave consumption and should use leave endpoints
const oldCheck = `const isCompOff = leave._source === 'compoff' || (String(leaveType).toLowerCase() === 'comp off');`;
const newCheck = `const isCompOff = leave._source === 'compoff' || leave.request_type === 'compoff';`;

if (content.includes(oldCheck)) {
    content = content.replace(oldCheck, newCheck);
    console.log('✅ Fixed isCompOff detection - now only routes to comp-off API when explicitly marked');
} else {
    console.log('⚠️  isCompOff pattern not found');
}

fs.writeFileSync(filePath, content, 'latin1');

console.log('✅ Fix applied!');
console.log('📝 Restart frontend: npm run dev');
console.log('');
console.log('What changed:');
console.log('  - "Comp Off" leaves from the leave entity will now be approved/rejected as regular leaves');
console.log('  - Only actual comp-off REQUESTS (from comp-off entity) use the comp-off endpoints');
