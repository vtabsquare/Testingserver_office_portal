import { state } from '../state.js';
import { canUseFunction, canViewApplication } from '../utils/roleSettings.js';

export const getSidebarHTML = () => {
    const canViewTeamTimesheet = canViewApplication('time_team_timesheet');
    const canViewTeamAttendance = canViewApplication('attendance_team');
    const canViewTeamLeaves = canViewApplication('leave_team');
    const canViewEmployeeModule = canViewApplication('employee') || canViewApplication('employees') || canViewApplication('interns') || canViewApplication('team_management');
    const canViewInternsModule = canViewApplication('interns');
    const canViewSettings = canViewApplication('settings') || canViewApplication('leave_settings') || canViewApplication('login_settings') || canViewApplication('faceauth_settings') || canViewApplication('role_settings');
    const canViewTimeTrackerModule = canViewApplication('time_tracker') || canViewApplication('time_my_tasks') || canViewApplication('time_my_timesheet') || canViewTeamTimesheet || canViewApplication('time_clients') || canViewApplication('time_projects');
    const canViewAttendanceModule = canViewApplication('attendance_tracker') || canViewApplication('attendance_my') || canViewTeamAttendance || canViewApplication('attendance_holidays');
    const canViewLeaveModule = canViewApplication('leave_tracker') || canViewApplication('leave_my') || canViewTeamLeaves || canViewApplication('compoff');
    
    return `
    <div class="sidebar-header">
        <a href="#/" class="sidebar-brand nav-link" data-page="home">
            <div class="sidebar-logo">
                <img src="/vtab-logo.jpeg" alt="VTAB SQUARE" width="48" height="48" />
            </div>
            <span class="sidebar-title">VTAB SQUARE</span>
        </a>
    </div>
    <ul class="sidebar-nav">
        <li><p class="nav-section-title">APPLICATIONS</p></li>
        <li><a href="#/" class="nav-link" data-page="home"><i class="fa-solid fa-house"></i> Home</a></li>
        ${canViewApplication('admin_dashboard') ? '<li><a href="#/admin-dashboard" class="nav-link" data-page="admin-dashboard"><i class="fa-solid fa-chart-line"></i> Admin Dashboard</a></li>' : ''}
        ${canViewEmployeeModule ? `
        <li class="nav-group" data-group="employee-module">
            <a href="#" class="nav-link nav-toggle">
                <span class="nav-toggle-label">
                    <i class="fa-solid fa-users"></i>
                    <span>Employee</span>
                </span>
                <i class="fa-solid fa-chevron-down"></i>
            </a>
            <ul class="nav-submenu">
                ${canViewApplication('employees') ? '<li><a href="#/employees" class="nav-link" data-page="employees">Employees</a></li>' : ''}
                ${canViewInternsModule ? '<li><a href="#/interns" class="nav-link" data-page="interns">Interns</a></li>' : ''}
                ${canViewApplication('team_management') ? '<li><a href="#/team-management" class="nav-link" data-page="team-management">Team Management</a></li>' : ''}
            </ul>
        </li>` : ''}
        ${canViewApplication('inbox') ? '<li><a href="#/inbox" class="nav-link" data-page="inbox"><i class="fa-solid fa-inbox"></i> Inbox</a></li>' : ''}
        ${canViewApplication('onboarding') ? '<li><a href="#/onboarding" class="nav-link" data-page="onboarding"><i class="fa-solid fa-user-plus"></i> Onboarding</a></li>' : ''}
        ${canViewTimeTrackerModule ? `
        <li class="nav-group" data-group="time-tracker">
            <a href="#" class="nav-link nav-toggle">
                <span class="nav-toggle-label">
                    <i class="fa-solid fa-clock"></i>
                    <span>Time Tracker</span>
                </span>
                <i class="fa-solid fa-chevron-down"></i>
            </a>
            <ul class="nav-submenu">
                ${canViewApplication('time_my_tasks') ? '<li><a href="#/time-my-tasks" class="nav-link" data-page="time-my-tasks">My Tasks</a></li>' : ''}
                ${canViewApplication('time_my_timesheet') ? '<li><a href="#/time-my-timesheet" class="nav-link" data-page="time-my-timesheet">My Timesheet</a></li>' : ''}
                ${canViewTeamTimesheet ? '<li><a href="#/time-team-timesheet" class="nav-link" data-page="time-team-timesheet">My Team Timesheet</a></li>' : ''}
                ${canViewApplication('time_clients') ? '<li><a href="#/time-clients" class="nav-link" data-page="time-clients">Clients</a></li>' : ''}
                ${canViewApplication('time_projects') ? '<li><a href="#/time-projects" class="nav-link" data-page="time-projects">Projects</a></li>' : ''}
            </ul>
        </li>` : ''}
        ${canViewAttendanceModule ? `
        <li class="nav-group" data-group="attendance-tracker">
            <a href="#" class="nav-link nav-toggle">
                <span class="nav-toggle-label">
                    <i class="fa-solid fa-calendar-check"></i>
                    <span>Attendance Tracker</span>
                </span>
                <i class="fa-solid fa-chevron-down"></i>
            </a>
            <ul class="nav-submenu">
                ${canViewApplication('attendance_my') ? '<li><a href="#/attendance-my" class="nav-link" data-page="attendance-my">My Attendance</a></li>' : ''}
                ${canViewTeamAttendance ? '<li><a href="#/attendance-team" class="nav-link" data-page="attendance-team">My Team Attendance</a></li>' : ''}
                ${canViewApplication('attendance_holidays') ? '<li><a href="#/attendance-holidays" class="nav-link" data-page="attendance-holidays"><i class="fa-solid fa-umbrella-beach" style="margin-right:6px;"></i>Holidays</a></li>' : ''}
            </ul>
        </li>` : ''}
        ${canViewLeaveModule ? `
        <li class="nav-group" data-group="leave-tracker">
            <a href="#" class="nav-link nav-toggle">
                <span class="nav-toggle-label">
                    <i class="fa-solid fa-calendar-days"></i>
                    <span>Leave Tracker</span>
                </span>
                <i class="fa-solid fa-chevron-down"></i>
            </a>
            <ul class="nav-submenu">
                ${canViewApplication('leave_my') ? '<li><a href="#/leave-my" class="nav-link" data-page="leave-my">My Leaves</a></li>' : ''}
                ${canViewTeamLeaves ? '<li><a href="#/leave-team" class="nav-link" data-page="leave-team">My Team Leaves</a></li>' : ''}
                ${canViewApplication('compoff') ? '<li><a href="#/compoff" class="nav-link" data-page="compoff">Comp Off</a></li>' : ''}
            </ul>
        </li>` : ''}
        ${canViewApplication('assets') ? '<li><a href="#/assets" class="nav-link" data-page="assets"><i class="fa-solid fa-box"></i> Assets</a></li>' : ''}
        ${canViewSettings ? `
        <li>
            <a href="${(() => {
                if (canViewApplication('leave_settings')) return '#/leave-settings';
                if (canViewApplication('shift_settings')) return '#/shift-settings';
                if (canViewApplication('login_settings')) return '#/login-settings';
                if (canViewApplication('faceauth_settings')) return '#/faceauth-settings';
                if (canViewApplication('role_settings')) return '#/role-settings';
                return '#/settings';
            })()}" class="nav-link" data-page="settings">
                <i class="fa-solid fa-gear" style="margin-right: 8px;"></i>Settings
            </a>
        </li>
        ${canViewApplication('faceauth_admin') ? '<li><a href="#" class="nav-link" id="faceauth-admin-btn"><i class="fa-solid fa-fingerprint"></i> FaceAuth Admin</a></li>' : ''}` : ''}
    </ul>
`;
};
const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) return 'Good Morning';
    if (hour >= 12 && hour < 17) return 'Good Afternoon';
    if (hour >= 17 && hour < 21) return 'Good Evening';
    return 'Good Night';
};

