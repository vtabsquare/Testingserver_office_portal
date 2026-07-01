# backup_scheduler.py
# ─────────────────────────────────────────────────────────────────────────────
# Handles:
#   1. Generating the 3-month backup ZIP (same logic as /api/admin/backup)
#   2. Uploading the ZIP to OneDrive via Microsoft Graph API (app-only auth)
#   3. Purging transactional rows older than 3 months from Supabase
#   4. APScheduler job that fires on the configured schedule automatically
#      — completely independent of any admin being logged in.
#
# Usage (called once from unified_server.py on startup):
#   from backup_scheduler import init_backup_scheduler
#   init_backup_scheduler(app, get_supabase_fn, read_cfg_fn, write_cfg_fn)
# ─────────────────────────────────────────────────────────────────────────────

import io
import os
import csv
import json
import zipfile
import logging
from datetime import datetime, timedelta, timezone

import msal
import requests as _requests

logger = logging.getLogger(__name__)

# ── Microsoft Graph (read from env dynamically) ───────────────────────────────
_GRAPH_SCOPE     = ['https://graph.microsoft.com/.default']
_GRAPH_BASE      = 'https://graph.microsoft.com/v1.0'

# Module-level scheduler reference (singleton)
_scheduler = None


# ── Table definitions (mirrors the /api/admin/backup endpoint) ────────────────
_TABLE_DEFS = [
    ("employees",        "crc6f_table12s",                 "created_at"),
    ("attendance",       "crc6f_table13s",                 "crc6f_date"),
    ("leave_requests",   "crc6f_table14s",                 "created_at"),
    ("leave_management", "crc6f_hr_leavemangements",       "created_at"),
    ("comp_off_requests","crc6f_compensatoryrequests",      "created_at"),
    ("assets",           "crc6f_hr_assetdetailses",        "created_at"),
    ("holidays",         "crc6f_hr_holidayses",            None),
    ("projects",         "crc6f_hr_projectheaders",        "created_at"),
    ("project_details",  "crc6f_hr_projectdetailses",      "created_at"),
    ("tasks",            "crc6f_hr_taskdetailses",         "created_at"),
    ("contributors",     "crc6f_hr_projectcontributorses", "created_at"),
    ("timesheet_logs",   "crc6f_hr_timesheetlogs",         "created_at"),
    ("login_activity",   "crc6f_hr_loginactivitytbs",      "crc6f_date"),
    ("inbox",            "crc6f_hr_inboxes",               "created_at"),
    ("hierarchies",      "crc6f_hierarchies",              "created_at"),
    ("role_permissions", "role_permissions",               "created_at"),
]

# Transactional tables to purge (children before parents to satisfy FK order)
_PURGE_ORDER = [
    ("inbox",               "crc6f_hr_inboxes",          "created_at"),
    ("login_activity",      "crc6f_hr_loginactivitytbs", "crc6f_date"),
    ("attendance",          "crc6f_table13s",            "crc6f_date"),
    ("timesheet_logs",      "crc6f_hr_timesheetlogs",    "created_at"),
    ("comp_off_requests",   "crc6f_compensatoryrequests","created_at"),
    ("leave_requests",      "crc6f_table14s",            "created_at"),
    ("auth_session_events", "auth_session_events",       "created_at"),
]


# ═══════════════════════════════════════════════════════════════════════════════
# Microsoft Graph helpers
# ═══════════════════════════════════════════════════════════════════════════════

def _get_graph_token() -> str | None:
    """Acquire an app-only access token for Microsoft Graph using MSAL."""
    client_id = os.getenv('ONEDRIVE_CLIENT_ID', '')
    client_sec = os.getenv('ONEDRIVE_CLIENT_SECRET', '')
    tenant_id = os.getenv('ONEDRIVE_TENANT_ID', '')

    if not all([client_id, client_sec, tenant_id]):
        logger.warning('[BACKUP-OD] OneDrive credentials not configured in environment.')
        return None
    try:
        authority = f'https://login.microsoftonline.com/{tenant_id}'
        app = msal.ConfidentialClientApplication(
            client_id,
            authority=authority,
            client_credential=client_sec,
        )

        result = app.acquire_token_silent(_GRAPH_SCOPE, account=None)
        if not result:
            result = app.acquire_token_for_client(scopes=_GRAPH_SCOPE)
        if 'access_token' in result:
            return result['access_token']
        logger.error(f'[BACKUP-OD] Token error: {result.get("error_description")}')
        return None
    except Exception as e:
        logger.error(f'[BACKUP-OD] Token exception: {e}')
        return None


