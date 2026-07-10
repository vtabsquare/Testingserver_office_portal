const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'pages', 'shared.js');

console.log('🔧 Fixing comp-off ID resolution from pending leaves...');

let content = fs.readFileSync(filePath, 'latin1');

// Update both buttons to also fall back to leave.compoff_id or leave.id
const oldApproveBtn = `<button class="btn btn-success btn-sm inbox-approve-btn" data-leave-id="\${leaveId}" data-source="\${isCompOff ? 'compoff' : 'leave'}" data-compoff-id="\${isCompOff ? (leave._raw?.id || '') : ''}">`;
const newApproveBtn = `<button class="btn btn-success btn-sm inbox-approve-btn" data-leave-id="\${leaveId}" data-source="\${isCompOff ? 'compoff' : 'leave'}" data-compoff-id="\${isCompOff ? (leave._raw?.id || leave.compoff_id || leave.id || '') : ''}">`;

if (content.includes(oldApproveBtn)) {
    content = content.replace(oldApproveBtn, newApproveBtn);
    console.log('✅ Fixed approve button compoff-id fallback');
} else {
    console.log('⚠️  Approve button pattern not found');
}

const oldRejectBtn = `<button class="btn btn-danger btn-sm inbox-reject-btn" data-leave-id="\${leaveId}" data-source="\${isCompOff ? 'compoff' : 'leave'}" data-compoff-id="\${isCompOff ? (leave._raw?.id || '') : ''}">`;
const newRejectBtn = `<button class="btn btn-danger btn-sm inbox-reject-btn" data-leave-id="\${leaveId}" data-source="\${isCompOff ? 'compoff' : 'leave'}" data-compoff-id="\${isCompOff ? (leave._raw?.id || leave.compoff_id || leave.id || '') : ''}">`;

if (content.includes(oldRejectBtn)) {
    content = content.replace(oldRejectBtn, newRejectBtn);
    console.log('✅ Fixed reject button compoff-id fallback');
} else {
    console.log('⚠️  Reject button pattern not found');
}

fs.writeFileSync(filePath, content, 'latin1');

console.log('✅ Frontend fix applied!');
console.log('📝 Restart frontend: npm run dev');
