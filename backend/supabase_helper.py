"""
Supabase Helper - Drop-in replacement for dataverse_helper.py
=============================================================

This module provides the SAME function signatures as dataverse_helper.py
so that switching from Dataverse to Supabase requires only changing the import.

Usage:
    # Old: from dataverse_helper import create_record, update_record, ...
    # New: from supabase_helper import create_record, update_record, ...
"""

import os
import logging
from dotenv import load_dotenv
from supabase import create_client, Client

# Load environment variables from id.env
load_dotenv("id.env")

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

EMPLOYEE_ENTITY = "crc6f_table12s"

logger = logging.getLogger(__name__)

# ================== Singleton Supabase client ==================
_supabase_client: Client = None


def _get_supabase() -> Client:
    """Return a shared Supabase client (uses service key for full access)."""
    global _supabase_client
    if _supabase_client is None:
        key = SUPABASE_SERVICE_KEY or SUPABASE_ANON_KEY
        if not SUPABASE_URL or not key:
            raise Exception(
                "SUPABASE_URL and SUPABASE_SERVICE_KEY (or SUPABASE_ANON_KEY) "
                "must be set in id.env"
            )
        _supabase_client = create_client(SUPABASE_URL, key)
    return _supabase_client


def get_supabase() -> Client:
    """Public accessor for the Supabase client."""
    return _get_supabase()


# ================== Compatibility shims ==================
# These exist so that code importing get_access_token / get_dataverse_session
# does not break.  They are intentionally no-ops for Supabase.

def get_access_token() -> str:
    """Compatibility shim. Returns a placeholder token.
    Supabase uses API keys, not OAuth tokens."""
    return SUPABASE_SERVICE_KEY or SUPABASE_ANON_KEY or "supabase-token"


def get_dataverse_session():
    """Compatibility adapter: returns an OData-to-Supabase translator.
    All raw OData HTTP calls are intercepted and routed through Supabase."""
    return _SupabaseODataAdapter(_get_supabase())


# ================== OData → Supabase Adapter ==================

import re as _re
from urllib.parse import urlparse as _urlparse, parse_qs as _parse_qs, unquote as _unquote


class _MockResponse:
    """Mimics a requests.Response object."""

    def __init__(self, status_code=200, body=None, text=""):
        self.status_code = status_code
        self._body = body
        self.text = text or ""
        self.content = text.encode("utf-8") if text else b""
        self.ok = 200 <= status_code < 300

    def json(self):
        return self._body if self._body is not None else {}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise Exception(f"HTTP {self.status_code}: {self.text}")


