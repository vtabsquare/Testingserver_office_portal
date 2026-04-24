"""
Dataverse to Supabase Data Migration Script
============================================
Pulls all data from Dataverse and inserts into Supabase tables.

Usage:
    python migrate_dataverse_to_supabase.py                  # Migrate all tables
    python migrate_dataverse_to_supabase.py --table employees # Migrate one table
    python migrate_dataverse_to_supabase.py --dry-run         # Preview without writing
"""

import os
import sys
import json
import time
import argparse
import logging
from datetime import datetime
from dotenv import load_dotenv

load_dotenv("id.env")

# ── Dataverse config ──
import msal
import requests

TENANT_ID = os.getenv("TENANT_ID")
CLIENT_ID = os.getenv("CLIENT_ID")
CLIENT_SECRET = os.getenv("CLIENT_SECRET")
RESOURCE = os.getenv("RESOURCE")
AUTHORITY = f"https://login.microsoftonline.com/{TENANT_ID}"
SCOPE = [f"{RESOURCE}/.default"]

# ── Supabase config ──
from supabase import create_client

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY") or os.getenv("SUPABASE_ANON_KEY")

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

# ── Dataverse helpers ──
_msal_app = None
_dv_session = None


def _get_msal_app():
    global _msal_app
    if _msal_app is None:
        _msal_app = msal.ConfidentialClientApplication(
            client_id=CLIENT_ID, client_credential=CLIENT_SECRET, authority=AUTHORITY
        )
    return _msal_app


def dv_token():
    result = _get_msal_app().acquire_token_for_client(scopes=SCOPE)
    if "access_token" in result:
        return result["access_token"]
    raise Exception(f"Dataverse token error: {result}")


def dv_session():
    global _dv_session
    if _dv_session is None:
        _dv_session = requests.Session()
        _dv_session.headers.update({
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0",
        })
    return _dv_session


def dv_fetch_all(entity: str, select: str = None, top: int = 5000) -> list:
    """Fetch all records from a Dataverse entity, handling pagination."""
    token = dv_token()
    headers = {"Authorization": f"Bearer {token}"}
    url = f"{RESOURCE}/api/data/v9.2/{entity}?$top={top}"
    if select:
        url += f"&$select={select}"

    all_records = []
    while url:
        resp = dv_session().get(url, headers=headers, timeout=30)
        if resp.status_code != 200:
            log.error(f"Dataverse fetch failed for {entity}: {resp.status_code} {resp.text[:200]}")
            break
        data = resp.json()
        records = data.get("value", [])
        all_records.extend(records)
        url = data.get("@odata.nextLink")
        if url:
            log.info(f"  ... paging {entity}: fetched {len(all_records)} so far")

    return all_records


# ── Supabase client ──
sb = create_client(SUPABASE_URL, SUPABASE_KEY)

# Cache of valid column names per table
_sb_columns_cache = {}


def sb_get_columns(table: str) -> set:
    """Get valid column names for a Supabase table via a dummy query."""
    if table in _sb_columns_cache:
        return _sb_columns_cache[table]
    try:
        resp = sb.table(table).select("*").limit(0).execute()
        # If table is empty, we need to get columns from the schema
        # Use postgrest's OpenAPI spec via a raw HTTP call
        import httpx
        headers = {
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
        }
        r = httpx.get(f"{SUPABASE_URL}/rest/v1/", headers=headers, params={"select": "*"}, timeout=10)
        if r.status_code == 200:
            spec = r.json()
            if "definitions" in spec and table in spec["definitions"]:
                cols = set(spec["definitions"][table].get("properties", {}).keys())
                _sb_columns_cache[table] = cols
                return cols
        # Fallback: insert a dummy to discover columns from error, or just return empty
        log.warning(f"  Could not discover columns for {table}, will use broad filter")
        _sb_columns_cache[table] = set()
        return set()
    except Exception as e:
        log.warning(f"  Column discovery error for {table}: {e}")
        _sb_columns_cache[table] = set()
        return set()


