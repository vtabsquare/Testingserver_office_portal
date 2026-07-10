const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'pages', 'shared.js');

console.log('🔧 Adding daily subtotals and weekly total to timesheet inbox...');

// Read file with latin1 encoding
let content = fs.readFileSync(filePath, 'latin1');

// Find the timesheet table rendering section and add subtotals
const oldTimesheetTable = `                const rowsHtml = group.rows
                    .map((r) => {
                        const mergedBadge = r.merge_count > 1
                            ? \`<span style="margin-left:6px; padding:1px 6px; border-radius:999px; font-size:11px; background:#eef2ff; color:#3730a3; font-weight:600;">\${r.merge_count} records combined</span>\`
                            : '';
                        return \`<tr><td style="padding:8px 10px; border-bottom:1px solid #eef2f7;">\${r.day_text}</td><td style="padding:8px 10px; border-bottom:1px solid #eef2f7;">\${r.task_text}\${mergedBadge}</td><td style="padding:8px 10px; border-bottom:1px solid #eef2f7; text-align:right;">\${Number(r.hours_value || 0).toFixed(2)}</td></tr>\`;
                    })
                    .join('');`;

const newTimesheetTable = `                // Calculate daily subtotals and weekly total
                const dailyTotals = {};
                let weeklyTotal = 0;
                
                group.rows.forEach((r) => {
                    const day = r.day_text;
                    const hours = Number(r.hours_value || 0);
                    
                    if (!dailyTotals[day]) {
                        dailyTotals[day] = 0;
                    }
                    dailyTotals[day] += hours;
                    weeklyTotal += hours;
                });

                const rowsHtml = [];
                let currentDay = null;
                
                group.rows.forEach((r, idx) => {
                    const mergedBadge = r.merge_count > 1
                        ? \`<span style="margin-left:6px; padding:1px 6px; border-radius:999px; font-size:11px; background:#eef2ff; color:#3730a3; font-weight:600;">\${r.merge_count} records combined</span>\`
                        : '';
                    
                    rowsHtml.push(\`<tr><td style="padding:8px 10px; border-bottom:1px solid #eef2f7;">\${r.day_text}</td><td style="padding:8px 10px; border-bottom:1px solid #eef2f7;">\${r.task_text}\${mergedBadge}</td><td style="padding:8px 10px; border-bottom:1px solid #eef2f7; text-align:right;">\${Number(r.hours_value || 0).toFixed(2)}</td></tr>\`);
                    
                    // Check if next row is a different day or if this is the last row
                    const isLastRow = idx === group.rows.length - 1;
                    const nextDay = !isLastRow ? group.rows[idx + 1].day_text : null;
                    
                    if (r.day_text !== nextDay) {
                        // Add daily subtotal row
                        const dayTotal = dailyTotals[r.day_text];
                        rowsHtml.push(\`<tr style="background:#f8fafc;"><td colspan="2" style="padding:8px 10px; border-bottom:1px solid #d1d5db; text-align:right; font-weight:600; color:#4b5563;">Subtotal (\${r.day_text}):</td><td style="padding:8px 10px; border-bottom:1px solid #d1d5db; text-align:right; font-weight:700; color:#1f2937;">\${dayTotal.toFixed(2)}</td></tr>\`);
                    }
                });
                
                const rowsHtmlString = rowsHtml.join('');`;

if (content.includes(oldTimesheetTable)) {
    content = content.replace(oldTimesheetTable, newTimesheetTable);
    console.log('✅ Added daily subtotals calculation');
} else {
    console.log('⚠️  Warning: Timesheet table pattern not found');
}

// Now add the weekly total row at the bottom of the table
const oldTableClosing = `                                <table style="width:100%; border-collapse:collapse; font-size:13px;">
                                    <thead style="background:#f8fafc;"><tr><th style="text-align:left; padding:8px 10px;">Day</th><th style="text-align:left; padding:8px 10px;">Task</th><th style="text-align:right; padding:8px 10px;">Hours</th></tr></thead>
                                    <tbody>\${rowsHtml}</tbody>
                                </table>`;

const newTableClosing = `                                <table style="width:100%; border-collapse:collapse; font-size:13px;">
                                    <thead style="background:#f8fafc;"><tr><th style="text-align:left; padding:8px 10px;">Day</th><th style="text-align:left; padding:8px 10px;">Task</th><th style="text-align:right; padding:8px 10px;">Hours</th></tr></thead>
                                    <tbody>\${rowsHtmlString}</tbody>
                                    <tfoot style="background:#eef2ff;">
                                        <tr>
                                            <td colspan="2" style="padding:10px; text-align:right; font-weight:700; color:#1e40af; font-size:14px;">Weekly Total:</td>
                                            <td style="padding:10px; text-align:right; font-weight:700; color:#1e40af; font-size:14px;">\${weeklyTotal.toFixed(2)}</td>
                                        </tr>
                                    </tfoot>
                                </table>`;

if (content.includes(oldTableClosing)) {
    content = content.replace(oldTableClosing, newTableClosing);
    console.log('✅ Added weekly total row');
} else {
    console.log('⚠️  Warning: Table closing pattern not found');
}

// Write back
fs.writeFileSync(filePath, content, 'latin1');

console.log('✅ Timesheet subtotals and weekly total added successfully!');
console.log('📝 Restart your frontend dev server to see the changes');
console.log('');
console.log('Features added:');
console.log('  - Daily subtotals after each day\'s tasks');
console.log('  - Weekly total at the bottom of the table');
