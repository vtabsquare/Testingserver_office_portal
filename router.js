import { isAdminUser, isManagerOrAdmin, isL2OrL3User, isTeamLeadUser } from './utils/accessControl.js';
import { canViewApplication, canUseFunction } from './utils/roleSettings.js';

// Access denied page for non-admin users
const renderAccessDenied = (redirectPath = '#/') => {
  document.getElementById('app-content').innerHTML = `
    <div class="card" style="padding: 40px; text-align: center;">
      <i class="fa-solid fa-lock" style="font-size: 48px; color: #e74c3c; margin-bottom: 16px;"></i>
      <h2>Access Denied</h2>
      <p>You don't have permission to access this page.</p>
      <p>Only administrators (EMP001) can view team data.</p>
      <button class="btn btn-primary" onclick="window.location.hash='${redirectPath}'" style="margin-top: 16px;">
        <i class="fa-solid fa-arrow-left"></i> Go Back
      </button>
    </div>
  `;
};

const loaders = {
  "/": async () => (await import('./pages/home.js')).renderHomePage,
  "/employees": async () => (await import('./pages/employees.js')).renderEmployeesPage,
  "/interns": async () => (await import('./pages/interns.js')).renderInternsPage,
  "/employees/bulk-upload": async () => (await import('./pages/employees.js')).renderBulkUploadPage,
  "/employees/bulk-delete": async () => (await import('./pages/employees.js')).renderBulkDeletePage,
  "/team-management": async () => (await import('./pages/teamManagement.js')).renderTeamManagementPage,
  "/inbox": async () => (await import('./pages/shared.js')).renderInboxPage,
  "/meet": async () => (await import('./pages/meet_redesign.js')).renderMeetPage,
  "/chat": async () => (await import('./pages/chats.js')).renderChatPage,
  "/time-tracker": async () => (await import('./pages/shared.js')).renderTimeTrackerPage,
  "/time-my-tasks": async () => (await import('./pages/shared.js')).renderMyTasksPage,
  "/time-my-timesheet": async () => (await import('./pages/shared.js')).renderMyTimesheetPage,
  "/time-team-timesheet": async () => (await import('./pages/shared.js')).renderTeamTimesheetPage,
  "/time-clients": async () => (await import('./pages/shared.js')).renderTTClientsPage,
  "/time-projects": async () => (await import('./pages/projects.js')).renderProjectsRoute,
  "/leave-tracker": async () => (await import('./pages/leaveTracker.js')).renderLeaveTrackerPage,
  "/leave-my": async () => (await import('./pages/leaveTracker.js')).renderLeaveTrackerPage,
  "/leave-team": async () => (await import('./pages/leaveTracker.js')).renderLeaveTrackerPage,
  "/leave-settings": async () => (await import('./pages/leaveSettings.js')).renderLeaveSettingsPage,
  "/shift-settings": async () => (await import('./pages/shiftSettings.js')).renderShiftSettingsPage,
  "/login-settings": async () => (await import('./pages/loginSettings.js')).renderLoginSettingsPage,
  "/compoff": async () => (await import('./pages/comp_off.js')).renderCompOffPage,
  "/attendance-my": async () => (await import('./pages/attendance.js')).renderMyAttendancePage,
  "/attendance-team": async () => (await import('./pages/attendance.js')).renderTeamAttendancePage,
  "/admin-dashboard": async () => (await import('./pages/adminDashboard.js')).renderAdminDashboardPage,
  "/assets": async () => (await import('./pages/assets.js')).renderAssetsPage,
  "/attendance-holidays": async () => (await import('./pages/holidays.js')).renderHolidaysPage,
  "/onboarding": async () => (await import('./pages/onboarding.js')).renderOnboardingPage,
  "/interns/detail": async () => (await import('./pages/internDetail.js')).renderInternDetailPage,
  "/faceauth-settings": async () => (await import('./pages/faceAuthSettings.js')).renderFaceAuthSettings,
  "/role-settings": async () => (await import('./pages/roleSettings.js')).renderRoleSettingsPage,
};

