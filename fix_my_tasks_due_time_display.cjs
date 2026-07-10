const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'pages', 'shared.js');

console.log('🔧 Fixing My Tasks Due Time display...');

// Read file with latin1 encoding
let content = fs.readFileSync(filePath, 'latin1');

// Fix the skeleton table header (line 5697) - add Due Time column
const oldSkeletonHeader = `<thead><tr><th>Work item id & name</th><th>Project</th><th>Client</th><th>Status</th><th>Due date</th><th>Priority</th><th>Time spent</th></tr></thead>`;
const newSkeletonHeader = `<thead><tr><th>Work item id & name</th><th>Project</th><th>Client</th><th>Status</th><th>Due date</th><th>Due Time</th><th>Priority</th><th>Time spent</th></tr></thead>`;

if (content.includes(oldSkeletonHeader)) {
    content = content.replace(oldSkeletonHeader, newSkeletonHeader);
    console.log('✅ Fixed skeleton table header');
} else {
    console.log('⚠️  Skeleton header already updated or not found');
}

// Ensure the main table header is correct (should already be done, but double-check)
const mainHeaderCheck = `                                <th>Due date</th>
                                <th>Due Time</th>
                                <th>Priority</th>`;

if (content.includes(mainHeaderCheck)) {
    console.log('✅ Main table header is correct');
} else {
    console.log('⚠️  Main table header might need fixing');
    
    // Try to fix it
    const oldMainHeader = `                                <th>Due date</th>
                                <th>Priority</th>`;
    const newMainHeader = `                                <th>Due date</th>
                                <th>Due Time</th>
                                <th>Priority</th>`;
    
    if (content.includes(oldMainHeader)) {
        content = content.replace(oldMainHeader, newMainHeader);
        console.log('✅ Fixed main table header');
    }
}

// Write back
fs.writeFileSync(filePath, content, 'latin1');

console.log('✅ My Tasks Due Time display fixed!');
console.log('📝 Restart your frontend dev server to see the changes');
console.log('');
console.log('Note: Make sure the backend is returning due_time in the API response.');
console.log('Check backend logs for: /api/my-tasks');
