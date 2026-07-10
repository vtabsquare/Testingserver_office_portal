const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'pages', 'shared.js');

console.log('🔧 Fixing comp-off ID issue...');

// Read file with latin1 encoding
let content = fs.readFileSync(filePath, 'latin1');

// Add validation and logging to handleCompOffApprove
const oldApproveHandler = `const handleCompOffApprove = async (requestId) => {
    if (!confirm('Grant this Comp Off request?')) return;
    try {
        const allRequests = await fetchCompOffRequests();
        const req = allRequests.find(r => String(r.id) === String(requestId));
        const adminId = await resolveCurrentEmployeeId();`;

const newApproveHandler = `const handleCompOffApprove = async (requestId) => {
    console.log('🔍 handleCompOffApprove called with requestId:', requestId);
    
    if (!requestId || requestId === '' || requestId === 'undefined') {
        alert('❌ Error: Request ID is missing. Please refresh the page and try again.');
        console.error('❌ Invalid requestId:', requestId);
        return;
    }
    
    if (!confirm('Grant this Comp Off request?')) return;
    try {
        const allRequests = await fetchCompOffRequests();
        console.log('📋 All comp-off requests:', allRequests);
        const req = allRequests.find(r => String(r.id) === String(requestId));
        console.log('🎯 Found request:', req);
        const adminId = await resolveCurrentEmployeeId();`;

if (content.includes(oldApproveHandler)) {
    content = content.replace(oldApproveHandler, newApproveHandler);
    console.log('✅ Added validation to approve handler');
} else {
    console.log('⚠️  Approve handler pattern not found');
}

// Add validation to handleCompOffReject
const oldRejectHandler = `const handleCompOffReject = async (requestId) => {
    const reason = prompt('Enter rejection reason (optional):');
    if (reason === null) {
        return;
    }

    try {
        const allRequests = await fetchCompOffRequests();
        const req = allRequests.find(r => String(r.id) === String(requestId));
        const adminId = await resolveCurrentEmployeeId();`;

const newRejectHandler = `const handleCompOffReject = async (requestId) => {
    console.log('🔍 handleCompOffReject called with requestId:', requestId);
    
    if (!requestId || requestId === '' || requestId === 'undefined') {
        alert('❌ Error: Request ID is missing. Please refresh the page and try again.');
        console.error('❌ Invalid requestId:', requestId);
        return;
    }
    
    const reason = prompt('Enter rejection reason (optional):');
    if (reason === null) {
        return;
    }

    try {
        const allRequests = await fetchCompOffRequests();
        console.log('📋 All comp-off requests:', allRequests);
        const req = allRequests.find(r => String(r.id) === String(requestId));
        console.log('🎯 Found request:', req);
        const adminId = await resolveCurrentEmployeeId();`;

if (content.includes(oldRejectHandler)) {
    content = content.replace(oldRejectHandler, newRejectHandler);
    console.log('✅ Added validation to reject handler');
} else {
    console.log('⚠️  Reject handler pattern not found');
}

// Add logging to the button rendering to see what ID is being set
const oldButtonRender = `                            <button class="btn btn-success btn-sm compoff-approve-btn" data-id="\${req.id}"><i class="fa-solid fa-check"></i> Grant</button>
                            <button class="btn btn-danger btn-sm compoff-reject-btn" data-id="\${req.id}"><i class="fa-solid fa-times"></i> Reject</button>`;

const newButtonRender = `                            <button class="btn btn-success btn-sm compoff-approve-btn" data-id="\${req.id || ''}" data-debug-req="\${JSON.stringify({id: req.id, empId: req.employeeId}).replace(/"/g, '&quot;')}"><i class="fa-solid fa-check"></i> Grant</button>
                            <button class="btn btn-danger btn-sm compoff-reject-btn" data-id="\${req.id || ''}" data-debug-req="\${JSON.stringify({id: req.id, empId: req.employeeId}).replace(/"/g, '&quot;')}"><i class="fa-solid fa-times"></i> Reject</button>`;

if (content.includes(oldButtonRender)) {
    content = content.replace(oldButtonRender, newButtonRender);
    console.log('✅ Added debug attributes to buttons');
} else {
    console.log('⚠️  Button render pattern not found');
}

// Write back
fs.writeFileSync(filePath, content, 'latin1');

console.log('✅ Comp-off ID validation and logging added!');
console.log('📝 Restart your frontend and check the console logs');
console.log('');
console.log('Next steps:');
console.log('1. Restart frontend: npm run dev');
console.log('2. Go to Inbox → Comp Off requests');
console.log('3. Open browser console (F12)');
console.log('4. Click Approve or Reject');
console.log('5. Check console logs to see what requestId is being passed');
