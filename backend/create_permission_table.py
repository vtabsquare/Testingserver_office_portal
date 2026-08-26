"""
Create the crc6f_permissions table in Supabase using a direct PostgreSQL
connection. Mirrors run_migration.py's connection-brute-force approach.

Usage:
    python create_permission_table.py
"""
import os
import sys
import json
import base64

from dotenv import load_dotenv
load_dotenv("id.env")

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

parts = SUPABASE_SERVICE_KEY.split(".")
if len(parts) >= 2:
    payload = parts[1]
    payload += "=" * (4 - len(payload) % 4)
    decoded = json.loads(base64.b64decode(payload))
    project_ref = decoded.get("ref", "")
    print(f"Project ref from JWT: {project_ref}")
else:
    print("[FAIL] Could not decode SUPABASE_SERVICE_KEY to find project ref.")
    sys.exit(1)

sql_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "create_permission_table.sql")
with open(sql_path, "r", encoding="utf-8") as f:
    SQL = f.read()

try:
    import psycopg2
except ImportError:
    print("psycopg2 not installed. Run: python -m pip install psycopg2-binary")
    sys.exit(1)

regions = ["ap-south-1", "us-east-1", "us-west-1", "eu-west-1", "ap-southeast-1"]

connection_configs = [
    {
        "host": f"db.{project_ref}.supabase.co",
        "port": 5432,
        "database": "postgres",
        "user": f"postgres.{project_ref}",
        "password": SUPABASE_SERVICE_KEY,
        "sslmode": "require",
        "connect_timeout": 10,
    },
    {
        "host": f"db.{project_ref}.supabase.co",
        "port": 5432,
        "database": "postgres",
        "user": "postgres",
        "password": SUPABASE_SERVICE_KEY,
        "sslmode": "require",
        "connect_timeout": 10,
    },
]

for region in regions:
    connection_configs.extend([
        {
            "host": f"aws-0-{region}.pooler.supabase.com",
            "port": 6543,
            "database": "postgres",
            "user": f"postgres.{project_ref}",
            "password": SUPABASE_SERVICE_KEY,
            "sslmode": "require",
            "connect_timeout": 10,
        },
        {
            "host": f"aws-0-{region}.pooler.supabase.com",
            "port": 5432,
            "database": "postgres",
            "user": f"postgres.{project_ref}",
            "password": SUPABASE_SERVICE_KEY,
            "sslmode": "require",
            "connect_timeout": 10,
        },
    ])

connected = False
for i, config in enumerate(connection_configs):
    desc = f"{config['user']}@{config['host']}:{config['port']}"
    try:
        print(f"Trying [{i+1}/{len(connection_configs)}]: {desc} ... ", end="", flush=True)
        conn = psycopg2.connect(**config)
        conn.autocommit = True
        print("CONNECTED!")
        connected = True

        cur = conn.cursor()
        cur.execute(SQL)
        print("[OK] crc6f_permissions table created successfully!")

        cur.execute("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'crc6f_permissions'")
        tables = cur.fetchall()
        print(f"[OK] Verified tables: {[t[0] for t in tables]}")

        cur.close()
        conn.close()
        break
    except psycopg2.OperationalError as e:
        err = str(e).split('\n')[0][:100]
        print(f"FAILED ({err})")
    except Exception as e:
        err = str(e).split('\n')[0][:100]
        print(f"ERROR ({err})")

if not connected:
    print("\n[FAIL] Could not connect to Supabase PostgreSQL.")
    print("Please run the SQL manually in the Supabase Dashboard:")
    print(f"  https://supabase.com/dashboard/project/{project_ref}/sql/new")
    print(f"\nSQL file: {sql_path}")
