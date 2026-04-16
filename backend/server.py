# server.py
from flask import Flask, request, jsonify
from flask_cors import CORS
from supabase_helper import create_record, update_record, get_access_token, query_records, upsert_record, get_supabase
from datetime import datetime, timezone
import os
from dotenv import load_dotenv

try:
    from zoneinfo import ZoneInfo
except Exception:
    ZoneInfo = None

app = Flask(__name__)
CORS(app)  # Enable CORS for React frontend

load_dotenv("id.env")

# Field names (same as Dataverse schema, now in Supabase)
ENTITY_NAME = "crc6f_table13s"
FIELD_EMPLOYEE_ID = "crc6f_employeeid"
FIELD_DATE = "crc6f_date"
FIELD_CHECKIN = "crc6f_checkin"
FIELD_CHECKOUT = "crc6f_checkout"
FIELD_DURATION = "crc6f_duration"
FIELD_ATTENDANCE_ID = "crc6f_table13id"

# Store active check-in sessions (in production, use Redis or database)
active_sessions = {}

LOGIN_ACTIVITY_ENTITY = "crc6f_hr_loginactivitytbs"
LOGIN_ACTIVITY_PRIMARY_FIELD = "crc6f_hr_loginactivitytbid"
LA_FIELD_EMPLOYEE_ID = "crc6f_employeeid"
LA_FIELD_DATE = "crc6f_date"
LA_FIELD_CHECKIN_LOCATION = "crc6f_checkinlocation"
LA_FIELD_CHECKIN_TIME = "crc6f_checkintime"
LA_FIELD_CHECKOUT_LOCATION = "crc6f_checkoutlocation"
LA_FIELD_CHECKOUT_TIME = "crc6f_checkouttime"


def _safe_odata_string(val: str) -> str:
    return (val or "").replace("'", "''")


def _event_local_date(client_time: str, timezone_str: str) -> str:
    ts = (client_time or "").strip()
    if not ts:
        return datetime.now().date().isoformat()
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        if timezone_str and ZoneInfo:
            try:
                dt = dt.astimezone(ZoneInfo(timezone_str))
            except Exception:
                pass
        return dt.date().isoformat()
    except Exception:
        return datetime.now().date().isoformat()


def _location_to_string(location) -> str | None:
    if not location:
        return None
    if isinstance(location, str):
        v = location.strip()
        return v or None
    if isinstance(location, dict):
        lat = location.get("lat")
        lng = location.get("lng")
        if lat is not None and lng is not None:
            try:
                return f"{float(lat):.6f},{float(lng):.6f}"
            except Exception:
                return f"{lat},{lng}"
    return None


def _fetch_login_activity_record(employee_id: str, date_str: str):
    emp = (employee_id or "").strip().upper()
    dt = (date_str or "").strip()
    if not emp or not dt:
        return None
    try:
        sb = get_supabase()
        response = (sb.table(LOGIN_ACTIVITY_ENTITY)
                    .select(LOGIN_ACTIVITY_PRIMARY_FIELD)
                    .eq(LA_FIELD_EMPLOYEE_ID, emp)
                    .eq(LA_FIELD_DATE, dt)
                    .limit(1)
                    .execute())
        if response.data and len(response.data) > 0:
            return response.data[0]
        return None
    except Exception:
        return None


def _upsert_login_activity(employee_id: str, date_str: str, payload: dict):
    emp = (employee_id or "").strip().upper()
    dt = (date_str or "").strip()
    if not emp or not dt:
        return None

    existing = _fetch_login_activity_record(emp, dt)

    if existing and existing.get(LOGIN_ACTIVITY_PRIMARY_FIELD):
        rid = str(existing.get(LOGIN_ACTIVITY_PRIMARY_FIELD)).strip("{}")
        update_record(LOGIN_ACTIVITY_ENTITY, rid, payload)
        return rid

    # Create new record
    create_payload = {
        LA_FIELD_EMPLOYEE_ID: emp,
        LA_FIELD_DATE: dt,
        **(payload or {}),
    }
    created = create_record(LOGIN_ACTIVITY_ENTITY, create_payload)
    rid = created.get(LOGIN_ACTIVITY_PRIMARY_FIELD) or created.get("id")
    return str(rid).strip("{}") if rid else None