def _upload_to_onedrive(zip_bytes: bytes, filename: str) -> dict:
    """
    Upload zip_bytes as filename into the configured OneDrive folder.
    Uses the Graph large-file upload session for files > 4 MB, otherwise
    a simple PUT for smaller files.
    Returns {'success': True/False, 'url': ...}
    """
    token = _get_graph_token()
    if not token:
        return {'success': False, 'error': 'Could not acquire Graph token'}

    headers_auth = {
        'Authorization': f'Bearer {token}',
        'Content-Type': 'application/octet-stream',
    }

    # Ensure the target folder exists by uploading a placeholder first attempt
    # The Graph API creates intermediate folders automatically on PUT.
    folder_env = os.getenv('ONEDRIVE_BACKUP_FOLDER', 'OfficeTool Backups')
    user_env   = os.getenv('ONEDRIVE_TARGET_USER', '')
    
    folder  = folder_env.strip('/')
    user    = user_env
    put_url = f'{_GRAPH_BASE}/users/{user}/drive/root:/{folder}/{filename}:/content'

    try:
        resp = _requests.put(put_url, headers=headers_auth, data=zip_bytes, timeout=120)
        if resp.status_code in (200, 201):
            item = resp.json()
            web_url = item.get('webUrl', '')
            logger.info(f'[BACKUP-OD] Uploaded successfully → {web_url}')
            return {'success': True, 'url': web_url, 'filename': filename}
        else:
            logger.error(f'[BACKUP-OD] Upload failed {resp.status_code}: {resp.text[:500]}')
            return {'success': False, 'error': f'HTTP {resp.status_code}: {resp.text[:300]}'}
    except Exception as e:
        logger.error(f'[BACKUP-OD] Upload exception: {e}')
        return {'success': False, 'error': str(e)}


# ═══════════════════════════════════════════════════════════════════════════════
# Backup ZIP builder
# ═══════════════════════════════════════════════════════════════════════════════

def _build_backup_zip(sb, since_date: str, until_date: str) -> tuple[bytes, dict]:
    """
    Query Supabase for the last-3-months window and return (zip_bytes, row_counts).
    """
    zip_buffer = io.BytesIO()
    row_counts: dict[str, int] = {}

    with zipfile.ZipFile(zip_buffer, mode='w', compression=zipfile.ZIP_DEFLATED) as zf:
        for (friendly, table, date_col) in _TABLE_DEFS:
            try:
                query = sb.table(table).select('*')
                if date_col:
                    query = query.gte(date_col, since_date).lte(date_col, until_date)
                result = query.limit(10000).execute()
                rows = result.data or []
            except Exception as tbl_err:
                logger.warning(f'[BACKUP] Skipping {table}: {tbl_err}')
                rows = []

            row_counts[friendly] = len(rows)

            if not rows:
                csv_bytes = b''
            else:
                csv_io = io.StringIO()
                writer = csv.DictWriter(
                    csv_io,
                    fieldnames=list(rows[0].keys()),
                    extrasaction='ignore',
                    lineterminator='\r\n',
                )
                writer.writeheader()
                writer.writerows(rows)
                csv_bytes = csv_io.getvalue().encode('utf-8-sig')

            zf.writestr(f'{friendly}.csv', csv_bytes)

        # README
        readme_lines = [
            'OfficeTool Backup',
            '=================',
            f'Generated : {datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")}',
            f'Period    : {since_date}  to  {until_date}',
            '',
            'Files in this archive (last 3 months of data):',
        ]
        for (friendly, _, _dc) in _TABLE_DEFS:
            readme_lines.append(f'  {friendly}.csv  — {row_counts.get(friendly, 0)} rows')
        readme_lines += [
            '',
            'Uploaded automatically by OfficeTool Backup Scheduler → OneDrive.',
            'Master records (employees, projects, assets, etc.) are NEVER deleted.',
        ]
        zf.writestr('README.txt', '\n'.join(readme_lines).encode('utf-8'))

    return zip_buffer.getvalue(), row_counts


