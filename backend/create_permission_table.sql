-- ============================================================================
-- PERMISSION MODULE - Supabase Table
-- Hour-based short leave ("Permission") separate from full/half-day leaves.
-- Approval is audit-only: the auto-pause scheduler acts on ANY submitted
-- permission (Pending/Approved/Rejected) once its start_time arrives.
-- ============================================================================

CREATE TABLE IF NOT EXISTS crc6f_permissions (
    crc6f_permissionid UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    crc6f_permission_code VARCHAR(50) UNIQUE,
    crc6f_employeeid VARCHAR(50) NOT NULL,
    crc6f_date DATE NOT NULL,
    crc6f_starttime TIME NOT NULL,
    crc6f_endtime TIME NOT NULL,
    crc6f_reason TEXT,
    crc6f_status VARCHAR(50) DEFAULT 'Pending',
    crc6f_approvedby VARCHAR(50),
    crc6f_approvedon TIMESTAMPTZ,
    crc6f_rejectionreason TEXT,
    -- Set once the auto-pause scheduler force-checks-out the employee at start_time.
    -- Prevents re-triggering the same permission on subsequent scheduler ticks.
    crc6f_pausedat TIMESTAMPTZ,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ,
    CONSTRAINT fk_permission_employee FOREIGN KEY (crc6f_employeeid)
        REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE CASCADE,
    CONSTRAINT chk_permission_time_order CHECK (crc6f_endtime > crc6f_starttime)
);

CREATE INDEX IF NOT EXISTS idx_crc6f_permissions_employeeid ON crc6f_permissions(crc6f_employeeid);
CREATE INDEX IF NOT EXISTS idx_crc6f_permissions_date ON crc6f_permissions(crc6f_date);
CREATE INDEX IF NOT EXISTS idx_crc6f_permissions_status ON crc6f_permissions(crc6f_status);
CREATE INDEX IF NOT EXISTS idx_crc6f_permissions_pausedat ON crc6f_permissions(crc6f_pausedat);

ALTER TABLE crc6f_permissions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'crc6f_permissions' AND policyname = 'Allow full access to crc6f_permissions') THEN
        CREATE POLICY "Allow full access to crc6f_permissions" ON crc6f_permissions FOR ALL USING (true);
    END IF;
END $$;

DROP TRIGGER IF EXISTS update_crc6f_permissions_updated_at ON crc6f_permissions;
CREATE TRIGGER update_crc6f_permissions_updated_at
    BEFORE UPDATE ON crc6f_permissions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
