const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'pages', 'shared.js');

console.log('🔧 Adding simple validation to comp-off handlers...');

// Read file with latin1 encoding
let content = fs.readFileSync(filePath, 'latin1');

// Simple fix: Just add validation at the start of handleCompOffApprove
const oldApprove = `const handleCompOffApprove = async (requestId) => {
    if (!confirm('Grant this Comp Off request?')) return;`;

const newApprove = `const handleCompOffApprove = async (requestId) => {
    console.log('Approve requestId:', requestId);
    if (!requestId) {
        alert('Error: Request ID not found');
        return;
    }
    if (!confirm('Grant this Comp Off request?')) return;`;

if (content.includes(oldApprove)) {
    content = content.replace(oldApprove, newApprove);
    console.log('✅ Added validation to approve handler');
} else {
    console.log('⚠️  Approve pattern not found');
}

// Simple fix for reject handler
const oldReject = `const handleCompOffReject = async (requestId) => {
    const reason = prompt('Enter rejection reason (optional):');`;

const newReject = `const handleCompOffReject = async (requestId) => {
    console.log('Reject requestId:', requestId);
    if (!requestId) {
        alert('Error: Request ID not found');
        return;
    }
    const reason = prompt('Enter rejection reason (optional):');`;

if (content.includes(oldReject)) {
    content = content.replace(oldReject, newReject);
    console.log('✅ Added validation to reject handler');
} else {
    console.log('⚠️  Reject pattern not found');
}

// Write back
fs.writeFileSync(filePath, content, 'latin1');

console.log('✅ Simple validation added!');
console.log('📝 Restart frontend and check console when clicking approve/reject');
