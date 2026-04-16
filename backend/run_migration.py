"""
Create onboarding tables in Supabase using direct PostgreSQL connection.
Tries multiple connection methods.
"""
import os, sys, json
from dotenv import load_dotenv
load_dotenv("id.env")

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

# Decode the JWT to get project ref
import base64
parts = SUPABASE_SERVICE_KEY.split(".")
if len(parts) >= 2:
    payload = parts[1]
    # Add padding
    payload += "=" * (4 - len(payload) % 4)
    decoded = json.loads(base64.b64decode(payload))
    project_ref = decoded.get("ref", "")
    print(f"Project ref from JWT: {project_ref}")
else:
    project_ref = "ofzdvvjkqgnheogwfdnk"

# Try to connect using psycopg2
# Supabase direct connection: postgres://postgres.[ref]:[password]@db.[ref].supabase.co:5432/postgres
# Session mode pooler: postgres://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres
# Transaction mode pooler: postgres://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres

# The service key JWT can be used as the password for the pooler connection
# https://supabase.com/docs/guides/database/connecting-to-postgres#connecting-with-ssl

SQL = """
CREATE TABLE IF NOT EXISTS crc6f_hr_onboardings (
    crc6f_hr_onboardingid UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    crc6f_firstname VARCHAR(100),
    crc6f_lastname VARCHAR(100),
    crc6f_email VARCHAR(255),
    crc6f_contactno VARCHAR(50),
    crc6f_address TEXT,
    crc6f_department VARCHAR(100),
    crc6f_designation VARCHAR(100),
    crc6f_doj DATE,
    crc6f_progresssteps VARCHAR(100) DEFAULT 'Personal Information',
    crc6f_interviewstatus VARCHAR(50),
    crc6f_interviewdate VARCHAR(100),
    crc6f_offerpmail VARCHAR(50) DEFAULT 'Not Sent',
    crc6f_offerpmailreply VARCHAR(50) DEFAULT 'Pending',
    crc6f_documentsstatus VARCHAR(50) DEFAULT 'Pending',
    crc6f_documentsuploaded TEXT,
    crc6f_onboardingid VARCHAR(50),
    crc6f_convertedtoemployee BOOLEAN DEFAULT FALSE,
    metadata JSONB,
    createdon TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    modifiedon TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS crc6f_hr_onboardingprogresslogs (
    crc6f_hr_onboardingprogresslogid UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    crc6f_onboardingid UUID,
    crc6f_stagename VARCHAR(200),
    crc6f_progresssteps VARCHAR(200),
    crc6f_stagenumber INTEGER,
    crc6f_refid INTEGER,
    crc6f_completedat TIMESTAMPTZ,
    crc6f_timestamps TIMESTAMPTZ,
    crc6f_notes TEXT,
    createdby VARCHAR(100),
    metadata JSONB,
    createdon TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ,
    CONSTRAINT fk_progresslog_onboarding FOREIGN KEY (crc6f_onboardingid)
        REFERENCES crc6f_hr_onboardings(crc6f_hr_onboardingid) ON DELETE CASCADE
);

ALTER TABLE crc6f_hr_onboardings ENABLE ROW LEVEL SECURITY;
ALTER TABLE crc6f_hr_onboardingprogresslogs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'crc6f_hr_onboardings' AND policyname = 'Allow full access to crc6f_hr_onboardings') THEN
        CREATE POLICY "Allow full access to crc6f_hr_onboardings" ON crc6f_hr_onboardings FOR ALL USING (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'crc6f_hr_onboardingprogresslogs' AND policyname = 'Allow full access to crc6f_hr_onboardingprogresslogs') THEN
        CREATE POLICY "Allow full access to crc6f_hr_onboardingprogresslogs" ON crc6f_hr_onboardingprogresslogs FOR ALL USING (true);
    END IF;
END $$;
"""

try:
    import psycopg2
except ImportError:
    print("psycopg2 not installed. Run: python -m pip install psycopg2-binary")
    sys.exit(1)

# Try different connection strings
# Common Supabase regions
regions = ["ap-south-1", "us-east-1", "us-west-1", "eu-west-1", "ap-southeast-1"]

# Try direct connection first
connection_configs = [
    # Direct connection with service key as password
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

# Add pooler configs for common regions
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
        
        # Execute the SQL
        cur = conn.cursor()
        cur.execute(SQL)
        print("[OK] Tables created successfully!")
        
        # Verify
        cur.execute("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'crc6f_hr_onboarding%'")
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
    print(f"\nSQL file: {os.path.join(os.path.dirname(os.path.abspath(__file__)), 'create_onboarding_tables.sql')}")
