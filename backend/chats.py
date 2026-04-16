import os
import time
import uuid
import base64
import json
import traceback
import re
from threading import Lock
from difflib import SequenceMatcher
import requests
import datetime
from flask import Blueprint, request, jsonify, Response, current_app,send_file, make_response
import logging
from dataverse_helper import get_dataverse_session

# --------------------------------------------------------------
# BLUEPRINT
# --------------------------------------------------------------
chat_bp = Blueprint("chat", __name__, url_prefix="/chat")

# ================== FILE ATTACHMENT RPT MIRRORING ==================
FILEATTACH_RPT_MAP = {
    "createdon": "crc6f_RPT_createdon",
    "modifiedon": "crc6f_RPT_modifiedon",
    "statecode": "crc6f_RPT_statecode",
    "statuscode": "crc6f_RPT_statuscode",
    "importsequencenumber": "crc6f_RPT_importsequencenumber",
    "overriddencreatedon": "crc6f_RPT_overriddencreatedon",
    "timezoneruleversionnumber": "crc6f_RPT_timezoneruleversionnumber",
    "utcconversiontimezonecode": "crc6f_RPT_utcconversiontimezonecode",
    "crc6f_filesize": "crc6f_RPT_filesize",
}


def _apply_fileattach_rpt(payload: dict) -> dict:
    """Apply RPT mirroring for file attachment payloads."""
    if not isinstance(payload, dict):
        return {}
    for base_key, rpt_key in FILEATTACH_RPT_MAP.items():
        if base_key in payload and payload[base_key] not in (None, "", []):
            payload[rpt_key] = payload[base_key]
    return payload

# ================== CONVERSATION RPT MIRRORING ==================
CONV_RPT_MAP = {
    "createdon": "crc6f_RPT_createdon",
}


def _apply_conv_rpt(payload: dict) -> dict:
    """Apply RPT mirroring for conversation payloads."""
    if not isinstance(payload, dict):
        return {}
    for base_key, rpt_key in CONV_RPT_MAP.items():
        if base_key in payload and payload[base_key] not in (None, "", []):
            payload[rpt_key] = payload[base_key]
    return payload

# ================== CONVERSATION MEMBERS RPT MIRRORING ==================
MEMBER_RPT_MAP = {
    "crc6f_joined_on": "crc6f_RPT_joined_on",
}


def _apply_member_rpt(payload: dict) -> dict:
    """Apply RPT mirroring for conversation member payloads."""
    if not isinstance(payload, dict):
        return {}
    for base_key, rpt_key in MEMBER_RPT_MAP.items():
        if base_key in payload and payload[base_key] not in (None, "", []):
            payload[rpt_key] = payload[base_key]
    return payload

# --------------------------------------------------------------
# CHATBOT AUTOMATION - Helper Functions
# --------------------------------------------------------------

def fuzzy_match_name(search_name, employees):
    """Find the best matching employee by name using fuzzy matching."""
    if not search_name or not employees:
        return None, []
    
    search_lower = search_name.lower().strip()
    matches = []
    
    for emp in employees:
        emp_id = emp.get("crc6f_employeeid", "")
        first_name = emp.get("crc6f_firstname", "") or ""
        last_name = emp.get("crc6f_lastname", "") or ""
        full_name = f"{first_name} {last_name}".strip()
        
        if not full_name:
            continue
        
        full_name_lower = full_name.lower()
        
        # Exact match
        if search_lower == full_name_lower:
            return emp, [{"employee": emp, "name": full_name, "score": 1.0}]
        
        # First name exact match
        if search_lower == first_name.lower():
            matches.append({"employee": emp, "name": full_name, "score": 0.95})
            continue
        
        # Partial match using SequenceMatcher
        ratio = SequenceMatcher(None, search_lower, full_name_lower).ratio()
        first_ratio = SequenceMatcher(None, search_lower, first_name.lower()).ratio()
        
        best_ratio = max(ratio, first_ratio)
        
        if best_ratio >= 0.5:  # Threshold for fuzzy matching
            matches.append({"employee": emp, "name": full_name, "score": best_ratio})
    
    # Sort by score descending
    matches.sort(key=lambda x: x["score"], reverse=True)
    
    if matches:
        return matches[0]["employee"], matches[:5]  # Return best match and top 5
    
    return None, []


def get_or_create_conversation(user_id, target_id):
    """Get existing conversation or create a new one between two users."""
    try:
        # Find if both already share a conversation
        q = f"$filter=crc6f_user_id eq '{user_id}' or crc6f_user_id eq '{target_id}'"
        rows = dataverse_get(MEMBERS_ENTITY_SET, q).get("value", [])
        
        map_conv = {}
        for r in rows:
            cid = r["crc6f_conversation_id"]
            map_conv.setdefault(cid, set()).add(r["crc6f_user_id"])
        
        for cid, users in map_conv.items():
            if user_id in users and target_id in users:
                # Check if direct chat (not group)
                cq = f"$filter=crc6f_conversationid eq '{cid}'&$top=1"
                conv = dataverse_get(CONV_ENTITY_SET, cq).get("value", [])
                if conv and str(conv[0].get("crc6f_isgroup")).lower() != "true":
                    return cid, False  # Existing conversation
        
        # Create new conversation
        conversation_id = str(uuid.uuid4())
        
        conv_payload = {
            "crc6f_conversationid": conversation_id,
            "crc6f_empname": f"{user_id} → {target_id}",
            "crc6f_isgroup": False,
        }
        _apply_conv_rpt(conv_payload)
        dataverse_create(CONV_ENTITY_SET, conv_payload)
        
        # Create 2 members
        for uid in (user_id, target_id):
            mem = {
                "crc6f_conversation_id": conversation_id,
                "crc6f_member_id": str(uuid.uuid4()),
                "crc6f_user_id": uid,
                "crc6f_joined_on": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
            }
            _apply_member_rpt(mem)
            dataverse_create(MEMBERS_ENTITY_SET, mem)
        
        return conversation_id, True  # New conversation
        
    except Exception as e:
        print(f"[CHATBOT] Error in get_or_create_conversation: {e}")
        return None, False


def send_message_to_user(sender_id, conversation_id, message_text):
    """Send a message to a conversation."""
    try:
        message_id = str(uuid.uuid4())
        
        payload = {
            "crc6f_message_id": message_id,
            "crc6f_conversation_id": conversation_id,
            "crc6f_sender_id": sender_id,
            "crc6f_message_type": "text",
            "crc6f_message_text": message_text,
        }
        
        dataverse_create(MSG_ENTITY_SET, payload)
        
        # Emit socket event for real-time delivery
        msg_out = normalize_message(payload)
        msg_out["status"] = "delivered"
        emit_socket_event("new_message", msg_out)
        
        return {"success": True, "message_id": message_id}
        
    except Exception as e:
        print(f"[CHATBOT] Error sending message: {e}")
        return {"success": False, "error": str(e)}


def get_unread_messages_for_user(user_id):
    """Get unread messages for a user across all conversations."""
    try:
        # Get all conversations for user
        q = f"$filter=crc6f_user_id eq '{user_id}'&$top=500"
        mem_rows = dataverse_get(MEMBERS_ENTITY_SET, q).get("value", [])
        
        convo_ids = list({m["crc6f_conversation_id"] for m in mem_rows})
        
        unread_messages = []
        emp_map = build_employee_name_map()
        
        for cid in convo_ids:
            # Get messages not sent by user (potential unread)
            mq = f"$filter=crc6f_conversation_id eq '{cid}' and crc6f_sender_id ne '{user_id}'&$orderby=createdon desc&$top=50"
            messages = dataverse_get(MSG_ENTITY_SET, mq).get("value", [])
            
            # Get conversation name
            cq = f"$filter=crc6f_conversationid eq '{cid}'&$top=1"
            conv_resp = dataverse_get(CONV_ENTITY_SET, cq).get("value", [])
            conv_name = conv_resp[0].get("crc6f_empname", "Unknown") if conv_resp else "Unknown"
            
            for msg in messages:
                sender_id = msg.get("crc6f_sender_id")
                sender_name = emp_map.get(sender_id, sender_id)
                
                unread_messages.append({
                    "conversation_id": cid,
                    "conversation_name": conv_name,
                    "message_id": msg.get("crc6f_message_id"),
                    "sender_id": sender_id,
                    "sender_name": sender_name,
                    "message_text": msg.get("crc6f_message_text"),
                    "message_type": msg.get("crc6f_message_type"),
                    "created_on": msg.get("createdon"),
                })
        
        return unread_messages
        
    except Exception as e:
        print(f"[CHATBOT] Error getting unread messages: {e}")
        return []


# --------------------------------------------------------------
# CHATBOT AUTOMATION ENDPOINTS
# --------------------------------------------------------------

