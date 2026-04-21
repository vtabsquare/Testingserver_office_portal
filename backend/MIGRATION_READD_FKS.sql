-- ============================================================================
-- STEP 2: Run this AFTER data migration completes
-- Re-adds all FK and unique constraints
-- ====================AA========================================================

-- FK constraints
-- NOTE: Using NOT VALID because existing data has crc6f_userid = 'USER-xxx' 
-- which doesn't match crc6f_employeeid = 'EMP-xxx' in employees table.
-- This FK will enforce on future inserts only. Consider dropping it entirely if not needed.
ALTER TABLE crc6f_hr_login_detailses ADD CONSTRAINT fk_login_employee 
    FOREIGN KEY (crc6f_userid) REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE SET NULL NOT VALID;

ALTER TABLE crc6f_table13s ADD CONSTRAINT fk_attendance_employee 
    FOREIGN KEY (crc6f_employeeid) REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE CASCADE NOT VALID;

ALTER TABLE crc6f_table14s ADD CONSTRAINT fk_leave_employee 
    FOREIGN KEY (crc6f_employeeid) REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE CASCADE NOT VALID;
ALTER TABLE crc6f_table14s ADD CONSTRAINT fk_leave_approver 
    FOREIGN KEY (crc6f_approvedby) REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE SET NULL NOT VALID;

ALTER TABLE crc6f_hr_leavemangements ADD CONSTRAINT fk_leavebalance_employee 
    FOREIGN KEY (crc6f_employeeid) REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE CASCADE NOT VALID;

ALTER TABLE crc6f_compensatoryrequests ADD CONSTRAINT fk_compoff_employee 
    FOREIGN KEY (crc6f_employeeid) REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE CASCADE NOT VALID;
ALTER TABLE crc6f_compensatoryrequests ADD CONSTRAINT fk_compoff_approver 
    FOREIGN KEY (crc6f_approvedby) REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE SET NULL NOT VALID;

ALTER TABLE crc6f_hr_assetdetailses ADD CONSTRAINT fk_asset_employee 
    FOREIGN KEY (crc6f_employeeid) REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE SET NULL NOT VALID;

ALTER TABLE crc6f_hr_projectheaders ADD CONSTRAINT fk_project_client 
    FOREIGN KEY (crc6f_client) REFERENCES crc6f_hr_clients(crc6f_clientid) ON DELETE SET NULL NOT VALID;
ALTER TABLE crc6f_hr_projectheaders ADD CONSTRAINT fk_project_manager 
    FOREIGN KEY (crc6f_manager) REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE SET NULL NOT VALID;

ALTER TABLE crc6f_hr_projectdetailses ADD CONSTRAINT fk_board_project 
    FOREIGN KEY (crc6f_projectid) REFERENCES crc6f_hr_projectheaders(crc6f_projectid) ON DELETE CASCADE NOT VALID;

ALTER TABLE crc6f_hr_taskdetailses ADD CONSTRAINT fk_task_project 
    FOREIGN KEY (crc6f_projectid) REFERENCES crc6f_hr_projectheaders(crc6f_projectid) ON DELETE CASCADE NOT VALID;
ALTER TABLE crc6f_hr_taskdetailses ADD CONSTRAINT fk_task_board 
    FOREIGN KEY (crc6f_boardid) REFERENCES crc6f_hr_projectdetailses(crc6f_boardid) ON DELETE CASCADE NOT VALID;
ALTER TABLE crc6f_hr_taskdetailses ADD CONSTRAINT fk_task_assignee 
    FOREIGN KEY (crc6f_assignedto) REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE SET NULL NOT VALID;

ALTER TABLE crc6f_hr_projectcontributorses ADD CONSTRAINT fk_contributor_employee 
    FOREIGN KEY (crc6f_employeeid) REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE CASCADE NOT VALID;
ALTER TABLE crc6f_hr_projectcontributorses ADD CONSTRAINT fk_contributor_project 
    FOREIGN KEY (crc6f_projectid) REFERENCES crc6f_hr_projectheaders(crc6f_projectid) ON DELETE CASCADE NOT VALID;

ALTER TABLE crc6f_hr_timesheetlogs ADD CONSTRAINT fk_timesheet_employee 
    FOREIGN KEY (crc6f_employeeid) REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE CASCADE NOT VALID;
