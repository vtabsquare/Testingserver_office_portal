-- ============================================================================
-- Drop over-strict FK constraints on the Projects / Tasks / Contributors
-- tables. Dataverse (the original source) never enforced these FKs, so the
-- application stores human-readable strings (e.g. client name, employee
-- full name) in these columns. Leaving the FK constraints in place blocks
-- legitimate creates with errors like:
--   23503 "violates foreign key constraint fk_project_client"
--   23503 "violates foreign key constraint fk_task_assignee"
--
-- Safe to run multiple times; non-destructive (no TRUNCATE).
-- ============================================================================

-- Projects
ALTER TABLE crc6f_hr_projectheaders DROP CONSTRAINT IF EXISTS fk_project_client;
ALTER TABLE crc6f_hr_projectheaders DROP CONSTRAINT IF EXISTS fk_project_manager;

-- Boards
ALTER TABLE crc6f_hr_projectdetailses DROP CONSTRAINT IF EXISTS fk_board_project;

-- Tasks
ALTER TABLE crc6f_hr_taskdetailses DROP CONSTRAINT IF EXISTS fk_task_project;
ALTER TABLE crc6f_hr_taskdetailses DROP CONSTRAINT IF EXISTS fk_task_board;
ALTER TABLE crc6f_hr_taskdetailses DROP CONSTRAINT IF EXISTS fk_task_assignee;

-- Contributors
ALTER TABLE crc6f_hr_projectcontributorses DROP CONSTRAINT IF EXISTS fk_contributor_employee;
ALTER TABLE crc6f_hr_projectcontributorses DROP CONSTRAINT IF EXISTS fk_contributor_project;

-- Timesheet references projects too
ALTER TABLE crc6f_hr_timesheetlogs DROP CONSTRAINT IF EXISTS fk_timesheet_project;

-- Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';

SELECT 'Projects-module FK constraints dropped.' AS status;