def _pk_for_table(table: str) -> str:
    """Return the primary key column for a Supabase table (Dataverse uses <entity_singular>id)."""
    # Dataverse plural-to-id convention: crc6f_table13s -> crc6f_table13id
    if table.endswith("ses"):
        return table[:-3] + "id"
    if table.endswith("s"):
        return table[:-1] + "id"
    return table + "id"


def sb_insert_batch(table: str, records: list, batch_size: int = 200) -> int:
    """Upsert records into Supabase in batches using the primary key for idempotency.

    Returns count inserted/updated. Safe to re-run without creating duplicates
    because conflicts on the primary key are resolved by update.
    """
    inserted = 0
    pk = _pk_for_table(table)
    for i in range(0, len(records), batch_size):
        batch = records[i:i + batch_size]
        try:
            sb.table(table).upsert(batch, on_conflict=pk).execute()
            inserted += len(batch)
        except Exception as e:
            log.error(f"  Batch upsert error in {table} (rows {i}-{i+len(batch)}): {e}")
            # Fallback: try one-by-one so a single bad row does not poison the batch
            for row in batch:
                try:
                    sb.table(table).upsert(row, on_conflict=pk).execute()
                    inserted += 1
                except Exception as e2:
                    log.error(f"  Row upsert error: {e2} | data: {json.dumps(row, default=str)[:200]}")
    return inserted


def dv_count(entity: str) -> int:
    """Return total row count in a Dataverse entity using OData $count."""
    token = dv_token()
    headers = {
        "Authorization": f"Bearer {token}",
        "Prefer": "odata.include-annotations=\"*\"",
    }
    url = f"{RESOURCE}/api/data/v9.2/{entity}?$count=true&$top=1"
    try:
        resp = dv_session().get(url, headers=headers, timeout=30)
        if resp.status_code != 200:
            return -1
        data = resp.json()
        return int(data.get("@odata.count", 0))
    except Exception as e:
        log.warning(f"  dv_count failed for {entity}: {e}")
        return -1


def sb_count(table: str) -> int:
    """Return total row count in a Supabase table."""
    try:
        resp = sb.table(table).select("*", count="exact").limit(1).execute()
        return int(getattr(resp, "count", 0) or 0)
    except Exception as e:
        log.warning(f"  sb_count failed for {table}: {e}")
        return -1


# ── Data type transformations ──
# Map of known boolean fields in Supabase that Dataverse stores as strings
_BOOLEAN_FIELDS = {
    "crc6f_activeflag",
    "crc6f_isgroup",
    "crc6f_is_admin",
    "crc6f_is_muted",
}

# Known string-to-bool mappings from Dataverse
_TRUTHY = {"active", "true", "yes", "1", "on"}
_FALSY = {"inactive", "false", "no", "0", "off", "deleted"}


def _convert_value(key: str, value):
    """Convert a Dataverse value to the correct Supabase type."""
    if value is None:
        return None
    # Boolean conversion
    if key in _BOOLEAN_FIELDS:
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            return value.strip().lower() in _TRUTHY
        return bool(value)
    return value


# ── Field mapping & cleaning ──
def _clean(val, valid_columns: set = None):
    """Remove Dataverse OData metadata fields and keep only valid Supabase columns."""
    if not isinstance(val, dict):
        return val
    skip_prefixes = ("@odata", "_", "versionnumber", "overriddencreatedon",
                     "importsequencenumber", "timezoneruleversionnumber",
                     "utcconversiontimezonecode", "modifiedon", "createdon",
                     "modifiedby", "createdby", "ownerid", "owningbusinessunit",
                     "owningteam", "owninguser", "organizationid")
    cleaned = {}
    for k, v in val.items():
        k_lower = k.lower()
        if any(k_lower.startswith(p) or k_lower == p for p in skip_prefixes):
            continue
        if k.startswith("@") or k.startswith("_"):
            continue
        # If we know valid columns, skip anything not in them
        if valid_columns and k not in valid_columns:
            continue
        cleaned[k] = _convert_value(k, v)
    return cleaned