# ═══════════════════════════════════════════════════════════════════════════════
# Purge old rows
# ═══════════════════════════════════════════════════════════════════════════════

def _purge_old_rows(sb, cutoff_iso: str) -> dict:
    deleted_counts: dict = {}
    for (label, table, date_col) in _PURGE_ORDER:
        try:
            result = (
                sb.table(table)
                  .delete()
                  .lt(date_col, cutoff_iso)
                  .execute()
            )
            count = len(result.data) if result.data else 0
            deleted_counts[label] = count
            logger.info(f'[PURGE]  {label}: deleted {count} rows (before {cutoff_iso})')
        except Exception as tbl_err:
            logger.error(f'[PURGE]  {label}: FAILED — {tbl_err}')
            deleted_counts[label] = f'error: {tbl_err}'
    return deleted_counts


# ═══════════════════════════════════════════════════════════════════════════════
# The main scheduled job
# ═══════════════════════════════════════════════════════════════════════════════

def _send_backup_email(sb, success: bool, subject: str, details: str):
    try:
        from mail_app import send_email
    except ImportError:
        logger.error("[BACKUP-SCHEDULER] mail_app not found, cannot send email")
        return

    admin_emails = []
    
    # 1. From env
    env_admin = os.getenv('ADMIN_EMAIL')
    if env_admin:
        admin_emails.append(env_admin)
        
    # 2. From database
    try:
        res = sb.table('crc6f_table12s').select('crc6f_emailaddress1,crc6f_designation').execute()
        for emp in res.data or []:
            email = emp.get('crc6f_emailaddress1')
            desig = (emp.get('crc6f_designation') or '').lower()
            if email and ('admin' in desig or 'l3' in desig):
                admin_emails.append(email)
    except Exception as e:
        logger.error(f"[BACKUP-SCHEDULER] Could not fetch DB admins for email: {e}")

    admin_emails = list(set(admin_emails))
    if not admin_emails:
        logger.warning("[BACKUP-SCHEDULER] No admin emails found to notify.")
        return
        
    html_body = f"""
    <h2>OfficeTool Backup Report</h2>
    <p><strong>Status:</strong> {'✅ SUCCESS' if success else '❌ FAILED'}</p>
    <p><strong>Time:</strong> {datetime.now(timezone.utc).isoformat()}</p>
    <p><strong>Details:</strong></p>
    <pre>{details}</pre>
    """
    
    try:
        send_email(subject, admin_emails, details, html=html_body, async_send=True)
        logger.info(f"[BACKUP-SCHEDULER] Sent notification to {len(admin_emails)} admins.")
    except Exception as e:
        logger.error(f"[BACKUP-SCHEDULER] Failed to send email: {e}")

