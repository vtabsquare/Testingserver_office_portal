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

-- 3. Asset register: add missing crc6f_client column (Dataverse had it; the
--    Supabase migration dropped it). Frontend pages/assets.js sends this
--    field when saving an asset, producing PGRST204 "Could not find the
--    'crc6f_client' column of 'crc6f_hr_assetdetailses' in the schema cache".
ALTER TABLE crc6f_hr_assetdetailses
    ADD COLUMN IF NOT EXISTS crc6f_client VARCHAR(200);

-- 4. Leave approval comments: crc6f_table14s is missing crc6f_approvalcomments.
--    Used by /api/leaves/approve/<id> when an approver types a comment.
--    Without this column, approval fails with PGRST204.
ALTER TABLE crc6f_table14s
    ADD COLUMN IF NOT EXISTS crc6f_approvalcomments VARCHAR(200);

-- 5. Compensatory Off requests (crc6f_compensatoryrequests)
--    Schema is missing several fields the /api/comp-off/requests POST sends:
--      - crc6f_totaldays   (integer, e.g. 1)
--      - crc6f_dateworked  (DATE)
--      - crc6f_applieddate (DATE)
--    Additionally, crc6f_workdate is declared NOT NULL but the code never
--    sends it (it uses crc6f_dateworked instead), so the column must be
--    nullable to allow inserts. Without these changes comp-off creation
--    fails with PGRST204 or 23502 NOT NULL violations.
ALTER TABLE crc6f_compensatoryrequests
    ADD COLUMN IF NOT EXISTS crc6f_totaldays INTEGER DEFAULT 1;
ALTER TABLE crc6f_compensatoryrequests
    ADD COLUMN IF NOT EXISTS crc6f_dateworked DATE;
ALTER TABLE crc6f_compensatoryrequests
    ADD COLUMN IF NOT EXISTS crc6f_applieddate DATE;
ALTER TABLE crc6f_compensatoryrequests
    ALTER COLUMN crc6f_workdate DROP NOT NULL;

-- Idempotency flag: set to TRUE once an approved request has successfully
-- credited the employee's comp-off balance. Prevents double-credit on retry.
ALTER TABLE crc6f_compensatoryrequests
    ADD COLUMN IF NOT EXISTS crc6f_credited BOOLEAN DEFAULT FALSE;

-- 6. Retroactive credit for previously-approved comp-off requests that never
--    credited the balance due to an earlier silent failure. For every
--    Approved row where crc6f_credited IS NOT TRUE, add its total days to
--    the employee's comp-off balance and flip the flag. Safe to run multiple
--    times (flag makes it idempotent).
DO $$
DECLARE
    r RECORD;
    v_days INTEGER;
BEGIN
    FOR r IN
        SELECT crc6f_compensatoryrequestid, crc6f_employeeid,
               COALESCE(crc6f_totaldays, 1) AS days
        FROM crc6f_compensatoryrequests
        WHERE LOWER(COALESCE(crc6f_status, '')) = 'approved'
          AND COALESCE(crc6f_credited, FALSE) = FALSE
          AND crc6f_employeeid IS NOT NULL
    LOOP
        v_days := GREATEST(COALESCE(r.days, 1), 1);

        -- Ensure a balance row exists
        INSERT INTO crc6f_hr_leavemangements
            (crc6f_employeeid, crc6f_empid, crc6f_cl, crc6f_sl, crc6f_compoff,
             crc6f_total, crc6f_actualtotal)
        VALUES (r.crc6f_employeeid, r.crc6f_employeeid, 0, 0, 0, 0, 0)
        ON CONFLICT (crc6f_employeeid) DO NOTHING;

        -- Add the credited days to crc6f_compoff and recompute totals
        UPDATE crc6f_hr_leavemangements
        SET crc6f_compoff = COALESCE(crc6f_compoff, 0) + v_days,
            crc6f_total = COALESCE(crc6f_cl, 0) + COALESCE(crc6f_sl, 0)
                          + COALESCE(crc6f_compoff, 0) + v_days,
            crc6f_actualtotal = COALESCE(crc6f_cl, 0) + COALESCE(crc6f_sl, 0)
                                 + COALESCE(crc6f_compoff, 0) + v_days
        WHERE crc6f_employeeid = r.crc6f_employeeid;

        UPDATE crc6f_compensatoryrequests
        SET crc6f_credited = TRUE
        WHERE crc6f_compensatoryrequestid = r.crc6f_compensatoryrequestid;
    END LOOP;
END $$;

-- Refresh PostgREST schema cache so new/renamed columns are visible immediately.
NOTIFY pgrst, 'reload schema';
