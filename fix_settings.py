import re

files = [
    ("pages/shiftSettings.js", "shift_settings", "manage_shift_settings", "Shift Settings is only accessible to administrators."),
    ("pages/loginSettings.js", "login_settings", "manage_login_settings", "Login Settings is only accessible to administrators, managers, and team leads."),
    ("pages/faceAuthSettings.js", "faceauth_settings", "manage_faceauth_settings", "Only administrators can access FaceAuth settings."),
    ("pages/leaveSettings.js", "leave_settings", "manage_leave_settings", "Leave Settings is only accessible to administrators."),
    ("pages/roleSettings.js", "role_settings", "manage_role_settings", "Only administrators can access Role Settings.")
]

for file_path, app, func, text in files:
    full_path = r"c:\Users\91733\Documents\Office_portal-dynamic settings\Testingserver_office_portal\\" + file_path.replace("/", "\\")
    with open(full_path, "r", encoding="utf-8", errors="surrogateescape") as f:
        content = f.read()
    
    # 1. Import canViewApplication
    import_match = re.search(r"import\s+\{([^}]*)\}\s+from\s+['\"]../utils/roleSettings.js['\"];", content)
    if import_match:
        imports = [i.strip() for i in import_match.group(1).split(",")]
        if "canViewApplication" not in imports:
            imports.append("canViewApplication")
            new_import = "import { " + ", ".join(imports) + " } from '../utils/roleSettings.js';"
            content = content.replace(import_match.group(0), new_import)
    else:
        # If no roleSettings import, maybe add it
        pass

    # 2. Fix the condition
    cond_str = f"!canUseFunction('{func}')"
    new_cond_str = f"!canUseFunction('{func}') && !canViewApplication('{app}')"
    # Ensure not to replace if already there
    if new_cond_str not in content:
        content = content.replace(cond_str, new_cond_str)
        # Also handle potential whitespace
        content = content.replace(f"!canUseFunction('{func}')", new_cond_str)
        
    # Also handle some edge cases if the previous replacement messed it up
    content = content.replace(f"!canUseFunction('{func}') && !canViewApplication('{app}') && !canViewApplication('{app}')", new_cond_str)

    # 3. Fix the text
    new_text = "You don't have permission to manage these settings. Please ask your administrator to grant you access."
    content = content.replace(text, new_text)
    
    # Also remove that extra </div></div> that might have been added to shiftSettings
    if file_path == "pages/shiftSettings.js":
        content = content.replace("</div>    </div>\n            </div>", "</div>\n            </div>")
        content = content.replace("</div>    </div>", "</div>")

    # For login settings there's an extra note:
    content = content.replace('<p class="access-denied-note">Please contact your administrator if you need access.</p>', '')
    content = content.replace('<p style="color: var(--text-secondary); margin-top: 8px; font-size: 14px;">Please contact your administrator if you need access.</p>', '')
    
    with open(full_path, "w", encoding="utf-8", errors="surrogateescape") as f:
        f.write(content)
    print(f"Updated {file_path}")