@app.route('/api/checkin', methods=['POST'])
def checkin():
    try:
        data = request.json
        employee_id = data.get('employee_id')
        client_time = data.get('client_time')
        timezone_str = data.get('timezone')
        location_data = data.get('location')
        
        if not employee_id:
            return jsonify({"success": False, "error": "Employee ID is required"}), 400
        
        # Check if already checked in
        if employee_id in active_sessions:
            return jsonify({
                "success": False, 
                "error": "Already checked in. Please check out first."
            }), 400
        
        now = datetime.now(timezone.utc)
        formatted_date = now.date().isoformat()
        formatted_time = now.strftime("%H:%M:%S")
        formatted_timestamp = now.isoformat()

        # Punch login activity using client-local date as key
        la_date = _event_local_date(client_time, timezone_str)
        la_location = _location_to_string(location_data)
        try:
            _upsert_login_activity(employee_id, la_date, {
                LA_FIELD_CHECKIN_TIME: client_time or now.replace(microsecond=0).isoformat() + "Z",
                LA_FIELD_CHECKIN_LOCATION: la_location,
            })
        except Exception as e:
            print(f"[WARN] Login activity check-in punch failed: {e}")
        
        # Create attendance record
        record_data = {
            FIELD_EMPLOYEE_ID: employee_id,
            FIELD_DATE: formatted_date,
            FIELD_CHECKIN: formatted_timestamp
        }
        
        print(f"\n{'='*60}")
        print(f"CHECK-IN REQUEST")
        print(f"{'='*60}")
        print(f"Employee: {employee_id}")
        print(f"Date: {formatted_date}")
        print(f"Time: {formatted_time}")
        print(f"Sending to Supabase...")
        
        created = create_record(ENTITY_NAME, record_data)
        
        # Extract record ID
        record_id = (created.get(FIELD_ATTENDANCE_ID) or 
                     created.get("id"))
        
        if record_id:
            # Save session
            active_sessions[employee_id] = {
                "record_id": record_id,
                "checkin_time": formatted_time,
                "checkin_datetime": now.isoformat()
            }
            
            print(f"✅ SUCCESS! Record ID: {record_id}")
            print(f"{'='*60}\n")
            
            return jsonify({
                "success": True,
                "record_id": record_id,
                "checkin_time": formatted_time
            })
        else:
            print(f"❌ FAILED: No record ID returned")
            print(f"{'='*60}\n")
            return jsonify({
                "success": False,
                "error": "Failed to create record"
            }), 500
            
    except Exception as e:
        print(f"\n❌ CHECK-IN ERROR: {str(e)}\n")
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


