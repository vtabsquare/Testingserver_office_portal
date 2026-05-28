-- ============================================================================
-- VTAB Square Office Portal - Role Permissions Migration
-- ============================================================================

CREATE TABLE IF NOT EXISTS role_permissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    role_key VARCHAR(10) NOT NULL,        -- 'L1', 'L2', 'L3', 'L4'
    permission_type VARCHAR(20) NOT NULL, -- 'application' or 'function'
    permission_key VARCHAR(100) NOT NULL, -- e.g. 'admin_dashboard', 'manage_leave_settings'
    enabled BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ,
    CONSTRAINT uq_role_perm UNIQUE (role_key, permission_type, permission_key)
);

CREATE INDEX IF NOT EXISTS idx_role_permissions_role_key ON role_permissions(role_key);
CREATE INDEX IF NOT EXISTS idx_role_permissions_type ON role_permissions(permission_type);

-- Auto-update updated_at timestamp
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'update_role_permissions_updated_at'
    ) THEN
        CREATE TRIGGER update_role_permissions_updated_at
            BEFORE UPDATE ON role_permissions
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
    END IF;
END
$$;

-- Enable RLS
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'Service role has full access to role_permissions'
    ) THEN
        CREATE POLICY "Service role has full access to role_permissions" ON role_permissions FOR ALL USING (true);
    END IF;
END
$$;
