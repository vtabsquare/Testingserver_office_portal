"""
Additive fix for the role_permissions table: the 'permission' (Permission /
short-leave module) application key was never seeded for any role, so
non-admin users never saw the "Permission" sidebar link (admins only saw it
because of the L3 bypass in canViewApplication()). This inserts/enables the
missing rows for every role WITHOUT touching any other existing rows/
customizations (unlike /api/role-permissions/seed, which wipes everything).

Usage:
    python add_permission_role_access.py
"""
from supabase_helper import get_supabase

ROLES = ["L1", "L2", "L3", "L4"]


def main():
    sb = get_supabase()

    for role in ROLES:
        existing = (
            sb.table("role_permissions")
            .select("id")
            .eq("role_key", role)
            .eq("permission_type", "application")
            .eq("permission_key", "permission")
            .execute()
        )
        rows = existing.data or []
        if rows:
            record_id = rows[0]["id"]
            sb.table("role_permissions").update({"enabled": True}).eq("id", record_id).execute()
            print(f"[OK] {role}: updated existing row -> enabled=True")
        else:
            sb.table("role_permissions").insert({
                "role_key": role,
                "permission_type": "application",
                "permission_key": "permission",
                "enabled": True,
            }).execute()
            print(f"[OK] {role}: inserted new row -> enabled=True")

    print("\n[DONE] 'permission' application is now enabled for all roles.")


if __name__ == "__main__":
    main()