# ── Table migration definitions ──

TABLE_CONFIGS = {
    "employees": {
        "dv_entity": "crc6f_table12s",
        "sb_table": "crc6f_table12s",
        "dv_select": "crc6f_table12id,crc6f_employeeid,crc6f_firstname,crc6f_lastname,crc6f_email,crc6f_contactnumber,crc6f_address,crc6f_department,crc6f_designation,crc6f_doj,crc6f_activeflag,crc6f_experience,crc6f_quotahours,crc6f_employeeflag,crc6f_profilepicture",
    },
    "login_accounts": {
        "dv_entity": "crc6f_hr_login_detailses",
        "sb_table": "crc6f_hr_login_detailses",
        "dv_select": "crc6f_hr_login_detailsid,crc6f_username,crc6f_password,crc6f_accesslevel,crc6f_user_status,crc6f_loginattempts,crc6f_employeename,crc6f_userid,crc6f_last_login",
    },
    "attendance": {
        "dv_entity": "crc6f_table13s",
        "sb_table": "crc6f_table13s",
        "dv_select": "crc6f_table13id,crc6f_attendanceid,crc6f_employeeid,crc6f_date,crc6f_checkin,crc6f_checkout,crc6f_duration,crc6f_duration_intext,crc6f_status",
    },
    "leave_requests": {
        "dv_entity": "crc6f_table14s",
        "sb_table": "crc6f_table14s",
        "dv_select": "crc6f_table14id,crc6f_leaveid,crc6f_employeeid,crc6f_leavetype,crc6f_startdate,crc6f_enddate,crc6f_totaldays,crc6f_paidunpaid,crc6f_status,crc6f_approvedby,crc6f_rejectionreason,crc6f_reason",
    },
    "leave_balances": {
        "dv_entity": "crc6f_hr_leavemangements",
        "sb_table": "crc6f_hr_leavemangements",
        "dv_select": "crc6f_hr_leavemangementid,crc6f_employeeid,crc6f_empid,crc6f_cl,crc6f_sl,crc6f_compoff,crc6f_total,crc6f_actualtotal,crc6f_leaveallocationtype",
    },
    "comp_off": {
        "dv_entity": "crc6f_compensatoryrequests",
        "sb_table": "crc6f_compensatoryrequests",
        "dv_select": None,
    },
    "assets": {
        "dv_entity": "crc6f_hr_assetdetailses",
        "sb_table": "crc6f_hr_assetdetailses",
        "dv_select": "crc6f_hr_assetdetailsid,crc6f_assetid,crc6f_assetname,crc6f_serialnumber,crc6f_assetcategory,crc6f_location,crc6f_assetstatus,crc6f_assignedto,crc6f_employeeid,crc6f_assignedon",
    },
    "holidays": {
        "dv_entity": "crc6f_hr_holidayses",
        "sb_table": "crc6f_hr_holidayses",
        "dv_select": "crc6f_hr_holidaysid,crc6f_date,crc6f_holidayname,crc6f_description,crc6f_year",
    },
    "clients": {
        "dv_entity": "crc6f_hr_clients",
        "sb_table": "crc6f_hr_clients",
        "dv_select": None,
    },
    "projects": {
        "dv_entity": "crc6f_hr_projectheaders",
        "sb_table": "crc6f_hr_projectheaders",
        "dv_select": None,
    },
    "project_boards": {
        "dv_entity": "crc6f_hr_projectdetailses",
        "sb_table": "crc6f_hr_projectdetailses",
        "dv_select": None,
    },
    "project_tasks": {
        "dv_entity": "crc6f_hr_taskdetailses",
        "sb_table": "crc6f_hr_taskdetailses",
        "dv_select": None,
    },
    "project_contributors": {
        "dv_entity": "crc6f_hr_projectcontributorses",
        "sb_table": "crc6f_hr_projectcontributorses",
        "dv_select": None,
    },
    "timesheets": {
        "dv_entity": "crc6f_hr_timesheetlogs",
        "sb_table": "crc6f_hr_timesheetlogs",
        "dv_select": None,
    },
    "chat_conversations": {
        "dv_entity": "crc6f_hr_chat_conversations",
        "sb_table": "crc6f_hr_chat_conversations",
        "dv_select": None,
    },
    "chat_members": {
        "dv_entity": "crc6f_hr_conversation_memberses",
        "sb_table": "crc6f_hr_conversation_memberses",
        "dv_select": None,
    },
    "chat_messages": {
        "dv_entity": "crc6f_hr_messageses",
        "sb_table": "crc6f_hr_messageses",
        "dv_select": None,
    },
    "message_status": {
        "dv_entity": "crc6f_hr_messagestatuses",
        "sb_table": "crc6f_hr_messagestatuses",
        "dv_select": None,
    },
    "interns": {
        "dv_entity": "crc6f_hr_interndetailses",
        "sb_table": "crc6f_hr_interndetailses",
        "dv_select": None,
    },
    "hierarchy": {
        "dv_entity": "crc6f_hierarchies",
        "sb_table": "crc6f_hierarchies",
        "dv_select": None,
    },
    "login_activity": {
        "dv_entity": "crc6f_hr_loginactivitytbs",
        "sb_table": "crc6f_hr_loginactivitytbs",
        "dv_select": None,
    },
    "notifications": {
        "dv_entity": "crc6f_hr_inboxes",
        "sb_table": "crc6f_hr_inboxes",
        "dv_select": None,
    },
    "project_columns": {
        "dv_entity": "crc6f_hr_projectcolumns",
        "sb_table": "crc6f_hr_projectcolumns",
        "dv_select": None,
    },
}