export const getHeaderHTML = (user, timer) => `
    <div class="header-greeting header-visible" style="font-size:1.1rem; font-weight:600; color:var(--text-primary); margin-right:auto; display:flex; align-items:center;">
        ${getGreeting()}, ${user.name ? user.name.split(' ')[0] : 'User'}!
    </div>

    <div class="header-search">
        <i class="fa-solid fa-search"></i>
        <input type="text" placeholder="Search for an employee name or ID (Ctrl + E)">
    </div>
    <div class="header-actions header-visible">
        <button id="theme-toggle" class="icon-btn header-theme-toggle" aria-label="Toggle theme">
            <i class="fa-solid fa-moon"></i>
        </button>
        <button id="timer-btn" class="timer-btn ${timer.isRunning ? 'check-out' : 'check-in'}">
            <span id="timer-display">00:00:00</span> ${timer.isRunning ? 'CHECK OUT' : 'CHECK IN'}
        </button>
        <div class="notification-bell" id="notification-bell" style="cursor: pointer; position: relative;">
            <i class="fa-solid fa-bell"></i>
            <span class="notification-badge" id="notification-badge" style="display: none;">0</span>
            <div class="notification-dropdown" id="notification-dropdown" style="display:none; position:absolute; top:100%; right:-10px; background:var(--surface-color); border:1px solid var(--border-color); border-radius:8px; padding:12px; min-width:200px; box-shadow:0 8px 20px rgba(15,23,42,0.15); z-index:1001; cursor:default;">
                <div style="font-weight:600; margin-bottom:8px; border-bottom:1px solid var(--border-color); padding-bottom:6px; font-size:14px; color:var(--text-primary);">Inbox Pending</div>
                <div style="display:flex; justify-content:space-between; margin-bottom:6px; font-size:13px; color:var(--text-secondary);"><span>Leaves:</span> <strong id="notif-leaves" style="color:var(--text-primary);">0</strong></div>
                <div style="display:flex; justify-content:space-between; margin-bottom:6px; font-size:13px; color:var(--text-secondary);"><span>Timesheets:</span> <strong id="notif-timesheets" style="color:var(--text-primary);">0</strong></div>
                <div style="display:flex; justify-content:space-between; font-size:13px; color:var(--text-secondary);"><span>Attendance:</span> <strong id="notif-attendance" style="color:var(--text-primary);">0</strong></div>
            </div>
        </div>
        <div class="user-profile" id="user-profile" style="position:relative; cursor:pointer;">
            <div class="user-avatar ${user.avatarUrl ? 'has-photo' : ''}" ${user.avatarUrl ? `style="background-image:url('${user.avatarUrl}')"` : ''}>${user.initials}</div>
            <span>${user.name}</span>
            <i class="fa-solid fa-chevron-down" style="margin-left:6px;"></i>
            <div class="dropdown-menu" id="user-menu" style="display:none; position:absolute; right:0; top:100%; border-radius:8px; padding:6px; min-width:200px; box-shadow:0 8px 20px rgba(15,23,42,0.45); z-index:1000; background:var(--surface-color); border:1px solid var(--border-color);">
                <div class="user-menu-header" style="padding:8px 10px 6px; border-bottom:1px solid var(--border-color); margin-bottom:4px;">
                    <div style="font-weight:600; font-size:14px; color: var(--text-primary);">${user.name || ''}</div>
                    ${user.designation ? `<div style="font-size:12px; color:var(--text-secondary); margin-top:2px;">${user.designation}</div>` : ''}
                    ${user.email ? `<div style="font-size:11px; color:var(--text-secondary); margin-top:2px;">${user.email}</div>` : ''}
                    ${user.id ? `<div style="font-size:11px; color:var(--text-muted); margin-top:2px;">${user.id}</div>` : ''}
                </div>
                <button class="dropdown-item" id="profile-btn" style="width:100%; text-align:left; background:none; border:none; padding:8px 10px; cursor:pointer; font-size:13px; display:flex; align-items:center; gap:6px;">
                    <i class="fa-solid fa-user"></i>
                    <span>Profile</span>
                </button>
                <button class="dropdown-item" id="logout-btn" style="width:100%; text-align:left; background:none; border:none; padding:8px 10px; cursor:pointer; font-size:13px; display:flex; align-items:center; gap:6px;">
                    <i class="fa-solid fa-arrow-right-from-bracket"></i>
                    <span>Logout</span>
                </button>
            </div>
        </div>
    </div>
`;
