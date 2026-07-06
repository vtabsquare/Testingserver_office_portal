# leave_reset_scheduler.py
# ─────────────────────────────────────────────────────────────────────────────
# Annual Leave Balance Reset
#
# Resets every employee's leave balance at the start of the new financial year:
#   - Financial Year: July 1 → June 30
#   - Reset runs at: July 1, 12:00 AM IST (Asia/Kolkata)
#   - Also runs at startup if the reset was missed this year (catch-up logic)
#
# Leave balance table: crc6f_hr_leavemangements
#   Fields reset:
#     crc6f_cl          → Casual Leave balance (reset to allocation)
#     crc6f_sl          → Sick Leave balance   (reset to allocation)
#     crc6f_total       → Total balance        (reset to CL + SL)
#
#   Allocation determined by crc6f_leaveallocationtype:
#     "Type 1" → CL=6, SL=6, Total=12, ActualTotal=12
#     "Type 2" → CL=4, SL=4, Total=8,  ActualTotal=8
#     "Type 3" → CL=3, SL=3, Total=6,  ActualTotal=6
#     (null/unknown) → defaults to Type 3 (CL=3, SL=3)
#
# Usage (called once from unified_server.py on startup):
#   from leave_reset_scheduler import init_leave_reset_scheduler
#   init_leave_reset_scheduler(get_supabase_fn)
# ─────────────────────────────────────────────────────────────────────────────

import logging
import os
from datetime import datetime, timezone, date

logger = logging.getLogger(__name__)

# Module-level scheduler reference
_leave_scheduler = None

# ── Allocation map ─────────────────────────────────────────────────────────────
_ALLOCATION_MAP = {
    "Type 1": {"cl": 6.0, "sl": 6.0, "total": 12.0},
    "Type 2": {"cl": 4.0, "sl": 4.0, "total": 8.0},
    "Type 3": {"cl": 3.0, "sl": 3.0, "total": 6.0},
}
_DEFAULT_ALLOCATION = {"cl": 3.0, "sl": 3.0, "total": 6.0}

LEAVE_TABLE = "crc6f_hr_leavemangements"
RESET_LOG_KEY = "last_annual_leave_reset_year"   # stored in metadata or checked by year


def _get_allocation(row: dict) -> dict:
    """Return the leave allocation dict for this employee based on their type."""
    alloc_type = (row.get("crc6f_leaveallocationtype") or "").strip()
    return _ALLOCATION_MAP.get(alloc_type, _DEFAULT_ALLOCATION)


def perform_leave_reset(get_supabase_fn, triggered_by: str = "scheduler") -> dict:
    """
    Reset all employees' leave balances to their allocated amounts.
    This is the core reset function — safe to call multiple times (idempotent
    within the same financial year due to the catch-up guard in init).

    Returns a summary dict with counts of success/failures.
    """
    logger.info(f"[LEAVE-RESET] ===== Starting Annual Leave Balance Reset (triggered by: {triggered_by}) =====")

    try:
        sb = get_supabase_fn()
        result = sb.table(LEAVE_TABLE).select("*").execute()
        rows = result.data or []
    except Exception as e:
        logger.error(f"[LEAVE-RESET] Failed to fetch leave records: {e}")
        return {"success": False, "error": str(e), "reset_count": 0, "error_count": 0}

    if not rows:
        logger.warning("[LEAVE-RESET] No leave balance records found — nothing to reset.")
        return {"success": True, "reset_count": 0, "error_count": 0, "message": "No records found"}

    reset_year = datetime.now().year
    reset_count = 0
    error_count = 0
    errors = []

    for row in rows:
        emp_id = row.get("crc6f_employeeid") or row.get("crc6f_empid") or "UNKNOWN"
        rec_id = row.get("crc6f_hr_leavemangementid")

        if not rec_id:
            logger.warning(f"[LEAVE-RESET] Skipping row with no PK for emp: {emp_id}")
            continue

        alloc = _get_allocation(row)
        cl_alloc   = alloc["cl"]
        sl_alloc   = alloc["sl"]
        total_alloc = alloc["total"]

        update_payload = {
            "crc6f_cl":          cl_alloc,
            "crc6f_sl":          sl_alloc,
            "crc6f_compoff":     0.0,          # comp-off resets to 0 each year
            "crc6f_total":       total_alloc,
            "crc6f_actualtotal": total_alloc,
            "updated_at":        datetime.utcnow().isoformat(),
        }

        try:
            sb.table(LEAVE_TABLE).update(update_payload).eq(
                "crc6f_hr_leavemangementid", rec_id
            ).execute()

            logger.info(
                f"[LEAVE-RESET] ✅ {emp_id} → CL={cl_alloc}, SL={sl_alloc}, "
                f"CompOff=0, Total={total_alloc} "
                f"(alloc_type={row.get('crc6f_leaveallocationtype', 'default')})"
            )
            reset_count += 1

        except Exception as e:
            logger.error(f"[LEAVE-RESET] ❌ Failed to reset {emp_id}: {e}")
            error_count += 1
            errors.append({"employee_id": emp_id, "error": str(e)})

    summary = {
        "success": True,
        "triggered_by": triggered_by,
        "reset_year": reset_year,
        "total_employees": len(rows),
        "reset_count": reset_count,
        "error_count": error_count,
        "errors": errors,
        "timestamp": datetime.utcnow().isoformat(),
    }

    logger.info(
        f"[LEAVE-RESET] ===== Complete: {reset_count}/{len(rows)} employees reset, "
        f"{error_count} errors ====="
    )
    return summary


