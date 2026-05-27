"""
Daily scheduler to check for overdue tasks and send notifications.
Runs at 9:00 AM every day.
"""

import threading
import time
from datetime import datetime, time as dt_time
import requests
import os

BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:5000")
CHECK_TIME_HOUR = 9  # 9:00 AM
CHECK_TIME_MINUTE = 0


def check_overdue_tasks_job():
    """Job that calls the overdue tasks check endpoint."""
    try:
        print(f"[OVERDUE-SCHEDULER] Running daily overdue tasks check at {datetime.now()}")
        url = f"{BACKEND_URL}/api/tasks/check-overdue?send_email=true"
        response = requests.get(url, timeout=60)
        
        if response.ok:
            data = response.json()
            print(f"[OVERDUE-SCHEDULER] Check complete: {data.get('overdue_count', 0)} overdue tasks, {data.get('notifications_sent', 0)} notifications sent")
        else:
            print(f"[OVERDUE-SCHEDULER] Check failed: {response.status_code} - {response.text}")
    except Exception as e:
        print(f"[OVERDUE-SCHEDULER] Error running overdue check: {e}")


def scheduler_loop():
    """Background thread that runs the overdue check daily at specified time."""
    print(f"[OVERDUE-SCHEDULER] Started. Will check overdue tasks daily at {CHECK_TIME_HOUR:02d}:{CHECK_TIME_MINUTE:02d}")
    
    while True:
        try:
            now = datetime.now()
            target_time = now.replace(hour=CHECK_TIME_HOUR, minute=CHECK_TIME_MINUTE, second=0, microsecond=0)
            
            # If target time has passed today, schedule for tomorrow
            if now >= target_time:
                target_time = target_time.replace(day=target_time.day + 1)
            
            # Calculate seconds until next run
            seconds_until_run = (target_time - now).total_seconds()
            
            print(f"[OVERDUE-SCHEDULER] Next check scheduled for: {target_time}")
            
            # Sleep until target time
            time.sleep(seconds_until_run)
            
            # Run the job
            check_overdue_tasks_job()
            
        except Exception as e:
            print(f"[OVERDUE-SCHEDULER] Error in scheduler loop: {e}")
            # Sleep for 1 hour before retrying
            time.sleep(3600)


def setup_overdue_scheduler(app=None):
    """Start the overdue tasks scheduler as a daemon thread."""
    try:
        scheduler_thread = threading.Thread(target=scheduler_loop, daemon=True)
        scheduler_thread.start()
        print("[OVERDUE-SCHEDULER] Scheduler thread started successfully")
    except Exception as e:
        print(f"[OVERDUE-SCHEDULER] Failed to start scheduler: {e}")


if __name__ == "__main__":
    # For testing: run the check immediately
    print("Running overdue tasks check (test mode)...")
    check_overdue_tasks_job()
