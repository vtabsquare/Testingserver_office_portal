"""Test leaves module with correct API paths."""
import requests
import json

BASE = "http://localhost:5000"

endpoints = [
    ("GET", "/api/leaves/EMP001"),
    ("GET", "/api/leave-balance/all/EMP001"),
    ("GET", "/api/leaves/pending"),
    ("GET", "/api/comp-off/requests"),
    ("GET", "/api/comp-off"),
    ("GET", "/api/comp-off/requests?employee_id=EMP001"),
]

for method, path in endpoints:
    url = BASE + path
    try:
        r = requests.request(method, url, timeout=15)
        body = r.text[:400]
        print(f"[{r.status_code}] {method} {path}")
        print(f"  Body: {body}")
    except Exception as e:
        print(f"[ERR] {method} {path}: {str(e)[:150]}")
    print()

# Test applying a leave
print("--- Testing POST /api/apply-leave ---")
leave_data = {
    "employee_id": "EMP001",
    "leave_type": "Casual Leave",
    "from_date": "2026-04-20",
    "to_date": "2026-04-20",
    "reason": "Test leave",
    "total_days": 1,
}
try:
    r = requests.post(f"{BASE}/api/apply-leave", json=leave_data, timeout=15)
    print(f"[{r.status_code}] POST /api/apply-leave")
    print(f"  Body: {r.text[:400]}")
except Exception as e:
    print(f"[ERR] POST /api/apply-leave: {str(e)[:150]}")
