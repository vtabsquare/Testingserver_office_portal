-- ============================================================================
-- VTAB Square Office Portal - Supabase PostgreSQL Schema
-- Generated from Dataverse schema analysis
-- ============================================================================
-- Run this script in Supabase SQL Editor
-- Tables are created in dependency order (parent tables first)
-- ============================================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- 1. EMPLOYEE MASTER (crc6f_table12s)
-- Core employee directory - referenced by most other tables
-- ============================================================================
CREATE TABLE IF NOT EXISTS crc6f_table12s (
    crc6f_table12id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    crc6f_employeeid VARCHAR(50) UNIQUE NOT NULL,
    crc6f_firstname VARCHAR(100),
    crc6f_lastname VARCHAR(100),
    crc6f_email VARCHAR(255),
    crc6f_contactnumber VARCHAR(50),
    crc6f_address TEXT,
    crc6f_department VARCHAR(100),
    crc6f_designation VARCHAR(100),
    crc6f_doj DATE,
    crc6f_activeflag BOOLEAN DEFAULT TRUE,
    crc6f_experience VARCHAR(50),
    crc6f_quotahours DECIMAL(10,2),
    crc6f_employeeflag VARCHAR(50),
    crc6f_profilepicture TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_crc6f_table12s_employeeid ON crc6f_table12s(crc6f_employeeid);
CREATE INDEX IF NOT EXISTS idx_crc6f_table12s_email ON crc6f_table12s(crc6f_email);
CREATE INDEX IF NOT EXISTS idx_crc6f_table12s_department ON crc6f_table12s(crc6f_department);
CREATE INDEX IF NOT EXISTS idx_crc6f_table12s_activeflag ON crc6f_table12s(crc6f_activeflag);
CREATE INDEX IF NOT EXISTS idx_crc6f_table12s_created_at ON crc6f_table12s(created_at);

-- ============================================================================
-- 2. LOGIN ACCOUNTS (crc6f_hr_login_detailses)
-- Portal credentials and access levels
-- ============================================================================
CREATE TABLE IF NOT EXISTS crc6f_hr_login_detailses (
    crc6f_hr_login_detailsid UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    crc6f_username VARCHAR(255) UNIQUE NOT NULL,
    crc6f_password VARCHAR(255) NOT NULL,
    crc6f_accesslevel VARCHAR(20) DEFAULT 'L1',
    crc6f_user_status VARCHAR(50) DEFAULT 'active',
    crc6f_loginattempts INTEGER DEFAULT 0,
    crc6f_employeename VARCHAR(200),
    crc6f_userid VARCHAR(50),
    crc6f_last_login TIMESTAMPTZ,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ,
    CONSTRAINT fk_login_employee FOREIGN KEY (crc6f_userid) 
        REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_crc6f_hr_login_detailses_username ON crc6f_hr_login_detailses(crc6f_username);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_login_detailses_userid ON crc6f_hr_login_detailses(crc6f_userid);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_login_detailses_accesslevel ON crc6f_hr_login_detailses(crc6f_accesslevel);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_login_detailses_status ON crc6f_hr_login_detailses(crc6f_user_status);

-- ============================================================================
-- 3. ATTENDANCE (crc6f_table13s)
-- Daily check-in/out tracker
-- ============================================================================
CREATE TABLE IF NOT EXISTS crc6f_table13s (
    crc6f_table13id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    crc6f_attendanceid VARCHAR(50) UNIQUE,
    crc6f_employeeid VARCHAR(50) NOT NULL,
    crc6f_date DATE NOT NULL,
    crc6f_checkin TIMESTAMPTZ,
    crc6f_checkout TIMESTAMPTZ,
    crc6f_duration DECIMAL(10,2),
    crc6f_duration_intext VARCHAR(100),
    crc6f_status VARCHAR(50),
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ,
    CONSTRAINT fk_attendance_employee FOREIGN KEY (crc6f_employeeid) 
        REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE CASCADE,
    CONSTRAINT uq_attendance_employee_date UNIQUE (crc6f_employeeid, crc6f_date)
);

CREATE INDEX IF NOT EXISTS idx_crc6f_table13s_employeeid ON crc6f_table13s(crc6f_employeeid);
CREATE INDEX IF NOT EXISTS idx_crc6f_table13s_date ON crc6f_table13s(crc6f_date);
CREATE INDEX IF NOT EXISTS idx_crc6f_table13s_checkin ON crc6f_table13s(crc6f_checkin);
CREATE INDEX IF NOT EXISTS idx_crc6f_table13s_created_at ON crc6f_table13s(created_at);

-- ============================================================================
-- 4. LEAVE REQUESTS (crc6f_table14s)
-- Leave applications with approval workflow
-- ============================================================================
CREATE TABLE IF NOT EXISTS crc6f_table14s (
    crc6f_table14id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    crc6f_leaveid VARCHAR(50) UNIQUE,
    crc6f_employeeid VARCHAR(50) NOT NULL,
    crc6f_leavetype VARCHAR(50) NOT NULL,
    crc6f_startdate DATE NOT NULL,
    crc6f_enddate DATE NOT NULL,
    crc6f_totaldays DECIMAL(5,1),
    crc6f_paidunpaid VARCHAR(20),
    crc6f_status VARCHAR(50) DEFAULT 'pending',
    crc6f_approvedby VARCHAR(50),
    crc6f_rejectionreason TEXT,
    crc6f_approvalcomments VARCHAR(200),
    crc6f_reason TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ,
    CONSTRAINT fk_leave_employee FOREIGN KEY (crc6f_employeeid) 
        REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE CASCADE,
    CONSTRAINT fk_leave_approver FOREIGN KEY (crc6f_approvedby) 
        REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_crc6f_table14s_employeeid ON crc6f_table14s(crc6f_employeeid);
CREATE INDEX IF NOT EXISTS idx_crc6f_table14s_status ON crc6f_table14s(crc6f_status);
CREATE INDEX IF NOT EXISTS idx_crc6f_table14s_startdate ON crc6f_table14s(crc6f_startdate);
CREATE INDEX IF NOT EXISTS idx_crc6f_table14s_enddate ON crc6f_table14s(crc6f_enddate);
CREATE INDEX IF NOT EXISTS idx_crc6f_table14s_leavetype ON crc6f_table14s(crc6f_leavetype);
CREATE INDEX IF NOT EXISTS idx_crc6f_table14s_created_at ON crc6f_table14s(created_at);

-- ============================================================================
-- 5. LEAVE BALANCES (crc6f_hr_leavemangements)
-- Leave quota tracking per employee
-- ============================================================================
CREATE TABLE IF NOT EXISTS crc6f_hr_leavemangements (
    crc6f_hr_leavemangementid UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    crc6f_employeeid VARCHAR(50) NOT NULL,
    crc6f_empid VARCHAR(50),
    crc6f_cl DECIMAL(5,1) DEFAULT 0,
    crc6f_sl DECIMAL(5,1) DEFAULT 0,
    crc6f_compoff DECIMAL(5,1) DEFAULT 0,
    crc6f_total DECIMAL(5,1) DEFAULT 0,
    crc6f_actualtotal DECIMAL(5,1) DEFAULT 0,
    crc6f_leaveallocationtype VARCHAR(50),
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ,
    CONSTRAINT fk_leavebalance_employee FOREIGN KEY (crc6f_employeeid) 
        REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE CASCADE,
    CONSTRAINT uq_leavebalance_employee UNIQUE (crc6f_employeeid)
);

CREATE INDEX IF NOT EXISTS idx_crc6f_hr_leavemangements_employeeid ON crc6f_hr_leavemangements(crc6f_employeeid);

-- ============================================================================
-- 6. COMPENSATORY OFF REQUESTS (crc6f_compensatoryrequests)
-- Comp-off request tracking
-- ============================================================================
CREATE TABLE IF NOT EXISTS crc6f_compensatoryrequests (
    crc6f_compensatoryrequestid UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    crc6f_employeeid VARCHAR(50) NOT NULL,
    crc6f_workdate DATE,
    crc6f_dateworked DATE,
    crc6f_applieddate DATE,
    crc6f_totaldays INTEGER DEFAULT 1,
    crc6f_reason TEXT,
    crc6f_status VARCHAR(50) DEFAULT 'pending',
    crc6f_approvedby VARCHAR(50),
    crc6f_approvedon TIMESTAMPTZ,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ,
    CONSTRAINT fk_compoff_employee FOREIGN KEY (crc6f_employeeid) 
        REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE CASCADE,
    CONSTRAINT fk_compoff_approver FOREIGN KEY (crc6f_approvedby) 
        REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_crc6f_compensatoryrequests_employeeid ON crc6f_compensatoryrequests(crc6f_employeeid);
CREATE INDEX IF NOT EXISTS idx_crc6f_compensatoryrequests_status ON crc6f_compensatoryrequests(crc6f_status);
CREATE INDEX IF NOT EXISTS idx_crc6f_compensatoryrequests_workdate ON crc6f_compensatoryrequests(crc6f_workdate);

-- ============================================================================
-- 7. ASSET REGISTER (crc6f_hr_assetdetailses)
-- Company asset inventory
-- ============================================================================
CREATE TABLE IF NOT EXISTS crc6f_hr_assetdetailses (
    crc6f_hr_assetdetailsid UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    crc6f_assetid VARCHAR(50) UNIQUE,
    crc6f_assetname VARCHAR(200) NOT NULL,
    crc6f_serialnumber VARCHAR(100),
    crc6f_assetcategory VARCHAR(100),
    crc6f_client VARCHAR(200),
    crc6f_location VARCHAR(200),
    crc6f_assetstatus VARCHAR(50) DEFAULT 'available',
    crc6f_assignedto VARCHAR(200),
    crc6f_employeeid VARCHAR(50),
    crc6f_assignedon DATE,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ,
    CONSTRAINT fk_asset_employee FOREIGN KEY (crc6f_employeeid) 
        REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_crc6f_hr_assetdetailses_assetid ON crc6f_hr_assetdetailses(crc6f_assetid);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_assetdetailses_employeeid ON crc6f_hr_assetdetailses(crc6f_employeeid);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_assetdetailses_status ON crc6f_hr_assetdetailses(crc6f_assetstatus);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_assetdetailses_category ON crc6f_hr_assetdetailses(crc6f_assetcategory);

-- ============================================================================
-- 8. HOLIDAY CALENDAR (crc6f_hr_holidayses)
-- Organization-wide holidays
-- ============================================================================
CREATE TABLE IF NOT EXISTS crc6f_hr_holidayses (
    crc6f_hr_holidaysid UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    crc6f_date DATE NOT NULL,
    crc6f_holidayname VARCHAR(200) NOT NULL,
    crc6f_description TEXT,
    crc6f_year INTEGER,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ,
    CONSTRAINT uq_holiday_date UNIQUE (crc6f_date)
);

CREATE INDEX IF NOT EXISTS idx_crc6f_hr_holidayses_date ON crc6f_hr_holidayses(crc6f_date);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_holidayses_year ON crc6f_hr_holidayses(crc6f_year);

-- ============================================================================
-- 9. CLIENT DIRECTORY (crc6f_hr_clients)
-- Customer metadata for projects
-- ============================================================================
CREATE TABLE IF NOT EXISTS crc6f_hr_clients (
    crc6f_hr_clientsid UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    crc6f_clientid VARCHAR(50) UNIQUE,
    crc6f_clientname VARCHAR(200) NOT NULL,
    crc6f_companyname VARCHAR(200),
    crc6f_email VARCHAR(255),
    crc6f_phone VARCHAR(50),
    crc6f_address TEXT,
    crc6f_country VARCHAR(100),
    createdby VARCHAR(50),
    createdon TIMESTAMPTZ,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_crc6f_hr_clients_clientid ON crc6f_hr_clients(crc6f_clientid);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_clients_clientname ON crc6f_hr_clients(crc6f_clientname);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_clients_email ON crc6f_hr_clients(crc6f_email);

-- ============================================================================
-- 10. PROJECTS (crc6f_hr_projectheaders)
-- Project records with client and manager references
-- ============================================================================
CREATE TABLE IF NOT EXISTS crc6f_hr_projectheaders (
    crc6f_hr_projectheaderid UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    crc6f_projectid VARCHAR(50) UNIQUE NOT NULL,
    crc6f_projectname VARCHAR(200) NOT NULL,
    crc6f_client VARCHAR(50),
    crc6f_manager VARCHAR(50),
    crc6f_startdate DATE,
    crc6f_enddate DATE,
    crc6f_projectstatus VARCHAR(50) DEFAULT 'active',
    crc6f_estimationcost DECIMAL(15,2),
    crc6f_noofcontributors INTEGER DEFAULT 0,
    crc6f_projectdescription TEXT,
    statecode INTEGER DEFAULT 0,
    statuscode INTEGER DEFAULT 1,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ,
    CONSTRAINT fk_project_client FOREIGN KEY (crc6f_client) 
        REFERENCES crc6f_hr_clients(crc6f_clientid) ON DELETE SET NULL,
    CONSTRAINT fk_project_manager FOREIGN KEY (crc6f_manager) 
        REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_crc6f_hr_projectheaders_projectid ON crc6f_hr_projectheaders(crc6f_projectid);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_projectheaders_client ON crc6f_hr_projectheaders(crc6f_client);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_projectheaders_manager ON crc6f_hr_projectheaders(crc6f_manager);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_projectheaders_status ON crc6f_hr_projectheaders(crc6f_projectstatus);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_projectheaders_startdate ON crc6f_hr_projectheaders(crc6f_startdate);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_projectheaders_created_at ON crc6f_hr_projectheaders(created_at);

-- ============================================================================
-- 11. PROJECT BOARDS (crc6f_hr_projectdetailses)
-- Kanban board metadata
-- ============================================================================
CREATE TABLE IF NOT EXISTS crc6f_hr_projectdetailses (
    crc6f_hr_projectdetailsid UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    crc6f_boardid VARCHAR(50) UNIQUE,
    crc6f_boardname VARCHAR(200) NOT NULL,
    crc6f_boarddescription TEXT,
    crc6f_boardstatus VARCHAR(50) DEFAULT 'Active',
    crc6f_nooftasks INTEGER DEFAULT 0,
    crc6f_noofmembers INTEGER DEFAULT 0,
    crc6f_projectid VARCHAR(50) NOT NULL,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ,
    CONSTRAINT fk_board_project FOREIGN KEY (crc6f_projectid) 
        REFERENCES crc6f_hr_projectheaders(crc6f_projectid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_crc6f_hr_projectdetailses_boardid ON crc6f_hr_projectdetailses(crc6f_boardid);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_projectdetailses_projectid ON crc6f_hr_projectdetailses(crc6f_projectid);

-- ============================================================================
-- 12. PROJECT TASKS (crc6f_hr_taskdetailses)
-- Individual work items
-- ============================================================================
CREATE TABLE IF NOT EXISTS crc6f_hr_taskdetailses (
    crc6f_hr_taskdetailsid UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    crc6f_taskid VARCHAR(50) UNIQUE,
    crc6f_taskname VARCHAR(200) NOT NULL,
    crc6f_taskdescription TEXT,
    crc6f_tasktype VARCHAR(50) DEFAULT 'Task',
    crc6f_taskpriority VARCHAR(50) DEFAULT 'medium',
    crc6f_taskstatus VARCHAR(50) DEFAULT 'todo',
    crc6f_assignedto VARCHAR(50),
    crc6f_assigneddate DATE,
    crc6f_duedate DATE,
    crc6f_projectid VARCHAR(50),
    crc6f_boardid VARCHAR(50),
    crc6f_columnid VARCHAR(50),
    crc6f_position INTEGER DEFAULT 0,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ,
    CONSTRAINT fk_task_project FOREIGN KEY (crc6f_projectid) 
        REFERENCES crc6f_hr_projectheaders(crc6f_projectid) ON DELETE CASCADE,
    CONSTRAINT fk_task_board FOREIGN KEY (crc6f_boardid) 
        REFERENCES crc6f_hr_projectdetailses(crc6f_boardid) ON DELETE CASCADE,
    CONSTRAINT fk_task_assignee FOREIGN KEY (crc6f_assignedto) 
        REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_crc6f_hr_taskdetailses_taskid ON crc6f_hr_taskdetailses(crc6f_taskid);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_taskdetailses_projectid ON crc6f_hr_taskdetailses(crc6f_projectid);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_taskdetailses_boardid ON crc6f_hr_taskdetailses(crc6f_boardid);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_taskdetailses_assignedto ON crc6f_hr_taskdetailses(crc6f_assignedto);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_taskdetailses_status ON crc6f_hr_taskdetailses(crc6f_taskstatus);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_taskdetailses_priority ON crc6f_hr_taskdetailses(crc6f_taskpriority);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_taskdetailses_duedate ON crc6f_hr_taskdetailses(crc6f_duedate);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_taskdetailses_created_at ON crc6f_hr_taskdetailses(created_at);

-- ============================================================================
-- 13. PROJECT CONTRIBUTORS (crc6f_hr_projectcontributorses)
-- Junction table: employees <-> projects with billing
-- ============================================================================
CREATE TABLE IF NOT EXISTS crc6f_hr_projectcontributorses (
    crc6f_hr_projectcontributorsid UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    crc6f_recordid VARCHAR(50) UNIQUE,
    crc6f_employeeid VARCHAR(50) NOT NULL,
    crc6f_employeename VARCHAR(200),
    crc6f_billingtype VARCHAR(50),
    crc6f_assigneddate DATE,
    crc6f_projectid VARCHAR(50) NOT NULL,
    crc6f_hourlyrate DECIMAL(10,2),
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ,
    CONSTRAINT fk_contributor_employee FOREIGN KEY (crc6f_employeeid) 
        REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE CASCADE,
    CONSTRAINT fk_contributor_project FOREIGN KEY (crc6f_projectid) 
        REFERENCES crc6f_hr_projectheaders(crc6f_projectid) ON DELETE CASCADE,
    CONSTRAINT uq_contributor_employee_project UNIQUE (crc6f_employeeid, crc6f_projectid)
);

CREATE INDEX IF NOT EXISTS idx_crc6f_hr_projectcontributorses_employeeid ON crc6f_hr_projectcontributorses(crc6f_employeeid);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_projectcontributorses_projectid ON crc6f_hr_projectcontributorses(crc6f_projectid);

-- ============================================================================
-- 14. TIMESHEET LOGS (crc6f_hr_timesheetlogs)
-- Time tracking entries
-- ============================================================================
CREATE TABLE IF NOT EXISTS crc6f_hr_timesheetlogs (
    crc6f_hr_timesheetlogid UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    crc6f_employeeid VARCHAR(50) NOT NULL,
    crc6f_workdate DATE NOT NULL,
    crc6f_projectid VARCHAR(50),
    crc6f_taskid VARCHAR(50),
    crc6f_taskname VARCHAR(200),
    crc6f_hoursworked DECIMAL(5,2),
    crc6f_workdescription TEXT,
    crc6f_starttime TIMESTAMPTZ,
    crc6f_endtime TIMESTAMPTZ,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ,
    CONSTRAINT fk_timesheet_employee FOREIGN KEY (crc6f_employeeid) 
        REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE CASCADE,
    CONSTRAINT fk_timesheet_project FOREIGN KEY (crc6f_projectid) 
        REFERENCES crc6f_hr_projectheaders(crc6f_projectid) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_crc6f_hr_timesheetlogs_employeeid ON crc6f_hr_timesheetlogs(crc6f_employeeid);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_timesheetlogs_workdate ON crc6f_hr_timesheetlogs(crc6f_workdate);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_timesheetlogs_projectid ON crc6f_hr_timesheetlogs(crc6f_projectid);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_timesheetlogs_created_at ON crc6f_hr_timesheetlogs(created_at);

-- ============================================================================
-- 15. CHAT CONVERSATIONS (crc6f_hr_chat_conversations)
-- Chat room/conversation metadata
-- ============================================================================
CREATE TABLE IF NOT EXISTS crc6f_hr_chat_conversations (
    crc6f_hr_chat_conversationsid UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    crc6f_conversationid VARCHAR(100) UNIQUE NOT NULL,
    crc6f_empname VARCHAR(200),
    crc6f_isgroup BOOLEAN DEFAULT FALSE,
    crc6f_description TEXT,
    crc6f_icon_url TEXT,
    crc6f_created_by VARCHAR(50),
    createdon TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ,
    CONSTRAINT fk_conversation_creator FOREIGN KEY (crc6f_created_by) 
        REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_crc6f_hr_chat_conversations_conversationid ON crc6f_hr_chat_conversations(crc6f_conversationid);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_chat_conversations_isgroup ON crc6f_hr_chat_conversations(crc6f_isgroup);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_chat_conversations_created_by ON crc6f_hr_chat_conversations(crc6f_created_by);

-- ============================================================================
-- 16. CHAT CONVERSATION MEMBERS (crc6f_hr_conversation_memberses)
-- Members of each conversation
-- ============================================================================
CREATE TABLE IF NOT EXISTS crc6f_hr_conversation_memberses (
    crc6f_hr_conversation_membersid UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    crc6f_conversation_id VARCHAR(100) NOT NULL,
    crc6f_member_id VARCHAR(100),
    crc6f_user_id VARCHAR(50) NOT NULL,
    crc6f_joined_on TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    crc6f_is_admin BOOLEAN DEFAULT FALSE,
    crc6f_is_muted BOOLEAN DEFAULT FALSE,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ,
    CONSTRAINT fk_member_conversation FOREIGN KEY (crc6f_conversation_id) 
        REFERENCES crc6f_hr_chat_conversations(crc6f_conversationid) ON DELETE CASCADE,
    CONSTRAINT fk_member_user FOREIGN KEY (crc6f_user_id) 
        REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE CASCADE,
    CONSTRAINT uq_conversation_member UNIQUE (crc6f_conversation_id, crc6f_user_id)
);

CREATE INDEX IF NOT EXISTS idx_crc6f_hr_conversation_memberses_conversation_id ON crc6f_hr_conversation_memberses(crc6f_conversation_id);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_conversation_memberses_user_id ON crc6f_hr_conversation_memberses(crc6f_user_id);

-- ============================================================================
-- 17. CHAT MESSAGES (crc6f_hr_messageses)
-- Individual chat messages
-- ============================================================================
CREATE TABLE IF NOT EXISTS crc6f_hr_messageses (
    crc6f_hr_messagesid UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    crc6f_message_id VARCHAR(100) UNIQUE,
    crc6f_conversation_id VARCHAR(100) NOT NULL,
    crc6f_sender_id VARCHAR(50) NOT NULL,
    crc6f_message_type VARCHAR(50) DEFAULT 'text',
    crc6f_message_text TEXT,
    crc6f_media_url TEXT,
    crc6f_mime_type VARCHAR(100),
    crc6f_file_id VARCHAR(100),
    createdon TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ,
    CONSTRAINT fk_message_conversation FOREIGN KEY (crc6f_conversation_id) 
        REFERENCES crc6f_hr_chat_conversations(crc6f_conversationid) ON DELETE CASCADE,
    CONSTRAINT fk_message_sender FOREIGN KEY (crc6f_sender_id) 
        REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_crc6f_hr_messageses_conversation_id ON crc6f_hr_messageses(crc6f_conversation_id);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_messageses_sender_id ON crc6f_hr_messageses(crc6f_sender_id);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_messageses_createdon ON crc6f_hr_messageses(createdon);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_messageses_message_type ON crc6f_hr_messageses(crc6f_message_type);

-- ============================================================================
-- 18. CHAT MESSAGE STATUS (crc6f_hr_messagestatuses)
-- Read/delivery status per user per message
-- ============================================================================
CREATE TABLE IF NOT EXISTS crc6f_hr_messagestatuses (
    crc6f_hr_messagestatusid UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    crc6f_message_id VARCHAR(100) NOT NULL,
    crc6f_user_id VARCHAR(50) NOT NULL,
    crc6f_status VARCHAR(50) DEFAULT 'delivered',
    crc6f_read_at TIMESTAMPTZ,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ,
    CONSTRAINT fk_msgstatus_message FOREIGN KEY (crc6f_message_id) 
        REFERENCES crc6f_hr_messageses(crc6f_message_id) ON DELETE CASCADE,
    CONSTRAINT fk_msgstatus_user FOREIGN KEY (crc6f_user_id) 
        REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE CASCADE,
    CONSTRAINT uq_message_user_status UNIQUE (crc6f_message_id, crc6f_user_id)
);

CREATE INDEX IF NOT EXISTS idx_crc6f_hr_messagestatuses_message_id ON crc6f_hr_messagestatuses(crc6f_message_id);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_messagestatuses_user_id ON crc6f_hr_messagestatuses(crc6f_user_id);

-- ============================================================================
-- 19. INTERN LIFECYCLE (crc6f_hr_interndetailses)
-- Intern phase tracking
-- ============================================================================
CREATE TABLE IF NOT EXISTS crc6f_hr_interndetailses (
    crc6f_hr_interndetailsid UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    crc6f_internid VARCHAR(50) UNIQUE,
    crc6f_employeeid VARCHAR(50),
    crc6f_unpaidduration INTEGER,
    crc6f_unpaidstart DATE,
    crc6f_unpaidend DATE,
    crc6f_paidtrainingduration INTEGER,
    crc6f_paidtrainingstart DATE,
    crc6f_paidtrainingend DATE,
    crc6f_paidtrainingsalary DECIMAL(10,2),
    crc6f_probationduration INTEGER,
    crc6f_probationstart DATE,
    crc6f_probationend DATE,
    crc6f_probationsalary DECIMAL(10,2),
    crc6f_postprobduration INTEGER,
    crc6f_postprobstart DATE,
    crc6f_postprobend DATE,
    crc6f_postprobsalary DECIMAL(10,2),
    createdby VARCHAR(50),
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ,
    CONSTRAINT fk_intern_employee FOREIGN KEY (crc6f_employeeid) 
        REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_crc6f_hr_interndetailses_internid ON crc6f_hr_interndetailses(crc6f_internid);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_interndetailses_employeeid ON crc6f_hr_interndetailses(crc6f_employeeid);

-- ============================================================================
-- 20. HIERARCHY (crc6f_hierarchies)
-- Manager-reportee relationships
-- ============================================================================
CREATE TABLE IF NOT EXISTS crc6f_hierarchies (
    crc6f_hr_hierarchyid UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    crc6f_employeeid VARCHAR(50) NOT NULL,
    crc6f_managerid VARCHAR(50) NOT NULL,
    createdby VARCHAR(50),
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ,
    CONSTRAINT fk_hierarchy_employee FOREIGN KEY (crc6f_employeeid) 
        REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE CASCADE,
    CONSTRAINT fk_hierarchy_manager FOREIGN KEY (crc6f_managerid) 
        REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE CASCADE,
    CONSTRAINT uq_hierarchy_employee_manager UNIQUE (crc6f_employeeid, crc6f_managerid)
);

CREATE INDEX IF NOT EXISTS idx_crc6f_hierarchies_employeeid ON crc6f_hierarchies(crc6f_employeeid);
CREATE INDEX IF NOT EXISTS idx_crc6f_hierarchies_managerid ON crc6f_hierarchies(crc6f_managerid);

-- ============================================================================
-- 21. LOGIN ACTIVITY (crc6f_hr_loginactivitytbs)
-- Geolocation-based login/logout tracking
-- ============================================================================
CREATE TABLE IF NOT EXISTS crc6f_hr_loginactivitytbs (
    crc6f_hr_loginactivitytbid UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    crc6f_employeeid VARCHAR(50) NOT NULL,
    crc6f_date DATE NOT NULL,
    crc6f_checkintime TIMESTAMPTZ,
    crc6f_checkouttime TIMESTAMPTZ,
    crc6f_checkinlocation TEXT,
    crc6f_checkoutlocation TEXT,
    crc6f_checkin_timestamp BIGINT,
    crc6f_checkout_timestamp BIGINT,
    crc6f_base_seconds INTEGER DEFAULT 0,
    crc6f_total_seconds INTEGER DEFAULT 0,
    crc6f_deviceinfo TEXT,
    crc6f_ipaddress INET,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ,
    CONSTRAINT fk_loginactivity_employee FOREIGN KEY (crc6f_employeeid) 
        REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE CASCADE,
    CONSTRAINT uq_loginactivity_employee_date UNIQUE (crc6f_employeeid, crc6f_date)
);

CREATE INDEX IF NOT EXISTS idx_crc6f_hr_loginactivitytbs_employeeid ON crc6f_hr_loginactivitytbs(crc6f_employeeid);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_loginactivitytbs_date ON crc6f_hr_loginactivitytbs(crc6f_date);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_loginactivitytbs_checkintime ON crc6f_hr_loginactivitytbs(crc6f_checkintime);

-- ============================================================================
-- 22. INBOX / NOTIFICATIONS (crc6f_hr_inboxes)
-- Workflow notifications
-- ============================================================================
CREATE TABLE IF NOT EXISTS crc6f_hr_inboxes (
    crc6f_hr_inboxid UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    crc6f_employeeid VARCHAR(50) NOT NULL,
    crc6f_message TEXT,
    crc6f_type VARCHAR(50),
    crc6f_status VARCHAR(50) DEFAULT 'unread',
    crc6f_reference_id VARCHAR(100),
    crc6f_reference_type VARCHAR(50),
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ,
    CONSTRAINT fk_inbox_employee FOREIGN KEY (crc6f_employeeid) 
        REFERENCES crc6f_table12s(crc6f_employeeid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_crc6f_hr_inboxes_employeeid ON crc6f_hr_inboxes(crc6f_employeeid);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_inboxes_status ON crc6f_hr_inboxes(crc6f_status);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_inboxes_type ON crc6f_hr_inboxes(crc6f_type);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_inboxes_created_at ON crc6f_hr_inboxes(created_at);

-- ============================================================================
-- 23. FILE ANNOTATIONS (annotations)
-- File attachments storage (for chat, documents, etc.)
-- ============================================================================
CREATE TABLE IF NOT EXISTS annotations (
    annotationid UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    crc6f_file_id VARCHAR(100) UNIQUE,
    filename VARCHAR(255),
    mimetype VARCHAR(100),
    filesize BIGINT,
    documentbody TEXT,
    subject VARCHAR(255),
    objectid VARCHAR(100),
    objecttypecode VARCHAR(100),
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_annotations_file_id ON annotations(crc6f_file_id);
CREATE INDEX IF NOT EXISTS idx_annotations_objectid ON annotations(objectid);

-- ============================================================================
-- 24. AUTH SESSION EVENTS (auth_session_events)
-- Login/logout event tracking for force-logout feature
-- ============================================================================
CREATE TABLE IF NOT EXISTS auth_session_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_type VARCHAR(50) NOT NULL,
    employee_id VARCHAR(50),
    username VARCHAR(255),
    employee_name VARCHAR(200),
    reason TEXT,
    source VARCHAR(50) DEFAULT 'system',
    occurred_at_utc TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    date DATE,
    ip_address INET,
    user_agent TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_auth_session_events_employee_id ON auth_session_events(employee_id);
CREATE INDEX IF NOT EXISTS idx_auth_session_events_username ON auth_session_events(username);
CREATE INDEX IF NOT EXISTS idx_auth_session_events_event_type ON auth_session_events(event_type);
CREATE INDEX IF NOT EXISTS idx_auth_session_events_date ON auth_session_events(date);
CREATE INDEX IF NOT EXISTS idx_auth_session_events_occurred_at ON auth_session_events(occurred_at_utc);

-- ============================================================================
-- 25. AUTH SESSION POLICY (auth_session_policy)
-- Force logout policy storage
-- ============================================================================
CREATE TABLE IF NOT EXISTS auth_session_policy (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    policy_type VARCHAR(50) NOT NULL,
    target_identifier VARCHAR(255),
    force_logout_at TIMESTAMPTZ,
    created_by VARCHAR(50),
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_auth_session_policy_type ON auth_session_policy(policy_type);
CREATE INDEX IF NOT EXISTS idx_auth_session_policy_target ON auth_session_policy(target_identifier);

-- ============================================================================
-- 26. PROJECT COLUMNS (crc6f_hr_projectcolumns)
-- Kanban board columns
-- ============================================================================
CREATE TABLE IF NOT EXISTS crc6f_hr_projectcolumns (
    crc6f_hr_projectcolumnid UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    crc6f_columnid VARCHAR(50) UNIQUE,
    crc6f_columnname VARCHAR(100) NOT NULL,
    crc6f_boardid VARCHAR(50) NOT NULL,
    crc6f_position INTEGER DEFAULT 0,
    crc6f_color VARCHAR(20),
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ,
    CONSTRAINT fk_column_board FOREIGN KEY (crc6f_boardid) 
        REFERENCES crc6f_hr_projectdetailses(crc6f_boardid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_crc6f_hr_projectcolumns_boardid ON crc6f_hr_projectcolumns(crc6f_boardid);
CREATE INDEX IF NOT EXISTS idx_crc6f_hr_projectcolumns_position ON crc6f_hr_projectcolumns(crc6f_position);

-- ============================================================================
-- TRIGGERS: Auto-update updated_at timestamp
-- ============================================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply trigger to all tables with updated_at column
DO $$
DECLARE
    t text;
BEGIN
    FOR t IN 
        SELECT table_name 
        FROM information_schema.columns 
        WHERE column_name = 'updated_at' 
        AND table_schema = 'public'
    LOOP
        EXECUTE format('
            DROP TRIGGER IF EXISTS update_%I_updated_at ON %I;
            CREATE TRIGGER update_%I_updated_at
                BEFORE UPDATE ON %I
                FOR EACH ROW
                EXECUTE FUNCTION update_updated_at_column();
        ', t, t, t, t);
    END LOOP;
END;
$$;

-- ============================================================================
-- ROW LEVEL SECURITY (RLS) - Enable for Supabase
-- ============================================================================
ALTER TABLE crc6f_table12s ENABLE ROW LEVEL SECURITY;
ALTER TABLE crc6f_hr_login_detailses ENABLE ROW LEVEL SECURITY;
ALTER TABLE crc6f_table13s ENABLE ROW LEVEL SECURITY;
ALTER TABLE crc6f_table14s ENABLE ROW LEVEL SECURITY;
ALTER TABLE crc6f_hr_leavemangements ENABLE ROW LEVEL SECURITY;
ALTER TABLE crc6f_compensatoryrequests ENABLE ROW LEVEL SECURITY;
ALTER TABLE crc6f_hr_assetdetailses ENABLE ROW LEVEL SECURITY;
ALTER TABLE crc6f_hr_holidayses ENABLE ROW LEVEL SECURITY;
ALTER TABLE crc6f_hr_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE crc6f_hr_projectheaders ENABLE ROW LEVEL SECURITY;
ALTER TABLE crc6f_hr_projectdetailses ENABLE ROW LEVEL SECURITY;
ALTER TABLE crc6f_hr_taskdetailses ENABLE ROW LEVEL SECURITY;
ALTER TABLE crc6f_hr_projectcontributorses ENABLE ROW LEVEL SECURITY;
ALTER TABLE crc6f_hr_timesheetlogs ENABLE ROW LEVEL SECURITY;
ALTER TABLE crc6f_hr_chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE crc6f_hr_conversation_memberses ENABLE ROW LEVEL SECURITY;
ALTER TABLE crc6f_hr_messageses ENABLE ROW LEVEL SECURITY;
ALTER TABLE crc6f_hr_messagestatuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE crc6f_hr_interndetailses ENABLE ROW LEVEL SECURITY;
ALTER TABLE crc6f_hierarchies ENABLE ROW LEVEL SECURITY;
ALTER TABLE crc6f_hr_loginactivitytbs ENABLE ROW LEVEL SECURITY;
ALTER TABLE crc6f_hr_inboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE annotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_session_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_session_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE crc6f_hr_projectcolumns ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- DEFAULT RLS POLICIES (Allow service role full access)
-- You should customize these based on your authentication setup
-- ============================================================================
CREATE POLICY "Service role has full access to crc6f_table12s" ON crc6f_table12s FOR ALL USING (true);
CREATE POLICY "Service role has full access to crc6f_hr_login_detailses" ON crc6f_hr_login_detailses FOR ALL USING (true);
CREATE POLICY "Service role has full access to crc6f_table13s" ON crc6f_table13s FOR ALL USING (true);
CREATE POLICY "Service role has full access to crc6f_table14s" ON crc6f_table14s FOR ALL USING (true);
CREATE POLICY "Service role has full access to crc6f_hr_leavemangements" ON crc6f_hr_leavemangements FOR ALL USING (true);
CREATE POLICY "Service role has full access to crc6f_compensatoryrequests" ON crc6f_compensatoryrequests FOR ALL USING (true);
CREATE POLICY "Service role has full access to crc6f_hr_assetdetailses" ON crc6f_hr_assetdetailses FOR ALL USING (true);
CREATE POLICY "Service role has full access to crc6f_hr_holidayses" ON crc6f_hr_holidayses FOR ALL USING (true);
CREATE POLICY "Service role has full access to crc6f_hr_clients" ON crc6f_hr_clients FOR ALL USING (true);
CREATE POLICY "Service role has full access to crc6f_hr_projectheaders" ON crc6f_hr_projectheaders FOR ALL USING (true);
CREATE POLICY "Service role has full access to crc6f_hr_projectdetailses" ON crc6f_hr_projectdetailses FOR ALL USING (true);
CREATE POLICY "Service role has full access to crc6f_hr_taskdetailses" ON crc6f_hr_taskdetailses FOR ALL USING (true);
CREATE POLICY "Service role has full access to crc6f_hr_projectcontributorses" ON crc6f_hr_projectcontributorses FOR ALL USING (true);
CREATE POLICY "Service role has full access to crc6f_hr_timesheetlogs" ON crc6f_hr_timesheetlogs FOR ALL USING (true);
CREATE POLICY "Service role has full access to crc6f_hr_chat_conversations" ON crc6f_hr_chat_conversations FOR ALL USING (true);
CREATE POLICY "Service role has full access to crc6f_hr_conversation_memberses" ON crc6f_hr_conversation_memberses FOR ALL USING (true);
CREATE POLICY "Service role has full access to crc6f_hr_messageses" ON crc6f_hr_messageses FOR ALL USING (true);
CREATE POLICY "Service role has full access to crc6f_hr_messagestatuses" ON crc6f_hr_messagestatuses FOR ALL USING (true);
CREATE POLICY "Service role has full access to crc6f_hr_interndetailses" ON crc6f_hr_interndetailses FOR ALL USING (true);
CREATE POLICY "Service role has full access to crc6f_hierarchies" ON crc6f_hierarchies FOR ALL USING (true);
CREATE POLICY "Service role has full access to crc6f_hr_loginactivitytbs" ON crc6f_hr_loginactivitytbs FOR ALL USING (true);
CREATE POLICY "Service role has full access to crc6f_hr_inboxes" ON crc6f_hr_inboxes FOR ALL USING (true);
CREATE POLICY "Service role has full access to annotations" ON annotations FOR ALL USING (true);
CREATE POLICY "Service role has full access to auth_session_events" ON auth_session_events FOR ALL USING (true);
CREATE POLICY "Service role has full access to auth_session_policy" ON auth_session_policy FOR ALL USING (true);
CREATE POLICY "Service role has full access to crc6f_hr_projectcolumns" ON crc6f_hr_projectcolumns FOR ALL USING (true);

-- ============================================================================
-- 27. ROLE PERMISSIONS (role_permissions)
-- Admin-controlled access settings for applications and functions
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

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role has full access to role_permissions" ON role_permissions FOR ALL USING (true);

-- ============================================================================
-- END OF SCHEMA
-- ============================================================================
