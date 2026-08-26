-- ============================================================================
-- PERMISSION COMPENSATION - add columns to crc6f_permissions
-- Lets an employee mark a permission as "Compensate Today" or "Compensate
-- This Week" (on a chosen makeup day), extending that day's expected
-- checkout by the owed hours until fulfilled.
-- ============================================================================

ALTER TABLE crc6f_permissions
    ADD COLUMN IF NOT EXISTS crc6f_compensationmode VARCHAR(20) DEFAULT 'none',
    ADD COLUMN IF NOT EXISTS crc6f_makeupdate DATE,
    ADD COLUMN IF NOT EXISTS crc6f_compensationhours NUMERIC(5,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS crc6f_compensated BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS crc6f_compensatedat TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_crc6f_permissions_makeupdate ON crc6f_permissions(crc6f_makeupdate);
CREATE INDEX IF NOT EXISTS idx_crc6f_permissions_compensated ON crc6f_permissions(crc6f_compensated);