class _SupabaseODataAdapter:
    """Translates OData-style HTTP calls into Supabase PostgREST queries."""

    def __init__(self, sb: Client):
        self._sb = sb
        self.headers = {}

    def update(self, d):
        """Allow session.headers.update({...}) calls."""
        self.headers.update(d)

    # ---------- HTTP verb handlers ----------

    def get(self, url, **kwargs):
        try:
            entity, record_id, params = self._parse_url(url)
            if not entity:
                return _MockResponse(404, text="Entity not found in URL")

            # Single-record GET: /entity(uuid)
            if record_id:
                pk = _pk_field(entity)
                resp = self._sb.table(entity).select("*").eq(pk, record_id).limit(1).execute()
                if resp.data:
                    return _MockResponse(200, resp.data[0])
                return _MockResponse(404, text="Record not found")

            # Collection GET with OData params
            return self._odata_query(entity, params)
        except Exception as e:
            logger.error(f"[ODataAdapter] GET error: {e}")
            return _MockResponse(500, text=str(e))

    def post(self, url, json=None, **kwargs):
        try:
            entity, _, _ = self._parse_url(url)
            if not entity:
                return _MockResponse(404, text="Entity not found")
            # Strip @odata.bind navigation properties (no Supabase equivalent)
            raw = {k: v for k, v in (json or {}).items() if v is not None and '@odata.bind' not in k}
            clean = _coerce_types(raw)
            resp = self._sb.table(entity).insert(clean).execute()
            if resp.data and len(resp.data) > 0:
                return _MockResponse(201, resp.data[0], text=_json_dumps(resp.data[0]))
            return _MockResponse(201, {})
        except Exception as e:
            logger.error(f"[ODataAdapter] POST error: {e}")
            return _MockResponse(500, text=str(e))

    def patch(self, url, json=None, **kwargs):
        try:
            entity, record_id, _ = self._parse_url(url)
            if not entity or not record_id:
                return _MockResponse(404, text="Entity or record_id not found")
            pk = _pk_field(entity)
            clean = _coerce_types({k: v for k, v in (json or {}).items()})
            self._sb.table(entity).update(clean).eq(pk, record_id).execute()
            return _MockResponse(204)
        except Exception as e:
            logger.error(f"[ODataAdapter] PATCH error: {e}")
            return _MockResponse(500, text=str(e))

    def delete(self, url, **kwargs):
        try:
            entity, record_id, _ = self._parse_url(url)
            if not entity or not record_id:
                return _MockResponse(404, text="Entity or record_id not found")
            pk = _pk_field(entity)
            self._sb.table(entity).delete().eq(pk, record_id).execute()
            return _MockResponse(204)
        except Exception as e:
            logger.error(f"[ODataAdapter] DELETE error: {e}")
            return _MockResponse(500, text=str(e))

    # ---------- Internal helpers ----------

    def _parse_url(self, url):
        """Parse OData URL into (entity_name, record_id_or_None, query_params)."""
        parsed = _urlparse(url)
        path = parsed.path.rstrip("/")
        params = _parse_qs(parsed.query, keep_blank_values=True)

        # Extract last path segment, e.g. /api/data/v9.2/crc6f_table12s or /crc6f_table12s(uuid)
        last_seg = path.split("/")[-1] if path else ""

        # Check for entity(record_id) pattern
        m = _re.match(r'^([A-Za-z0-9_]+)\(([^)]+)\)$', last_seg)
        if m:
            entity = m.group(1)
            rid = m.group(2).strip("'\"{}").strip()
            # Handle alternate key syntax: entity(field='value')
            if "=" in rid:
                # e.g. crc6f_leaveid='LVE-ABC'
                return entity, None, self._alt_key_to_filter(rid, params)
            return entity, rid, params

        # EntityDefinitions or other metadata endpoints - return empty
        if last_seg == "EntityDefinitions":
            return None, None, params

        return last_seg, None, params

    def _alt_key_to_filter(self, alt_key_expr, params):
        """Convert alternate key like field='value' into a $filter param."""
        parts = alt_key_expr.split("=", 1)
        if len(parts) == 2:
            field = parts[0].strip()
            val = parts[1].strip().strip("'\"")
            existing = params.get("$filter", [""])[0]
            new_filter = f"{field} eq '{val}'"
            if existing:
                new_filter = f"{existing} and {new_filter}"
            params["$filter"] = [new_filter]
            params["$top"] = ["1"]
        return params

    def _odata_query(self, entity, params):
        """Execute a Supabase query from OData-style query params."""
        select_str = params.get("$select", ["*"])[0]
        top = params.get("$top", [None])[0]
        filter_str = params.get("$filter", [None])[0]
        orderby_str = params.get("$orderby", [None])[0]

        query = self._sb.table(entity).select(select_str)

        # Parse $filter
        if filter_str:
            query = self._apply_filter(query, filter_str)

        # Parse $orderby
        if orderby_str:
            query = self._apply_orderby(query, orderby_str)

        # $top
        if top:
            try:
                query = query.limit(int(top))
            except ValueError:
                pass

        try:
            resp = query.execute()
            data = resp.data or []
            return _MockResponse(200, {"value": data, "@odata.count": len(data)})
        except Exception as e:
            err_str = str(e)
            # Column doesn't exist -> retry with select("*") and no orderby
            if "does not exist" in err_str:
                # If it's a table (relation) not found, return 404
                if "relation" in err_str:
                    return _MockResponse(404, text=err_str)
                logger.warning(f"[ODataAdapter] Query failed for {entity}, retrying with select(*): {err_str[:120]}")
                try:
                    query2 = self._sb.table(entity).select("*")
                    if filter_str:
                        try:
                            query2 = self._apply_filter(query2, filter_str)
                        except Exception:
                            pass
                    if top:
                        try:
                            query2 = query2.limit(int(top))
                        except ValueError:
                            pass
                    resp2 = query2.execute()
                    data2 = resp2.data or []
                    return _MockResponse(200, {"value": data2, "@odata.count": len(data2)})
                except Exception as e2:
                    return _MockResponse(500, text=str(e2))
            return _MockResponse(500, text=err_str)

    def _apply_filter(self, query, filter_str):
        """Parse simple OData $filter expressions into Supabase .eq/.gt/.lt calls."""
        # Split on ' and ' outside parentheses (case-insensitive)
        conditions = self._split_and_outside_parens(filter_str)
        for cond in conditions:
            cond = cond.strip()
            if not cond:
                continue
            query = self._apply_single_condition(query, cond)
        return query

    @staticmethod
    def _split_and_outside_parens(filter_str):
        """Split OData filter on ' and ' only when outside parentheses."""
        parts = []
        depth = 0
        current = []
        tokens = _re.split(r'(\s+and\s+|\(|\))', filter_str, flags=_re.IGNORECASE)
        for tok in tokens:
            if tok == '(':
                depth += 1
                current.append(tok)
            elif tok == ')':
                depth -= 1
                current.append(tok)
            elif depth == 0 and _re.match(r'^\s+and\s+$', tok, _re.IGNORECASE):
                parts.append(''.join(current))
                current = []
            else:
                current.append(tok)
        if current:
            parts.append(''.join(current))
        return parts

    def _apply_single_condition(self, query, cond):
        """Apply a single OData filter condition."""
        # Strip tolower() wrapper: tolower(field) -> field
        cond = _re.sub(r'tolower\(([^)]+)\)', r'\1', cond)

        # Handle parenthesized OR groups: (field eq 'val1' or field eq 'val2' or ...)
        cond_stripped = cond.strip()
        if cond_stripped.startswith('(') and cond_stripped.endswith(')'):
            cond_stripped = cond_stripped[1:-1].strip()
        if _re.search(r'\s+or\s+', cond_stripped, _re.IGNORECASE):
            or_parts = _re.split(r'\s+or\s+', cond_stripped, flags=_re.IGNORECASE)
            parsed = []
            for part in or_parts:
                part = part.strip()
                m_or = _re.match(r'^(\S+)\s+(eq|ne|gt|ge|lt|le)\s+(.+)$', part, _re.IGNORECASE)
                if m_or:
                    parsed.append((m_or.group(1), m_or.group(2).lower(), m_or.group(3).strip().strip("'\"")))
            if parsed:
                # Optimisation: if all conditions are eq on the same field, use .in_()
                fields = set(p[0] for p in parsed)
                ops = set(p[1] for p in parsed)
                if len(fields) == 1 and ops == {'eq'}:
                    field = parsed[0][0]
                    values = [p[2] for p in parsed]
                    return query.in_(field, values)
                # General case: build PostgREST or filter string
                pg_ops = {'eq': 'eq', 'ne': 'neq', 'gt': 'gt', 'ge': 'gte', 'lt': 'lt', 'le': 'lte'}
                or_str = ",".join(f"{p[0]}.{pg_ops.get(p[1], p[1])}.{p[2]}" for p in parsed)
                try:
                    return query.or_(or_str)
                except AttributeError:
                    logger.warning(f"[ODataAdapter] or_() not available, skipping OR filter: {cond}")
                    return query
            logger.warning(f"[ODataAdapter] Could not parse OR group: {cond}")
            return query

        # Handle null comparisons: field eq null / field ne null
        m_null = _re.match(r'^(\S+)\s+(eq|ne)\s+null$', cond, _re.IGNORECASE)
        if m_null:
            field = m_null.group(1).strip()
            op = m_null.group(2).lower()
            if op == "eq":
                return query.is_(field, "null")
            else:
                return query.not_.is_(field, "null")

        # Patterns: field eq 'value', field ge 'value', field le 'value', etc.
        ops = [
            ("ge", "gte"), ("le", "lte"), ("gt", "gt"), ("lt", "lt"),
            ("ne", "neq"), ("eq", "eq"),
        ]
        for odata_op, pg_method in ops:
            pattern = rf"^(\S+)\s+{odata_op}\s+(.+)$"
            m = _re.match(pattern, cond, _re.IGNORECASE)
            if m:
                field = m.group(1).strip()
                raw_val = m.group(2).strip().strip("'\"")
                method = getattr(query, pg_method, None)
                if method:
                    return method(field, raw_val)
                break

        # contains(field, 'value') -> ilike
        m = _re.match(r"contains\((\S+),\s*'([^']*)'\)", cond, _re.IGNORECASE)
        if m:
            field = m.group(1)
            val = m.group(2)
            return query.ilike(field, f"%{val}%")

        # startswith(field, 'value') -> ilike
        m_starts = _re.match(r"startswith\((\S+),\s*'([^']*)'\)", cond, _re.IGNORECASE)
        if m_starts:
            field = m_starts.group(1)
            val = m_starts.group(2)
            return query.ilike(field, f"{val}%")

        logger.warning(f"[ODataAdapter] Unsupported filter condition: {cond}")
        return query

    def _apply_orderby(self, query, orderby_str):
        """Parse OData $orderby into Supabase .order() calls."""
        parts = [p.strip() for p in orderby_str.split(",")]
        for part in parts:
            tokens = part.split()
            col = tokens[0]
            desc = len(tokens) > 1 and tokens[1].lower() == "desc"
            query = query.order(col, desc=desc)
        return query


