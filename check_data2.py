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

q1 = f"{unified_server.BASE_URL}/{unified_server.LOGIN_ACTIVITY_ENTITY}?$filter=crc6f_employeeid eq '{emp}' and crc6f_date eq '{dt}'"
r1 = sess.get(q1, headers=headers)
print("Login Activity:")
for x in r1.json().get('value', []):
    print(f"ID: {x['crc6f_hr_loginactivitytbid']} | CheckIn: {x.get('crc6f_checkintime')} | Tz: {x.get('crc6f_timezone')} | ClientTime: {x.get('crc6f_clienttime')}")
