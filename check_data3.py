import sys
import os
import json
from dotenv import load_dotenv

load_dotenv('backend/id.env')

sys.path.append('backend')
import unified_server

token = unified_server.get_access_token()
headers = {
    'Authorization': f'Bearer {token}', 
    'Accept': 'application/json', 
    'OData-MaxVersion': '4.0', 
    'OData-Version': '4.0'
}
sess = unified_server.get_dataverse_session()
emp = 'EMP015'
dt = '2026-05-29'

# Get ALL fields from login activity
q1 = f"{unified_server.BASE_URL}/{unified_server.LOGIN_ACTIVITY_ENTITY}?$filter=crc6f_employeeid eq '{emp}' and crc6f_date eq '{dt}'"
r1 = sess.get(q1, headers=headers)
print("=== Login Activity RAW ===")
for x in r1.json().get('value', []):
    print(json.dumps({k:v for k,v in x.items() if not k.startswith('@') and not k.startswith('_')}, indent=2))

# Get shift info
shift = unified_server._resolve_employee_shift(emp)
print(f"\n=== Shift Info ===")
print(json.dumps(shift, indent=2))

# Test late detection manually
checkin = x.get('crc6f_checkintime')
print(f"\n=== Late Check ===")
print(f"Raw checkin from DB: {checkin}")
formatted = unified_server._format_login_checkin_time(checkin)
print(f"Formatted checkin: {formatted}")
is_late = unified_server._is_late_login_for_shift(formatted, shift.get('shift_start', '09:00'), shift.get('grace_minutes', 15))
print(f"Is late: {is_late}")
print(f"Shift start: {shift.get('shift_start')}")
print(f"Grace: {shift.get('grace_minutes')}")

# Time to minutes
from unified_server import _time_to_minutes, _normalize_shift_time
threshold = _time_to_minutes(shift.get('shift_start', '09:00')) + int(shift.get('grace_minutes', 15))
checkin_mins = _time_to_minutes(_normalize_shift_time(formatted, ''))
print(f"Threshold minutes: {threshold}")
print(f"Checkin minutes: {checkin_mins}")
print(f"Checkin > threshold: {checkin_mins > threshold}")
