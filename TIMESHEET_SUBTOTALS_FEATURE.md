# Timesheet Inbox Subtotals Feature

## Overview
Added **daily subtotals** and **weekly total** to the timesheet approval view in the Inbox. This helps approvers quickly see how many hours were worked each day and for the entire week.

## Features Implemented

### 1. Daily Subtotals
- After each day's tasks, a **subtotal row** is displayed
- Shows the total hours for that specific day
- Styled with a light gray background to distinguish from regular rows
- Format: `Subtotal (Mon, Nov 17): 39.09`

### 2. Weekly Total
- At the bottom of the timesheet table, a **weekly total row** is displayed
- Shows the sum of all hours for the entire week (Mon-Fri)
- Styled with a blue background in the footer
- Format: `Weekly Total: 39.09`

## Visual Example

**Before:**
```
Day          | Task      | Hours
-------------|-----------|-------
Mon, Nov 17  | TEST 001  | 10.09
Mon, Nov 17  | testing   | 29.00
Tue, Nov 18  | testing   | 0.09
```

**After:**
```
Day          | Task      | Hours
-------------|-----------|-------
Mon, Nov 17  | TEST 001  | 10.09
Mon, Nov 17  | testing   | 29.00
Subtotal (Mon, Nov 17):    39.09  ← Daily subtotal
Tue, Nov 18  | testing   | 0.09
Subtotal (Tue, Nov 18):    0.09   ← Daily subtotal
─────────────────────────────────
Weekly Total:              39.18  ← Weekly total
```

## Implementation Details

### File Modified:
- `pages/shared.js` (timesheet inbox rendering)

### Logic:
1. **Calculate daily totals**: Loop through all rows and sum hours by day
2. **Calculate weekly total**: Sum all hours for the week
3. **Insert subtotal rows**: After each day's last task, insert a subtotal row
4. **Add footer**: Add a `<tfoot>` element with the weekly total

### Code Changes:

#### Daily Subtotals:
```javascript
// Calculate daily totals
const dailyTotals = {};
let weeklyTotal = 0;

sortedRows.forEach((r) => {
    const day = r.day_text;
    const hours = Number(r.hours_value || 0);
    if (!dailyTotals[day]) dailyTotals[day] = 0;
    dailyTotals[day] += hours;
    weeklyTotal += hours;
});

// Add subtotal after each day
if (r.day_text !== nextDay) {
    const dayTotal = dailyTotals[r.day_text];
    rowsHtmlArray.push(`<tr style="background:#f8fafc;">
        <td colspan="2" style="padding:6px 10px; border-bottom:2px solid #d1d5db; text-align:right; font-weight:600; color:#4b5563; font-size:12px;">
            Subtotal (${r.day_text}):
        </td>
        <td style="padding:6px 10px; border-bottom:2px solid #d1d5db; text-align:right; font-weight:700; color:#1f2937;">
            ${dayTotal.toFixed(2)}
        </td>
    </tr>`);
}
```

#### Weekly Total:
```javascript
<tfoot style="background:#eef2ff; border-top:3px solid #3b82f6;">
    <tr>
        <td colspan="2" style="padding:10px; text-align:right; font-weight:700; color:#1e40af; font-size:14px;">
            Weekly Total:
        </td>
        <td style="padding:10px; text-align:right; font-weight:700; color:#1e40af; font-size:14px;">
            ${weeklyTotal.toFixed(2)}
        </td>
    </tr>
</tfoot>
```

## Styling

### Daily Subtotal Row:
- Background: `#f8fafc` (light gray)
- Border: `2px solid #d1d5db` (medium gray)
- Font weight: `600` (semi-bold)
- Text color: `#4b5563` (dark gray)
- Font size: `12px`

### Weekly Total Row:
- Background: `#eef2ff` (light blue)
- Border top: `3px solid #3b82f6` (blue)
- Font weight: `700` (bold)
- Text color: `#1e40af` (dark blue)
- Font size: `14px`

## Testing

### Test Scenario 1: Single Day
1. Submit timesheet with tasks on one day only
2. Go to Inbox → Timesheet
3. **Expected**: 
   - One subtotal row after the day's tasks
   - Weekly total = daily subtotal

### Test Scenario 2: Multiple Days
1. Submit timesheet with tasks on Mon, Tue, Wed
2. Go to Inbox → Timesheet
3. **Expected**:
   - Subtotal after Monday's tasks
   - Subtotal after Tuesday's tasks
   - Subtotal after Wednesday's tasks
   - Weekly total = sum of all subtotals

### Test Scenario 3: Multiple Tasks Same Day
1. Submit timesheet with 3 tasks on Monday (5hrs, 6hrs, 2hrs)
2. Go to Inbox → Timesheet
3. **Expected**:
   - All 3 tasks listed
   - Subtotal (Mon): 13.00
   - Weekly total: 13.00

## Edge Cases Handled

### ✅ No Tasks
- If no timesheet entries, table shows "No tasks" placeholder
- No subtotals or weekly total shown

### ✅ Single Task
- Shows the task
- Shows subtotal for that day
- Shows weekly total (same as subtotal)

### ✅ Merged Records
- If multiple records are combined (e.g., "2 records combined" badge)
- Subtotal correctly sums the merged hours
- Badge still appears next to task name

### ✅ Decimal Hours
- All hours are formatted to 2 decimal places
- Example: 10.09, 29.00, 0.09

## Backward Compatibility

✅ **Fully backward compatible!**

- Existing timesheet approval functionality unchanged
- Approve/Reject buttons still work
- No database changes required
- No API changes required
- Only frontend display enhanced

## Benefits

### For Approvers:
1. **Quick verification**: See daily totals at a glance
2. **Catch errors**: Easily spot if someone logged 20+ hours in one day
3. **Weekly overview**: Know total hours for the week without manual calculation

### For Employees:
1. **Transparency**: See exactly how hours are being calculated
2. **Confidence**: Know that totals are accurate before approval

## Future Enhancements

- [ ] Highlight days with >8 hours (overtime indicator)
- [ ] Show expected vs actual hours (e.g., "Expected: 40, Actual: 39.18")
- [ ] Color-code subtotals (red if >8hrs, green if normal)
- [ ] Add project-wise subtotals (if multiple projects in one week)
- [ ] Export timesheet with subtotals to PDF

## Troubleshooting

### Subtotals not showing
- Clear browser cache
- Restart frontend dev server
- Check browser console for JavaScript errors

### Wrong totals
- Verify hours are stored as numbers in database
- Check for null/undefined values in hours field
- Ensure `Number(r.hours_value || 0)` is working correctly

### Styling issues
- Check if custom CSS is overriding inline styles
- Verify browser supports the CSS properties used
- Test in different browsers (Chrome, Firefox, Edge)

## Production Deployment

### Step 1: Test Locally
```bash
# Restart frontend
npm run dev

# Submit a test timesheet
# Go to Inbox → Timesheet
# Verify subtotals and weekly total appear
```

### Step 2: Deploy
```bash
# Push changes
git add .
git commit -m "Add daily subtotals and weekly total to timesheet inbox"
git push

# On production server:
npm run build
pm2 restart office-frontend
```

### Step 3: Verify
1. Submit a real timesheet
2. Check inbox as approver
3. Verify subtotals and weekly total are correct

## Support

For issues or questions:
- Check browser console for errors
- Verify the timesheet data structure in the API response
- Contact development team if calculations are incorrect

---

**Feature Status**: ✅ Implemented and Ready for Testing
**Breaking Changes**: None
**Database Changes**: None
**API Changes**: None
