import { AppState } from '../types.js';

export const getSidebarHTML = () => `
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
        <li><a href="#/employees" class="nav-link" data-page="employees"><i class="fa-solid fa-users"></i> Employees</a></li>
        <li><a href="#/inbox" class="nav-link" data-page="inbox"><i class="fa-solid fa-inbox"></i> Inbox</a></li>
        <li><a href="#/time-tracker" class="nav-link" data-page="time-tracker"><i class="fa-solid fa-clock"></i> Time tracker</a></li>
        
        <li class="nav-group" data-group="attendance-tracker">
            <a href="#" class="nav-link nav-toggle">
                <span class="nav-toggle-label">
                    <i class="fa-solid fa-calendar-check"></i>
                    <span>Attendance tracker</span>
                </span>
                <i class="fa-solid fa-chevron-down"></i>
            </a>
            <ul class="nav-submenu">
                <li><a href="#/attendance-my" class="nav-link" data-page="attendance-my">My attendance</a></li>
                <li><a href="#/attendance-team" class="nav-link" data-page="attendance-team">My team attendance</a></li>
            </ul>
        </li>

        <li><a href="#/leave-tracker" class="nav-link" data-page="leave-tracker"><i class="fa-solid fa-calendar-alt"></i> Leave tracker</a></li>
        <li><a href="#/projects" class="nav-link" data-page="projects"><i class="fa-solid fa-briefcase"></i> Projects</a></li>
    </ul>
`;

export const getHeaderHTML = (user: AppState['user'], timer: AppState['timer']) => `
    <div class="header-search">
        <i class="fa-solid fa-search"></i>
        <input type="text" placeholder="Search for an employee name or ID (Ctrl + E)">
    </div>
    <div class="header-actions header-visible">
        <button id="timer-btn" class="timer-btn ${timer.isRunning ? 'check-out' : 'check-in'}">
            <span id="timer-display">00:00:00</span> ${timer.isRunning ? 'CHECK OUT' : 'CHECK IN'}
        </button>
        <div class="notification-bell">
            <i class="fa-solid fa-bell"></i>
            <span class="notification-badge">0</span>
        </div>
        <div class="user-profile">
            <div class="user-avatar">${user.initials}</div>
            <span>${user.name}</span>
        </div>
    </div>
`;