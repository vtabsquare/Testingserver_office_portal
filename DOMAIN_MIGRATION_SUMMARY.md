# Domain Migration Summary: officeportal → officehub360

## Overview
Migration from `https://officeportal.vtabsquare.com` to `https://officehub360.vtabsquare.com`

**Date:** May 25, 2026  
**Status:** Ready for deployment

---

## ✅ Completed Changes

### 1. HR Tool (OfficeHub360) Configuration

#### Backend Environment (`backend/id.env`)
```bash
FRONTEND_BASE_URL=https://officehub360.vtabsquare.com
CORS_ORIGIN=https://officehub360.vtabsquare.com
GOOGLE_REDIRECT_URI=https://officehub360.vtabsquare.com/google/oauth2callback
FACEAUTH_BASE_URL=https://biometrics.vtabsquare.com
SKIP_FACE_AUTH=false  # Enable face verification
```

#### Deployment Templates Updated
- ✅ `deploy/id.env.template` - Updated all domain references
- ✅ `deploy/ecosystem.config.cjs` - Updated PM2 env vars
- ✅ `deploy/nginx.conf` - Updated server_name directives
- ✅ `deploy/socket-server.env.template` - Updated CORS origins

#### Code Changes
- ✅ `backend/unified_server.py` - Added `/api/faceauth/admin-sso-token` endpoint
- ✅ `index.js` - Updated FaceAuth admin button to fetch SSO token from backend
- ✅ Frontend built successfully with new changes

---

### 2. FaceAuth App Configuration

#### Environment (`.env`)
```bash
FACEAUTH_BASE_URL=https://biometrics.vtabsquare.com
JWT_SECRET=f7671ea136486276dfee0bc1f6d5079b898e767cdaea80f18f68a09e57abe3687fd58871072ce85ffbb22442d9216abff62c0dd611c2...
JWT_ALGORITHM=HS512
```

**Note:** FaceAuth uses dynamic `callback_url` parameter, so no hardcoded domain changes needed.

---

## 🔄 Integration Flow (Updated)

### Login with Face Verification
1. User visits `https://officehub360.vtabsquare.com`
2. Backend generates JWT and redirects to:
   ```
   https://biometrics.vtabsquare.com/external-verify?
     token=<JWT>&
     callback_url=https://officehub360.vtabsquare.com/auth/face-callback
   ```
3. FaceAuth verifies face and redirects back to:
   ```
   https://officehub360.vtabsquare.com/auth/face-callback?
     token=<NEW_JWT>&
     face_verified=true
   ```
4. Frontend handles callback and redirects to dashboard

### FaceAuth Admin SSO
1. Admin clicks "FaceAuth Admin" in sidebar
2. Frontend calls `GET /api/faceauth/admin-sso-token` with auth header
3. Backend validates admin access and generates SSO token (15-min expiry)
4. Frontend opens new tab:
   ```
   https://biometrics.vtabsquare.com/admin-sso?token=<SSO_TOKEN>
   ```
5. FaceAuth validates token and logs admin in

---

## 📋 Deployment Checklist

### On Server (`/var/www/testofficeportal/Testingserver_office_portal`)

#### 1. Update Backend Environment
```bash
# Edit backend/id.env
nano backend/id.env

# Add/update these lines:
FRONTEND_BASE_URL=https://officehub360.vtabsquare.com
CORS_ORIGIN=https://officehub360.vtabsquare.com
GOOGLE_REDIRECT_URI=https://officehub360.vtabsquare.com/google/oauth2callback
FACEAUTH_BASE_URL=https://biometrics.vtabsquare.com
SKIP_FACE_AUTH=false
```

#### 2. Pull Latest Code
```bash
git pull origin main
```

#### 3. Build Frontend
```bash
npm run build
```

#### 4. Update PM2 Ecosystem (if using)
```bash
# Edit ecosystem.config.cjs
nano ecosystem.config.cjs

# Update env vars to match new domain
```

#### 5. Update Socket Server
```bash
# Edit socket-server/.env
nano socket-server/.env

# Update:
SOCKET_ORIGINS=https://officehub360.vtabsquare.com,https://api.officehub360.vtabsquare.com
```

