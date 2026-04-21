-- ============================================================================
-- Projects module schema fixes (Supabase).
-- Safe to run multiple times.
--
-- Fixes:
--   1. PGRST204 on task create  - missing crc6f_tasktype column
--   2. PGRST204 on project create - column is crc6f_description but code
--      sends crc6f_projectdescription (Dataverse name)
-- ============================================================================

-- 1. Task type column
ALTER TABLE crc6f_hr_taskdetailses
    ADD COLUMN IF NOT EXISTS crc6f_tasktype VARCHAR(50) DEFAULT 'Task';

-- 2. Rename crc6f_description -> crc6f_projectdescription on project headers.
--    If the target column already exists we do nothing. Otherwise rename in
--    place to preserve existing data.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'crc6f_hr_projectheaders'
          AND column_name = 'crc6f_description'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'crc6f_hr_projectheaders'
          AND column_name = 'crc6f_projectdescription'
    ) THEN
        ALTER TABLE crc6f_hr_projectheaders
            RENAME COLUMN crc6f_description TO crc6f_projectdescription;
    END IF;
END $$;

-- Ensure column exists (if table was created fresh without it).
ALTER TABLE crc6f_hr_projectheaders
    ADD COLUMN IF NOT EXISTS crc6f_projectdescription TEXT;

-- Refresh PostgREST schema cache so new/renamed columns are visible immediately.
NOTIFY pgrst, 'reload schema';
