import os, sys, json
from dotenv import load_dotenv
load_dotenv("id.env")

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

import base64
parts = SUPABASE_SERVICE_KEY.split(".")
if len(parts) >= 2:
    payload = parts[1]
    payload += "=" * (4 - len(payload) % 4)
    decoded = json.loads(base64.b64decode(payload))
    project_ref = decoded.get("ref", "")
else:
    project_ref = "ofzdvvjkqgnheogwfdnk"

SQL = """
CREATE TABLE IF NOT EXISTS custom_roles (
    role_key VARCHAR PRIMARY KEY,
    role_name VARCHAR NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
"""

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
    try:
        conn = psycopg2.connect(**config)
        conn.autocommit = True
        connected = True
        
        cur = conn.cursor()
        cur.execute(SQL)
        print("[OK] Table custom_roles created successfully!")
        
        cur.close()
        conn.close()
        break
    except psycopg2.OperationalError as e:
        pass
    except Exception as e:
        pass

if not connected:
    print("\n[FAIL] Could not connect to Supabase PostgreSQL.")