export const router = async () => {
  const full = window.location.hash.slice(1) || '/';
  const path = full.split('?')[0] || '/';

  // If we navigate away from Meet, ensure meet UI artifacts are cleaned up
  if (path !== '/meet') {
    // Call the cleanup function if it exists
    if (typeof window.__cleanupMeetUI === 'function') {
      try { window.__cleanupMeetUI(); } catch (e) { console.warn('cleanupMeetUI error', e); }
    }
    // Also forcefully remove any meet-call-modal from the DOM
    try {
      const modal = document.getElementById('meet-call-modal');
      if (modal) {
        modal.remove();
      }
    } catch (e) {}
  }

  // Special-case intern detail
  if (path.startsWith('/interns/')) {
    if (!isManagerOrAdmin()) {
      renderAccessDenied("#/employees");
      return;
    }
    const internId = decodeURIComponent(path.substring('/interns/'.length));
    const renderInternDetailPage = await loaders['/interns/detail']();
    await renderInternDetailPage(internId);
    updateActiveNav('/interns');
    return;
  }

  // Chat and Meet modules are disabled for testing — redirect to home
  if (path === '/chat' || path === '/meet') {
    window.location.hash = '#/';
    return;
  }

  let renderer;
  try {
    const loadFn = loaders[path] || loaders['/'];
    renderer = await loadFn();
  } catch (err) {
    console.error('Failed to load page module:', path, err);
    document.getElementById('app-content').innerHTML = `<div class="card" style="padding:40px;text-align:center;"><h3>Page failed to load</h3><p>Please refresh the page.</p></div>`;
    return;
  }

  // Access checks
  if (path.startsWith('/employees')) {
    if (!canViewApplication('employees')) {
      renderAccessDenied("#/");
      return;
    }
  }
  if (path === '/team-management') {
    if (!canViewApplication('team_management')) {
      renderAccessDenied("#/");
      return;
    }
  }
  if (path === '/employees/bulk-upload' || path === '/employees/bulk-delete') {
    if (!canUseFunction('view_employee_directory')) {
      renderAccessDenied("#/employees");
      return;
    }
  }
  if (path === '/interns') {
    if (!canViewApplication('interns')) {
      renderAccessDenied("#/");
      return;
    }
  }
  if (path === '/time-team-timesheet') {
    if (!canViewApplication('time_team_timesheet')) {
      renderAccessDenied("#/time-my-timesheet");
      return;
    }
  }
  if (path === '/time-clients') {
    if (!canViewApplication('time_clients')) {
      renderAccessDenied("#/time-my-timesheet");
      return;
    }
  }
  if (path === '/leave-team') {
    if (!canViewApplication('leave_team')) {
      renderAccessDenied("#/leave-my");
      return;
    }
    window.__leaveViewMode = "team";
  } else if (path === '/leave-my') {
    window.__leaveViewMode = "my";
  }
  if (path === '/login-settings') {
    if (!canViewApplication('login_settings')) {
      renderAccessDenied("#/");
      return;
    }
  }
  if (path === '/shift-settings') {
    if (!canViewApplication('shift_settings')) {
      renderAccessDenied("#/");
      return;
    }
  }
  if (path === '/attendance-team') {
    if (!canViewApplication('attendance_team')) {
      renderAccessDenied("#/attendance-my");
      return;
    }
  }
  if (path === '/admin-dashboard') {
    if (!canViewApplication('admin_dashboard')) {
      renderAccessDenied("#/");
      return;
    }
  }
  if (path === '/onboarding') {
    if (!canViewApplication('onboarding')) {
      renderAccessDenied("#/");
      return;
    }
  }
  if (path === '/faceauth-settings') {
    if (!canViewApplication('faceauth_settings')) {
      renderAccessDenied("#/");
      return;
    }
  }
  if (path === '/role-settings') {
    if (!canViewApplication('role_settings')) {
      renderAccessDenied("#/");
      return;
    }
  }

  try {
    await renderer();
  } catch (err) {
    console.error('Page render error:', path, err);
    document.getElementById('app-content').innerHTML = `<div class="card" style="padding:40px;text-align:center;"><h3>Something went wrong</h3><p>${err.message || 'Unknown error'}</p><button class="btn btn-primary" onclick="location.reload()" style="margin-top:12px;">Reload</button></div>`;
  }
  updateActiveNav(path);
};

const updateActiveNav = (path) => {
  let page = (path === '/') ? 'home' : path.slice(1);
  if (['leave-settings', 'shift-settings', 'login-settings', 'faceauth-settings', 'role-settings'].includes(page)) {
    page = 'settings';
  }

  document.querySelectorAll('.nav-group').forEach((group) => {
    group.classList.remove('open');
    group.querySelector('.nav-toggle')?.classList.remove('active');
  });

  document.querySelectorAll('.nav-link').forEach((linkEl) => {
    const link = linkEl;
    const linkPage = link.dataset.page;
    const isActive = linkPage === page;
    link.classList.toggle('active', isActive);

    if (isActive) {
      const parentGroup = link.closest('.nav-group');
      if (parentGroup) {
        parentGroup.classList.add('open');
        parentGroup.querySelector('.nav-toggle')?.classList.add('active');
      }
    }
  });
};

export const initRouter = () => {
  window.addEventListener('hashchange', router);
  window.addEventListener('load', () => {
    if (!window.location.hash) {
      window.location.hash = '#/';
    }
    router();
  });
};