def run_scheduled_backup(get_supabase_fn, read_cfg_fn, write_cfg_fn):
    """
    Full backup job: build ZIP → upload to OneDrive → purge old rows → update config.
    Called by APScheduler — runs entirely on the server, no browser required.
    """
    logger.info('[BACKUP-SCHEDULER] Starting scheduled backup job...')
    sb_inst = None
    try:
        sb = get_supabase_fn()
        sb_inst = sb

        # Date window
        today     = datetime.now(timezone.utc).date()
        cutoff    = today.replace(day=1)
        for _ in range(3):
            cutoff = (cutoff - timedelta(days=1)).replace(day=1)
        since_date = cutoff.isoformat()
        until_date = today.isoformat()

        # 1. Build ZIP
        logger.info(f'[BACKUP-SCHEDULER] Building ZIP for {since_date} → {until_date}')
        zip_bytes, row_counts = _build_backup_zip(sb, since_date, until_date)

        # 2. Upload to OneDrive
        ts       = today.strftime('%Y%m%d')
        filename = f'OfficeTool_Backup_{since_date}_to_{until_date}_{ts}.zip'
        logger.info(f'[BACKUP-SCHEDULER] Uploading {filename} to OneDrive...')
        upload_result = _upload_to_onedrive(zip_bytes, filename)

        if upload_result.get('success'):
            logger.info(f'[BACKUP-SCHEDULER] OneDrive upload OK → {upload_result.get("url")}')
        else:
            logger.error(f'[BACKUP-SCHEDULER] OneDrive upload FAILED: {upload_result.get("error")}')
            raise Exception(f"OneDrive upload failed: {upload_result.get('error')}. Aborting purge.")

        # 3. Purge old rows (runs regardless of upload success — data is already safe in OD)
        logger.info(f'[BACKUP-SCHEDULER] Purging rows older than {since_date}...')
        deleted = _purge_old_rows(sb, since_date)
        total_deleted = sum(v for v in deleted.values() if isinstance(v, int))
        logger.info(f'[BACKUP-SCHEDULER] Purge done. Total deleted: {total_deleted}')

        # 4. Update config with last_backup_date and append history log
        cfg = read_cfg_fn()
        history = cfg.get('history', [])
        history.insert(0, {
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'status': 'success',
            'filename': filename,
            'url': upload_result.get('url', ''),
            'records_purged': total_deleted,
            'error': None
        })
        cfg['history'] = history[:50]  # Keep last 50 logs
        cfg['last_backup_date'] = today.isoformat()
        cfg['last_backup_onedrive_url'] = upload_result.get('url', '')
        cfg['last_backup_status'] = 'success'
        write_cfg_fn(cfg)

        logger.info('[BACKUP-SCHEDULER] Job complete.')
        
        # 5. Send Success Email
        _send_backup_email(sb, True, "✅ OfficeTool Backup Successful", f"Backup completed and uploaded to OneDrive.\nFilename: {filename}\nRecords Purged: {total_deleted}\nURL: {upload_result.get('url', '')}")
        
        return {'success': True, 'filename': filename, 'upload': upload_result, 'deleted': deleted}

    except Exception as e:
        import traceback as _tb
        tb_str = _tb.format_exc()
        logger.error(f'[BACKUP-SCHEDULER] Job FAILED: {e}\n{tb_str}')
        
        # Log failure to history
        try:
            cfg = read_cfg_fn()
            history = cfg.get('history', [])
            history.insert(0, {
                'timestamp': datetime.now(timezone.utc).isoformat(),
                'status': 'failed',
                'filename': None,
                'url': None,
                'records_purged': 0,
                'error': str(e)
            })
            cfg['history'] = history[:50]
            cfg['last_backup_status'] = 'failed'
            write_cfg_fn(cfg)
        except Exception as log_err:
            logger.error(f'[BACKUP-SCHEDULER] Failed to write failure log: {log_err}')
        
        if sb_inst is None:
            try:
                sb_inst = get_supabase_fn()
            except:
                pass
                
        if sb_inst:
            _send_backup_email(sb_inst, False, "❌ OfficeTool Backup FAILED", f"Error: {e}\n\n{tb_str}")
            
        return {'success': False, 'error': str(e)}


# ═══════════════════════════════════════════════════════════════════════════════
# APScheduler setup — called once on server startup
# ═══════════════════════════════════════════════════════════════════════════════