def _should_run_catchup(get_supabase_fn) -> bool:
    """
    Check if the annual reset for the current financial year has already been done.
    The reset is considered done if ANY employee's updated_at is on/after July 1 of this year
    AND the current date is on/after July 1.

    Returns True if we need to run a catch-up reset.
    """
    today = date.today()
    current_fy_start = date(today.year, 7, 1)

    # Not yet July 1 — don't run catch-up
    if today < current_fy_start:
        logger.info(f"[LEAVE-RESET] Catch-up check: today {today} is before FY start {current_fy_start}. No catch-up needed.")
        return False

    # It's on or after July 1. Check if any record was updated after this FY start.
    try:
        sb = get_supabase_fn()
        fy_start_str = current_fy_start.isoformat()
        result = sb.table(LEAVE_TABLE).select("updated_at").gte(
            "updated_at", f"{fy_start_str}T00:00:00"
        ).limit(1).execute()

        if result.data:
            # At least one record was updated after FY start — reset already done
            logger.info(
                f"[LEAVE-RESET] Catch-up check: Reset already performed for FY {current_fy_start.year}. Skipping."
            )
            return False
        else:
            # No records updated after FY start — reset was MISSED
            logger.warning(
                f"[LEAVE-RESET] Catch-up check: Reset NOT yet done for FY {current_fy_start.year}. "
                f"Running catch-up reset now."
            )
            return True

    except Exception as e:
        logger.error(f"[LEAVE-RESET] Catch-up check failed: {e}. Skipping catch-up to be safe.")
        return False


def _scheduled_reset_job(get_supabase_fn):
    """Wrapper called by APScheduler — ensures errors don't crash the scheduler."""
    try:
        summary = perform_leave_reset(get_supabase_fn, triggered_by="scheduler (July 1 cron)")
        logger.info(f"[LEAVE-RESET] Scheduled job completed: {summary}")
    except Exception as e:
        logger.error(f"[LEAVE-RESET] Scheduled job raised unexpected error: {e}")


def init_leave_reset_scheduler(get_supabase_fn) -> object:
    """
    Initialize the annual leave reset scheduler.

    - Schedules the leave reset job to run at July 1, 12:00 AM IST every year.
    - At startup, checks if the reset was missed this year and runs catch-up if needed.
    - Uses the same GeventScheduler pattern as backup_scheduler.py.

    Call once from unified_server.py at startup:
        from leave_reset_scheduler import init_leave_reset_scheduler
        init_leave_reset_scheduler(get_supabase)

    Returns the scheduler instance.
    """
    global _leave_scheduler

    try:
        from apscheduler.schedulers.gevent import GeventScheduler
        from apscheduler.triggers.cron import CronTrigger
        from apscheduler.jobstores.memory import MemoryJobStore
        from apscheduler.executors.pool import ThreadPoolExecutor
    except ImportError:
        logger.error("[LEAVE-RESET] APScheduler / gevent not installed. Leave reset scheduler NOT started.")
        return None

    # ── 1. Run catch-up check at startup ──────────────────────────────────────
    try:
        if _should_run_catchup(get_supabase_fn):
            perform_leave_reset(get_supabase_fn, triggered_by="startup catch-up (missed July 1 reset)")
    except Exception as e:
        logger.error(f"[LEAVE-RESET] Catch-up check/run failed at startup: {e}")

    # ── 2. Schedule the annual cron job ───────────────────────────────────────
    jobstores    = {"default": MemoryJobStore()}
    executors    = {"default": ThreadPoolExecutor(1)}
    job_defaults = {"coalesce": True, "max_instances": 1}

    _leave_scheduler = GeventScheduler(
        jobstores=jobstores,
        executors=executors,
        job_defaults=job_defaults,
        timezone="Asia/Kolkata",
    )

    # Fire every year on July 1 at 12:00:00 AM IST
    _leave_scheduler.add_job(
        func=_scheduled_reset_job,
        trigger=CronTrigger(month=7, day=1, hour=0, minute=0, second=0),
        id="annual_leave_reset",
        name="Annual Leave Balance Reset (July 1)",
        args=[get_supabase_fn],
        replace_existing=True,
    )

    _leave_scheduler.start()

    next_run = _leave_scheduler.get_job("annual_leave_reset").next_run_time
    logger.info(
        f"[LEAVE-RESET] Scheduler started. Annual reset scheduled for July 1 at 12:00 AM IST. "
        f"Next run: {next_run}"
    )

    return _leave_scheduler


def get_leave_reset_status() -> dict:
    """Return the current state of the leave reset scheduler."""
    global _leave_scheduler
    if _leave_scheduler is None:
        return {"running": False, "next_run": None}
    try:
        job = _leave_scheduler.get_job("annual_leave_reset")
        return {
            "running": _leave_scheduler.running,
            "next_run": job.next_run_time.isoformat() if job and job.next_run_time else None,
            "job_name": job.name if job else None,
        }
    except Exception:
        return {"running": _leave_scheduler.running if _leave_scheduler else False, "next_run": None}