def _json_dumps(obj):
    import json
    return json.dumps(obj, default=str)


# ================== Primary-key field map ==================
# Maps entity (table) name -> its UUID primary-key column
_PK_MAP = {
    "crc6f_table12s": "crc6f_table12id",
    "crc6f_hr_login_detailses": "crc6f_hr_login_detailsid",
    "crc6f_table13s": "crc6f_table13id",
    "crc6f_table14s": "crc6f_table14id",
    "crc6f_hr_leavemangements": "crc6f_hr_leavemangementid",
    "crc6f_compensatoryrequests": "crc6f_compensatoryrequestid",
    "crc6f_hr_assetdetailses": "crc6f_hr_assetdetailsid",
    "crc6f_hr_holidayses": "crc6f_hr_holidaysid",
    "crc6f_hr_clients": "crc6f_hr_clientsid",
    "crc6f_hr_projectheaders": "crc6f_hr_projectheaderid",
    "crc6f_hr_projectdetailses": "crc6f_hr_projectdetailsid",
    "crc6f_hr_taskdetailses": "crc6f_hr_taskdetailsid",
    "crc6f_hr_projectcontributorses": "crc6f_hr_projectcontributorsid",
    "crc6f_hr_timesheetlogs": "crc6f_hr_timesheetlogid",
    "crc6f_hr_chat_conversations": "crc6f_hr_chat_conversationsid",
    "crc6f_hr_conversation_memberses": "crc6f_hr_conversation_membersid",
    "crc6f_hr_messageses": "crc6f_hr_messagesid",
    "crc6f_hr_messagestatuses": "crc6f_hr_messagestatusid",
    "crc6f_hr_interndetailses": "crc6f_hr_interndetailsid",
    "crc6f_hierarchies": "crc6f_hr_hierarchyid",
    "crc6f_hr_loginactivitytbs": "crc6f_hr_loginactivitytbid",
    "crc6f_hr_inboxes": "crc6f_hr_inboxid",
    "annotations": "annotationid",
    "auth_session_events": "id",
    "auth_session_policy": "id",
    "crc6f_hr_projectcolumns": "crc6f_hr_projectcolumnid",
    "crc6f_hr_onboardings": "crc6f_hr_onboardingid",
    "crc6f_hr_onboardingprogresslogs": "crc6f_hr_onboardingprogresslogid",
}


