from flask import Flask, jsonify, request, session, current_app
from flask_mail import Mail, Message
import os
import base64
import traceback
import requests as http_requests  # renamed to avoid conflict
from dotenv import load_dotenv

# Load env for local dev
if os.path.exists("id.env"):
    load_dotenv("id.env")
load_dotenv()

# Standalone app for backward compatibility
app = Flask(__name__)
app.config['MAIL_SERVER'] = os.getenv('MAIL_SERVER', 'smtp.gmail.com')
app.config['MAIL_PORT'] = 587
app.config['MAIL_USE_TLS'] = True
app.config['MAIL_USERNAME'] = os.getenv('MAIL_USERNAME')
app.config['MAIL_PASSWORD'] = os.getenv('MAIL_PASSWORD')
app.config['MAIL_DEFAULT_SENDER'] = os.getenv('MAIL_DEFAULT_SENDER', app.config['MAIL_USERNAME'])
app.config['MAIL_TIMEOUT'] = 10  # 10 second timeout to prevent hanging on blocked SMTP
mail = Mail(app)

print("DEBUG: MAIL_USERNAME =", os.getenv("MAIL_USERNAME"))
print("DEBUG: MAIL_DEFAULT_SENDER =", os.getenv("MAIL_DEFAULT_SENDER"))


# ------------------------------
# ✉️ Email Send via Brevo API (formerly Sendinblue)
# ------------------------------
def send_email_brevo(subject, recipients, body, html=None, attachments=None):
    """
    Send email using Brevo API (HTTP-based, works on Render free tier).
    Free tier: 300 emails/day, no domain verification required.
    Requires BREVO_API_KEY env var.
    Supports attachments via base64 encoding.
    """
    api_key = os.getenv('BREVO_API_KEY')
    from_email = os.getenv('BREVO_FROM_EMAIL', os.getenv('MAIL_USERNAME', 'noreply@example.com'))
    from_name = os.getenv('BREVO_FROM_NAME', 'VTab Office Tool')
    
    if not api_key:
        print("[MAIL-BREVO] No BREVO_API_KEY configured", flush=True)
        return False
    
    print(f"[MAIL-BREVO] Sending to {recipients} from {from_email}", flush=True)
    
    # Prepare recipients list
    to_list = recipients if isinstance(recipients, list) else [recipients]
    to_formatted = [{"email": email} for email in to_list]
    
    payload = {
        "sender": {"name": from_name, "email": from_email},
        "to": to_formatted,
        "subject": subject,
        "textContent": body,
        "headers": {
            "X-Mailin-custom": "disable-tracking"
        },
        "params": {
            "DISABLE_TRACKING": True
        }
    }
    # Disable click tracking to avoid broken redirect links
    payload["trackClicks"] = False
    payload["trackOpens"] = False
    
    if html:
        payload["htmlContent"] = html
    
    # Add attachments as base64 encoded content
    if attachments:
        att_list = []
        for filename, file_data in attachments:
            encoded = base64.b64encode(file_data).decode('utf-8')
            att_list.append({"name": filename, "content": encoded})
            print(f"[MAIL-BREVO] Attaching: {filename} ({len(file_data)} bytes)", flush=True)
        payload["attachment"] = att_list
    
    try:
        response = http_requests.post(
            "https://api.brevo.com/v3/smtp/email",
            headers={
                "api-key": api_key,
                "Content-Type": "application/json",
                "Accept": "application/json"
            },
            json=payload,
            timeout=15
        )
        
        if response.status_code in [200, 201]:
            print(f"[MAIL-BREVO] Email sent successfully: {response.json()}", flush=True)
            return True
        else:
            print(f"[MAIL-BREVO] Failed: {response.status_code} - {response.text}", flush=True)
            return False
    except Exception as e:
        print(f"[MAIL-BREVO] Error: {e}", flush=True)
        traceback.print_exc()
        return False


