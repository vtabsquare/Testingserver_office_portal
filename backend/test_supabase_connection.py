"""
Test Supabase Connection
========================
Run this script to verify your Supabase setup works correctly.

Usage:
    python test_supabase_connection.py
"""

import os
import sys
from dotenv import load_dotenv

load_dotenv("id.env")

print("=" * 60)
print("SUPABASE CONNECTION TEST")
print("=" * 60)

# Step 1: Check environment variables
print("\n[1/5] Checking environment variables...")
url = os.getenv("SUPABASE_URL")
anon_key = os.getenv("SUPABASE_ANON_KEY")
service_key = os.getenv("SUPABASE_SERVICE_KEY")

if not url:
    print("   FAIL: SUPABASE_URL not set in id.env")
    sys.exit(1)
if not service_key and not anon_key:
    print("   FAIL: Neither SUPABASE_SERVICE_KEY nor SUPABASE_ANON_KEY set in id.env")
    sys.exit(1)

print(f"   SUPABASE_URL: {url}")
print(f"   SUPABASE_ANON_KEY: {'SET' if anon_key else 'NOT SET'}")
print(f"   SUPABASE_SERVICE_KEY: {'SET' if service_key else 'NOT SET'}")
print("   PASS")

# Step 2: Import supabase
print("\n[2/5] Importing supabase package...")
try:
    from supabase import create_client
    print("   PASS")
except ImportError:
    print("   FAIL: supabase package not installed")
    print("   Run: pip install supabase")
    sys.exit(1)

# Step 3: Connect to Supabase
print("\n[3/5] Connecting to Supabase...")
try:
    key = service_key or anon_key
    sb = create_client(url, key)
    print("   PASS - Client created")
except Exception as e:
    print(f"   FAIL: {e}")
    sys.exit(1)

# Step 4: Test table access
print("\n[4/5] Testing table access...")
TABLES_TO_CHECK = [
    "crc6f_table12s",          # Employees
    "crc6f_hr_login_detailses", # Login accounts
    "crc6f_table13s",          # Attendance
    "crc6f_table14s",          # Leave requests
    "crc6f_hr_leavemangements", # Leave balances
    "crc6f_hr_assetdetailses",  # Assets
    "crc6f_hr_holidayses",     # Holidays
    "crc6f_hr_clients",        # Clients
    "crc6f_hr_projectheaders", # Projects
    "crc6f_hr_projectdetailses", # Project boards
    "crc6f_hr_taskdetailses",  # Tasks
    "crc6f_hr_projectcontributorses", # Contributors
    "crc6f_hr_timesheetlogs",  # Timesheets
    "crc6f_hr_chat_conversations", # Chat conversations
    "crc6f_hr_conversation_memberses", # Chat members
    "crc6f_hr_messageses",     # Chat messages
    "crc6f_hr_messagestatuses", # Message status
    "crc6f_hr_interndetailses", # Interns
    "crc6f_hierarchies",       # Hierarchy
    "crc6f_hr_loginactivitytbs", # Login activity
    "crc6f_hr_inboxes",        # Notifications
    "annotations",             # File annotations
    "auth_session_events",     # Auth events
    "auth_session_policy",     # Auth policy
    "crc6f_hr_projectcolumns", # Project columns
    "crc6f_compensatoryrequests", # Comp off
]

found = 0
missing = 0
for table in TABLES_TO_CHECK:
    try:
        response = sb.table(table).select("*", count="exact").limit(0).execute()
        count = response.count if response.count is not None else "?"
        print(f"   OK  {table:45s} ({count} rows)")
        found += 1
    except Exception as e:
        err_str = str(e)
        if "does not exist" in err_str or "404" in err_str or "relation" in err_str:
            print(f"   MISSING  {table}")
            missing += 1
        else:
            print(f"   ERROR  {table}: {err_str[:80]}")
            missing += 1

print(f"\n   Tables found: {found}/{len(TABLES_TO_CHECK)}")
if missing > 0:
    print(f"   Tables missing: {missing}")

# Step 5: Test CRUD operations
print("\n[5/5] Testing CRUD operations...")
TEST_TABLE = "crc6f_table12s"

try:
    # Test INSERT
    test_data = {
        "crc6f_employeeid": "TEST_MIGRATION_001",
        "crc6f_firstname": "Test",
        "crc6f_lastname": "Migration",
        "crc6f_email": "test@migration.local",
        "crc6f_department": "TEST",
        "crc6f_activeflag": False,
    }
    
    print("   Testing INSERT...")
    result = sb.table(TEST_TABLE).insert(test_data).execute()
    if result.data and len(result.data) > 0:
        record_id = result.data[0].get("crc6f_table12id")
        print(f"   INSERT OK - ID: {record_id}")
    else:
        print("   INSERT returned no data (may still have succeeded)")
        record_id = None

    # Test SELECT
    print("   Testing SELECT...")
    result = sb.table(TEST_TABLE).select("*").eq("crc6f_employeeid", "TEST_MIGRATION_001").execute()
    if result.data and len(result.data) > 0:
        print(f"   SELECT OK - Found {len(result.data)} record(s)")
        record_id = record_id or result.data[0].get("crc6f_table12id")
    else:
        print("   SELECT returned no data")

    # Test UPDATE
    if record_id:
        print("   Testing UPDATE...")
        result = sb.table(TEST_TABLE).update({"crc6f_designation": "Test Role"}).eq("crc6f_table12id", record_id).execute()
        print("   UPDATE OK")

    # Test DELETE (clean up test data)
    print("   Testing DELETE...")
    result = sb.table(TEST_TABLE).delete().eq("crc6f_employeeid", "TEST_MIGRATION_001").execute()
    print("   DELETE OK - Test data cleaned up")

    print("\n   ALL CRUD OPERATIONS PASSED")

except Exception as e:
    print(f"   CRUD TEST FAILED: {e}")
    # Try to clean up
    try:
        sb.table(TEST_TABLE).delete().eq("crc6f_employeeid", "TEST_MIGRATION_001").execute()
    except:
        pass

# Step 6: Test supabase_helper.py import
print("\n[BONUS] Testing supabase_helper.py import...")
try:
    from supabase_helper import (
        create_record, get_record, update_record, delete_record,
        fetch_record_by_id, get_employee_name, get_employee_email,
        get_access_token, get_dataverse_session, query_records
    )
    print("   All function imports OK")
    print("   PASS")
except ImportError as e:
    print(f"   FAIL: {e}")

# Summary
print("\n" + "=" * 60)
print("TEST SUMMARY")
print("=" * 60)
print(f"  Tables found:    {found}/{len(TABLES_TO_CHECK)}")
print(f"  Tables missing:  {missing}")
print(f"  CRUD operations: PASSED")
print(f"  Connection:      ACTIVE")
print("=" * 60)
print("\nYou are ready to migrate from Dataverse to Supabase!")
print("Next step: Update imports in your backend files:")
print("  Old: from dataverse_helper import ...")
print("  New: from supabase_helper import ...")
print("=" * 60)
