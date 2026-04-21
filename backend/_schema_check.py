"""Fetch all Supabase table schemas to identify column types."""
import os, json, urllib.request
from dotenv import load_dotenv
load_dotenv("id.env")

url = os.getenv("SUPABASE_URL")
key = os.getenv("SUPABASE_SERVICE_KEY") or os.getenv("SUPABASE_KEY")

# Use OpenAPI spec to get all table names
req = urllib.request.Request(f"{url}/rest/v1/", headers={
    "apikey": key, "Authorization": f"Bearer {key}"
})
resp = urllib.request.urlopen(req)
data = json.loads(resp.read())
if "definitions" in data:
    tables = sorted(data["definitions"].keys())
elif "paths" in data:
    tables = sorted(set(p.strip("/").split("?")[0] for p in data["paths"].keys() if p.strip("/")))
else:
    tables = []

print("ALL SUPABASE TABLES:")
for t in tables:
    print(f"  {t}")

from supabase import create_client
sb = create_client(url, key)

print("\nCOLUMN TYPES FROM OPENAPI SPEC (for empty tables):")
empty_tables = ["crc6f_table14s", "crc6f_compensatoryrequests", "crc6f_hierarchies",
                "crc6f_hr_holidayses", "crc6f_hr_inboxes", "crc6f_hr_clients",
                "crc6f_hr_projectcolumns", "crc6f_hr_interndetailses",
                "crc6f_hr_projectheaders", "crc6f_hr_timesheetlogs",
                "crc6f_hr_assetdetailses", "crc6f_hr_leavemangements"]
for tbl in empty_tables:
    defn = data.get("definitions", {}).get(tbl, {})
    props = defn.get("properties", {})
    if props:
        cols = ", ".join(f"{k}:{v.get('type','?')}({v.get('format','')})" for k, v in sorted(props.items())
                        if k not in ("created_at","updated_at","metadata"))
        print(f"\n{tbl}: {cols}")
    else:
        print(f"\n{tbl}: NO DEFINITION")
