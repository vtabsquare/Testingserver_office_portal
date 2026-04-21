import os, requests
from dotenv import load_dotenv
load_dotenv("id.env")
url = os.getenv("SUPABASE_URL","").rstrip("/")
key = os.getenv("SUPABASE_SERVICE_KEY","")
h = {"apikey": key, "Authorization": f"Bearer {key}"}

for table in ["crc6f_table13s", "crc6f_hr_loginactivitytbs"]:
    r = requests.options(f"{url}/rest/v1/{table}", headers=h)
    if r.status_code == 200:
        defs = r.json().get("definitions", {}).get(table, {}).get("properties", {})
        relevant = {}
        for k, v in defs.items():
            if any(x in k.lower() for x in ["check", "date", "duration", "status", "time", "second"]):
                relevant[k] = v
        print(f"=== {table} ===")
        for k, v in sorted(relevant.items()):
            fmt = v.get("format", "?")
            typ = v.get("type", "?")
            desc = v.get("description", "")
            print(f"  {k}: type={typ}, format={fmt}")
    else:
        print(f"{table}: OPTIONS returned {r.status_code}")