def _pk_field(entity_name: str) -> str:
    """Return the primary-key column for an entity."""
    return _PK_MAP.get(entity_name, "id")


# -------------------- Type Coercion Safety Net --------------------
# Maps known Supabase column names to their expected Python types.
# Applied before every insert/update to prevent type mismatch errors.

_BOOLEAN_COLUMNS = frozenset({
    "crc6f_activeflag", "crc6f_isgroup", "crc6f_is_admin", "crc6f_is_muted",
    "crc6f_convertedtoemployee",
})

_INTEGER_COLUMNS = frozenset({
    "crc6f_loginattempts", "crc6f_noofcontributors", "crc6f_position",
    "crc6f_year", "crc6f_unpaidduration", "crc6f_paidtrainingduration",
    "crc6f_probationduration", "crc6f_postprobduration",
    "crc6f_checkin_timestamp", "crc6f_checkout_timestamp",
    "crc6f_base_seconds", "crc6f_total_seconds",
    "statecode", "statuscode",
    "crc6f_stagenumber", "crc6f_refid",
})

_FLOAT_COLUMNS = frozenset({
    "crc6f_duration", "crc6f_hoursworked", "crc6f_quotahours",
    "crc6f_estimationcost", "crc6f_totaldays",
    "crc6f_cl", "crc6f_sl", "crc6f_compoff", "crc6f_actualtotal", "crc6f_total",
    "crc6f_paidtrainingsalary", "crc6f_probationsalary", "crc6f_postprobsalary",
})