@chat_bp.route('/chatbot/search-employee', methods=['POST'])
def chatbot_search_employee():
    """Search for an employee by name for chatbot automation."""
    try:
        data = request.get_json()
        search_name = data.get('name', '').strip()
        user_id = data.get('user_id')
        
        if not search_name:
            return jsonify({'error': 'Name is required'}), 400
        
        # Get all employees
        employees = dataverse_get(EMPLOYEE_ENTITY_SET).get("value", [])
        
        best_match, all_matches = fuzzy_match_name(search_name, employees)
        
        if not best_match:
            return jsonify({
                'found': False,
                'message': f"No employee found matching '{search_name}'",
                'suggestions': []
            })
        
        # Format matches for response
        formatted_matches = []
        for m in all_matches:
            emp = m["employee"]
            formatted_matches.append({
                'employee_id': emp.get("crc6f_employeeid"),
                'name': m["name"],
                'score': round(m["score"], 2),
                'department': emp.get("crc6f_department"),
                'designation': emp.get("crc6f_designation")
            })
        
        return jsonify({
            'found': True,
            'best_match': {
                'employee_id': best_match.get("crc6f_employeeid"),
                'name': f"{best_match.get('crc6f_firstname', '')} {best_match.get('crc6f_lastname', '')}".strip(),
                'department': best_match.get("crc6f_department"),
                'designation': best_match.get("crc6f_designation")
            },
            'all_matches': formatted_matches,
            'message': f"Found {len(formatted_matches)} matching employee(s)"
        })
        
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@chat_bp.route('/chatbot/send-message', methods=['POST'])
def chatbot_send_message():
    """Send a message to an employee via chatbot automation."""
    try:
        data = request.get_json()
        sender_id = data.get('sender_id')
        target_employee_id = data.get('target_employee_id')
        message_text = data.get('message')
        
        if not sender_id or not target_employee_id or not message_text:
            return jsonify({'error': 'sender_id, target_employee_id, and message are required'}), 400
        
        # Get or create conversation
        conversation_id, is_new = get_or_create_conversation(sender_id, target_employee_id)
        
        if not conversation_id:
            return jsonify({'error': 'Failed to get or create conversation'}), 500
        
        # Send the message
        result = send_message_to_user(sender_id, conversation_id, message_text)
        
        if result.get("success"):
            # Get target employee name
            emp_map = build_employee_name_map()
            target_name = emp_map.get(target_employee_id, target_employee_id)
            
            return jsonify({
                'success': True,
                'message_id': result.get("message_id"),
                'conversation_id': conversation_id,
                'is_new_conversation': is_new,
                'recipient_name': target_name,
                'message': f"Message sent successfully to {target_name}"
            })
        else:
            return jsonify({'error': result.get("error", "Failed to send message")}), 500
        
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@chat_bp.route('/chatbot/unread-messages', methods=['POST'])
def chatbot_get_unread():
    """Get unread messages for a user."""
    try:
        data = request.get_json()
        user_id = data.get('user_id')
        
        if not user_id:
            return jsonify({'error': 'user_id is required'}), 400
        
        messages = get_unread_messages_for_user(user_id)
        
        # Group by sender
        by_sender = {}
        for msg in messages:
            sender = msg["sender_name"]
            if sender not in by_sender:
                by_sender[sender] = {
                    "sender_id": msg["sender_id"],
                    "sender_name": sender,
                    "messages": [],
                    "count": 0
                }
            by_sender[sender]["messages"].append(msg)
            by_sender[sender]["count"] += 1
        
        return jsonify({
            'success': True,
            'total_unread': len(messages),
            'by_sender': list(by_sender.values()),
            'recent_messages': messages[:20]  # Last 20 messages
        })
        
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@chat_bp.route('/chatbot/read-conversation', methods=['POST'])
def chatbot_read_conversation():
    """Read messages from a specific conversation or with a specific person."""
    try:
        data = request.get_json()
        user_id = data.get('user_id')
        target_name = data.get('target_name')
        target_employee_id = data.get('target_employee_id')
        limit = data.get('limit', 20)
        
        if not user_id:
            return jsonify({'error': 'user_id is required'}), 400
        
        # If target_name provided, find the employee
        if target_name and not target_employee_id:
            employees = dataverse_get(EMPLOYEE_ENTITY_SET).get("value", [])
            best_match, _ = fuzzy_match_name(target_name, employees)
            if best_match:
                target_employee_id = best_match.get("crc6f_employeeid")
            else:
                return jsonify({
                    'success': False,
                    'error': f"No employee found matching '{target_name}'"
                }), 404
        
        if not target_employee_id:
            return jsonify({'error': 'target_name or target_employee_id is required'}), 400
        
        # Find conversation between user and target
        q = f"$filter=crc6f_user_id eq '{user_id}' or crc6f_user_id eq '{target_employee_id}'"
        rows = dataverse_get(MEMBERS_ENTITY_SET, q).get("value", [])
        
        map_conv = {}
        for r in rows:
            cid = r["crc6f_conversation_id"]
            map_conv.setdefault(cid, set()).add(r["crc6f_user_id"])
        
        conversation_id = None
        for cid, users in map_conv.items():
            if user_id in users and target_employee_id in users:
                conversation_id = cid
                break
        
        if not conversation_id:
            emp_map = build_employee_name_map()
            target_name = emp_map.get(target_employee_id, target_employee_id)
            return jsonify({
                'success': False,
                'error': f"No conversation found with {target_name}"
            }), 404
        
        # Get messages
        mq = f"$filter=crc6f_conversation_id eq '{conversation_id}'&$orderby=createdon desc&$top={limit}"
        messages = dataverse_get(MSG_ENTITY_SET, mq).get("value", [])
        
        emp_map = build_employee_name_map()
        target_name = emp_map.get(target_employee_id, target_employee_id)
        
        formatted_messages = []
        for msg in reversed(messages):  # Reverse to show oldest first
            sender_id = msg.get("crc6f_sender_id")
            formatted_messages.append({
                'sender_id': sender_id,
                'sender_name': emp_map.get(sender_id, sender_id),
                'is_me': sender_id == user_id,
                'message_text': msg.get("crc6f_message_text"),
                'message_type': msg.get("crc6f_message_type"),
                'created_on': msg.get("createdon")
            })
        
        return jsonify({
            'success': True,
            'conversation_id': conversation_id,
            'target_name': target_name,
            'target_employee_id': target_employee_id,
            'message_count': len(formatted_messages),
            'messages': formatted_messages
        })
        
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@chat_bp.route('/chatbot/reply', methods=['POST'])
def chatbot_reply():
    """Reply to the last message from a specific person."""
    try:
        data = request.get_json()
        user_id = data.get('user_id')
        target_name = data.get('target_name')
        target_employee_id = data.get('target_employee_id')
        reply_text = data.get('message')
        
        if not user_id or not reply_text:
            return jsonify({'error': 'user_id and message are required'}), 400
        
        # If target_name provided, find the employee
        if target_name and not target_employee_id:
            employees = dataverse_get(EMPLOYEE_ENTITY_SET).get("value", [])
            best_match, _ = fuzzy_match_name(target_name, employees)
            if best_match:
                target_employee_id = best_match.get("crc6f_employeeid")
            else:
                return jsonify({
                    'success': False,
                    'error': f"No employee found matching '{target_name}'"
                }), 404
        
        if not target_employee_id:
            return jsonify({'error': 'target_name or target_employee_id is required'}), 400
        
        # Get or create conversation
        conversation_id, is_new = get_or_create_conversation(user_id, target_employee_id)
        
        if not conversation_id:
            return jsonify({'error': 'Failed to get or create conversation'}), 500
        
        # Send the reply
        result = send_message_to_user(user_id, conversation_id, reply_text)
        
        if result.get("success"):
            emp_map = build_employee_name_map()
            target_name = emp_map.get(target_employee_id, target_employee_id)
            
            return jsonify({
                'success': True,
                'message_id': result.get("message_id"),
                'conversation_id': conversation_id,
                'recipient_name': target_name,
                'message': f"Reply sent to {target_name}"
            })
        else:
            return jsonify({'error': result.get("error", "Failed to send reply")}), 500
        
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@chat_bp.route('/chatbot/query', methods=['POST'])
def chatbot_query():
    try:
        data = request.get_json()
        user_id = data.get('user_id')
        query = data.get('query')
        
        if not user_id or not query:
            return jsonify({'error': 'User ID and query are required'}), 400
            
        # Check if user is admin
        token = _get_oauth_token()
        headers = {
            'Authorization': f'Bearer {token}',
            'Accept': 'application/json'
        }
        
        # Get user details
        q = f"$filter=crc6f_employeeid eq '{user_id}'&$select=crc6f_designation"
        resp = dataverse_get(EMPLOYEE_ENTITY_SET, q)
        if not resp.get('value'):
            return jsonify({'error': 'User not found'}), 404
            
        user = resp['value'][0]
        designation = user.get('crc6f_designation', '').lower()
        
        if not ('admin' in designation or 'manager' in designation):
            return jsonify({'error': 'Admin access required'}), 403
            
        # Process the query and get data from relevant tables
        # This is a simple example - you can expand this to handle more complex queries
        tables = {
            'employees': EMPLOYEE_ENTITY_SET,
            'attendance': 'crc6f_table13s',
            'leaves': 'crc6f_table14s',
            'projects': 'crc6f_hr_projectheaders',
            'clients': 'crc6f_hr_clients'
        }
        
        results = {}
        for table_name, entity_set in tables.items():
            try:
                data = dataverse_get(entity_set)
                results[table_name] = data.get('value', [])
            except Exception as e:
                print(f'Error fetching {table_name}: {str(e)}')
                continue
                
        # Here you can add natural language processing to interpret the query
        # and filter/process the results accordingly
        
        return jsonify({
            'query': query,
            'results': results
        })
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500


log = logging.getLogger(__name__)
log.setLevel(logging.DEBUG)
# --------------------------------------------------------------
# ENTITY SETS (TABLE NAMES)
# --------------------------------------------------------------

