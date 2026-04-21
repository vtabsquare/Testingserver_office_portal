"""Create onboarding tables using Supabase's postgrest-py rpc or direct HTTP SQL endpoint."""
import os, sys, requests, json
from dotenv import load_dotenv
load_dotenv("id.env")

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
    print("ERROR: SUPABASE_URL or SUPABASE_SERVICE_KEY not set")
    sys.exit(1)

# Read SQL file
sql_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "create_onboarding_tables.sql")
with open(sql_file, "r", encoding="utf-8") as f:
    sql = f.read()

# Use Supabase's internal SQL execution endpoint
# This endpoint is used by the Supabase dashboard
headers = {
    "apikey": SUPABASE_SERVICE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=minimal",
}

# Try the pg_meta SQL query endpoint
# Supabase exposes /pg/query for service-role authenticated SQL
endpoints_to_try = [
    f"{SUPABASE_URL}/rest/v1/rpc/",  # Check if there's a custom RPC
]

# First approach: use supabase-py to call a raw SQL function
# This requires creating an RPC function first, which we can't do without SQL access
# Let's try the direct approach: execute individual CREATE statements via psycopg2

print("Attempting to create tables using direct PostgreSQL connection...")
print(f"Supabase URL: {SUPABASE_URL}")

# Extract the project ref from the URL
import re
ref_match = re.search(r'https://([^.]+)\.supabase\.co', SUPABASE_URL)
project_ref = ref_match.group(1) if ref_match else None
print(f"Project ref: {project_ref}")

# Try using the pooler connection
# Supabase provides a connection string format:
# postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres
# But we need the DB password which is different from the service key

# Alternative: Use the Supabase Management API to execute SQL
# POST https://api.supabase.com/v1/projects/{ref}/database/query
# This requires the user's access token (not the service key)

# Simplest approach: try to create tables by calling individual INSERT/SELECT
# to see if they exist, if not, guide the user

print("\n" + "="*60)
print("CHECKING TABLE STATUS")
print("="*60)

# Test if tables exist
for table_name in ["crc6f_hr_onboardings", "crc6f_hr_onboardingprogresslogs"]:
    url = f"{SUPABASE_URL}/rest/v1/{table_name}?select=*&limit=0"
    resp = requests.get(url, headers={
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
    })
    if resp.status_code == 200:
        print(f"  [OK] {table_name} - EXISTS")
    elif resp.status_code == 404 or "does not exist" in resp.text:
        print(f"  [MISSING] {table_name} - NEEDS TO BE CREATED")
    else:
        print(f"  [?] {table_name} - Status {resp.status_code}: {resp.text[:150]}")

print("\n" + "="*60)
print("SQL TO RUN IN SUPABASE DASHBOARD -> SQL EDITOR:")
print("="*60)
print(f"\nFile: {sql_file}")
print(f"\nDashboard URL: https://supabase.com/dashboard/project/{project_ref}/sql/new")
print("\nPlease open the above URL, paste the SQL from the file, and click Run.")