# Columns that are foreign keys. An empty string "" is NOT a valid FK value in
# Postgres (it would try to match a row whose key literally equals ""), so we
# coerce "" -> None here to let it become NULL. Nullable FKs accept NULL.
_FK_NULLABLE_COLUMNS = frozenset({
    "crc6f_approvedby",    # -> crc6f_table12s (leaves.fk_leave_approver)
    "crc6f_assignedto",    # -> crc6f_table12s (tasks)
    "crc6f_rejectedby",    # -> crc6f_table12s
})


def _coerce_types(data: dict) -> dict:
    """Coerce known columns to their correct Supabase types."""
    out = {}
    for k, v in data.items():
        # Empty string on nullable FK columns -> NULL (avoids FK violation)
        if k in _FK_NULLABLE_COLUMNS and isinstance(v, str) and v.strip() == "":
            out[k] = None
            continue
        if v is None:
            out[k] = v
            continue
        if k in _BOOLEAN_COLUMNS:
            if isinstance(v, bool):
                out[k] = v
            else:
                out[k] = str(v).lower() in ("true", "1", "yes", "active")
        elif k in _INTEGER_COLUMNS:
            try:
                out[k] = int(float(v)) if not isinstance(v, int) else v
            except (ValueError, TypeError):
                out[k] = 0
        elif k in _FLOAT_COLUMNS:
            try:
                out[k] = round(float(v), 4) if not isinstance(v, (int, float)) else v
            except (ValueError, TypeError):
                out[k] = 0.0
        else:
            out[k] = v
    return out


# -------------------- CRUD Functions --------------------

def create_record(entity_name: str, data: dict) -> dict:
    """Create a new record in Supabase.
    Returns the created record dict (same shape as Dataverse response)."""
    sb = _get_supabase()
    # Remove None values to avoid Supabase errors
    clean_data = _coerce_types({k: v for k, v in data.items() if v is not None})

    try:
        response = sb.table(entity_name).insert(clean_data).execute()
        if response.data and len(response.data) > 0:
            return response.data[0]
        return {}
    except Exception as e:
        raise Exception(f"Error creating record in {entity_name}: {e}")


def get_record(entity_name: str, record_id: str) -> dict:
    """Retrieve a single record by its primary-key UUID."""
    sb = _get_supabase()
    pk = _pk_field(entity_name)
    try:
        response = sb.table(entity_name).select("*").eq(pk, record_id).execute()
        if response.data and len(response.data) > 0:
            return response.data[0]
        raise Exception(f"Record not found: {entity_name}({record_id})")
    except Exception as e:
        raise Exception(f"Error getting record from {entity_name}: {e}")


