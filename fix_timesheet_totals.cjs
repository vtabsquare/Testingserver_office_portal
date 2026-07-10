const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'pages', 'shared.js');

console.log('🔧 Adding timesheet subtotals and weekly total...');

// Read file with latin1 encoding
let content = fs.readFileSync(filePath, 'latin1');

// Step 1: Replace the rows generation to add daily subtotals
const oldPattern1 = `.sort((a, b) => (a.date === b.date ? a.task_text.localeCompare(b.task_text) : a.date.localeCompare(b.date)))
                    .map((r) => {
                        const mergedBadge = r.merge_count > 1
                            ? \`<span style="margin-left:6px; padding:1px 6px; border-radius:999px; font-size:11px; background:#eef2ff; color:#3730a3; font-weight:600;">\${r.merge_count} records combined</span>\`
                            : '';
                        return \`<tr><td style="padding:8px 10px; border-bottom:1px solid #eef2f7;">\${r.day_text}</td><td style="padding:8px 10px; border-bottom:1px solid #eef2f7;">\${r.task_text}\${mergedBadge}</td><td style="padding:8px 10px; border-bottom:1px solid #eef2f7; text-align:right;">\${Number(r.hours_value || 0).toFixed(2)}</td></tr>\`;
                    })
                    .join('');`;

const newPattern1 = `.sort((a, b) => (a.date === b.date ? a.task_text.localeCompare(b.task_text) : a.date.localeCompare(b.date)));
                
                // Calculate daily totals and weekly total
                const dailyTotals = {};
                let weeklyTotal = 0;
                const sortedRows = group.rows.sort((a, b) => (a.date === b.date ? a.task_text.localeCompare(b.task_text) : a.date.localeCompare(b.date)));
                
                sortedRows.forEach((r) => {
                    const day = r.day_text;
                    const hours = Number(r.hours_value || 0);
                    if (!dailyTotals[day]) dailyTotals[day] = 0;
                    dailyTotals[day] += hours;
                    weeklyTotal += hours;
                });
                
                // Generate rows with daily subtotals
                const rowsHtmlArray = [];
                let currentDay = null;
                
                sortedRows.forEach((r, idx) => {
                    const mergedBadge = r.merge_count > 1
                        ? \`<span style="margin-left:6px; padding:1px 6px; border-radius:999px; font-size:11px; background:#eef2ff; color:#3730a3; font-weight:600;">\${r.merge_count} records combined</span>\`
                        : '';
                    
                    rowsHtmlArray.push(\`<tr><td style="padding:8px 10px; border-bottom:1px solid #eef2f7;">\${r.day_text}</td><td style="padding:8px 10px; border-bottom:1px solid #eef2f7;">\${r.task_text}\${mergedBadge}</td><td style="padding:8px 10px; border-bottom:1px solid #eef2f7; text-align:right;">\${Number(r.hours_value || 0).toFixed(2)}</td></tr>\`);
                    
                    // Add subtotal if day changes or last row
                    const isLastRow = idx === sortedRows.length - 1;
                    const nextDay = !isLastRow ? sortedRows[idx + 1].day_text : null;
                    
                    if (r.day_text !== nextDay) {
                        const dayTotal = dailyTotals[r.day_text];
                        rowsHtmlArray.push(\`<tr style="background:#f8fafc;"><td colspan="2" style="padding:6px 10px; border-bottom:2px solid #d1d5db; text-align:right; font-weight:600; color:#4b5563; font-size:12px;">Subtotal (\${r.day_text}):</td><td style="padding:6px 10px; border-bottom:2px solid #d1d5db; text-align:right; font-weight:700; color:#1f2937;">\${dayTotal.toFixed(2)}</td></tr>\`);
                    }
                });
                
                const rowsHtml = rowsHtmlArray.join('');`;

if (content.includes(oldPattern1)) {
    content = content.replace(oldPattern1, newPattern1);
    console.log('✅ Added daily subtotals logic');
} else {
    console.log('⚠️  Pattern 1 not found - daily subtotals not added');
}

// Step 2: Add weekly total to table footer (already done in previous script, but ensure it's using weeklyTotal variable)
const oldTablePattern = `<tbody>\${rowsHtml}</tbody>
                                </table>`;

const newTablePattern = `<tbody>\${rowsHtml}</tbody>
                                    <tfoot style="background:#eef2ff; border-top:3px solid #3b82f6;">
                                        <tr>
                                            <td colspan="2" style="padding:12px 10px; text-align:right; font-weight:700; color:#1e40af; font-size:14px;">Weekly Total:</td>
                                            <td style="padding:12px 10px; text-align:right; font-weight:700; color:#1e40af; font-size:15px;">\${weeklyTotal.toFixed(2)}</td>
                                        </tr>
                                    </tfoot>
                                </table>`;

if (content.includes(oldTablePattern)) {
    content = content.replace(oldTablePattern, newTablePattern);
    console.log('✅ Added weekly total footer');
} else {
    console.log('⚠️  Pattern 2 not found - weekly total might already be added');
}

// Write back
fs.writeFileSync(filePath, content, 'latin1');

console.log('✅ Timesheet inbox updated successfully!');
console.log('📝 Restart your frontend to see:');
console.log('   - Daily subtotals after each day');
console.log('   - Weekly total at the bottom');