CONV_ENTITY_SET = os.getenv("CHAT_CONVERSATION_ENTITY_SET", "crc6f_hr_chat_conversations")
MEMBERS_ENTITY_SET = os.getenv("CHAT_MEMBERS_ENTITY_SET", "crc6f_hr_conversation_memberses")
MSG_ENTITY_SET = os.getenv("CHAT_MESSAGE_ENTITY_SET", "crc6f_hr_messageses")
MSGSTATUS_ENTITY_SET = os.getenv("CHAT_MSGSTATUS_ENTITY_SET", "crc6f_hr_messagestatuses")
ANNOTATION_ENTITY_SET = "annotations"
EMPLOYEE_ENTITY_SET = os.getenv("CHAT_EMPLOYEE_ENTITY_SET", "crc6f_table12s")

RESOURCE = os.getenv("RESOURCE")
TENANT_ID = os.getenv("TENANT_ID") or os.getenv("AZURE_TENANT_ID")
CLIENT_ID = os.getenv("CLIENT_ID")
CLIENT_SECRET = os.getenv("CLIENT_SECRET")

if not RESOURCE:
    raise RuntimeError("RESOURCE environment variable is required")

# --------------------------------------------------------------
# TOKEN CACHE
# --------------------------------------------------------------

_token_cache = {"access_token": None, "expires_at": 0}


def _get_oauth_token():
    now = int(time.time())
    if _token_cache.get("access_token") and _token_cache["expires_at"] - 60 > now:
        return _token_cache["access_token"]

    url = f"https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/token"
    data = {
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "scope": f"{RESOURCE.rstrip('/')}/.default",
        "grant_type": "client_credentials",
    }
    r = requests.post(url, data=data, timeout=10)
    r.raise_for_status()
    j = r.json()

    _token_cache["access_token"] = j["access_token"]
    _token_cache["expires_at"] = now + int(j.get("expires_in", 3600))
    return j["access_token"]

SOCKET_SERVER_URL = os.getenv("SOCKET_SERVER_URL", "http://localhost:4001")


CHAT_SOCKET_EMIT_URL = f"{SOCKET_SERVER_URL}/emit-to-room"


def emit_socket_event(event, payload):
    """
    Sends real-time event to Node socket server.
    This avoids running socket in Python.
    """
    try:
        requests.post(
            f"{SOCKET_SERVER_URL}/emit",
            json={"event": event, "data": payload},
            timeout=3
        )
    except Exception as e:
        print("Socket emit failed:", e)



def dataverse_headers():
    return {
        "Authorization": f"Bearer {_get_oauth_token()}",
        "Content-Type": "application/json; charset=utf-8",
        "Accept": "application/json",
    }
# --------------------------------------------------------------
# CRUD HELPERS (Dataverse)
# --------------------------------------------------------------

def dataverse_get(entity_set, q=None):
    url = f"{RESOURCE}/api/data/v9.2/{entity_set}"
    if q:
        url += f"?{q}"
    r = get_dataverse_session().get(url, headers=dataverse_headers(), timeout=15)
    r.raise_for_status()
    return r.json()


def dataverse_create(entity_set, data):
    url = f"{RESOURCE}/api/data/v9.2/{entity_set}"
    r = get_dataverse_session().post(url, headers=dataverse_headers(), data=json.dumps(data), timeout=15)

    if r.status_code in (200, 201, 204):
        try:
            if r.text and r.text.strip():
                return r.json()
        except:
            pass

        ent = r.headers.get("OData-EntityId") or r.headers.get("odata-entityid")
        return {"entity_reference": ent}

    raise RuntimeError(f"Dataverse create failed: {r.status_code} {r.text}")


def dataverse_update(entity_set, record_guid, data):
    # record_guid should be GUID without surrounding ()
    url = f"{RESOURCE}/api/data/v9.2/{entity_set}({record_guid})"
    r = get_dataverse_session().patch(url, headers=dataverse_headers(), data=json.dumps(data), timeout=15)
    if r.status_code not in (200, 204):
        r.raise_for_status()
    return True


def dataverse_delete(entity_set, record_guid):
    url = f"{RESOURCE}/api/data/v9.2/{entity_set}({record_guid})"
    r = get_dataverse_session().delete(url, headers=dataverse_headers(), timeout=15)
    if r.status_code not in (200, 204):
        r.raise_for_status()
    return True




# --------------------------------------------------------------
# Helper: Extract GUID from Dataverse record
# --------------------------------------------------------------

def extract_guid(record):
    """
    Finds the Dataverse GUID for update/delete.
    Works with:
      - crc6f_hr_xxxxxid fields
      - @odata.id
      - id field
    """
    if not record:
        return None

    # 1. Check any field ending in 'id' except business IDs
    for k, v in record.items():
        if k.lower().endswith("id") and not k.lower().startswith("crc6f_message_id") \
            and not k.lower().startswith("crc6f_conversationid") \
            and not k.lower().startswith("crc6f_member_id"):
            return v

    # 2. @odata.id — extract GUID
    odata = record.get("@odata.id")
    if odata and "(" in odata:
        return odata.split("(")[1].replace(")", "")

    # 3. fallback
    return record.get("id")


# --------------------------------------------------------------
# Employee name lookup (cached using file cache)
# --------------------------------------------------------------

def _get_employee_name_by_id(emp_id):
    try:
        if not emp_id:
            return None

        

        query = f"$filter=crc6f_employeeid eq '{emp_id}'&$top=1"
        resp = dataverse_get(EMPLOYEE_ENTITY_SET, query)
        rows = resp.get("value", []) if resp else []

        if not rows:
            
            return emp_id  # fallback to id

        r = rows[0]
        fn = r.get("crc6f_firstname") or ""
        ln = r.get("crc6f_lastname") or ""
        full = (fn + " " + ln).strip()

        result = full if full else emp_id
        

        return result

    except Exception:
        # Do not crash the flow if lookup fails
        return emp_id


# --------------------------------------------------------------
# Normalize message record
# --------------------------------------------------------------

def normalize_message(rec, emp_map=None):
    if not rec:
        return {}

    sender_id = rec.get("crc6f_sender_id")

    sender_name = None
    if emp_map and sender_id:
        sender_name = emp_map.get(sender_id)

    if not sender_name:
        sender_name = sender_id  # final fallback

    # Message status: sent -> delivered -> read
    # Default to "delivered" for messages fetched from DB (they were saved + emitted)
    status = rec.get("crc6f_status") or "delivered"

    return {
        "message_id": rec.get("crc6f_message_id"),
        "conversation_id": rec.get("crc6f_conversation_id"),
        "sender_id": sender_id,
        "sender_name": sender_name,
        "message_type": rec.get("crc6f_message_type"),
        "message_text": rec.get("crc6f_message_text"),
        "media_url": rec.get("crc6f_media_url"),
        "file_name": rec.get("crc6f_file_name"),
        "mime_type": rec.get("crc6f_mime_type"),
        "created_on": rec.get("createdon"),
        "status": status,
        "is_edited": rec.get("crc6f_is_edited") or False,
        "reply_to": rec.get("crc6f_reply_to_message_id"),
    }

def build_employee_name_map():
    """
    Build { employee_id: full_name } map once per request
    """
    try:
        rows = dataverse_get(EMPLOYEE_ENTITY_SET).get("value", [])
        emp_map = {}

        for r in rows:
            emp_id = r.get("crc6f_employeeid")
            if not emp_id:
                continue

            fn = r.get("crc6f_firstname") or ""
            ln = r.get("crc6f_lastname") or ""
            full = (fn + " " + ln).strip()

            emp_map[emp_id] = full if full else emp_id

        return emp_map

    except Exception:
        traceback.print_exc()
        return {}

def dataverse_upload_file(entity_set, row_guid, file_column, binary):
    """
    Uploads binary to Dataverse File column
    """
    url = f"{RESOURCE}/api/data/v9.2/{entity_set}({row_guid})/{file_column}"
    headers = {
        "Authorization": f"Bearer {_get_oauth_token()}",
        "Content-Type": "application/octet-stream"
    }
    r = requests.put(url, headers=headers, data=binary, timeout=60)
    r.raise_for_status()


def generate_file_id():
    ts = datetime.datetime.utcnow().strftime("%Y%m%d")
    rand = uuid.uuid4().hex[:8].upper()
    return f"FILE-{ts}-{rand}"


# --------------------------------------------------------------
# GET CONVERSATIONS (WITH MEMBERS ARRAY) — CACHED
# --------------------------------------------------------------