ALTER TABLE crc6f_hr_timesheetlogs ADD CONSTRAINT fk_timesheet_project 
    FOREIGN KEY (crc6f_projectid) REFERENCES crc6f_hr_projectheaders(crc6f_projectid) ON DELETE SET NULL NOT VALID;

ALTER TABLE crc6f_hr_chat_conversations ADD CONSTRAINT fk_conversation_creator 
    FOREIGN KEY (crc6f_created_by) REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE SET NULL NOT VALID;

ALTER TABLE crc6f_hr_conversation_memberses ADD CONSTRAINT fk_member_conversation 
    FOREIGN KEY (crc6f_conversation_id) REFERENCES crc6f_hr_chat_conversations(crc6f_conversationid) ON DELETE CASCADE NOT VALID;
ALTER TABLE crc6f_hr_conversation_memberses ADD CONSTRAINT fk_member_user 
    FOREIGN KEY (crc6f_user_id) REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE CASCADE NOT VALID;

ALTER TABLE crc6f_hr_messageses ADD CONSTRAINT fk_message_conversation 
    FOREIGN KEY (crc6f_conversation_id) REFERENCES crc6f_hr_chat_conversations(crc6f_conversationid) ON DELETE CASCADE NOT VALID;
ALTER TABLE crc6f_hr_messageses ADD CONSTRAINT fk_message_sender 
    FOREIGN KEY (crc6f_sender_id) REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE CASCADE NOT VALID;

ALTER TABLE crc6f_hr_messagestatuses ADD CONSTRAINT fk_msgstatus_message 
    FOREIGN KEY (crc6f_message_id) REFERENCES crc6f_hr_messageses(crc6f_message_id) ON DELETE CASCADE NOT VALID;
ALTER TABLE crc6f_hr_messagestatuses ADD CONSTRAINT fk_msgstatus_user 
    FOREIGN KEY (crc6f_user_id) REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE CASCADE NOT VALID;

ALTER TABLE crc6f_hr_interndetailses ADD CONSTRAINT fk_intern_employee 
    FOREIGN KEY (crc6f_employeeid) REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE SET NULL NOT VALID;

ALTER TABLE crc6f_hierarchies ADD CONSTRAINT fk_hierarchy_employee 
    FOREIGN KEY (crc6f_employeeid) REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE CASCADE NOT VALID;
ALTER TABLE crc6f_hierarchies ADD CONSTRAINT fk_hierarchy_manager 
    FOREIGN KEY (crc6f_managerid) REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE CASCADE NOT VALID;

ALTER TABLE crc6f_hr_loginactivitytbs ADD CONSTRAINT fk_loginactivity_employee 
    FOREIGN KEY (crc6f_employeeid) REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE CASCADE NOT VALID;

ALTER TABLE crc6f_hr_inboxes ADD CONSTRAINT fk_inbox_employee 
    FOREIGN KEY (crc6f_employeeid) REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE CASCADE NOT VALID;

ALTER TABLE crc6f_hr_projectcolumns ADD CONSTRAINT fk_column_board 
    FOREIGN KEY (crc6f_boardid) REFERENCES crc6f_hr_projectdetailses(crc6f_boardid) ON DELETE CASCADE NOT VALID;

-- Unique constraints
ALTER TABLE crc6f_hr_projectcontributorses ADD CONSTRAINT uq_contributor_employee_project 
    UNIQUE (crc6f_employeeid, crc6f_projectid);
ALTER TABLE crc6f_hr_conversation_memberses ADD CONSTRAINT uq_conversation_member 
    UNIQUE (crc6f_conversation_id, crc6f_user_id);
ALTER TABLE crc6f_hr_messagestatuses ADD CONSTRAINT uq_message_user_status 
    UNIQUE (crc6f_message_id, crc6f_user_id);
ALTER TABLE crc6f_hr_loginactivitytbs ADD CONSTRAINT uq_loginactivity_employee_date 
    UNIQUE (crc6f_employeeid, crc6f_date);
ALTER TABLE crc6f_table13s ADD CONSTRAINT uq_attendance_employee_date 
    UNIQUE (crc6f_employeeid, crc6f_date);
ALTER TABLE crc6f_hr_leavemangements ADD CONSTRAINT uq_leavebalance_employee 
    UNIQUE (crc6f_employeeid);
ALTER TABLE crc6f_hierarchies ADD CONSTRAINT uq_hierarchy_employee_manager 
    UNIQUE (crc6f_employeeid, crc6f_managerid);

SELECT 'All FK and unique constraints re-added successfully.' AS status;
