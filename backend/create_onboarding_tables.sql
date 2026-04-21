-- ============================================================================
-- ONBOARDING MODULE - Supabase Tables
-- Creates the missing onboarding and progress log tables
-- ============================================================================

-- 1. ONBOARDING RECORDS
CREATE TABLE IF NOT EXISTS crc6f_hr_onboardings (
    crc6f_hr_onboardingid UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    crc6f_firstname VARCHAR(100),
    crc6f_lastname VARCHAR(100),
    crc6f_email VARCHAR(255),
    crc6f_contactno VARCHAR(50),
    crc6f_address TEXT,
    crc6f_department VARCHAR(100),
    crc6f_designation VARCHAR(100),
    crc6f_doj DATE,
    crc6f_progresssteps VARCHAR(100) DEFAULT 'Personal Information',
    crc6f_interviewstatus VARCHAR(50),
    crc6f_interviewdate VARCHAR(100),
    crc6f_offerpmail VARCHAR(50) DEFAULT 'Not Sent',
    crc6f_offerpmailreply VARCHAR(50) DEFAULT 'Pending',
    crc6f_documentsstatus VARCHAR(50) DEFAULT 'Pending',
    crc6f_documentsuploaded TEXT,
    crc6f_onboardingid VARCHAR(50),
    crc6f_convertedtoemployee BOOLEAN DEFAULT FALSE,
    metadata JSONB,
    createdon TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    modifiedon TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_onboardings_email ON crc6f_hr_onboardings(crc6f_email);
CREATE INDEX IF NOT EXISTS idx_onboardings_firstname ON crc6f_hr_onboardings(crc6f_firstname);
CREATE INDEX IF NOT EXISTS idx_onboardings_lastname ON crc6f_hr_onboardings(crc6f_lastname);
CREATE INDEX IF NOT EXISTS idx_onboardings_progresssteps ON crc6f_hr_onboardings(crc6f_progresssteps);
CREATE INDEX IF NOT EXISTS idx_onboardings_createdon ON crc6f_hr_onboardings(createdon);

-- 2. ONBOARDING PROGRESS LOGS (audit trail)
CREATE TABLE IF NOT EXISTS crc6f_hr_onboardingprogresslogs (
    crc6f_hr_onboardingprogresslogid UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    crc6f_onboardingid UUID,
    crc6f_stagename VARCHAR(200),
    crc6f_progresssteps VARCHAR(200),
    crc6f_stagenumber INTEGER,
    crc6f_refid INTEGER,
    crc6f_completedat TIMESTAMPTZ,
    crc6f_timestamps TIMESTAMPTZ,
    crc6f_notes TEXT,
    createdby VARCHAR(100),
    metadata JSONB,
    createdon TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ,
    CONSTRAINT fk_progresslog_onboarding FOREIGN KEY (crc6f_onboardingid)
        REFERENCES crc6f_hr_onboardings(crc6f_hr_onboardingid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_progresslogs_onboardingid ON crc6f_hr_onboardingprogresslogs(crc6f_onboardingid);
CREATE INDEX IF NOT EXISTS idx_progresslogs_stagenumber ON crc6f_hr_onboardingprogresslogs(crc6f_stagenumber);
CREATE INDEX IF NOT EXISTS idx_progresslogs_completedat ON crc6f_hr_onboardingprogresslogs(crc6f_completedat);

-- Enable RLS
ALTER TABLE crc6f_hr_onboardings ENABLE ROW LEVEL SECURITY;
ALTER TABLE crc6f_hr_onboardingprogresslogs ENABLE ROW LEVEL SECURITY;

-- Allow full access (same policy pattern as other tables)
CREATE POLICY "Service role has full access to crc6f_hr_onboardings"
    ON crc6f_hr_onboardings FOR ALL USING (true);
CREATE POLICY "Service role has full access to crc6f_hr_onboardingprogresslogs"
    ON crc6f_hr_onboardingprogresslogs FOR ALL USING (true);

-- Auto-update triggers
DROP TRIGGER IF EXISTS update_crc6f_hr_onboardings_updated_at ON crc6f_hr_onboardings;
CREATE TRIGGER update_crc6f_hr_onboardings_updated_at
    BEFORE UPDATE ON crc6f_hr_onboardings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_crc6f_hr_onboardingprogresslogs_updated_at ON crc6f_hr_onboardingprogresslogs;
CREATE TRIGGER update_crc6f_hr_onboardingprogresslogs_updated_at
    BEFORE UPDATE ON crc6f_hr_onboardingprogresslogs
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Also auto-update modifiedon for the onboarding table
CREATE OR REPLACE FUNCTION update_modifiedon_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.modifiedon = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_crc6f_hr_onboardings_modifiedon ON crc6f_hr_onboardings;
CREATE TRIGGER update_crc6f_hr_onboardings_modifiedon
    BEFORE UPDATE ON crc6f_hr_onboardings
    FOR EACH ROW
    EXECUTE FUNCTION update_modifiedon_column();
