const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'pages', 'shared.js');

console.log('🔧 Fixing inbox comp-off filter in shared.js...');

// Read file with latin1 encoding to preserve special characters
let content = fs.readFileSync(filePath, 'latin1');

// Fix 1: Remove filter that excludes comp-off from pending leaves (line 4493)
const oldPendingFilter = `leaves = (pendingLeaves || []).filter(l => !isCompOffLeaveType(l.leave_type)).concat(compPending);`;
const newPendingFilter = `leaves = (pendingLeaves || []);  // Backend now includes comp-off requests`;

if (content.includes(oldPendingFilter)) {
    content = content.replace(oldPendingFilter, newPendingFilter);
    console.log('✅ Fixed: Removed comp-off filter from pending leaves');
} else {
    console.log('⚠️  Warning: Pending filter pattern not found (may already be fixed)');
}

// Fix 2: Remove filter from completed leaves (line 4516)
const oldCompletedFilter = `(l.status?.toLowerCase() === 'approved' || l.status?.toLowerCase() === 'rejected') && !isCompOffLeaveType(l.leave_type)`;
const newCompletedFilter = `(l.status?.toLowerCase() === 'approved' || l.status?.toLowerCase() === 'rejected')`;

if (content.includes(oldCompletedFilter)) {
    content = content.replace(oldCompletedFilter, newCompletedFilter);
    console.log('✅ Fixed: Removed comp-off filter from completed leaves (admin)');
} else {
    console.log('⚠️  Warning: Completed filter pattern not found');
}

// Fix 3: Remove filter from user's pending requests (line 4531)
const oldUserPendingFilter = `leaves = (allLeaves || []).filter(l => l.status?.toLowerCase() === 'pending' && !isCompOffLeaveType(l.leave_type)).concat(compMine);`;
const newUserPendingFilter = `leaves = (allLeaves || []).filter(l => l.status?.toLowerCase() === 'pending');  // Backend includes comp-off`;

if (content.includes(oldUserPendingFilter)) {
    content = content.replace(oldUserPendingFilter, newUserPendingFilter);
    console.log('✅ Fixed: Removed comp-off filter from user pending requests');
} else {
    console.log('⚠️  Warning: User pending filter pattern not found');
}

// Fix 4: Remove filter from user's completed requests (line 4535)
const oldUserCompletedFilter = `(l.status?.toLowerCase() === 'approved' || l.status?.toLowerCase() === 'rejected') && !isCompOffLeaveType(l.leave_type)`;

if (content.includes(oldUserCompletedFilter)) {
    content = content.replace(oldUserCompletedFilter, newCompletedFilter);
    console.log('✅ Fixed: Removed comp-off filter from user completed requests');
} else {
    console.log('⚠️  Warning: User completed filter pattern not found');
}

// Write back with latin1 encoding
fs.writeFileSync(filePath, content, 'latin1');

console.log('✅ All fixes applied successfully!');
console.log('📝 Restart your frontend dev server to see the changes');