@chat_bp.route("/conversations/<string:user_id>", methods=["GET"])
def get_conversations(user_id):
    try:
        

        q = f"$filter=crc6f_user_id eq '{user_id}'&$top=500"
        mem_rows = dataverse_get(MEMBERS_ENTITY_SET, q).get("value", [])

        convo_ids = list({m["crc6f_conversation_id"] for m in mem_rows})

        results = []

        for cid in convo_ids:
            # fetch conversation
            cq = f"$filter=crc6f_conversationid eq '{cid}'&$top=1"
            conv_resp = dataverse_get(CONV_ENTITY_SET, cq).get("value", [])
            if not conv_resp:
                continue
            conv = conv_resp[0]

            # fetch all members
            mq = f"$filter=crc6f_conversation_id eq '{cid}'&$top=200"
            members_resp = dataverse_get(MEMBERS_ENTITY_SET, mq).get("value", [])

            members = []
            for m in members_resp:
                uid = m["crc6f_user_id"]
                real_name = _get_employee_name_by_id(uid)
                members.append({
                    "id": uid,
                    "name": real_name
                })

            is_group = str(conv.get("crc6f_isgroup", "")).lower() in ("true", "1", "yes")
            name = conv.get("crc6f_empname") or "Conversation"
            # ---- FETCH LAST MESSAGE ----
            mq2 = f"$filter=crc6f_conversation_id eq '{cid}'&$orderby=createdon desc&$top=1"
            last_msg_resp = dataverse_get(MSG_ENTITY_SET, mq2).get("value", [])

            last_msg_text = ""
            last_msg_sender = ""
            last_msg_time = ""
            last_sender_name = ""

            if last_msg_resp:
                last = last_msg_resp[0]
                last_msg_text = last.get("crc6f_message_text") or last.get("crc6f_file_name") or ""
                last_msg_sender = last.get("crc6f_sender_id")
                last_msg_time = last.get("createdon")
                if last_msg_sender:
                    last_sender_name = _get_employee_name_by_id(last_msg_sender)

            # Best-effort: fetch description, icon_url, created_by, created_on
            description = conv.get("crc6f_description") or ""
            icon_url = conv.get("crc6f_icon_url") or ""
            created_by = conv.get("crc6f_created_by") or ""
            created_on = conv.get("createdon") or ""
            created_by_name = _get_employee_name_by_id(created_by) if created_by else ""

            results.append({
                "conversation_id": cid,
                "name": name,
                "display_name": name,
                "is_group": is_group,
                "avatar": (name[:1] or "").upper(),
                "members": members,
                "last_message": last_msg_text,
                "last_sender": last_msg_sender,
                "last_sender_name": last_sender_name,
                "last_message_time": last_msg_time,
                "description": description,
                "icon_url": icon_url,
                "created_by": created_by,
                "created_by_name": created_by_name,
                "created_on": created_on,
            })

        
        return jsonify(results)

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "convo_failed", "details": str(e)}), 500


# --------------------------------------------------------------
# DIRECT CHAT - reuse existing conversation if present or create
# --------------------------------------------------------------

@chat_bp.route("/direct", methods=["POST"])
def start_direct_chat():
    data = request.get_json() or {}
    u1 = data.get("user_id")
    u2 = data.get("target_id")

    if not u1 or not u2:
        return jsonify({"error": "user_id and target_id required"}), 400

    try:
        # find if both already share a conversation
        q = f"$filter=crc6f_user_id eq '{u1}' or crc6f_user_id eq '{u2}'"
        rows = dataverse_get(MEMBERS_ENTITY_SET, q).get("value", [])

        map_conv = {}
        for r in rows:
            cid = r["crc6f_conversation_id"]
            map_conv.setdefault(cid, set()).add(r["crc6f_user_id"])

        for cid, users in map_conv.items():
            if u1 in users and u2 in users:
                # check if direct chat
                cq = f"$filter=crc6f_conversationid eq '{cid}'&$top=1"
                conv = dataverse_get(CONV_ENTITY_SET, cq).get("value", [])
                if conv and str(conv[0].get("crc6f_isgroup")).lower() != "true":
                    return jsonify({"conversation_id": cid})

        # create new conversation
        conversation_id = str(uuid.uuid4())

        conv_payload = {
            "crc6f_conversationid": conversation_id,
            "crc6f_empname": f"{u1} → {u2}",
            "crc6f_isgroup": False,
        }
        _apply_conv_rpt(conv_payload)
        dataverse_create(CONV_ENTITY_SET, conv_payload)

        # create 2 members
        for uid in (u1, u2):
            mem = {
                "crc6f_conversation_id": conversation_id,
                "crc6f_member_id": str(uuid.uuid4()),
                "crc6f_user_id": uid,
                "crc6f_joined_on": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
            }
            _apply_member_rpt(mem)
            dataverse_create(MEMBERS_ENTITY_SET, mem)

        
        emit_socket_event("conversation_created", {
            "conversation_id": conversation_id,
            "members": [u1, u2],
            "is_group": False
        })


        return jsonify({"conversation_id": conversation_id})

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "direct_failed", "details": str(e)}), 500


# --------------------------------------------------------------
# GROUP CREATE
# --------------------------------------------------------------

@chat_bp.route("/group", methods=["POST"])
def create_group():
    data = request.get_json() or {}
    name = data.get("name", "Group")
    members = data.get("members", [])
    creator = data.get("creator_id")

    if not members:
         members = []
    # Ensure creator is always in the group AND inserted first.
    # This matters for fallback admin detection when schema doesn't support crc6f_is_admin.
    if creator:
         # Deduplicate and move creator to front
         members = [m for m in members if str(m) != str(creator)]
         members.insert(0, creator)

    cid = str(uuid.uuid4())

    try:
        conv_payload = {
            "crc6f_conversationid": cid,
            "crc6f_empname": name,
            "crc6f_isgroup": True,
        }
        # Best-effort: store creator_id for "created by" info
        if creator:
            conv_payload["crc6f_created_by"] = creator
        _apply_conv_rpt(conv_payload)
        try:
            dataverse_create(CONV_ENTITY_SET, conv_payload)
        except Exception:
            # Fallback without created_by if field doesn't exist
            fallback_conv = {
                "crc6f_conversationid": cid,
                "crc6f_empname": name,
                "crc6f_isgroup": True,
            }
            _apply_conv_rpt(fallback_conv)
            dataverse_create(CONV_ENTITY_SET, fallback_conv)

        for uid in members:
            member_payload = {
                "crc6f_conversation_id": cid,
                "crc6f_member_id": str(uuid.uuid4()),
                "crc6f_user_id": uid,
                "crc6f_joined_on": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
            }

            # Best-effort: persist admin + mute state if the Dataverse schema supports it.
            # If fields do not exist, fallback to creating without them.
            if creator and str(uid) == str(creator):
                member_payload["crc6f_is_admin"] = True
            else:
                member_payload["crc6f_is_admin"] = False
            member_payload["crc6f_is_muted"] = False

            try:
                dataverse_create(MEMBERS_ENTITY_SET, member_payload)
            except Exception:
                fallback = {
                    "crc6f_conversation_id": cid,
                    "crc6f_member_id": member_payload["crc6f_member_id"],
                    "crc6f_user_id": uid,
                    "crc6f_joined_on": member_payload["crc6f_joined_on"],
                }
                dataverse_create(MEMBERS_ENTITY_SET, fallback)

      
            
        emit_socket_event("conversation_created", {
            "conversation_id": cid,
            "members": members,
            "name": name,
            "is_group": True
        })


        return jsonify({"conversation_id": cid})

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "group_failed", "details": str(e)}), 500


def _get_member_row(conversation_id, user_id):
    q = f"$filter=crc6f_conversation_id eq '{conversation_id}' and crc6f_user_id eq '{user_id}'&$top=1"
    resp = dataverse_get(MEMBERS_ENTITY_SET, q)
    rows = resp.get("value", []) if resp else []
    return rows[0] if rows else None


def _is_group_admin(conversation_id, user_id):
    """Best-effort admin check.
    - If membership row has crc6f_is_admin, use it.
    - Otherwise, prefer conversation's crc6f_created_by.
    - Finally, fallback to treating the earliest joined member (stable) as admin.
    """
    try:
        me = _get_member_row(conversation_id, user_id)
        if me is None:
            return False

        if "crc6f_is_admin" in me and me.get("crc6f_is_admin") is not None:
            v = me.get("crc6f_is_admin")
            if isinstance(v, bool):
                return v
            return str(v).lower() in ("true", "1", "yes")

        # If the conversation has a creator field, use it.
        try:
            cq = f"$filter=crc6f_conversationid eq '{conversation_id}'&$top=1"
            conv_rows = dataverse_get(CONV_ENTITY_SET, cq).get("value", [])
            if conv_rows:
                created_by = conv_rows[0].get("crc6f_created_by")
                if created_by and str(created_by) == str(user_id):
                    return True
        except Exception:
            pass

        q = f"$filter=crc6f_conversation_id eq '{conversation_id}'&$top=500"
        resp = dataverse_get(MEMBERS_ENTITY_SET, q)
        rows = resp.get("value", []) if resp else []
        if not rows:
            return False

        def _joined_key(r):
            return r.get("crc6f_joined_on") or ""

        rows_sorted = sorted(rows, key=_joined_key)
        first_uid = rows_sorted[0].get("crc6f_user_id")
        return str(first_uid) == str(user_id)
    except Exception:
        traceback.print_exc()
        return False


# --------------------------------------------------------------
# GET MESSAGES (cached per conversation)
# --------------------------------------------------------------

@chat_bp.route("/messages/<string:conversation_id>", methods=["GET"])
def get_messages(conversation_id):
    try:
        

        q = f"$filter=crc6f_conversation_id eq '{conversation_id}'&$orderby=createdon asc&$top=1000"
        rows = dataverse_get(MSG_ENTITY_SET, q).get("value", [])
        emp_map = build_employee_name_map()

        out = [
            normalize_message(r, emp_map)
            for r in rows
        ]


        
        return jsonify(out)

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "messages_failed", "details": str(e)}), 500


# --------------------------------------------------------------
# SEND TEXT MESSAGE (and cache invalidation)
# --------------------------------------------------------------