# ------------------------------
# ✉️ Email Send via Resend API (backup)
# ------------------------------
def send_email_resend(subject, recipients, body, html=None):
    """
    Send email using Resend API (HTTP-based).
    Note: Free tier only allows sending to your own email without domain verification.
    """
    api_key = os.getenv('RESEND_API_KEY')
    from_email = os.getenv('RESEND_FROM_EMAIL', 'onboarding@resend.dev')
    
    if not api_key:
        print("[MAIL-RESEND] No RESEND_API_KEY configured", flush=True)
        return False
    
    print(f"[MAIL-RESEND] Sending to {recipients} from {from_email}", flush=True)
    
    to_list = recipients if isinstance(recipients, list) else [recipients]
    
    payload = {
        "from": from_email,
        "to": to_list,
        "subject": subject,
        "text": body,
    }
    if html:
        payload["html"] = html
    
    try:
        response = http_requests.post(
            "https://api.resend.com/emails",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json"
            },
            json=payload,
            timeout=10
        )
        
        if response.status_code == 200:
            print(f"[MAIL-RESEND] Email sent successfully: {response.json()}", flush=True)
            return True
        else:
            print(f"[MAIL-RESEND] Failed: {response.status_code} - {response.text}", flush=True)
            return False
    except Exception as e:
        print(f"[MAIL-RESEND] Error: {e}", flush=True)
        traceback.print_exc()
        return False


def send_email(subject, recipients, body, html=None, cc=None, attachments=None, async_send=False):
    """
    Send email - tries multiple providers in order:
    1. Brevo API (300 free emails/day, no domain verification)
    2. Resend API (requires domain verification for non-self emails)
    3. Flask-Mail SMTP (for local dev or attachments)

    If async_send=True, the email is dispatched in a background thread and the
    function returns True immediately. Useful for HTTP handlers that must not
    block on slow/blocked SMTP (prevents 502 gateway timeouts).
    """
    if async_send:
        import threading
        def _worker():
            try:
                send_email(subject, recipients, body, html=html, cc=cc, attachments=attachments, async_send=False)
            except Exception as _e:
                print(f"[MAIL-ASYNC] Background send failed: {_e}", flush=True)
        t = threading.Thread(target=_worker, daemon=True)
        t.start()
        print(f"[MAIL] Dispatched async email to={recipients}, subject={subject}", flush=True)
        return True

    print(f"[MAIL] send_email called: to={recipients}, subject={subject}, attachments={len(attachments) if attachments else 0}", flush=True)
    
    # Try Brevo first (supports attachments via base64)
    if os.getenv('BREVO_API_KEY'):
        result = send_email_brevo(subject, recipients, body, html, attachments=attachments)
        if result:
            return True
        print("[MAIL] Brevo failed, trying next provider...", flush=True)
    
    # Try Resend as backup (no attachment support)
    if not attachments and os.getenv('RESEND_API_KEY'):
        result = send_email_resend(subject, recipients, body, html)
        if result:
            return True
        print("[MAIL] Resend failed, trying Flask-Mail...", flush=True)
    
    # Fall back to Flask-Mail (for local dev, attachments, or if APIs fail)
    print("[MAIL] Using Flask-Mail fallback", flush=True)
    try:
        flask_app = current_app._get_current_object()
        mail_instance = flask_app.extensions.get('mail')
        if not mail_instance:
            flask_app = app
            mail_instance = mail
    except RuntimeError:
        flask_app = app
        mail_instance = mail

    try:
        with flask_app.app_context():
            msg = Message(subject=subject, recipients=recipients, cc=cc, body=body, html=html)
            if attachments:
                for filename, file_data in attachments:
                    msg.attach(filename=filename, content_type='application/pdf', data=file_data)
                    print(f"[MAIL] Attached: {filename}", flush=True)
            mail_instance.send(msg)
            print(f"[MAIL] Email sent successfully -> {recipients}", flush=True)
            return True
    except Exception as e:
        print(f"[MAIL] Flask-Mail failed: {e}", flush=True)
        traceback.print_exc()
        return False
    
    