# Migration order respects foreign-key dependencies
MIGRATION_ORDER = [
    "employees",
    "clients",
    "holidays",
    "login_accounts",
    "attendance",
    "leave_balances",
    "leave_requests",
    "comp_off",
    "assets",
    "projects",
    "project_boards",
    "project_columns",
    "project_tasks",
    "project_contributors",
    "timesheets",
    "chat_conversations",
    "chat_members",
    "chat_messages",
    "message_status",
    "interns",
    "hierarchy",
    "login_activity",
    "notifications",
]

# Logical module groups for safe per-feature migration.
# Each group is migrated in FK-safe order.
MODULE_GROUPS = {
    "holidays": ["holidays"],
    "leaves": ["leave_balances", "leave_requests", "comp_off"],
    "attendance": ["attendance", "login_activity"],
}


def migrate_table(name: str, dry_run: bool = False) -> dict:
    """Migrate a single table from Dataverse to Supabase."""
    cfg = TABLE_CONFIGS[name]
    dv_entity = cfg["dv_entity"]
    sb_table = cfg["sb_table"]
    dv_select = cfg.get("dv_select")

    log.info(f"{'[DRY RUN] ' if dry_run else ''}Migrating: {name} ({dv_entity} -> {sb_table})")

    # Fetch from Dataverse
    start = time.time()
    records = dv_fetch_all(dv_entity, select=dv_select)
    fetch_time = time.time() - start
    log.info(f"  Fetched {len(records)} records from Dataverse in {fetch_time:.1f}s")

    if not records:
        log.info(f"  No records to migrate for {name}")
        return {"table": name, "fetched": 0, "inserted": 0, "status": "empty"}

    # Discover valid columns for the Supabase table
    valid_cols = sb_get_columns(sb_table)
    if valid_cols:
        log.info(f"  Supabase table has {len(valid_cols)} columns")
    else:
        log.warning(f"  Could not discover columns for {sb_table}, using broad filter")

    # Clean records (remove OData metadata + filter to valid columns)
    cleaned = [_clean(r, valid_cols) for r in records]

    if dry_run:
        log.info(f"  [DRY RUN] Would insert {len(cleaned)} records into {sb_table}")
        if cleaned:
            log.info(f"  Sample record keys: {list(cleaned[0].keys())}")
        return {"table": name, "fetched": len(cleaned), "inserted": 0, "status": "dry_run"}

    # Insert into Supabase
    start = time.time()
    inserted = sb_insert_batch(sb_table, cleaned)
    insert_time = time.time() - start
    log.info(f"  Inserted {inserted}/{len(cleaned)} records into Supabase in {insert_time:.1f}s")

    status = "ok" if inserted == len(cleaned) else "partial"
    return {"table": name, "fetched": len(cleaned), "inserted": inserted, "status": status}