@app.route('/api/checkout', methods=['POST'])
def checkout():
    try:
        data = request.json
        employee_id = data.get('employee_id')
        client_time = data.get('client_time')
        timezone_str = data.get('timezone')
        location_data = data.get('location')
        
        if not employee_id:
            return jsonify({"success": False, "error": "Employee ID is required"}), 400
        
        session = active_sessions.get(employee_id)
        
        if not session:
            return jsonify({
                "success": False,
                "error": "No active check-in found. Please check in first."
            }), 400
        
        now = datetime.now(timezone.utc)
        checkout_time_str = now.strftime("%H:%M:%S")
        checkout_timestamp = now.isoformat()

        # Punch login activity using client-local date as key
        la_date = _event_local_date(client_time, timezone_str)
        la_location = _location_to_string(location_data)
        try:
            _upsert_login_activity(employee_id, la_date, {
                LA_FIELD_CHECKOUT_TIME: client_time or now.replace(microsecond=0).isoformat() + "Z",
                LA_FIELD_CHECKOUT_LOCATION: la_location,
            })
        except Exception as e:
            print(f"[WARN] Login activity check-out punch failed: {e}")
        
        # Calculate duration
        checkin_dt = datetime.fromisoformat(session["checkin_datetime"])
        total_seconds = int((now - checkin_dt).total_seconds())

        hours = total_seconds // 3600
        minutes = (total_seconds % 3600) // 60
        seconds = total_seconds % 60

        # Formatted duration for display (e.g. "2h 15m 30s")
        formatted_duration = f"{hours}h {minutes}m {seconds}s"

        total_hours = round(total_seconds / 3600)

        update_data = {
            FIELD_CHECKOUT: checkout_timestamp,
            FIELD_DURATION: total_hours
        }

        print(f"\n{'='*60}")
        print(f"CHECK-OUT REQUEST")
        print(f"{'='*60}")
        print(f"Employee: {employee_id}")
        print(f"Record ID: {session['record_id']}")
        print(f"Check-out: {checkout_time_str}")
        print(f"Duration: {formatted_duration}")
        print(f"Updating Supabase...")

        update_record(ENTITY_NAME, session["record_id"], update_data)
        
        # Remove session after successful checkout
        del active_sessions[employee_id]
        
        print(f"✅ CHECK-OUT SUCCESS!")
        print(f"{'='*60}\n")
        
        return jsonify({
            "success": True,
            "checkout_time": checkout_time_str,
            "duration": formatted_duration,
            "total_hours": total_hours
        })
        
    except Exception as e:
        print(f"\n❌ CHECK-OUT ERROR: {str(e)}\n")
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


@app.route('/api/status/<employee_id>', methods=['GET'])
def get_status(employee_id):
    """Check if employee is currently checked in"""
    if employee_id in active_sessions:
        session = active_sessions[employee_id]
        checkin_dt = datetime.fromisoformat(session["checkin_datetime"])
        elapsed = int((datetime.now() - checkin_dt).total_seconds())
        
        return jsonify({
            "checked_in": True,
            "checkin_time": session["checkin_time"],
            "elapsed_seconds": elapsed
        })
    else:
        return jsonify({
            "checked_in": False
        })


@app.route('/api/attendance/<employee_id>/<int:year>/<int:month>', methods=['GET'])
def get_monthly_attendance(employee_id, year, month):
    """Get attendance records for a specific month"""
    try:
        from calendar import monthrange
        _, last_day = monthrange(year, month)
        
        start_date = f"{year}-{str(month).zfill(2)}-01"
        end_date = f"{year}-{str(month).zfill(2)}-{str(last_day).zfill(2)}"
        
        sb = get_supabase()
        response = (sb.table(ENTITY_NAME)
                    .select(f"{FIELD_DATE},{FIELD_CHECKIN},{FIELD_CHECKOUT},{FIELD_DURATION}")
                    .eq(FIELD_EMPLOYEE_ID, employee_id)
                    .gte(FIELD_DATE, start_date)
                    .lte(FIELD_DATE, end_date)
                    .execute())
        
        records = response.data or []
        formatted_records = []
        for record in records:
            formatted_records.append({
                "date": record.get(FIELD_DATE),
                "checkin": record.get(FIELD_CHECKIN),
                "checkout": record.get(FIELD_CHECKOUT),
                "duration": record.get(FIELD_DURATION)
            })
        
        return jsonify({
            "success": True,
            "records": formatted_records,
            "count": len(formatted_records)
        })
            
    except Exception as e:
        print(f"Error fetching monthly attendance: {str(e)}")
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


@app.route('/ping', methods=['GET'])
def ping():
    return jsonify({"message": "Backend is connected ✅"}), 200


if __name__ == '__main__':
    print("\n" + "🚀 " * 30)
    print("ATTENDANCE SYSTEM SERVER STARTING...")
    print("🚀 " * 30 + "\n")
    print("Server running on: http://localhost:5000")
    print("Frontend should connect to: http://localhost:5000/api/checkin")
    print("\n" + "="*80 + "\n")
    
    app.run(debug=True, port=5000)