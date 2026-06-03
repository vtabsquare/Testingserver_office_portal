import sys
import os
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

print('Finding Login Activity records...')
q1 = f"{unified_server.BASE_URL}/{unified_server.LOGIN_ACTIVITY_ENTITY}?$filter=crc6f_employeeid eq '{emp}' and crc6f_date eq '{dt}'"
r1 = sess.get(q1, headers=headers)
la_records = r1.json().get('value', [])
print(f"Found {len(la_records)} login activity records")
for x in la_records:
    id_val = x['crc6f_hr_loginactivitytbid']
    res = sess.delete(f"{unified_server.BASE_URL}/{unified_server.LOGIN_ACTIVITY_ENTITY}({id_val})", headers=headers)
    print(f"  Deleted Login Activity: {id_val} - Status: {res.status_code}")

print('Finding Attendance records...')
q2 = f"{unified_server.BASE_URL}/{unified_server.ATTENDANCE_ENTITY}?$filter=crc6f_employeeid eq '{emp}' and crc6f_date eq '{dt}'"
r2 = sess.get(q2, headers=headers)
att_records = r2.json().get('value', [])
print(f"Found {len(att_records)} attendance records")
for x in att_records:
    id_val = x.get('crc6f_table13id') or x.get('cr6f_table13id')
    if id_val:
        res = sess.delete(f"{unified_server.BASE_URL}/{unified_server.ATTENDANCE_ENTITY}({id_val})", headers=headers)
        print(f"  Deleted Attendance: {id_val} - Status: {res.status_code}")

print(f'\nDone! Cleared all data for {emp} on {dt}')
print('*** IMPORTANT: You must restart the backend server for the timezone fix to take effect! ***')