@chat_bp.route("/send-text", methods=["POST"])
def send_text():
    data = request.get_json() or {}

    message_id = data.get("message_id") or str(uuid.uuid4())

    # ✅ Block non-members from sending (handles removed users)
    conv_id = data.get("conversation_id")
    sender_id = data.get("sender_id")
    try:
        mq = f"$filter=crc6f_conversation_id eq '{conv_id}' and crc6f_user_id eq '{sender_id}'&$top=1"
        mresp = dataverse_get(MEMBERS_ENTITY_SET, mq).get("value", []) if conv_id and sender_id else []
        if not mresp:
            return jsonify({"error": "forbidden", "details": "not_a_member"}), 403
    except Exception:
        return jsonify({"error": "membership_check_failed"}), 500

    payload = {
        "crc6f_message_id": message_id,
        "crc6f_conversation_id": data.get("conversation_id"),
        "crc6f_sender_id": data.get("sender_id"),
        "crc6f_message_type": data.get("message_type", "text"),
        "crc6f_message_text": data.get("message_text"),
    }

    # Support reply_to for threaded replies
    reply_to = data.get("reply_to")
    if reply_to:
        payload["crc6f_reply_to_message_id"] = reply_to

    try:
        dataverse_create(MSG_ENTITY_SET, payload)
        # Emit with status="delivered" since it's now saved and being broadcast
        msg_out = normalize_message(payload)
        msg_out["status"] = "delivered"
        emit_socket_event("new_message", msg_out)


        # Invalidate messages cache for this conversation and convo list of members
        conv_id = payload.get("crc6f_conversation_id")
        

            # invalidate conversation lists for all members of this conv (so last_message updates)
        try:
                mq = f"$filter=crc6f_conversation_id eq '{conv_id}'&$top=500"
                members_resp = dataverse_get(MEMBERS_ENTITY_SET, mq).get("value", [])
                for m in members_resp:
                    uid = m.get("crc6f_user_id")
                   
        except Exception:
                pass

        return jsonify(normalize_message(payload))

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "send_text_failed", "details": str(e)}), 500

# --------------------------------------------------------------
# SEND FILE MESSAGE (UPLOAD ANNOTATION + MESSAGE)
# --------------------------------------------------------------
@chat_bp.route("/send-files", methods=["POST"])
def send_files():
    try:
        conversation_id = request.form.get("conversation_id")
        sender_id = request.form.get("sender_id")
        files = request.files.getlist("files")

        if not conversation_id or not sender_id or not files:
            return jsonify({"error": "conversation_id, sender_id, files required"}), 400

        # ✅ Block non-members from sending (handles removed users)
        try:
            mq = f"$filter=crc6f_conversation_id eq '{conversation_id}' and crc6f_user_id eq '{sender_id}'&$top=1"
            mresp = dataverse_get(MEMBERS_ENTITY_SET, mq).get("value", [])
            if not mresp:
                return jsonify({"error": "forbidden", "details": "not_a_member"}), 403
        except Exception:
            return jsonify({"error": "membership_check_failed"}), 500

        attachments = []

        for f in files:
            raw = f.read()
            file_id = generate_file_id()

            # 1️⃣ Create Dataverse row (metadata only)
            meta = {
                "crc6f_file_id": str(file_id),
                "crc6f_conversationid": str(conversation_id),
                "crc6f_filename": f.filename,
                "crc6f_filesize": str(len(raw)),     # ✅ MUST BE STRING
                "crc6f_mimetype": f.mimetype or "application/octet-stream",
            }

            _apply_fileattach_rpt(meta)

            res = dataverse_create("crc6f_hr_fileattachments", meta)

            # Extract Dataverse row GUID
            ent = res.get("entity_reference")
            row_guid = ent.split("(")[1].replace(")", "")

            # 2️⃣ Upload binary to File column
            dataverse_upload_file(
                "crc6f_hr_fileattachments",
                row_guid,
                "crc6f_fileupload",
                raw
            )
            # 3️⃣ CREATE CHAT MESSAGE ROW (THIS IS THE FIX)
            message_id = f"msg_{uuid.uuid4()}"

            dataverse_create(MSG_ENTITY_SET, {
                "crc6f_message_id": message_id,
                "crc6f_conversation_id": conversation_id,
                "crc6f_sender_id": sender_id,
                "crc6f_message_type": (
                    "image" if f.mimetype.startswith("image/")
                    else "video" if f.mimetype.startswith("video/")
                    else "audio" if f.mimetype.startswith("audio/")
                    else "file"
                ),
                "crc6f_media_url": str(file_id),          # 🔥 LINK TO FILE
                "crc6f_file_name": f.filename,
                "crc6f_mime_type": f.mimetype,
            })
            # 🔔 4️⃣ REALTIME SOCKET EMIT (ADD EXACTLY HERE)
            emit_socket_event("new_message", {
                "message_id": message_id,
                "conversation_id": conversation_id,
                "sender_id": sender_id,
                "message_type": (
                    "image" if f.mimetype.startswith("image/")
                    else "video" if f.mimetype.startswith("video/")
                    else "audio" if f.mimetype.startswith("audio/")
                    else "file"
                ),
                "media_url": str(file_id),
                "file_name": f.filename,
                "mime_type": f.mimetype,
            })



            attachments.append({
                "file_id": file_id,
                "file_name": f.filename,
                "mime_type": f.mimetype,
                "file_size": len(raw)
            })

        return jsonify({
            "ok": True,
            "attachments": attachments
        })

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "send_files_failed", "details": str(e)}), 500

# --------------------------------------------------------------
# DOWNLOAD FILE FROM DATAVERSE (ANNOTATION)
# --------------------------------------------------------------
@chat_bp.route("/file-download/<string:file_id>", methods=["GET"])
def download_file(file_id):
    try:
        q = f"$filter=crc6f_file_id eq '{file_id}'&$top=1"
        rows = dataverse_get("crc6f_hr_fileattachments", q).get("value", [])

        if not rows:
            return Response("File not found", status=404)

        rec = rows[0]

        row_guid = rec["crc6f_hr_fileattachmentid"]
        filename = rec.get("crc6f_filename")
        mime = rec.get("crc6f_mimetype") or "application/octet-stream"

        # Fetch binary from File column
        url = f"{RESOURCE}/api/data/v9.2/crc6f_hr_fileattachments({row_guid})/crc6f_fileupload/$value"
        headers = {"Authorization": f"Bearer {_get_oauth_token()}"}

        r = get_dataverse_session().get(url, headers=headers, timeout=60)
        r.raise_for_status()

        resp = Response(r.content, mimetype=mime)
        resp.headers["Content-Disposition"] = f'attachment; filename="{filename}"'
        resp.headers["Content-Length"] = str(len(r.content))
        resp.headers["Cache-Control"] = "no-store"

        return resp

    except Exception:
        traceback.print_exc()
        return Response("Server error", status=500)


# ================================================================
# PART 2 — GROUP MEMBERS, MESSAGE EDIT/DELETE, EMPLOYEE SEARCH
# ================================================================

# --------------------------------------------------------------
# GET GROUP MEMBERS (cached)
# --------------------------------------------------------------
@chat_bp.route("/group/<string:conversation_id>/members", methods=["GET"])
def get_group_members(conversation_id):
    try:
        

        q = f"$filter=crc6f_conversation_id eq '{conversation_id}'&$top=500"
        resp = dataverse_get(MEMBERS_ENTITY_SET, q)
        rows = resp.get("value", []) if resp else []

        out = []
        for r in rows:
            uid = r.get("crc6f_user_id")
            name = _get_employee_name_by_id(uid)

            # Best-effort admin detection:
            # - Prefer stored member field crc6f_is_admin when present
            # - Otherwise fall back to server-side heuristic _is_group_admin
            if r.get("crc6f_is_admin") is not None:
                is_admin = bool(r.get("crc6f_is_admin"))
            else:
                is_admin = _is_group_admin(conversation_id, uid)

            out.append({
                "id": uid,
                "name": name,
                "joined_on": r.get("crc6f_joined_on"),
                "is_admin": is_admin,
                "is_muted": (
                    bool(r.get("crc6f_is_muted"))
                    if r.get("crc6f_is_muted") is not None
                    else False
                ),
            })

        
        return jsonify(out), 200

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "fetch_members_failed", "details": str(e)}), 500


# --------------------------------------------------------------
# GET GROUP ICON (data url stored in crc6f_icon_url)
# --------------------------------------------------------------
@chat_bp.route("/group/<string:conversation_id>/icon", methods=["GET"])
def get_group_icon(conversation_id):
    try:
        q = f"$filter=crc6f_conversationid eq '{conversation_id}'&$top=1"
        resp = dataverse_get(CONV_ENTITY_SET, q)
        rows = resp.get("value", []) if resp else []
        if not rows:
            return jsonify({"error": "conversation_not_found"}), 404

        conv = rows[0]
        icon_url = conv.get("crc6f_icon_url") or ""
        return jsonify({"conversation_id": conversation_id, "icon_url": icon_url}), 200
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "get_icon_failed", "details": str(e)}), 500


