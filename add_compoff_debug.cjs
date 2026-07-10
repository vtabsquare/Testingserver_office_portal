const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'pages', 'shared.js');

console.log('🔧 Adding debug logging to comp-off...');

// Read file
let content = fs.readFileSync(filePath, 'latin1');

// Add console.log right after the function declaration
content = content.replace(
    'const handleCompOffApprove = async (requestId) => {',
    'const handleCompOffApprove = async (requestId) => {\n    console.log("🔍 Approve requestId:", requestId);'
);

content = content.replace(
    'const handleCompOffReject = async (requestId) => {',
    'const handleCompOffReject = async (requestId) => {\n    console.log("🔍 Reject requestId:", requestId);'
);

// Also log when buttons are clicked
content = content.replace(
    'btn.addEventListener(\'click\', async (e) => {\n                    const requestId = e.currentTarget.getAttribute(\'data-id\');',
    'btn.addEventListener(\'click\', async (e) => {\n                    const requestId = e.currentTarget.getAttribute(\'data-id\');\n                    console.log("🔘 Button clicked, data-id:", requestId);'
);

fs.writeFileSync(filePath, content, 'latin1');

console.log('✅ Debug logging added!');
console.log('📝 Now restart: npm run dev');