def migrate_all(dry_run: bool = False, tables: list = None):
    """Migrate all tables in dependency order."""
    target_tables = tables or MIGRATION_ORDER
    results = []
    total_start = time.time()

    log.info("=" * 60)
    log.info(f"DATAVERSE -> SUPABASE MIGRATION {'(DRY RUN)' if dry_run else ''}")
    log.info(f"Tables to migrate: {len(target_tables)}")
    log.info("=" * 60)

    for name in target_tables:
        if name not in TABLE_CONFIGS:
            log.warning(f"Unknown table: {name}, skipping")
            continue
        try:
            result = migrate_table(name, dry_run=dry_run)
            results.append(result)
        except Exception as e:
            log.error(f"FAILED migrating {name}: {e}")
            results.append({"table": name, "fetched": 0, "inserted": 0, "status": f"error: {e}"})

    total_time = time.time() - total_start

    # Print summary
    log.info("\n" + "=" * 60)
    log.info("MIGRATION SUMMARY")
    log.info("=" * 60)
    log.info(f"{'Table':<25} {'Fetched':>8} {'Inserted':>9} {'Status':<15}")
    log.info("-" * 60)
    total_fetched = 0
    total_inserted = 0
    for r in results:
        log.info(f"{r['table']:<25} {r['fetched']:>8} {r['inserted']:>9} {r['status']:<15}")
        total_fetched += r["fetched"]
        total_inserted += r["inserted"]
    log.info("-" * 60)
    log.info(f"{'TOTAL':<25} {total_fetched:>8} {total_inserted:>9}")
    log.info(f"Time: {total_time:.1f}s")
    log.info("=" * 60)

    return results


def preflight(tables: list) -> list:
    """Compare Dataverse vs Supabase row counts for each table without writing.

    Purpose: confirm the target Supabase tables exist and show how much data
    would be migrated before any write operation.
    """
    log.info("=" * 60)
    log.info("PREFLIGHT CHECK")
    log.info("=" * 60)
    log.info(f"{'Table':<25} {'DV count':>10} {'SB count':>10} {'Delta':>10}")
    log.info("-" * 60)
    rows = []
    for name in tables:
        cfg = TABLE_CONFIGS.get(name)
        if not cfg:
            log.warning(f"Unknown table: {name}, skipping")
            continue
        dv_n = dv_count(cfg["dv_entity"])
        sb_n = sb_count(cfg["sb_table"])
        delta = (dv_n - sb_n) if (dv_n >= 0 and sb_n >= 0) else None
        log.info(f"{name:<25} {dv_n:>10} {sb_n:>10} {str(delta if delta is not None else 'n/a'):>10}")
        rows.append({"table": name, "dv": dv_n, "sb": sb_n, "delta": delta})
    log.info("=" * 60)
    return rows