def fetch_record_by_id(entity_name: str, value: str, id_field: str = "crc6f_leaveid") -> dict | None:
    """Fetch a record by an alternate/business key field."""
    sb = _get_supabase()
    try:
        response = sb.table(entity_name).select("*").eq(id_field, value).limit(1).execute()
        if response.data and len(response.data) > 0:
            return response.data[0]
        return None
    except Exception as e:
        raise Exception(f"Error fetching record by {id_field} from {entity_name}: {e}")


def update_record(entity_name: str, record_id: str, data: dict) -> bool:
    """Update a record by its primary-key UUID."""
    sb = _get_supabase()
    pk = _pk_field(entity_name)
    clean_data = _coerce_types({k: v for k, v in data.items()})
    try:
        response = sb.table(entity_name).update(clean_data).eq(pk, record_id).execute()
        return True
    except Exception as e:
        raise Exception(f"Error updating record in {entity_name}: {e}")


def update_record_by_alt_key(entity_name: str, alt_key_value: str, data: dict,
                              alt_key_field: str = "crc6f_leaveid") -> bool:
    """Update a record using an alternate/business key."""
    sb = _get_supabase()
    clean_data = _coerce_types({k: v for k, v in data.items()})
    try:
        response = sb.table(entity_name).update(clean_data).eq(alt_key_field, alt_key_value).execute()
        return True
    except Exception as e:
        raise Exception(f"Error updating record by {alt_key_field} in {entity_name}: {e}")


def delete_record(entity_name: str, record_id: str) -> bool:
    """Delete a record by its primary-key UUID."""
    sb = _get_supabase()
    pk = _pk_field(entity_name)
    try:
        response = sb.table(entity_name).delete().eq(pk, record_id).execute()
        return True
    except Exception as e:
        raise Exception(f"Error deleting record from {entity_name}: {e}")


# -------------------- Convenience helpers --------------------

def get_employee_name(employee_id: str) -> str | None:
    """Fetch employee first name from master table."""
    try:
        sb = _get_supabase()
        response = (
            sb.table(EMPLOYEE_ENTITY)
            .select("crc6f_firstname")
            .eq("crc6f_employeeid", employee_id)
            .limit(1)
            .execute()
        )
        if response.data and len(response.data) > 0:
            return response.data[0].get("crc6f_firstname")
        return None
    except Exception as e:
        print(f"Could not fetch name for {employee_id}: {e}")
        return employee_id


def get_employee_email(employee_id: str):
    """Fetch employee email from Employee Master."""
    try:
        sb = _get_supabase()
        response = (
            sb.table(EMPLOYEE_ENTITY)
            .select("*")
            .eq("crc6f_employeeid", employee_id)
            .limit(1)
            .execute()
        )
        if not response.data:
            print(f"No employee found for ID: {employee_id}")
            return None, employee_id

        emp = response.data[0]
        email = emp.get("crc6f_email")
        name = emp.get("crc6f_firstname", employee_id)
        print(f"Found employee email: {email} for {employee_id}")
        return email

    except Exception as e:
        print(f"Error fetching email for {employee_id}: {e}")
        return None, employee_id


def get_l2_l3_emails():
    """Fetch email addresses of all L2 (Manager) and L3 (Admin) users.
    Retrieves email directly from crc6f_username in the login details table.
    Returns a list of dicts: [{"email": "...", "name": "..."}, ...]
    """
    try:
        sb = _get_supabase()
        results = []
        
        # 1. First, always add the fallback ADMIN_EMAIL from environment
        admin_email = os.getenv("ADMIN_EMAIL")
        if admin_email:
            results.append({"email": admin_email.strip(), "name": "System Admin"})

        # 2. Query all login details to avoid Supabase strict matching issues
        resp = sb.table("crc6f_hr_login_detailses").select("*").execute()
        if not resp.data:
            print("[MAIL] No L2/L3 users found in login_details")
            return results

        seen_emails = {admin_email.strip().lower()} if admin_email else set()

        for login in resp.data:
            # Case-insensitive checks
            access_level = str(login.get("crc6f_accesslevel") or "").strip().upper()
            status = str(login.get("crc6f_user_status") or "").strip().lower()
            
            # Allow "active" or empty status for L2/L3 users
            if access_level in ["L2", "L3"] and status in ["active", ""]:
                email = str(login.get("crc6f_username") or "").strip()
                if email and "@" in email:
                    if email.lower() not in seen_emails:
                        seen_emails.add(email.lower())
                        name = str(login.get("crc6f_employeename") or "").strip() or "Admin/Manager"
                        results.append({"email": email, "name": name})

        print(f"[MAIL] Found {len(results)} L2/L3 email recipients")
        return results
    except Exception as e:
        print(f"[MAIL] Error fetching L2/L3 emails: {e}")
        # Return fallback on error
        admin_email = os.getenv("ADMIN_EMAIL")
        if admin_email:
            return [{"email": admin_email.strip(), "name": "System Admin"}]
        return []


