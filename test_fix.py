import sys
import os
from dotenv import load_dotenv
from datetime import datetime, timezone

load_dotenv('backend/id.env')
sys.path.append('backend')
import unified_server

# Test with the actual epoch timestamp from DB for today
# crc6f_checkin_timestamp: 1780052017
epoch_ts = 1780052017
ist_time = unified_server._checkin_time_from_epoch(epoch_ts)
print(f"Epoch {epoch_ts} -> IST time: {ist_time}")

# Simulate what the record looks like
record = {
    "crc6f_checkintime": "10:53:37",  # The incorrectly stored UTC time
    "crc6f_checkin_timestamp": 1780052017,  # The correct epoch
}
from_record = unified_server._checkin_time_from_record(record)
print(f"From record (epoch preferred): {from_record}")

# Test late check
shift = unified_server._resolve_employee_shift("EMP015")
print(f"\nShift: {shift}")
is_late = unified_server._is_late_login_for_shift(from_record, shift['shift_start'], shift['grace_minutes'])
print(f"Is late with epoch-derived time: {is_late}")

threshold = unified_server._time_to_minutes(shift['shift_start']) + shift['grace_minutes']
checkin_mins = unified_server._time_to_minutes(unified_server._normalize_shift_time(from_record, ''))
print(f"Threshold: {threshold} min, Checkin: {checkin_mins} min, Late: {checkin_mins > threshold}")
