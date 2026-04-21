# OfficeTool Migration Plan: Dataverse to Supabase

**Project Goal**: Migrate all data and authentication from Microsoft Dataverse to Supabase for better performance, cost efficiency, and maintenance.

**Target Completion**: May 15, 2026

---

## Migration Overview

| Phase | Duration | Start Date | End Date | Status |
|-------|----------|------------|----------|---------|
| Phase 1: Planning & Setup | 5 days | Apr 10, 2026 | Apr 14, 2026 | In Progress |
| Phase 2: Schema Design | 3 days | Apr 15, 2026 | Apr 17, 2026 | Pending |
| Phase 3: Supabase Setup | 2 days | Apr 18, 2026 | Apr 19, 2026 | Pending |
| Phase 4: Data Migration | 7 days | Apr 21, 2026 | Apr 29, 2026 | Pending |
| Phase 5: Backend Refactor | 10 days | Apr 30, 2026 | May 9, 2026 | Pending |
| Phase 6: Testing & Validation | 3 days | May 12, 2026 | May 14, 2026 | Pending |
| Phase 7: Go-Live | 1 day | May 15, 2026 | May 15, 2026 | Pending |

---

## Phase 1: Planning & Setup (Apr 10-14, 2026)

### Tasks

- [ ] **Apr 10**: Inventory all Dataverse entities and tables
- [ ] **Apr 11**: Document data relationships and dependencies
- [ ] **Apr 12**: Identify authentication flows and JWT structure
- [ ] **Apr 13**: Plan Supabase project structure and security model
- [ ] **Apr 14**: Create migration checklist and backup strategy

### Deliverables
- Complete data inventory document
- Entity relationship diagram
- Authentication flow documentation
- Supabase project plan

---

## Phase 2: Schema Design (Apr 15-17, 2026)

### Database Schema

```sql
-- Employees Table
CREATE TABLE employees (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id VARCHAR(20) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100),
    full_name VARCHAR(201) GENERATED ALWAYS AS (first_name || ' ' || COALESCE(last_name, '')) STORED,
    phone VARCHAR(20),
    address TEXT,
    department VARCHAR(100),
    designation VARCHAR(100),
    doj DATE,
    access_level VARCHAR(50) DEFAULT 'user',
    is_admin BOOLEAN DEFAULT FALSE,
    is_manager BOOLEAN DEFAULT FALSE,
    avatar_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Attendance Table
CREATE TABLE attendance (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    checkin_time TIMESTAMPTZ,
    checkout_time TIMESTAMPTZ,
    checkin_location TEXT,
    checkout_location TEXT,
    checkin_latitude DECIMAL(10, 8),
    checkin_longitude DECIMAL(11, 8),
    checkout_latitude DECIMAL(10, 8),
    checkout_longitude DECIMAL(11, 8),
    duration_seconds INTEGER,
    city VARCHAR(100),
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(employee_id, date)
);

-- Time Entries Table
CREATE TABLE time_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
    task_guid UUID NOT NULL,
    task_name VARCHAR(255) NOT NULL,
    project_id UUID,
    project_name VARCHAR(255),
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ,
    duration_seconds INTEGER,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Projects Table
CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    status VARCHAR(50) DEFAULT 'active',
    created_by UUID REFERENCES employees(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tasks Table
CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    status VARCHAR(50) DEFAULT 'todo',
    assigned_to UUID REFERENCES employees(id),
    created_by UUID REFERENCES employees(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Leave Requests Table
CREATE TABLE leave_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
    leave_type VARCHAR(50) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    days_count DECIMAL(3,1) NOT NULL,
    reason TEXT,
    status VARCHAR(50) DEFAULT 'pending',
    approved_by UUID REFERENCES employees(id),
    approved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Login Events Table
CREATE TABLE login_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
    event_type VARCHAR(50) NOT NULL,
    occurred_at TIMESTAMPTZ DEFAULT NOW(),
    ip_address INET,
    user_agent TEXT,
    reason TEXT,
    source VARCHAR(50) DEFAULT 'web'
);

-- Auth Session Policy Table
CREATE TABLE auth_session_policy (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_type VARCHAR(50) NOT NULL, -- 'global' or 'target'
    target_identifier VARCHAR(255), -- email or employee_id
    force_logout_at TIMESTAMPTZ,
    created_by UUID REFERENCES employees(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Intern Details Table
CREATE TABLE intern_details (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
    intern_id VARCHAR(20) UNIQUE NOT NULL,
    unpaid_duration INTEGER,
    unpaid_start DATE,
    unpaid_end DATE,
    paid_duration INTEGER,
    paid_start DATE,
    paid_end DATE,
    paid_salary DECIMAL(10,2),
    probation_duration INTEGER,
    probation_start DATE,
    probation_end DATE,
    probation_salary DECIMAL(10,2),
    postprob_duration INTEGER,
    postprob_start DATE,
    postprob_end DATE,
    postprob_salary DECIMAL(10,2),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Tasks

- [ ] **Apr 15**: Design core tables schema
- [ ] **Apr 16**: Define relationships and constraints
- [ ] **Apr 17**: Create indexes and RLS policies

---

## Phase 3: Supabase Setup (Apr 18-19, 2026)

### Tasks

- [ ] **Apr 18**: 
  - Create Supabase project
  - Set up authentication providers
  - Configure JWT settings
- [ ] **Apr 19**:
  - Create database schema
  - Set up Row Level Security (RLS)
  - Create API keys and service roles

### Supabase Configuration

```javascript
// supabase/config.js
export const supabaseUrl = 'https://your-project.supabase.co';
export const supabaseAnonKey = 'your-anon-key';
export const supabaseServiceKey = 'your-service-key';
```

---

## Phase 4: Data Migration (Apr 21-29, 2026)

### Migration Scripts

```python
# migration_scripts.py
import asyncio
import aiohttp
from datetime import datetime
import json