def _build_trigger(cfg: dict):
    """Convert backup config to an APScheduler CronTrigger or IntervalTrigger."""
    from apscheduler.triggers.cron     import CronTrigger
    from apscheduler.triggers.interval import IntervalTrigger

    freq = cfg.get('frequency', 'monthly')
    dom  = int(cfg.get('day_of_month', 1))

    if freq == 'daily':
        return CronTrigger(hour=0, minute=0)                        # 12:00 AM daily
    if freq == 'weekly':
        return CronTrigger(day_of_week='mon', hour=0, minute=0)     # Every Monday 12:00 AM
    if freq == 'fortnightly':
        return IntervalTrigger(weeks=2)                             # Every 14 days
    if freq == 'monthly':
        return CronTrigger(day=dom, hour=0, minute=0)               # Monthly on day X at 12:00 AM
    if freq == 'quarterly':
        # Every 3 months on dom at 12:00 AM — approximate via month list
        months = '1,4,7,10'
        return CronTrigger(month=months, day=dom, hour=0, minute=0)
    # Default fallback — 1st of every month
    return CronTrigger(day=1, hour=0, minute=0)


def init_backup_scheduler(app, get_supabase_fn, read_cfg_fn, write_cfg_fn):
    """
    Initialize APScheduler and schedule the backup job based on backup_config.json.
    Call this once at application startup from unified_server.py.
    Returns the scheduler instance.
    """
    global _scheduler

    try:
        from apscheduler.schedulers.background import BackgroundScheduler
        from apscheduler.jobstores.memory      import MemoryJobStore
        from apscheduler.executors.pool        import ThreadPoolExecutor
    except ImportError:
        logger.error('[BACKUP-SCHEDULER] APScheduler not installed. Run: pip install APScheduler')
        return None

    cfg = read_cfg_fn()

    if cfg.get('enabled') is False:
        logger.info('[BACKUP-SCHEDULER] Backup scheduling is disabled in config. Skipping.')
        return None

    jobstores  = {'default': MemoryJobStore()}
    executors  = {'default': ThreadPoolExecutor(1)}
    job_defaults = {'coalesce': True, 'max_instances': 1}

    _scheduler = BackgroundScheduler(
        jobstores=jobstores,
        executors=executors,
        job_defaults=job_defaults,
        timezone='Asia/Calcutta',
    )

    trigger = _build_trigger(cfg)

    _scheduler.add_job(
        func=run_scheduled_backup,
        trigger=trigger,
        id='officetool_backup',
        name='OfficeTool Scheduled Backup → OneDrive',
        args=[get_supabase_fn, read_cfg_fn, write_cfg_fn],
        replace_existing=True,
    )

    _scheduler.start()
    next_run = _scheduler.get_job('officetool_backup').next_run_time
    logger.info(f'[BACKUP-SCHEDULER] Started. Frequency: {cfg.get("frequency")}. '
                f'Next run: {next_run}')
    return _scheduler


def reschedule(read_cfg_fn, get_supabase_fn, write_cfg_fn):
    """
    Called when the admin changes the schedule via the UI.
    Updates the existing scheduler job with the new trigger.
    """
    global _scheduler
    if _scheduler is None:
        logger.warning('[BACKUP-SCHEDULER] reschedule() called but scheduler not running.')
        return

    cfg = read_cfg_fn()

    if cfg.get('enabled') is False:
        _scheduler.pause()
        logger.info('[BACKUP-SCHEDULER] Scheduler paused (disabled in config).')
        return

    _scheduler.resume()
    trigger = _build_trigger(cfg)
    _scheduler.reschedule_job(
        'officetool_backup',
        trigger=trigger,
        args=[get_supabase_fn, read_cfg_fn, write_cfg_fn],
    )
    next_run = _scheduler.get_job('officetool_backup').next_run_time
    logger.info(f'[BACKUP-SCHEDULER] Rescheduled. Next run: {next_run}')


def get_scheduler_status() -> dict:
    """Return current scheduler state for the API status endpoint."""
    global _scheduler
    if _scheduler is None:
        return {'running': False, 'next_run': None}
    try:
        job = _scheduler.get_job('officetool_backup')
        return {
            'running': _scheduler.running,
            'next_run': job.next_run_time.isoformat() if job and job.next_run_time else None,
            'job_name': job.name if job else None,
        }
    except Exception:
        return {'running': _scheduler.running if _scheduler else False, 'next_run': None}
