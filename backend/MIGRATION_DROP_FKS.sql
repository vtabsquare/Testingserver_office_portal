-- ============================================================================
-- STEP 1: Run this BEFORE data migration
-- Temporarily drops all FK constraints to allow unrestricted data insertion
-- ============================================================================

-- First, clear any previously migrated data (employees already inserted)
TRUNCATE TABLE crc6f_hr_messagestatuses CASCADE;
TRUNCATE TABLE crc6f_hr_messageses CASCADE;
TRUNCATE TABLE crc6f_hr_conversation_memberses CASCADE;
TRUNCATE TABLE crc6f_hr_chat_conversations CASCADE;
TRUNCATE TABLE crc6f_hr_timesheetlogs CASCADE;
TRUNCATE TABLE crc6f_hr_projectcontributorses CASCADE;
TRUNCATE TABLE crc6f_hr_taskdetailses CASCADE;
TRUNCATE TABLE crc6f_hr_projectdetailses CASCADE;
TRUNCATE TABLE crc6f_hr_projectcolumns CASCADE;
TRUNCATE TABLE crc6f_hr_projectheaders CASCADE;
TRUNCATE TABLE crc6f_hr_assetdetailses CASCADE;
TRUNCATE TABLE crc6f_compensatoryrequests CASCADE;
TRUNCATE TABLE crc6f_hr_leavemangements CASCADE;
TRUNCATE TABLE crc6f_table14s CASCADE;
TRUNCATE TABLE crc6f_table13s CASCADE;
TRUNCATE TABLE crc6f_hr_login_detailses CASCADE;
TRUNCATE TABLE crc6f_hr_interndetailses CASCADE;
TRUNCATE TABLE crc6f_hierarchies CASCADE;
TRUNCATE TABLE crc6f_hr_loginactivitytbs CASCADE;
TRUNCATE TABLE crc6f_hr_inboxes CASCADE;
TRUNCATE TABLE crc6f_table12s CASCADE;

-- Drop all FK constraints
ALTER TABLE crc6f_hr_login_detailses DROP CONSTRAINT IF EXISTS fk_login_employee;
ALTER TABLE crc6f_table13s DROP CONSTRAINT IF EXISTS fk_attendance_employee;
ALTER TABLE crc6f_table14s DROP CONSTRAINT IF EXISTS fk_leave_employee;
ALTER TABLE crc6f_table14s DROP CONSTRAINT IF EXISTS fk_leave_approver;
ALTER TABLE crc6f_hr_leavemangements DROP CONSTRAINT IF EXISTS fk_leavebalance_employee;
ALTER TABLE crc6f_compensatoryrequests DROP CONSTRAINT IF EXISTS fk_compoff_employee;
ALTER TABLE crc6f_compensatoryrequests DROP CONSTRAINT IF EXISTS fk_compoff_approver;
ALTER TABLE crc6f_hr_assetdetailses DROP CONSTRAINT IF EXISTS fk_asset_employee;
ALTER TABLE crc6f_hr_projectheaders DROP CONSTRAINT IF EXISTS fk_project_client;
ALTER TABLE crc6f_hr_projectheaders DROP CONSTRAINT IF EXISTS fk_project_manager;
ALTER TABLE crc6f_hr_projectdetailses DROP CONSTRAINT IF EXISTS fk_board_project;
ALTER TABLE crc6f_hr_taskdetailses DROP CONSTRAINT IF EXISTS fk_task_project;
ALTER TABLE crc6f_hr_taskdetailses DROP CONSTRAINT IF EXISTS fk_task_board;
ALTER TABLE crc6f_hr_taskdetailses DROP CONSTRAINT IF EXISTS fk_task_assignee;
ALTER TABLE crc6f_hr_projectcontributorses DROP CONSTRAINT IF EXISTS fk_contributor_employee;
ALTER TABLE crc6f_hr_projectcontributorses DROP CONSTRAINT IF EXISTS fk_contributor_project;
ALTER TABLE crc6f_hr_timesheetlogs DROP CONSTRAINT IF EXISTS fk_timesheet_employee;
ALTER TABLE crc6f_hr_timesheetlogs DROP CONSTRAINT IF EXISTS fk_timesheet_project;
ALTER TABLE crc6f_hr_chat_conversations DROP CONSTRAINT IF EXISTS fk_conversation_creator;
ALTER TABLE crc6f_hr_conversation_memberses DROP CONSTRAINT IF EXISTS fk_member_conversation;
ALTER TABLE crc6f_hr_conversation_memberses DROP CONSTRAINT IF EXISTS fk_member_user;
ALTER TABLE crc6f_hr_messageses DROP CONSTRAINT IF EXISTS fk_message_conversation;
ALTER TABLE crc6f_hr_messageses DROP CONSTRAINT IF EXISTS fk_message_sender;
ALTER TABLE crc6f_hr_messagestatuses DROP CONSTRAINT IF EXISTS fk_msgstatus_message;
ALTER TABLE crc6f_hr_messagestatuses DROP CONSTRAINT IF EXISTS fk_msgstatus_user;
ALTER TABLE crc6f_hr_interndetailses DROP CONSTRAINT IF EXISTS fk_intern_employee;
ALTER TABLE crc6f_hierarchies DROP CONSTRAINT IF EXISTS fk_hierarchy_employee;
ALTER TABLE crc6f_hierarchies DROP CONSTRAINT IF EXISTS fk_hierarchy_manager;
ALTER TABLE crc6f_hr_loginactivitytbs DROP CONSTRAINT IF EXISTS fk_loginactivity_employee;
ALTER TABLE crc6f_hr_inboxes DROP CONSTRAINT IF EXISTS fk_inbox_employee;
ALTER TABLE crc6f_hr_projectcolumns DROP CONSTRAINT IF EXISTS fk_column_board;

-- Also drop unique constraints that might cause issues with duplicate data
ALTER TABLE crc6f_hr_projectcontributorses DROP CONSTRAINT IF EXISTS uq_contributor_employee_project;
ALTER TABLE crc6f_hr_conversation_memberses DROP CONSTRAINT IF EXISTS uq_conversation_member;
ALTER TABLE crc6f_hr_messagestatuses DROP CONSTRAINT IF EXISTS uq_message_user_status;
ALTER TABLE crc6f_hr_loginactivitytbs DROP CONSTRAINT IF EXISTS uq_loginactivity_employee_date;
ALTER TABLE crc6f_table13s DROP CONSTRAINT IF EXISTS uq_attendance_employee_date;
ALTER TABLE crc6f_hr_leavemangements DROP CONSTRAINT IF EXISTS uq_leavebalance_employee;
ALTER TABLE crc6f_hierarchies DROP CONSTRAINT IF EXISTS uq_hierarchy_employee_manager;

SELECT 'All FK and unique constraints dropped. Ready for migration.' AS status;