# --------------------------------------------------------------
# UPDATE GROUP ICON
# POST /chat/group/<conversation_id>/icon
# Accepts multipart form-data: file=<image>
# Stores a data URL in crc6f_icon_url (best-effort, no schema changes)
# --------------------------------------------------------------
@chat_bp.route("/group/<string:conversation_id>/icon", methods=["POST"])
def update_group_icon(conversation_id):
    try:
        actor_id = request.form.get("actor_id") or request.form.get("user_id")
        if not actor_id:
            return jsonify({"error": "actor_id_required"}), 400

        if not _is_group_admin(conversation_id, actor_id):
            return jsonify({"error": "forbidden", "details": "admin_required"}), 403

        f = request.files.get("file")
        if not f:
            return jsonify({"error": "file_required"}), 400

        raw = f.read()
        if not raw:
            return jsonify({"error": "empty_file"}), 400

        # Build data URL to avoid needing a new file column / schema change.
        mime = f.mimetype or "application/octet-stream"
        b64 = base64.b64encode(raw).decode("utf-8")
        data_url = f"data:{mime};base64,{b64}"

        # Fetch conversation row
        q = f"$filter=crc6f_conversationid eq '{conversation_id}'&$top=1"
        resp = dataverse_get(CONV_ENTITY_SET, q)
        rows = resp.get("value", []) if resp else []
        if not rows:
            return jsonify({"error": "conversation_not_found"}), 404

        conv = rows[0]
        guid = conv.get("crc6f_hr_chat_conversationid") or conv.get("crc6f_hr_chat_conversationsid") or extract_guid(conv)
        if not guid:
            return jsonify({"error": "cannot_determine_guid"}), 500
        guid = str(guid).strip().replace("(", "").replace(")", "")

        try:
            dataverse_update(CONV_ENTITY_SET, guid, {"crc6f_icon_url": data_url})
        except Exception:
            return jsonify({"error": "icon_field_missing"}), 501

        emit_socket_event("group_updated", {"conversation_id": conversation_id})
        return jsonify({"ok": True, "icon_url": data_url}), 200

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "update_icon_failed", "details": str(e)}), 500


# --------------------------------------------------------------
# ADD MEMBERS (CREATE NEW ROWS) - POST
# Body: { "members": ["EMP001", "EMP002"] }
# --------------------------------------------------------------
@chat_bp.route("/group/<string:conversation_id>/members/add", methods=["POST"])
def add_group_members(conversation_id):
    try:
        payload = request.get_json() or {}
        members = payload.get("members") or []
        sender_id = payload.get("sender_id")   # ✅ USE ONLY sender_id

        if not members:
            return jsonify({"error": "members_required"}), 400

        if not sender_id:
            return jsonify({"error": "sender_id_required"}), 400

        if not _is_group_admin(conversation_id, sender_id):
            return jsonify({"error": "forbidden", "details": "admin_required"}), 403

        # fetch existing members
        q = f"$filter=crc6f_conversation_id eq '{conversation_id}'&$top=1000"
        resp = dataverse_get(MEMBERS_ENTITY_SET, q)
        existing_rows = resp.get("value", []) if resp else []
        existing_ids = {str(r.get("crc6f_user_id")) for r in existing_rows}

        inserted = []
        for uid in members:
            if str(uid) in existing_ids:
                continue

            new_member = {
                "crc6f_conversation_id": conversation_id,
                "crc6f_member_id": str(uuid.uuid4()),
                "crc6f_user_id": uid,
                "crc6f_joined_on": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            }
            # best-effort role fields
            new_member["crc6f_is_admin"] = False
            new_member["crc6f_is_muted"] = False
            try:
                dataverse_create(MEMBERS_ENTITY_SET, new_member)
            except Exception:
                fallback = {
                    "crc6f_conversation_id": new_member["crc6f_conversation_id"],
                    "crc6f_member_id": new_member["crc6f_member_id"],
                    "crc6f_user_id": new_member["crc6f_user_id"],
                    "crc6f_joined_on": new_member["crc6f_joined_on"],
                }
                dataverse_create(MEMBERS_ENTITY_SET, fallback)
            inserted.append(uid)

           

        
        for r in existing_rows:
            uid = r.get("crc6f_user_id")
            

        # ✅ ✅ ✅ SYSTEM MESSAGE (STORED + REALTIME)
        if sender_id and inserted:
            admin_name = _get_employee_name_by_id(sender_id)
            new_names = [_get_employee_name_by_id(mid) for mid in inserted]
            text = f"{admin_name} added " + ", ".join(new_names)

            sys_payload = {
                "message_id": f"sys_{uuid.uuid4()}",
                "conversation_id": conversation_id,
                "sender_id": "system",
                "message_type": "text",
                "message_text": text,
            }

            dataverse_create(MSG_ENTITY_SET, {
                "crc6f_message_id": sys_payload["message_id"],
                "crc6f_conversation_id": conversation_id,
                "crc6f_sender_id": "system",
                "crc6f_message_type": "text",
                "crc6f_message_text": text,
            })

            emit_socket_event("new_message", sys_payload)

        
        # ✅ REAL-TIME GROUP UPDATE SOCKET
        emit_socket_event("group_add_members", {
            "conversation_id": conversation_id,
            "members": inserted,
            "sender_id": payload.get("sender_id")
        })



        return jsonify({"ok": True, "inserted": inserted}), 200

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "add_members_failed", "details": str(e)}), 500

# --------------------------------------------------------------
# INTERNAL HELPER — delete Dataverse member row by GUID
# --------------------------------------------------------------
def _delete_member_record(rec):
    try:
        guid = rec.get("crc6f_hr_conversation_membersid") or extract_guid(rec)
        if not guid:
            return False

        guid = guid.strip()
        if guid.startswith("(") and guid.endswith(")"):
            guid = guid[1:-1]

        dataverse_delete(MEMBERS_ENTITY_SET, guid)
        return True

    except Exception:
        traceback.print_exc()
        return False


# --------------------------------------------------------------
# REMOVE SINGLE MEMBER
# DELETE /chat/group/<conversation_id>/members/<user_id>
# --------------------------------------------------------------
@chat_bp.route("/group/<string:conversation_id>/members/<string:user_id>", methods=["DELETE"])
def remove_group_member_single(conversation_id, user_id):
    try:
        q = f"$filter=crc6f_conversation_id eq '{conversation_id}' and crc6f_user_id eq '{user_id}'&$top=50"
        resp = dataverse_get(MEMBERS_ENTITY_SET, q)
        rows = resp.get("value", []) if resp else []

        deleted = []
        for r in rows:
            if _delete_member_record(r):
                deleted.append(user_id)

        
        # also invalidate convo_list for remaining members so UI refreshes correctly
        try:
            mq = f"$filter=crc6f_conversation_id eq '{conversation_id}'&$top=500"
            members_resp = dataverse_get(MEMBERS_ENTITY_SET, mq).get("value", [])
            for m in members_resp:
                uid = m.get("crc6f_user_id")
                
        except Exception:
            pass
        emit_socket_event("group_members_removed", {
            "conversation_id": conversation_id,
            "removed": deleted
        })


        return jsonify({"ok": True, "deleted": deleted}), 200

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "remove_member_failed", "details": str(e)}), 500


# --------------------------------------------------------------
# REMOVE MULTIPLE MEMBERS (DELETE or POST)
# Body: { "members": ["EMP007","EMP009"] }
# --------------------------------------------------------------
@chat_bp.route("/group/<string:conversation_id>/members/remove", methods=["POST", "DELETE"])
def remove_group_members(conversation_id):
    try:
        payload = request.get_json() or {}
        members = payload.get("members") or []
        sender_id = payload.get("sender_id")   # ✅ USE ONLY sender_id

        if not members:
            return jsonify({"error": "members_required"}), 400

        if not sender_id:
            return jsonify({"error": "sender_id_required"}), 400

        if not _is_group_admin(conversation_id, sender_id):
            return jsonify({"error": "forbidden", "details": "admin_required"}), 403

        or_filters = " or ".join([f"crc6f_user_id eq '{m}'" for m in members])
        q = f"$filter=crc6f_conversation_id eq '{conversation_id}' and ({or_filters})&$top=500"

        resp = dataverse_get(MEMBERS_ENTITY_SET, q)
        rows = resp.get("value", []) if resp else []

        deleted = []
        for r in rows:
            uid = r.get("crc6f_user_id")
            if _delete_member_record(r):
                deleted.append(uid)

     

        try:
            mq = f"$filter=crc6f_conversation_id eq '{conversation_id}'&$top=500"
            members_resp = dataverse_get(MEMBERS_ENTITY_SET, mq).get("value", [])
            for m in members_resp:
                uid = m.get("crc6f_user_id")
                
        except Exception:
            pass

        # ✅ ✅ ✅ SYSTEM MESSAGE (STORED + REALTIME)
        if sender_id and deleted:
            admin_name = _get_employee_name_by_id(sender_id)
            removed_names = [_get_employee_name_by_id(mid) for mid in deleted]
            text = f"{admin_name} removed " + ", ".join(removed_names)

            sys_payload = {
                "message_id": f"sys_{uuid.uuid4()}",
                "conversation_id": conversation_id,
                "sender_id": "system",
                "message_type": "text",
                "message_text": text,
            }

            dataverse_create(MSG_ENTITY_SET, {
                "crc6f_message_id": sys_payload["message_id"],
                "crc6f_conversation_id": conversation_id,
                "crc6f_sender_id": "system",
                "crc6f_message_type": "text",
                "crc6f_message_text": text,
            })

            emit_socket_event("new_message", sys_payload)

        emit_socket_event("group_remove_members", {
            "conversation_id": conversation_id,
            "members": deleted,
            "sender_id": payload.get("sender_id")
        })


        return jsonify({"ok": True, "deleted": deleted}), 200

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "remove_members_failed", "details": str(e)}), 500


