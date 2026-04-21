-- ============================================================================
-- Adds the missing crc6f_tasktype column to crc6f_hr_taskdetailses
-- Fixes: PGRST204 "Could not find the 'crc6f_tasktype' column of
-- 'crc6f_hr_taskdetailses' in the schema cache" when creating a task.
-- Safe to run multiple times.
-- ============================================================================

ALTER TABLE crc6f_hr_taskdetailses
    ADD COLUMN IF NOT EXISTS crc6f_tasktype VARCHAR(50) DEFAULT 'Task';

-- Refresh PostgREST schema cache so the new column is visible immediately.
NOTIFY pgrst, 'reload schema';
