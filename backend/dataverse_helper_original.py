import os
import time
import requests
from dotenv import load_dotenv
import msal

# Load environment variables from id.env
load_dotenv("id.env")

TENANT_ID = os.getenv("TENANT_ID")
CLIENT_ID = os.getenv("CLIENT_ID")
CLIENT_SECRET = os.getenv("CLIENT_SECRET")
RESOURCE = os.getenv("RESOURCE")  # e.g., https://<yourorg>.crm.dynamics.com

AUTHORITY = f"https://login.microsoftonline.com/{TENANT_ID}"
SCOPE = [f"{RESOURCE}/.default"]
EMPLOYEE_ENTITY="crc6f_table12s"

# ================== PERFORMANCE: Singleton MSAL app (reuses internal token cache) ==================
_msal_app = None
_token_cache = {"access_token": None, "expires_at": 0}
_TOKEN_REFRESH_MARGIN = 300  # refresh 5 min before expiry

def _get_msal_app():
    global _msal_app
    if _msal_app is None:
        _msal_app = msal.ConfidentialClientApplication(
            client_id=CLIENT_ID,
            client_credential=CLIENT_SECRET,
            authority=AUTHORITY
        )
    return _msal_app

def get_access_token():
    global _token_cache
    now = time.time()
    if _token_cache["access_token"] and now < _token_cache["expires_at"] - _TOKEN_REFRESH_MARGIN:
        return _token_cache["access_token"]

    app = _get_msal_app()
    result = app.acquire_token_for_client(scopes=SCOPE)

    if "access_token" in result:
        expires_in = result.get("expires_in", 3600)
        _token_cache["access_token"] = result["access_token"]
        _token_cache["expires_at"] = now + expires_in
        return result["access_token"]
    else:
        raise Exception(f"Failed to get token: {result}")

# ================== PERFORMANCE: Shared requests.Session (TCP + TLS reuse) ==================
_dataverse_session = None
_DEFAULT_TIMEOUT = 15

def get_dataverse_session():
    """Return a shared requests.Session for Dataverse calls. Reuses TCP connections."""
    global _dataverse_session
    if _dataverse_session is None:
        _dataverse_session = requests.Session()
        _dataverse_session.headers.update({
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0"
        })
    return _dataverse_session

# -------------------- CRUD Functions --------------------

def create_record(entity_name, data):
    """Create a new record in Dataverse"""
    token = get_access_token()
    url = f"{RESOURCE}/api/data/v9.2/{entity_name}"
    s = get_dataverse_session()
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Prefer": "return=representation"
    }
    response = s.post(url, headers=headers, json=data, timeout=_DEFAULT_TIMEOUT)
    if response.status_code in (200, 201):
        try:
            return response.json()
        except Exception:
            return {}
    if response.status_code == 204:
        return {}
    raise Exception(f"Error creating record: {response.status_code} - {response.text}")


def get_record(entity_name, record_id):
    """Retrieve a single record by ID"""
    token = get_access_token()
    url = f"{RESOURCE}/api/data/v9.2/{entity_name}({record_id})"
    s = get_dataverse_session()
    headers = {
        "Authorization": f"Bearer {token}",
    }
    response = s.get(url, headers=headers, timeout=_DEFAULT_TIMEOUT)
    if response.status_code == 200:
        return response.json()
    else:
        raise Exception(f"Error getting record: {response.status_code} - {response.text}")


def fetch_record_by_id(entity_name, leave_id, id_field="crc6f_leaveid"):
    """Fetch a record by alternate key (e.g., leave ID)"""
    token = get_access_token()
    # Use OData query to filter by the alternate key
    url = f"{RESOURCE}/api/data/v9.2/{entity_name}?$filter={id_field} eq '{leave_id}'"
    s = get_dataverse_session()
    headers = {
        "Authorization": f"Bearer {token}",
    }
    response = s.get(url, headers=headers, timeout=_DEFAULT_TIMEOUT)
    if response.status_code == 200:
        data = response.json()
        # Return the first record if found
        if data.get('value') and len(data['value']) > 0:
            return data['value'][0]
        return None
    else:
        raise Exception(f"Error fetching record by {id_field}: {response.status_code} - {response.text}")


def update_record(entity_name, record_id, data):
    """Update a record"""
    token = get_access_token()
    url = f"{RESOURCE}/api/data/v9.2/{entity_name}({record_id})"
    s = get_dataverse_session()
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "If-Match": "*"
    }
    response = s.patch(url, headers=headers, json=data, timeout=_DEFAULT_TIMEOUT)
    if response.status_code in (200, 204, 1223):
        return True
    else:
        raise Exception(f"Error updating record: {response.status_code} - {response.text}")


def update_record_by_alt_key(entity_name, alt_key_value, data, alt_key_field="crc6f_leaveid"):
    """Update a record using alternate key"""
    token = get_access_token()
    # Use alternate key syntax for update
    url = f"{RESOURCE}/api/data/v9.2/{entity_name}({alt_key_field}='{alt_key_value}')"
    s = get_dataverse_session()
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "If-Match": "*"
    }
    response = s.patch(url, headers=headers, json=data, timeout=_DEFAULT_TIMEOUT)
    if response.status_code in (200, 204, 1223):
        return True
    else:
        raise Exception(f"Error updating record by alt key: {response.status_code} - {response.text}")


def delete_record(entity_name, record_id):
    """Delete a record"""
    token = get_access_token()
    url = f"{RESOURCE}/api/data/v9.2/{entity_name}({record_id})"
    s = get_dataverse_session()
    headers = {
        "Authorization": f"Bearer {token}",
    }
    response = s.delete(url, headers=headers, timeout=_DEFAULT_TIMEOUT)
    if response.status_code == 204:
        return True
    else:
        raise Exception(f"Error deleting record: {response.status_code} - {response.text}")


def get_employee_name(employee_id):
    """Fetch employee name from master table."""
    try:
        token = get_access_token()
        s = get_dataverse_session()
        headers = {
            "Authorization": f"Bearer {token}",
        }
        url = f"{RESOURCE}/api/data/v9.2/{EMPLOYEE_ENTITY}?$filter=crc6f_employeeid eq '{employee_id}'&$select=crc6f_firstname"
        response = s.get(url, headers=headers, timeout=_DEFAULT_TIMEOUT)
        if response.status_code == 200 and response.json().get("value"):
            return response.json()["value"][0].get("crc6f_firstname")
        # else:
        #     return employee_id
    except Exception as e:
        print(f"⚠️ Could not fetch name for {employee_id}: {e}")
        return employee_id



def get_employee_email(employee_id):
    """Fetch employee email and name from Employee Master"""
    try:
        token = get_access_token()
        s = get_dataverse_session()
        headers = {
            "Authorization": f"Bearer {token}",
        }

        url = f"{RESOURCE}/api/data/v9.2/{EMPLOYEE_ENTITY}?$filter=crc6f_employeeid eq '{employee_id}'"
        response = s.get(url, headers=headers, timeout=_DEFAULT_TIMEOUT)
        response.raise_for_status()

        records = response.json().get("value", [])
        if not records:
            print(f"⚠️ No employee found for ID: {employee_id}")
            return None, employee_id

        emp = records[0]
        print(emp)
        email = emp.get("crc6f_email")     # ✅ Correct field
        name = emp.get("crc6f_name", employee_id)

        print(f"📧 Found employee email: {email} for {employee_id}")
        return email

    except Exception as e:
        print(f"❌ Error fetching email for {employee_id}: {e}")
        return None, employee_id