@chat_bp.route("/group/<string:conversation_id>/leave", methods=["POST"])
def leave_group(conversation_id):
    """Leave group for the given user_id in request body."""
    try:
        payload = request.get_json() or {}
        user_id = payload.get("user_id")
        if not user_id:
            return jsonify({"error": "user_id_required"}), 400

        # Reuse single-member removal logic
        q = f"$filter=crc6f_conversation_id eq '{conversation_id}' and crc6f_user_id eq '{user_id}'&$top=50"
        resp = dataverse_get(MEMBERS_ENTITY_SET, q)
        rows = resp.get("value", []) if resp else []

        deleted = []
        for r in rows:
            if _delete_member_record(r):
                deleted.append(user_id)

        if deleted:
            user_name = _get_employee_name_by_id(user_id)
            text = f"{user_name} left"
            sys_payload = {
                "message_id": f"sys_{uuid.uuid4()}",
                "conversation_id": conversation_id,
                "sender_id": "system",
                "message_type": "text",
                "message_text": text,
            }
            try:
                dataverse_create(MSG_ENTITY_SET, {
                    "crc6f_message_id": sys_payload["message_id"],
                    "crc6f_conversation_id": conversation_id,
                    "crc6f_sender_id": "system",
                    "crc6f_message_type": "text",
                    "crc6f_message_text": text,
                })
            except Exception:
                pass
            emit_socket_event("new_message", sys_payload)

        emit_socket_event("user_left_conversation", {
            "conversation_id": conversation_id,
            "user_id": user_id,
        })

        return jsonify({"ok": True, "deleted": deleted}), 200
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "leave_failed", "details": str(e)}), 500


@chat_bp.route("/group/<string:conversation_id>/mute", methods=["PATCH"])
def mute_group(conversation_id):
    """Mute/unmute group for a given user_id (best-effort persisted in member row)."""
    try:
        payload = request.get_json() or {}
        user_id = payload.get("user_id")
        mute = payload.get("mute")
        if user_id is None or mute is None:
            return jsonify({"error": "user_id_and_mute_required"}), 400

        q = f"$filter=crc6f_conversation_id eq '{conversation_id}' and crc6f_user_id eq '{user_id}'&$top=1"
        resp = dataverse_get(MEMBERS_ENTITY_SET, q)
        rows = resp.get("value", []) if resp else []
        if not rows:
            return jsonify({"error": "membership_not_found"}), 404

        rec = rows[0]
        guid = rec.get("crc6f_hr_conversation_membersid") or extract_guid(rec)
        if not guid:
            return jsonify({"error": "cannot_determine_guid"}), 500
        guid = guid.strip().replace("(", "").replace(")", "")

        # Best-effort update; if field doesn't exist, return ok without persisting.
        try:
            dataverse_update(MEMBERS_ENTITY_SET, guid, {"crc6f_is_muted": bool(mute)})
        except Exception:
            pass

        emit_socket_event("group_updated", {"conversation_id": conversation_id})
        return jsonify({"ok": True, "is_muted": bool(mute)}), 200
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "mute_failed", "details": str(e)}), 500


@chat_bp.route("/group/<string:conversation_id>/make-admin", methods=["POST"])
def make_admin(conversation_id):
    """Promote a member to admin. Body: { actor_id, user_id, is_admin }"""
    try:
        payload = request.get_json() or {}
        actor_id = payload.get("actor_id")
        user_id = payload.get("user_id")
        is_admin = payload.get("is_admin", True)

        if not actor_id or not user_id:
            return jsonify({"error": "actor_id_and_user_id_required"}), 400

        if not _is_group_admin(conversation_id, actor_id):
            return jsonify({"error": "forbidden", "details": "admin_required"}), 403

        rec = _get_member_row(conversation_id, user_id)
        if rec is None:
            return jsonify({"error": "membership_not_found"}), 404

        guid = rec.get("crc6f_hr_conversation_membersid") or extract_guid(rec)
        if not guid:
            return jsonify({"error": "cannot_determine_guid"}), 500
        guid = guid.strip().replace("(", "").replace(")", "")

        try:
            dataverse_update(MEMBERS_ENTITY_SET, guid, {"crc6f_is_admin": bool(is_admin)})
        except Exception:
            # If schema doesn't support, fail explicitly (admin can't be managed reliably)
            return jsonify({"error": "admin_field_missing"}), 501

        actor_name = _get_employee_name_by_id(actor_id)
        target_name = _get_employee_name_by_id(user_id)
        text = f"{actor_name} made {target_name} an admin"
        sys_payload = {
            "message_id": f"sys_{uuid.uuid4()}",
            "conversation_id": conversation_id,
            "sender_id": "system",
            "message_type": "text",
            "message_text": text,
        }
        try:
            dataverse_create(MSG_ENTITY_SET, {
                "crc6f_message_id": sys_payload["message_id"],
                "crc6f_conversation_id": conversation_id,
                "crc6f_sender_id": "system",
                "crc6f_message_type": "text",
                "crc6f_message_text": text,
            })
        except Exception:
            pass
        emit_socket_event("new_message", sys_payload)

        emit_socket_event("group_updated", {"conversation_id": conversation_id})
        return jsonify({"ok": True, "user_id": user_id, "is_admin": bool(is_admin)}), 200
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "make_admin_failed", "details": str(e)}), 500


# --------------------------------------------------------------
# UPDATE GROUP DESCRIPTION
# PATCH /chat/group/<conversation_id>/description
# Body: { "description": "New description", "sender_id": "..." }
# --------------------------------------------------------------
@chat_bp.route("/group/<string:conversation_id>/description", methods=["PATCH"])
def update_group_description(conversation_id):
    try:
        payload = request.get_json() or {}
        description = payload.get("description", "")
        sender_id = payload.get("sender_id")

        if not sender_id:
            return jsonify({"error": "sender_id_required"}), 400

        if not _is_group_admin(conversation_id, sender_id):
            return jsonify({"error": "forbidden", "details": "admin_required"}), 403

        # Fetch conversation row
        q = f"$filter=crc6f_conversationid eq '{conversation_id}'&$top=1"
        resp = dataverse_get(CONV_ENTITY_SET, q)
        rows = resp.get("value", []) if resp else []
        if not rows:
            return jsonify({"error": "conversation_not_found"}), 404

        rec = rows[0]
        guid = rec.get("crc6f_hr_chat_conversationid") or extract_guid(rec)
        if not guid:
            return jsonify({"error": "cannot_determine_guid"}), 500
        guid = guid.strip().replace("(", "").replace(")", "")

        try:
            dataverse_update(CONV_ENTITY_SET, guid, {"crc6f_description": description})
        except Exception:
            return jsonify({"error": "description_field_missing"}), 501

        emit_socket_event("group_updated", {"conversation_id": conversation_id})
        return jsonify({"ok": True, "description": description}), 200
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "update_description_failed", "details": str(e)}), 500


# --------------------------------------------------------------
# PATCH — EDIT MESSAGE
# Body: { "new_text": "Hello updated" }
# --------------------------------------------------------------
@chat_bp.route("/messages/<string:message_id>", methods=["PATCH"])
def edit_message(message_id):
    try:
        body = request.get_json() or {}
        new_text = body.get("new_text")
        if new_text is None:
            return jsonify({"error": "new_text required"}), 400

        q = f"$filter=crc6f_message_id eq '{message_id}'&$top=1"
        resp = dataverse_get(MSG_ENTITY_SET, q)
        rows = resp.get("value", []) if resp else []

        if not rows:
            return jsonify({"error": "message_not_found"}), 404

        rec = rows[0]
        guid = rec.get("crc6f_hr_messagesid") or extract_guid(rec)
        if not guid:
            return jsonify({"error": "cannot_determine_record_id"}), 500

        guid = guid.strip()
        if guid.startswith("(") and guid.endswith(")"):
            guid = guid[1:-1]

        dataverse_update(MSG_ENTITY_SET, guid, {
            "crc6f_message_text": new_text
        })

        # Invalidate caches for this conversation
        conv_id = rec.get("crc6f_conversation_id")
        
        try:
                mq = f"$filter=crc6f_conversation_id eq '{conv_id}'&$top=500"
                members_resp = dataverse_get(MEMBERS_ENTITY_SET, mq).get("value", [])
                for m in members_resp:
                    uid = m.get("crc6f_user_id")
                    
        except Exception:
                pass
        emit_socket_event("message_edited", {
            "message_id": message_id,
            "new_text": new_text
        })


        return jsonify({"ok": True, "message_id": message_id})

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "edit_failed", "details": str(e)}), 500