class DataverseToSupabaseMigration:
    def __init__(self):
        self.dataverse_base = "https://your-org.crm.dynamics.com"
        self.supabase_url = "https://your-project.supabase.co"
        self.supabase_key = "your-service-key"
        
    async def migrate_employees(self):
        """Migrate employees from Dataverse to Supabase"""
        # Fetch from Dataverse
        employees = await self.fetch_dataverse_employees()
        
        # Transform and insert to Supabase
        for emp in employees:
            transformed = {
                'employee_id': emp.get('crc6f_employeeid'),
                'email': emp.get('crc6f_email'),
                'first_name': emp.get('crc6f_firstname'),
                'last_name': emp.get('crc6f_lastname'),
                'phone': emp.get('crc6f_phonenumber'),
                'department': emp.get('crc6f_department'),
                'designation': emp.get('crc6f_designation'),
                'doj': emp.get('crc6f_dateofjoining'),
                'access_level': emp.get('crc6f_accesslevel', 'user'),
                'is_admin': 'admin' in emp.get('crc6f_designation', '').lower(),
                'is_manager': 'manager' in emp.get('crc6f_designation', '').lower()
            }
            await self.insert_supabase('employees', transformed)
    
    async def migrate_attendance(self):
        """Migrate attendance records"""
        # Similar pattern for attendance
        pass
    
    async def migrate_time_entries(self):
        """Migrate time tracking entries"""
        # Similar pattern for time entries
        pass
```

### Tasks

- [ ] **Apr 21-22**: Migrate employees and basic data
- [ ] **Apr 23-24**: Migrate attendance records
- [ ] **Apr 25-26**: Migrate time tracking data
- [ ] **Apr 27**: Migrate projects and tasks
- [ ] **Apr 28**: Migrate leave requests
- [ ] **Apr 29**: Validate data integrity

---

## Phase 5: Backend Refactor (Apr 30 - May 9, 2026)

### New Backend Structure

```
backend/
  supabase_client.py      # Supabase client wrapper
  auth_supabase.py        # Supabase authentication
  attendance_service.py   # Attendance CRUD operations
  time_tracking.py        # Time tracking operations
  leave_service.py        # Leave management
  employee_service.py     # Employee management
  project_service.py      # Project management
  unified_server.py       # Main Flask server (refactored)
```

### Key Changes

1. **Authentication**
   - Replace Dataverse auth with Supabase Auth
   - Update JWT handling
   - Implement session management

2. **Database Operations**
   - Replace Dataverse API calls with Supabase queries
   - Use Supabase client for all CRUD operations
   - Implement proper error handling

3. **API Endpoints**
   - Keep existing endpoint structure
   - Update internal implementation
   - Maintain backward compatibility

### Tasks

- [ ] **Apr 30-May 1**: Set up Supabase client and auth
- [ ] **May 2-3**: Refactor authentication system
- [ ] **May 4-5**: Migrate attendance service
- [ ] **May 6-7**: Migrate time tracking service
- [ ] **May 8**: Migrate other services
- [ ] **May 9**: Update API endpoints

---

## Phase 6: Testing & Validation (May 12-14, 2026)

### Test Plan

1. **Unit Tests**
   - Database operations
   - Authentication flows
   - Business logic

2. **Integration Tests**
   - API endpoints
   - Data consistency
   - Performance benchmarks

3. **User Acceptance Tests**
   - Login/logout flows
   - Attendance tracking
   - Time tracking
   - Leave management

### Tasks

- [ ] **May 12**: Run unit and integration tests
- [ ] **May 13**: Performance testing and optimization
- [ ] **May 14**: User acceptance testing

---

## Phase 7: Go-Live (May 15, 2026)

### Deployment Checklist

- [ ] Backup current Dataverse data
- [ ] Deploy new backend to staging
- [ ] Final data sync (last 24 hours)
- [ ] Switch DNS to new backend
- [ ] Monitor system performance
- [ ] Handle user issues

### Rollback Plan

- Keep Dataverse backup for 30 days
- Document rollback procedures
- Prepare emergency contact list

---

## Risk Assessment & Mitigation

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Data loss during migration | High | Low | Multiple backups, test migrations |
| Authentication issues | High | Medium | Thorough testing, gradual rollout |
| Performance degradation | Medium | Low | Load testing, optimization |
| User adoption issues | Medium | Medium | Training, documentation |

---

## Resource Requirements

### Technical Resources
- Supabase Pro plan ($25/month)
- Developer time (160 hours estimated)
- Testing environment

### Human Resources
- Backend Developer (Full time)
- Database Administrator (Part time)
- QA Tester (Part time)

---

## Success Metrics

1. **Technical Metrics**
   - API response time < 500ms
   - 99.9% uptime
   - Zero data loss

2. **Business Metrics**
   - User satisfaction > 90%
   - No disruption to operations
   - Cost savings > 50%

---

## Post-Migration Tasks

- [ ] Monitor system performance for 30 days
- [ ] Optimize database queries based on usage patterns
- [ ] Document new architecture
- [ ] Train users on any new features
- [ ] Decommission Dataverse resources

---

## Contact Information

**Project Lead**: [Your Name]
**Technical Lead**: [Tech Lead Name]
**Database Admin**: [DBA Name]

**Emergency Contacts**:
- Project Lead: [Phone/Email]
- Technical Lead: [Phone/Email]
- Database Admin: [Phone/Email]

---

*Last Updated: April 10, 2026*
*Version: 1.0*
