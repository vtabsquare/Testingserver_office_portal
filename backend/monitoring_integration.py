import os
import requests
import traceback

def sync_monitoring_state(employee_id, monitoring_state):
    """
    Synchronizes the employee's check-in state with the external Productivity Monitoring backend.
    Expected monitoring_state values: 'active', 'paused'
    """
    if not employee_id:
        print("[MONITORING] Missing employee_id, skipping sync.")
        return False
        
    api_url = os.getenv("MONITORING_API_URL")
    secret = os.getenv("OFFICEHUB_INTEGRATION_SECRET")
    org_id = os.getenv("MONITORING_ORG_ID")
    
    if not api_url or not secret or not org_id:
        print(f"[MONITORING] Configuration missing, skipping sync for {employee_id} -> {monitoring_state}.")
        return False

    api_url = api_url.rstrip("/")
    endpoint = f"{api_url}/api/external/officehub/monitoring-state"
    
    headers = {
        "Authorization": f"Bearer {secret}",
        "Content-Type": "application/json"
    }
    
    payload = {
        "org_id": org_id,
        "employee_id": employee_id,
        "monitoring_state": monitoring_state
    }
    
    try:
        # Use a short timeout so attendance is not blocked if Monitoring is down
        response = requests.post(endpoint, headers=headers, json=payload, timeout=3.0)
        
        if response.status_code >= 400:
            print(f"[MONITORING] Sync failed for {employee_id} -> {monitoring_state}. "
                  f"Status: {response.status_code}. Response: {response.text[:200]}")
            return False
            
        print(f"[MONITORING] Sync successful for {employee_id} -> {monitoring_state}.")
        return True
    except requests.exceptions.Timeout:
        print(f"[MONITORING] Sync timeout for {employee_id} -> {monitoring_state}.")
        return False
    except requests.exceptions.RequestException as e:
        print(f"[MONITORING] Sync request error for {employee_id} -> {monitoring_state}: {type(e).__name__}")
        return False
    except Exception as e:
        print(f"[MONITORING] Unexpected error during sync for {employee_id} -> {monitoring_state}.")
        traceback.print_exc()
        return False


def send_face_verification_alert(employee_id, alert_level, verify_url):
    """
    Notify the external Monitoring Tool that an employee's FaceAuth
    re-verification is due_soon/overdue/missed, so its Desktop Agent can show
    a native OS notification even when the OfficeHub browser tab is closed.
    Expected alert_level values: 'due_soon', 'overdue', 'missed'
    """
    if not employee_id or not alert_level:
        print("[MONITORING] Missing employee_id/alert_level, skipping face-auth alert.")
        return False

    api_url = os.getenv("MONITORING_API_URL")
    secret = os.getenv("OFFICEHUB_INTEGRATION_SECRET")
    org_id = os.getenv("MONITORING_ORG_ID")

    if not api_url or not secret or not org_id:
        print(f"[MONITORING] Configuration missing, skipping face-auth alert for {employee_id} -> {alert_level}.")
        return False

    api_url = api_url.rstrip("/")
    endpoint = f"{api_url}/api/external/officehub/face-verification-alert"

    headers = {
        "Authorization": f"Bearer {secret}",
        "Content-Type": "application/json"
    }

    payload = {
        "org_id": org_id,
        "employee_id": employee_id,
        "alert_level": alert_level,
        "verify_url": verify_url,
    }

    try:
        # Use a short timeout so nothing else is blocked if Monitoring is down
        response = requests.post(endpoint, headers=headers, json=payload, timeout=3.0)

        if response.status_code >= 400:
            print(f"[MONITORING] Face-auth alert failed for {employee_id} -> {alert_level}. "
                  f"Status: {response.status_code}. Response: {response.text[:200]}")
            return False

        print(f"[MONITORING] Face-auth alert sent for {employee_id} -> {alert_level}.")
        return True
    except requests.exceptions.Timeout:
        print(f"[MONITORING] Face-auth alert timeout for {employee_id} -> {alert_level}.")
        return False
    except requests.exceptions.RequestException as e:
        print(f"[MONITORING] Face-auth alert request error for {employee_id} -> {alert_level}: {type(e).__name__}")
        return False
    except Exception as e:
        print(f"[MONITORING] Unexpected error during face-auth alert for {employee_id} -> {alert_level}.")
        traceback.print_exc()
        return False