# -------------------- Query helpers (Supabase-native) --------------------

def query_records(entity_name: str, filters: dict = None, select: str = "*",
                  order_by: str = None, order_desc: bool = False,
                  limit: int = None, offset: int = None) -> list:
    """
    Query records with optional filters, sorting, and pagination.
    
    Args:
        entity_name: Table name
        filters: Dict of {column: value} for equality filters
        select: Comma-separated column names (default "*")
        order_by: Column to sort by
        order_desc: Sort descending if True
        limit: Max number of records
        offset: Offset for pagination
    
    Returns:
        List of record dicts
    """
    sb = _get_supabase()
    query = sb.table(entity_name).select(select)
    
    if filters:
        for key, value in filters.items():
            query = query.eq(key, value)
    
    if order_by:
        query = query.order(order_by, desc=order_desc)
    
    if limit:
        query = query.limit(limit)
    
    if offset:
        query = query.range(offset, offset + (limit or 1000) - 1)
    
    try:
        response = query.execute()
        return response.data or []
    except Exception as e:
        raise Exception(f"Error querying {entity_name}: {e}")


def query_records_filtered(entity_name: str, column: str, operator: str,
                           value, select: str = "*") -> list:
    """
    Query records with comparison operators.
    
    Args:
        entity_name: Table name
        column: Column to filter on
        operator: One of 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'in'
        value: Value to compare against
        select: Columns to select
    
    Returns:
        List of record dicts
    """
    sb = _get_supabase()
    query = sb.table(entity_name).select(select)
    
    op_map = {
        'eq': query.eq,
        'neq': query.neq,
        'gt': query.gt,
        'gte': query.gte,
        'lt': query.lt,
        'lte': query.lte,
        'like': query.like,
        'ilike': query.ilike,
    }
    
    if operator == 'in':
        query = query.in_(column, value)
    elif operator in op_map:
        query = op_map[operator](column, value)
    else:
        raise ValueError(f"Unsupported operator: {operator}")
    
    try:
        response = query.execute()
        return response.data or []
    except Exception as e:
        raise Exception(f"Error querying {entity_name}: {e}")


def upsert_record(entity_name: str, data: dict, on_conflict: str = None) -> dict:
    """Insert or update a record based on conflict column."""
    sb = _get_supabase()
    clean_data = _coerce_types({k: v for k, v in data.items() if v is not None})
    try:
        if on_conflict:
            response = sb.table(entity_name).upsert(clean_data, on_conflict=on_conflict).execute()
        else:
            response = sb.table(entity_name).upsert(clean_data).execute()
        if response.data and len(response.data) > 0:
            return response.data[0]
        return {}
    except Exception as e:
        raise Exception(f"Error upserting record in {entity_name}: {e}")


def count_records(entity_name: str, filters: dict = None) -> int:
    """Count records in a table, optionally filtered."""
    sb = _get_supabase()
    query = sb.table(entity_name).select("*", count="exact")
    if filters:
        for key, value in filters.items():
            query = query.eq(key, value)
    try:
        response = query.execute()
        return response.count or 0
    except Exception as e:
        raise Exception(f"Error counting records in {entity_name}: {e}")