def reconcile(tables: list, sample_size: int = 5) -> list:
    """Post-migration verification: compare counts and sample a few records.

    For each table, report:
      - Dataverse count vs Supabase count
      - Up to N sample records present in DV but missing in SB (by primary key)
    """
    log.info("=" * 60)
    log.info("RECONCILE")
    log.info("=" * 60)
    results = []
    for name in tables:
        cfg = TABLE_CONFIGS.get(name)
        if not cfg:
            log.warning(f"Unknown table: {name}, skipping")
            continue
        dv_entity = cfg["dv_entity"]
        sb_table = cfg["sb_table"]
        pk = _pk_for_table(sb_table)

        dv_n = dv_count(dv_entity)
        sb_n = sb_count(sb_table)
        log.info(f"[{name}] DV={dv_n} SB={sb_n} (pk={pk})")

        # Sample a few Dataverse PKs and check they exist in Supabase
        missing = []
        try:
            token = dv_token()
            headers = {"Authorization": f"Bearer {token}"}
            url = f"{RESOURCE}/api/data/v9.2/{dv_entity}?$select={pk}&$top={sample_size}"
            resp = dv_session().get(url, headers=headers, timeout=30)
            if resp.status_code == 200:
                for row in resp.json().get("value", []):
                    pk_val = row.get(pk)
                    if not pk_val:
                        continue
                    r = sb.table(sb_table).select(pk).eq(pk, pk_val).limit(1).execute()
                    if not r.data:
                        missing.append(pk_val)
        except Exception as e:
            log.warning(f"  sample check failed for {name}: {e}")

        status = "ok"
        if dv_n >= 0 and sb_n >= 0 and dv_n != sb_n:
            status = "count_mismatch"
        if missing:
            status = "missing_rows"
            log.warning(f"  {len(missing)} sample PKs missing in Supabase: {missing[:sample_size]}")
        else:
            log.info(f"  sample PK check: PASS")

        results.append({"table": name, "dv": dv_n, "sb": sb_n, "missing_sample": missing, "status": status})

    log.info("=" * 60)
    log.info(f"{'Table':<25} {'DV':>10} {'SB':>10} {'Status':<18}")
    log.info("-" * 60)
    for r in results:
        log.info(f"{r['table']:<25} {r['dv']:>10} {r['sb']:>10} {r['status']:<18}")
    log.info("=" * 60)
    return results


def resolve_tables(args_table: str, args_module: str) -> list:
    """Turn CLI --table / --module into an ordered list of migration targets."""
    if args_module:
        names = []
        for m in args_module.split(","):
            m = m.strip().lower()
            if m not in MODULE_GROUPS:
                raise SystemExit(
                    f"Unknown module: {m}. Available: {', '.join(MODULE_GROUPS.keys())}"
                )
            names.extend(MODULE_GROUPS[m])
        return names
    if args_table and args_table != "all":
        return [t.strip() for t in args_table.split(",")]
    return list(MIGRATION_ORDER)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Migrate Dataverse data to Supabase")
    parser.add_argument("--table", type=str, default=None,
                        help="Migrate a specific table (e.g. 'employees', 'attendance'). "
                             "Use 'all' or omit for all tables.")
    parser.add_argument("--module", type=str, default=None,
                        help="Migrate a logical module group. One of: "
                             + ", ".join(MODULE_GROUPS.keys())
                             + ". Comma-separated for multiple (e.g. 'holidays,leaves').")
    parser.add_argument("--dry-run", action="store_true",
                        help="Preview migration without writing to Supabase")
    parser.add_argument("--preflight", action="store_true",
                        help="Compare DV vs SB row counts without writing. "
                             "Run this first on every module.")
    parser.add_argument("--reconcile", action="store_true",
                        help="Post-migration verification: count match + sample PK check. "
                             "Run this after migration for the same --module or --table.")
    parser.add_argument("--list", action="store_true",
                        help="List available tables and module groups")
    args = parser.parse_args()

    if args.list:
        print("Available tables:")
        for name in MIGRATION_ORDER:
            cfg = TABLE_CONFIGS[name]
            print(f"  {name:<25} ({cfg['dv_entity']} -> {cfg['sb_table']})")
        print("\nAvailable module groups:")
        for mod, tables in MODULE_GROUPS.items():
            print(f"  {mod:<12} -> {tables}")
        sys.exit(0)

    targets = resolve_tables(args.table, args.module)

    if args.preflight:
        preflight(targets)
        sys.exit(0)

    if args.reconcile:
        reconcile(targets)
        sys.exit(0)

    migrate_all(dry_run=args.dry_run, tables=targets)