# --------------------------------------------------------------
# DELETE MESSAGE (SOFT DELETE) — Replace text with "[deleted]"
# --------------------------------------------------------------
@chat_bp.route("/messages/<string:message_id>", methods=["DELETE"])
def delete_message(message_id):
    try:
        q = f"$filter=crc6f_message_id eq '{message_id}'&$top=1"
        resp = dataverse_get(MSG_ENTITY_SET, q)
        rows = resp.get("value", []) if resp else []

        if not rows:
            return jsonify({"error": "message_not_found"}), 404

        rec = rows[0]
        guid = rec.get("crc6f_hr_messagesid") or extract_guid(rec)
        if not guid:
            return jsonify({"error": "cannot_determine_record_id"}), 500

        guid = guid.strip()
        if guid.startswith("(") and guid.endswith(")"):
            guid = guid[1:-1]

        dataverse_update(MSG_ENTITY_SET, guid, {
            "crc6f_message_text": "[deleted]",
            "crc6f_media_url": None,
            "crc6f_file_name": None,
            "crc6f_mime_type": None,
            "crc6f_message_type": "text"
        })

        # Invalidate caches for this conversation
        conv_id = rec.get("crc6f_conversation_id")
        
        try:
                mq = f"$filter=crc6f_conversation_id eq '{conv_id}'&$top=500"
                members_resp = dataverse_get(MEMBERS_ENTITY_SET, mq).get("value", [])
                for m in members_resp:
                    uid = m.get("crc6f_user_id")
                    
        except Exception:
                pass
        emit_socket_event("message_deleted", {
            "message_id": message_id,
            "conversation_id": conv_id
        })

        return jsonify({"ok": True, "message_id": message_id})

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "delete_failed", "details": str(e)}), 500


# --------------------------------------------------------------
# EMPLOYEE SEARCH
# --------------------------------------------------------------
@chat_bp.route("/employees/search", methods=["GET"])
def employee_search():
    try:
        q = (request.args.get("q") or "").strip()
        if not q:
            return jsonify([])

        safe = q.replace("'", "''")
        query = (
            f"$filter=contains(crc6f_firstname,'{safe}') or "
            f"contains(crc6f_lastname,'{safe}') or "
            f"contains(crc6f_email,'{safe}')&$top=30"
        )

        resp = dataverse_get(EMPLOYEE_ENTITY_SET, query)
        rows = resp.get("value", []) if resp else []

        out = []
        for r in rows:
            fn = r.get("crc6f_firstname") or ""
            ln = r.get("crc6f_lastname") or ""
            full = (fn + " " + ln).strip()

            emp_id = r.get("crc6f_employeeid") or r.get("crc6f_table12id")
            avatar = (fn[:1] or "U").upper()
            photo = r.get("crc6f_profilepicture") or None

            out.append({
                "id": emp_id,
                "name": full or emp_id,
                "email": r.get("crc6f_email"),
                "avatar": avatar,
                "photo": photo
            })

        return jsonify(out)

    except Exception as e:
        traceback.print_exc()
        return jsonify([]), 500


# --------------------------------------------------------------
# EMPLOYEE LIST (ALL)
# --------------------------------------------------------------
@chat_bp.route("/employees/all", methods=["GET"])
def employee_all():
    try:
        resp = dataverse_get(EMPLOYEE_ENTITY_SET, "$top=200&$select=crc6f_firstname,crc6f_lastname,crc6f_email,crc6f_employeeid,crc6f_table12id,crc6f_profilepicture")
        rows = resp.get("value", []) if resp else []

        out = []
        for r in rows:
            fn = r.get("crc6f_firstname") or ""
            ln = r.get("crc6f_lastname") or ""
            full = (fn + " " + ln).strip()

            emp_id = r.get("crc6f_employeeid") or r.get("crc6f_table12id")
            avatar = (fn[:1] or "U").upper()
            photo = r.get("crc6f_profilepicture") or None

            out.append({
                "id": emp_id,
                "name": full or emp_id,
                "email": r.get("crc6f_email"),
                "avatar": avatar,
                "photo": photo
            })

        return jsonify(out)

    except Exception as e:
        traceback.print_exc()
        return jsonify([]), 500
# --------------------------------------------------------------
# RENAME GROUP
# PATCH /chat/group/<conversation_id>/rename
# Body: { "name": "New Name" }
# --------------------------------------------------------------
@chat_bp.route("/group/<string:conversation_id>/rename", methods=["PATCH"])
def rename_group(conversation_id):
    try:
        body = request.get_json() or {}
        new_name = body.get("name", "").strip()

        if not new_name:
            return jsonify({"error": "name_required"}), 400

        # Fetch conversation row
        q = f"$filter=crc6f_conversationid eq '{conversation_id}'&$top=1"
        resp = dataverse_get(CONV_ENTITY_SET, q).get("value", [])
        if not resp:
            return jsonify({"error": "conversation_not_found"}), 404

        conv = resp[0]
        guid = conv.get("crc6f_hr_chat_conversationid") or extract_guid(conv)
        if not guid:
            return jsonify({"error": "cannot_determine_guid"}), 500

        guid = guid.strip().replace("(", "").replace(")", "")

        dataverse_update(CONV_ENTITY_SET, guid, {
            "crc6f_empname": new_name
        })

        # Invalidate all members' conversation list cache
        try:
            mq = f"$filter=crc6f_conversation_id eq '{conversation_id}'&$top=500"
            mems = dataverse_get(MEMBERS_ENTITY_SET, mq).get("value", [])
            for m in mems:
                uid = m.get("crc6f_user_id")
                
        except:
            pass
        emit_socket_event("group_renamed", {
            "conversation_id": conversation_id,
            "name": new_name
        })


        return jsonify({"ok": True, "name": new_name})

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "rename_failed", "details": str(e)}), 500

# --------------------------------------------------------------
# DELETE GROUP
# DELETE /chat/group/<conversation_id>
# --------------------------------------------------------------
@chat_bp.route("/group/<string:conversation_id>", methods=["DELETE"])
def delete_group(conversation_id):
    try:
        # 1. Fetch all member rows
        q = f"$filter=crc6f_conversation_id eq '{conversation_id}'&$top=500"
        resp = dataverse_get(MEMBERS_ENTITY_SET, q)
        existing_rows = resp.get("value", []) if resp else []

        # 2. Delete all member rows using correct GUID extraction
        for rec in existing_rows:
            _delete_member_record(rec)

        # 3. Delete conversation itself
        cq = f"$filter=crc6f_conversationid eq '{conversation_id}'&$top=1"
        conv_resp = dataverse_get(CONV_ENTITY_SET, cq).get("value", [])
        if conv_resp:
            conv_guid = conv_resp[0].get("crc6f_hr_chat_conversationsid") or extract_guid(conv_resp[0])
            if conv_guid:
                conv_guid = conv_guid.replace("(", "").replace(")", "")
                dataverse_delete(CONV_ENTITY_SET, conv_guid)

        # 4. Clear caches for all involved users
        for rec in existing_rows:
            uid = rec.get("crc6f_user_id")
           
        emit_socket_event("group_deleted", {
            "conversation_id": conversation_id
        })

        return jsonify({"ok": True})

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "group_delete_failed", "details": str(e)}), 500


# --------------------------------------------------------------
# LEAVE DIRECT CHAT (Remove only from the user)
# DELETE /chat/direct/<conversation_id>/<user_id>
# --------------------------------------------------------------
@chat_bp.route("/direct/<string:conversation_id>/<string:user_id>", methods=["DELETE"])
def leave_direct_chat(conversation_id, user_id):
    try:
        # 1. Fetch membership rows for this user in this conversation
        q = (
            f"$filter=crc6f_conversation_id eq '{conversation_id}' "
            f"and crc6f_user_id eq '{user_id}'&$top=10"
        )
        resp = dataverse_get(MEMBERS_ENTITY_SET, q)
        rows = resp.get("value", []) if resp else []

        if not rows:
            return jsonify({"ok": True, "note": "no member rows found"})

        # 2. Delete each member row using correct GUID
        for rec in rows:
            _delete_member_record(rec)

       
        emit_socket_event("direct_left", {
            "conversation_id": conversation_id,
            "user_id": user_id
        })

        return jsonify({"ok": True})

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "leave_direct_failed", "details": str(e)}), 500

@chat_bp.route("/mark-read", methods=["POST"])
def mark_read():
    try:
        payload = request.get_json() or {}
        conversation_id = payload.get("conversation_id")
        user_id = payload.get("user_id")
        message_ids = payload.get("message_ids", [])

        if not conversation_id or not user_id:
            return jsonify({"error": "conversation_id and user_id required"}), 400

        # Emit read receipt with message_ids so sender can update ticks to blue
        emit_socket_event("messages_read", {
            "conversation_id": conversation_id,
            "user_id": user_id,
            "message_ids": message_ids
        })

        return jsonify({"ok": True})

    except Exception as e:
        return jsonify({"error": "mark_read_failed", "details": str(e)}), 500


# --------------------------------------------------------------
# TYPING INDICATORS (relay via socket)
# POST /chat/typing
# Body: { conversation_id, user_id, is_typing }
# --------------------------------------------------------------
@chat_bp.route("/typing", methods=["POST"])
def typing_indicator():
    try:
        payload = request.get_json() or {}
        conversation_id = payload.get("conversation_id")
        user_id = payload.get("user_id")
        is_typing = payload.get("is_typing", True)

        if not conversation_id or not user_id:
            return jsonify({"error": "conversation_id and user_id required"}), 400

        event_name = "typing" if is_typing else "stop_typing"
        emit_socket_event(event_name, {
            "conversation_id": conversation_id,
            "sender_id": user_id
        })

        return jsonify({"ok": True})

    except Exception as e:
        return jsonify({"error": "typing_failed", "details": str(e)}), 500

# --------------------------------------------------------------
# OPTIONS HANDLER
# --------------------------------------------------------------
@chat_bp.before_request
def handle_options():
    if request.method == "OPTIONS":
        return jsonify({"ok": True}), 200