#### 6. Restart Services
```bash
pm2 restart all
pm2 save
```

#### 7. Verify Nginx (Already Updated)
```bash
# Check current config
sudo nginx -t

# If needed, update /etc/nginx/sites-available/testofficeportal
# server_name should be: officehub360.vtabsquare.com

# Reload nginx
sudo systemctl reload nginx
```

---

## 🔐 External Services to Update

### 1. Google OAuth Console
- Navigate to: https://console.cloud.google.com/apis/credentials
- Add authorized redirect URI:
  ```
  https://officehub360.vtabsquare.com/google/oauth2callback
  ```

### 2. Azure AD / Microsoft Dataverse (if applicable)
- Add allowed origin: `https://officehub360.vtabsquare.com`
- Add redirect URI if configured

### 3. DNS & SSL
- Ensure DNS A/CNAME record points to server IP
- SSL certificate should cover `officehub360.vtabsquare.com`
- Verify subdomains:
  - `api.officehub360.vtabsquare.com`
  - `socket.officehub360.vtabsquare.com`

---

## 🧪 Testing Checklist

After deployment, verify:

- [ ] Homepage loads at `https://officehub360.vtabsquare.com`
- [ ] Login redirects to FaceAuth
- [ ] Face verification completes successfully
- [ ] Callback returns to OfficeHub360 dashboard
- [ ] Admin can access FaceAuth admin via sidebar button
- [ ] FaceAuth admin SSO works without errors
- [ ] Socket connections work (real-time features)
- [ ] Google OAuth login works (if enabled)
- [ ] Password reset emails contain correct domain
- [ ] All API calls succeed (check browser console)

---

## 🔑 Key Technical Details

### JWT Secret Synchronization
Both apps share the same JWT secret for token validation:
```
JWT_SECRET=f7671ea136486276dfee0bc1f6d5079b898e767cdaea80f18f68a09e57abe3687fd58871072ce85ffbb22442d9216abff62c0dd611c2...
JWT_ALGORITHM=HS512
```

### Dynamic Callback URL
FaceAuth doesn't hardcode domains. It uses the `callback_url` parameter:
```python
# In FaceAuth app.py
callback_url = session.get('callback_url')  # From HR Tool
redirect_url = f"{callback_url}?token={new_token}&face_verified=true"
```

### Admin SSO Token
- Generated by HR Tool backend
- Short expiry (15 minutes)
- Includes admin claims: `is_admin: true`, `purpose: "admin_sso"`
- Validated by FaceAuth using shared JWT secret

---

## 📝 Files Modified

### HR Tool Repository
```
backend/unified_server.py          - Added admin SSO token endpoint
index.js                           - Updated FaceAuth admin button handler
deploy/id.env.template             - Updated domain references
deploy/ecosystem.config.cjs        - Updated PM2 env vars
deploy/nginx.conf                  - Updated server_name directives
deploy/socket-server.env.template  - Updated CORS origins
```

### FaceAuth Repository
```
.env                               - No changes needed (dynamic callback)
```

---

## 🚨 Rollback Plan

If issues occur:

1. **Revert backend env:**
   ```bash
   # Change back to old domain in backend/id.env
   FRONTEND_BASE_URL=https://officeportal.vtabsquare.com
   ```

2. **Restart services:**
   ```bash
   pm2 restart all
   ```

3. **Update DNS if needed:**
   - Point `officehub360.vtabsquare.com` back to old server
   - Or update Nginx to redirect to old domain

---

## 📞 Support Contacts

- **HR Tool Issues:** Check backend logs: `pm2 logs office-backend`
- **FaceAuth Issues:** Check FaceAuth logs on Digital Ocean
- **DNS/SSL Issues:** Check domain registrar and SSL provider
- **Google OAuth:** Check Google Cloud Console

---

## ✅ Final Status

**Ready for Production Deployment**

All code changes completed and tested locally. Deployment templates updated. Integration flow verified. External service updates documented.

**Next Steps:**
1. Pull latest code on server
2. Update environment variables
3. Build frontend
4. Restart services
5. Test end-to-end flow
6. Update external services (Google OAuth, etc.)

---

*Document generated: May 25, 2026*
