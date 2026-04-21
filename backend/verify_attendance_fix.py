"""Verify the attendance column fix by testing insert with time-only strings."""
import os
from dotenv import load_dotenv
from supabase import create_client
load_dotenv("id.env")
sb = create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_SERVICE_KEY"))

print("Testing crc6f_table13s (attendance) insert with time string...")
try:
    resp = sb.table("crc6f_table13s").insert({
        "crc6f_attendanceid": "ATD-TEST001",
        "crc6f_employeeid": "TESTFIX",
        "crc6f_date": "2026-04-15",
        "crc6f_checkin": "10:00:00",
        "crc6f_status": "P"
    }).execute()
    print(f"  [OK] Insert succeeded: {resp.data[0].get('crc6f_table13id', 'ok')}")
    # Clean up
    rid = resp.data[0]["crc6f_table13id"]
    sb.table("crc6f_table13s").delete().eq("crc6f_table13id", rid).execute()
    print("  [OK] Cleanup done")
except Exception as e:
    err = str(e)
    if "invalid input syntax for type timestamp" in err:
        print(f"  [FAIL] Column is still TIMESTAMPTZ - please run fix_attendance_columns.sql")
    else:
        print(f"  [FAIL] {err[:200]}")

print("\nTesting crc6f_hr_loginactivitytbs insert with time string...")
try:
    resp = sb.table("crc6f_hr_loginactivitytbs").insert({
        "crc6f_employeeid": "TESTFIX",
        "crc6f_date": "2026-04-15",
        "crc6f_checkintime": "10:00:00",
        "crc6f_checkin_timestamp": 1744720000,
        "crc6f_base_seconds": 0,
    }).execute()
    print(f"  [OK] Insert succeeded: {resp.data[0].get('crc6f_hr_loginactivitytbid', 'ok')}")
    # Clean up
    rid = resp.data[0]["crc6f_hr_loginactivitytbid"]
    sb.table("crc6f_hr_loginactivitytbs").delete().eq("crc6f_hr_loginactivitytbid", rid).execute()
    print("  [OK] Cleanup done")
except Exception as e:
    err = str(e)
    if "invalid input syntax for type timestamp" in err:
        print(f"  [FAIL] Column is still TIMESTAMPTZ - please run fix_attendance_columns.sql")
    else:
        print(f"  [FAIL] {err[:200]}")

print("\nDone. If both are OK, checkin/checkout will work.")
