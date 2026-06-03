import sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

event = {
    "server_time_utc": "2026-05-29T10:32:05Z",
    "client_timezone": None
}

time_only = None
try:
    ts = (event.get("client_time_local") or event.get("server_time_utc") or "").strip()
    if ts:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        tz_name = (event.get("client_timezone") or "").strip()
        if tz_name and ZoneInfo:
            try:
                dt = dt.astimezone(ZoneInfo(tz_name))
            except Exception:
                pass
        if ZoneInfo and dt.tzinfo == timezone.utc:
            try:
                dt = dt.astimezone(ZoneInfo("Asia/Kolkata"))
            except Exception as e:
                print("Exception:", e)
        time_only = dt.strftime("%H:%M:%S")
except Exception as e:
    print("Outer exception:", e)

print(f"Computed time_only: {time_only}")
