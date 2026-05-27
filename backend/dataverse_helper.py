"""
dataverse_helper.py - SHIM MODULE
==================================
This module now delegates ALL calls to supabase_helper.py.
The original Dataverse implementation is preserved in dataverse_helper_original.py.

All existing imports like:
    from dataverse_helper import create_record, update_record, ...
will now transparently use Supabase instead of Dataverse.
"""

# Re-export everything from supabase_helper
from supabase_helper import (
    create_record,
    get_record,
    update_record,
    delete_record,
    fetch_record_by_id,
    update_record_by_alt_key,
    get_employee_name,
    get_employee_email,
    get_l2_l3_emails,
    get_access_token,
    get_dataverse_session,
    get_supabase,
    query_records,
    query_records_filtered,
    upsert_record,
    count_records,
    EMPLOYEE_ENTITY,
    _pk_field as _pk_field,
)

import os
from dotenv import load_dotenv
load_dotenv("id.env")

RESOURCE = os.getenv("RESOURCE")
# Keep these for any code that references them directly
TENANT_ID = os.getenv("TENANT_ID")
CLIENT_ID = os.getenv("CLIENT_ID")
CLIENT_SECRET = os.getenv("CLIENT_SECRET")

_DEFAULT_TIMEOUT = 15
