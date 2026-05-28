import { state } from '../state.js';
import { getPageContentHTML } from '../utils.js';
import { renderModal, closeModal } from '../components/modal.js';
import { showToast } from '../components/toast.js';
import { listEmployees } from '../features/employeeApi.js';
import { getUserAccessContext } from '../utils/accessControl.js';
import { canUseFunction } from '../utils/roleSettings.js';
import {
  listHierarchy,
  createHierarchyMapping,
  updateHierarchyMapping,
  deleteHierarchyMapping
} from '../features/hierarchyApi.js';

const TEAM_PAGE_SIZE = 25;
let searchDebounceTimer = null;
let cachedEmployees = [];
let cachedDepartments = [];
let employeesLoaded = false;
let employeesLoading = false;

const getEmpNameById = (id = '') => {
  if (!id) return '';
  const rec = cachedEmployees.find(e => (e.id || '').toLowerCase() === id.toLowerCase());
  return rec?.name || '';
};

const getEmployeeMetaById = (id = '') => {
  if (!id) return null;
  return cachedEmployees.find(e => (e.id || '').toLowerCase() === String(id).toLowerCase()) || null;
};

const ensureEmployeesCache = async () => {
  if (employeesLoaded || employeesLoading) {
    while (employeesLoading) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return cachedEmployees;
  }
  try {
    employeesLoading = true;
    const { items } = await listEmployees(1, 5000);
    cachedEmployees = (items || []).map(emp => ({
      id: emp.employee_id,
      name: `${emp.first_name || ''} ${emp.last_name || ''}`.trim() || emp.employee_id,
      department: emp.department || '',
      designation: emp.designation || ''
    })).filter(emp => emp.id);
    cachedDepartments = Array.from(new Set(cachedEmployees
      .map(emp => emp.department)
      .filter(Boolean)))
      .sort((a, b) => a.localeCompare(b));
    employeesLoaded = true;
  } catch (err) {
    console.error('Failed to load employees for hierarchy:', err);
    showToast(err?.message || 'Failed to load employees', 'error');
  } finally {
    employeesLoading = false;
  }
  return cachedEmployees;
};

// Treat employees whose designation contains "manager" as managers
const isManagerEmployee = (emp = {}) => {
  const d = String(emp.designation || '').toLowerCase();
  return d.includes('manager');
};

const canManageTeamHierarchy = () => {
  try {
    return canUseFunction('manage_team_hierarchy');
  } catch {
    return false;
  }
};

const getManagerOptionsHTML = (selected = '') => {
  const managers = cachedEmployees.filter(isManagerEmployee);
  const options = managers
    .map(emp => `<option value="${emp.id}" ${emp.id === selected ? 'selected' : ''}>${emp.name} (${emp.id})</option>`)
    .join('');
  return `<option value="">All Managers</option>${options}`;
};

const getAssignOptionsHTML = (selected = '', ignoreId = '') =>
  cachedEmployees
    .filter(emp => emp.id !== ignoreId)
    .map(emp => `<option value="${emp.id}" ${emp.id === selected ? 'selected' : ''}>${emp.name} (${emp.id})</option>`)
    .join('');

// Manager assignment dropdown: only show manager-designation employees
const getAssignManagerOptionsHTML = (selected = '', ignoreId = '') =>
  cachedEmployees
    .filter(emp => emp.id !== ignoreId && isManagerEmployee(emp))
    .map(emp => `<option value="${emp.id}" ${emp.id === selected ? 'selected' : ''}>${emp.name} (${emp.id})</option>`)
    .join('');

const getDepartmentOptionsHTML = (selected = '') => {
  const options = cachedDepartments
    .map(dept => `<option value="${dept}" ${dept === selected ? 'selected' : ''}>${dept}</option>`)
    .join('');
  return `<option value="">All Departments</option>${options}`;
};

const buildTableRows = (items = [], canManageHierarchy = true) => {
  if (!items.length) {
    return `<tr><td colspan="5" class="placeholder-text">No hierarchy mappings found.</td></tr>`;
  }
  return items.map(item => `
    <tr data-id="${item.id}">
      <td>${item.employeeId || '-'}</td>
      <td>${item.employeeName || '-'}</td>
      <td>${item.managerId || '-'}</td>
      <td>${item.managerName || '-'}</td>
      <td class="actions-cell" style="text-align: center; vertical-align: middle;">
        ${canManageHierarchy
          ? `<div style="display: inline-flex; gap: 4px; align-items: center; justify-content: center;">
          <button class="icon-btn tm-edit-btn" title="Edit" data-id="${item.id}" data-employee="${item.employeeId || ''}">
            <i class="fa-solid fa-pen-to-square"></i>
          </button>
          <button class="icon-btn tm-delete-btn" title="Delete" data-id="${item.id}">
            <i class="fa-solid fa-trash"></i>
          </button>
        </div>`
          : '<span class="subtle">View only</span>'}
      </td>
    </tr>
  `).join('');
};

const buildGroupedView = (groups = [], canManageHierarchy = true) => {
  if (!groups.length) {
    return `<div class="placeholder-text">No manager groups found.</div>`;
  }
  return groups.map(group => {
    const members = (group.members || []).map(member => `
      <tr data-id="${member.id}">
        <td>${member.employeeId || '-'}</td>
        <td>${member.employeeName || '-'}</td>
        <td class="actions-cell" style="text-align: center; vertical-align: middle;">
          ${canManageHierarchy
            ? `<div style="display: inline-flex; gap: 4px; align-items: center; justify-content: center;">
            <button class="icon-btn tm-edit-btn" title="Edit" data-id="${member.id}" data-employee="${member.employeeId || ''}">
              <i class="fa-solid fa-pen-to-square"></i>
            </button>
            <button class="icon-btn tm-delete-btn" title="Delete" data-id="${member.id}">
              <i class="fa-solid fa-trash"></i>
            </button>
          </div>`
            : '<span class="subtle">View only</span>'}
        </td>
      </tr>
    `).join('');

    return `
      <div class="team-group-card">
        <div class="team-group-header">
          <div>
            <h3>${group.managerName || group.managerId || 'Unassigned Manager'}</h3>
            <p><strong>Manager ID:</strong> ${group.managerId || '-'}${group.managerDepartment ? ` • ${group.managerDepartment}` : ''}</p>
          </div>
          <span class="team-group-count">${(group.members || []).length} member${(group.members || []).length === 1 ? '' : 's'}</span>
        </div>
        <div class="table-container">
          <table class="table">
            <thead>
              <tr><th>Employee ID</th><th>Employee Name</th><th style="width:120px;">Actions</th></tr>
            </thead>
            <tbody>
              ${members || `<tr><td colspan="3" class="placeholder-text">No team members assigned.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }).join('');
};

const buildTreeView = (groups = []) => {
  if (!groups.length) {
    return `<div class="placeholder-text">No team hierarchy data found.</div>`;
  }
  const getInitials = (name = '', fallback = '?') => {
    const trimmed = String(name || '').trim();
    if (!trimmed) return fallback;
    return trimmed
      .split(' ')
      .filter(Boolean)
      .map(part => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
  };

  const cards = groups.map(group => {
    const managerMeta = getEmployeeMetaById(group.managerId || '');
    const managerName = group.managerName || group.managerId || 'Unassigned Manager';
    const managerInitials = getInitials(managerName, 'M');
    const managerRole = managerMeta?.designation || group.managerDepartment || 'Manager';

    const members = group.members || [];
    const membersHtml = members.length
      ? members.map(member => {
          const empMeta = getEmployeeMetaById(member.employeeId || '');
          const empName = member.employeeName || member.employeeId || '';
          const empInitials = getInitials(empName, 'E');
          const empRole = empMeta?.designation || member.employeeDepartment || 'Team Member';
          return `
            <div class="tree-child" draggable="true" data-record-id="${member.id}" data-employee-id="${member.employeeId || ''}" data-manager-id="${group.managerId || ''}">
              <div class="tree-child-line"></div>
              <div class="tree-node member-node">
                <div class="avatar-circle member-avatar">${empInitials}</div>
                <div class="node-pill">
                  <div class="node-name">${empName}</div>
                  <div class="node-role">${empRole}</div>
                </div>
              </div>
            </div>
          `;
        }).join('')
      : '<div class="placeholder-text">No direct reports assigned.</div>';

    return `
      <div class="team-tree-card">
        <div class="tree-root">
          <div class="tree-node manager-node" data-manager-id="${group.managerId || ''}">
            <div class="avatar-circle manager-avatar">${managerInitials}</div>
            <div class="node-pill">
              <div class="node-name">${managerName}</div>
              <div class="node-role">${managerRole}</div>
            </div>
          </div>
        </div>
        <div class="tree-level">
          <div class="tree-horizontal-line"></div>
          <div class="tree-children">
            ${membersHtml}
          </div>
        </div>
      </div>
    `;
  }).join('');

  return `<div class="team-tree-wrapper">${cards}</div>`;
};

const setupTreeDragAndDrop = () => {
  let draggedEl = null;

  const draggableNodes = document.querySelectorAll('.tree-child[draggable="true"]');
  draggableNodes.forEach(node => {
    node.addEventListener('dragstart', (event) => {
      console.log('[TM Tree DnD] dragstart on employee node', {
        node,
        recordId: node.dataset.recordId,
        employeeId: node.dataset.employeeId,
        managerId: node.dataset.managerId,
        dataTransfer: !!event.dataTransfer
      });
      draggedEl = node;
      node.classList.add('dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        const payload = {
          recordId: node.dataset.recordId,
          employeeId: node.dataset.employeeId,
          fromManagerId: node.dataset.managerId
        };
        try {
          const json = JSON.stringify(payload);
          // Some browsers require a text type for drag to initialize
          event.dataTransfer.setData('text/plain', json);
          event.dataTransfer.setData('application/json', json);
          console.log('[TM Tree DnD] dragstart setData payload', json);
        } catch (err) {
          console.warn('[TM Tree DnD] dragstart setData failed', err);
        }
      } else {
        console.warn('[TM Tree DnD] dragstart has no dataTransfer');
      }
    });
    node.addEventListener('dragend', () => {
      console.log('[TM Tree DnD] dragend on employee node', {
        recordId: node.dataset.recordId,
        employeeId: node.dataset.employeeId,
        managerId: node.dataset.managerId
      });
      node.classList.remove('dragging');
      draggedEl = null;
    });
  });

  // Treat both the manager node container and its main visual children as drop targets
  const managerTargets = document.querySelectorAll('.tree-node.manager-node, .tree-node.manager-node .avatar-circle.manager-avatar, .tree-node.manager-node .node-pill');
  console.log('[TM Tree DnD] Found manager targets', Array.from(managerTargets).map(t => ({
    tag: t.tagName,
    classes: t.className,
    managerId: t.closest('.tree-node.manager-node')?.dataset?.managerId || null
  })));

  managerTargets.forEach(target => {
    target.addEventListener('dragover', (event) => {
      if (!draggedEl) {
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move';
      }

      const managerEl = target.closest('.tree-node.manager-node') || target;
      const managerId = managerEl.dataset.managerId;

      if (!managerEl.classList.contains('drop-target')) {
        console.log('[TM Tree DnD] dragover on manager node', {
          managerId,
          draggedEmployeeId: draggedEl?.dataset?.employeeId
        });
      }
      managerEl.classList.add('drop-target');
    });
    target.addEventListener('dragleave', () => {
      const managerEl = target.closest('.tree-node.manager-node') || target;
      console.log('[TM Tree DnD] dragleave on manager node', {
        managerId: managerEl.dataset.managerId
      });
      managerEl.classList.remove('drop-target');
    });
    target.addEventListener('drop', async (event) => {
      if (!draggedEl) {
        console.warn('[TM Tree DnD] drop fired but draggedEl is null');
        return;
      }
      event.preventDefault();
      const managerEl = target.closest('.tree-node.manager-node') || target;
      managerEl.classList.remove('drop-target');

      const newManagerId = managerEl.dataset.managerId || '';
      console.log('[TM Tree DnD] drop on manager node', {
        newManagerId,
        target,
        managerEl,
        hasDataTransfer: !!event.dataTransfer
      });
      if (!newManagerId) {
        console.warn('[TM Tree DnD] drop: missing newManagerId on target');
        return;
      }

      let payload = null;
      try {
        let raw = '';
        if (event.dataTransfer) {
          const jsonData = event.dataTransfer.getData('application/json');
          const textData = event.dataTransfer.getData('text/plain');
          console.log('[TM Tree DnD] drop dataTransfer contents', {
            jsonData,
            textData
          });
          raw = jsonData || textData || '';
        }
        if (raw) {
          payload = JSON.parse(raw);
          console.log('[TM Tree DnD] drop parsed payload from dataTransfer', payload);
        }
      } catch (err) {
        console.warn('[TM Tree DnD] drop failed to parse payload from dataTransfer, falling back to DOM dataset', err);
      }
      if (!payload) {
        payload = {
          recordId: draggedEl.dataset.recordId,
          employeeId: draggedEl.dataset.employeeId,
          fromManagerId: draggedEl.dataset.managerId
        };
        console.log('[TM Tree DnD] drop using fallback payload from dragged element', payload);
      }

      if (!payload.recordId || !payload.employeeId) {
        console.warn('[TM Tree DnD] drop payload missing recordId/employeeId', payload);
        return;
      }
      if (payload.fromManagerId && payload.fromManagerId.toLowerCase() === newManagerId.toLowerCase()) {
        console.log('[TM Tree DnD] drop ignored because manager is unchanged', {
          fromManagerId: payload.fromManagerId,
          newManagerId
        });
        return;
      }

      try {
        console.log('[TM Tree DnD] calling updateHierarchyMapping', {
          recordId: payload.recordId,
          newManagerId
        });
        draggedEl.classList.add('dropping');
        await updateHierarchyMapping(payload.recordId, { managerId: newManagerId });
        console.log('[TM Tree DnD] updateHierarchyMapping success, reloading page');
        showToast('Team updated', 'success');
        await renderTeamManagementPage(state.teamHierarchy.page || 1);
      } catch (err) {
        console.error('Failed to move employee between managers:', err);
        showToast(err?.message || 'Failed to update team hierarchy', 'error');
      } finally {
        draggedEl.classList.remove('dropping');
      }
    });
  });
};

const buildPagination = (page, total, pageSize) => {
  if (!total || total <= pageSize) {
    return '';
  }
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const prevDisabled = page <= 1 ? 'disabled' : '';
  const nextDisabled = page >= totalPages ? 'disabled' : '';
  const prevPage = Math.max(1, page - 1);
  const nextPage = Math.min(totalPages, page + 1);
  return `
    <div class="pagination">
      <button id="tm-prev" class="btn" data-target-page="${prevPage}" ${prevDisabled}><i class="fa-solid fa-chevron-left"></i> Prev</button>
      <span class="page-indicator">Page ${page} of ${totalPages}</span>
      <button id="tm-next" class="btn" data-target-page="${nextPage}" ${nextDisabled}>Next <i class="fa-solid fa-chevron-right"></i></button>
    </div>
  `;
};

const renderAssignEmployeeModal = () => {
  if (!canManageTeamHierarchy()) {
    showToast('You have view-only access to team management.', 'warning');
    return;
  }
  const employeeOptions = getAssignOptionsHTML();
  const managerOptions = getAssignManagerOptionsHTML();

  const modalBody = `
    <div class="modal-form modern-form team-modal">
      <div class="form-section">
        <div class="form-section-header">
          <div>
            <p class="form-eyebrow">Team</p>
            <h3>Assignment details</h3>
          </div>
        </div>
        <div class="form-grid two-col">
          <div class="form-field">
            <label class="form-label" for="assign-employee">Employee</label>
            <select class="input-control" id="assign-employee" required>
              <option value="">Select Employee</option>
              ${employeeOptions}
            </select>
          </div>

          <div class="form-field">
            <label class="form-label" for="assign-manager">Manager</label>
            <select class="input-control" id="assign-manager" required>
              <option value="">Select Manager</option>
              ${managerOptions}
            </select>
          </div>
        </div>
      </div>
    </div>
  `;

  renderModal('Assign Employee to Manager', modalBody, 'assign-employee-submit');
  setTimeout(() => {
    const form = document.getElementById('modal-form');
    if (form) {
      form.addEventListener('submit', handleAssignSubmit);
    }
    document.querySelectorAll('#assign-employee, #assign-manager').forEach(select => {
      select?.addEventListener('change', () => {
        document.getElementById('assign-employee-submit').disabled = !document.getElementById('assign-employee').value || !document.getElementById('assign-manager').value;
      });
    });
  }, 50);
};

const renderEditManagerModal = (recordId, employeeId, currentManagerId = '') => {
  if (!canManageTeamHierarchy()) {
    showToast('You have view-only access to team management.', 'warning');
    return;
  }
  const managerOptions = getAssignManagerOptionsHTML(currentManagerId, employeeId);
  const modalBody = `
    <div class="modal-form modern-form team-modal">
      <div class="form-section">
        <div class="form-section-header">
          <div>
            <p class="form-eyebrow">Team</p>
            <h3>Update manager</h3>
          </div>
        </div>
        <div class="form-grid two-col">
          <div class="form-field">
            <label class="form-label">Employee</label>
            <input class="input-control readonly-input" type="text" value="${employeeId}" disabled>
          </div>

          <div class="form-field">
            <label class="form-label" for="edit-manager">Manager</label>
            <select class="input-control" id="edit-manager" required>
              <option value="">Select Manager</option>
              ${managerOptions}
            </select>
          </div>
        </div>
      </div>
    </div>
  `;
  renderModal('Update Manager', modalBody, 'edit-manager-submit', 'normal', 'Update');
  setTimeout(() => {
    const form = document.getElementById('modal-form');
    const select = document.getElementById('edit-manager');
    if (select) {
      select.value = currentManagerId || '';
    }
    if (form) {
      form.addEventListener('submit', (event) => handleEditSubmit(event, recordId, employeeId));
    }
  }, 50);
};

const handleAssignSubmit = async (event) => {
  event.preventDefault();
  if (!canManageTeamHierarchy()) {
    showToast('You have view-only access to team management.', 'warning');
    return;
  }
  const employeeId = document.getElementById('assign-employee')?.value?.trim();
  const managerId = document.getElementById('assign-manager')?.value?.trim();

  if (!employeeId || !managerId) {
    showToast('Please select both employee and manager', 'warning');
    return;
  }
  if (employeeId === managerId) {
    showToast('Employee and Manager cannot be the same person.', 'error');
    return;
  }

  try {
    document.getElementById('assign-employee-submit').disabled = true;
    await createHierarchyMapping({ employeeId, managerId });
    closeModal();
    showToast('Added successfully', 'success');
    await renderTeamManagementPage(1);
  } catch (err) {
    console.error('Failed to assign employee:', err);
    showToast(err?.message || 'Failed to assign employee', 'error');
    document.getElementById('assign-employee-submit').disabled = false;
  }
};

const handleEditSubmit = async (event, recordId, employeeId) => {
  event.preventDefault();
  if (!canManageTeamHierarchy()) {
    showToast('You have view-only access to team management.', 'warning');
    return;
  }
  const managerId = document.getElementById('edit-manager')?.value?.trim();
  if (!managerId) {
    showToast('Please select a manager', 'warning');
    return;
  }
  if (employeeId === managerId) {
    showToast('Employee and Manager cannot be the same person.', 'error');
    return;
  }
  try {
    document.getElementById('edit-manager-submit').disabled = true;
    await updateHierarchyMapping(recordId, { managerId });
    closeModal();
    showToast('Updated successfully', 'success');
    await renderTeamManagementPage(state.teamHierarchy.page || 1);
  } catch (err) {
    console.error('Failed to update hierarchy:', err);
    showToast(err?.message || 'Failed to update mapping', 'error');
    document.getElementById('edit-manager-submit').disabled = false;
  }
};

const handleDelete = async (recordId) => {
  if (!canManageTeamHierarchy()) {
    showToast('You have view-only access to team management.', 'warning');
    return;
  }
  const confirmed = confirm('Are you sure you want to remove this relationship?');
  if (!confirmed) return;
  try {
    await deleteHierarchyMapping(recordId);
    showToast('Relationship removed', 'success');
    const page = state.teamHierarchy.page || 1;
    await renderTeamManagementPage(page);
  } catch (err) {
    console.error('Failed to delete hierarchy:', err);
    showToast(err?.message || 'Failed to delete mapping', 'error');
  }
};

const attachEventHandlers = (canManageHierarchy = true) => {
  const searchInput = document.getElementById('tm-search');
  const managerFilter = document.getElementById('tm-filter-manager');
  const departmentFilter = document.getElementById('tm-filter-department');
  const groupToggle = document.getElementById('tm-group-toggle');
  const assignBtn = document.getElementById('tm-assign-btn');
  const refreshBtn = document.getElementById('tm-refresh-btn');
  const viewTableBtn = document.getElementById('tm-view-table');
  const viewTreeBtn = document.getElementById('tm-view-tree');

  if (searchInput) {
    searchInput.addEventListener('input', (event) => {
      clearTimeout(searchDebounceTimer);
      const value = event.target.value;
      searchDebounceTimer = setTimeout(() => {
        state.teamHierarchyFilters.search = value.trim();
        renderTeamManagementPage(1);
      }, 300);
    });
  }

  if (managerFilter) {
    managerFilter.addEventListener('change', (event) => {
      state.teamHierarchyFilters.manager = event.target.value;
      renderTeamManagementPage(1);
    });
  }

  if (departmentFilter) {
    departmentFilter.addEventListener('change', (event) => {
      state.teamHierarchyFilters.department = event.target.value;
      renderTeamManagementPage(1);
    });
  }

  if (groupToggle) {
    groupToggle.disabled = state.teamHierarchyFilters.viewMode === 'tree';
    groupToggle.addEventListener('change', (event) => {
      state.teamHierarchyFilters.groupByManager = event.target.checked;
      renderTeamManagementPage(1);
    });
  }

  if (viewTableBtn) {
    viewTableBtn.addEventListener('click', () => {
      if (state.teamHierarchyFilters.viewMode !== 'table') {
        state.teamHierarchyFilters.viewMode = 'table';
        renderTeamManagementPage(1);
      }
    });
  }

  if (viewTreeBtn) {
    viewTreeBtn.addEventListener('click', () => {
      if (state.teamHierarchyFilters.viewMode !== 'tree') {
        state.teamHierarchyFilters.viewMode = 'tree';
        state.teamHierarchyFilters.groupByManager = true;
        renderTeamManagementPage(1);
      }
    });
  }

  if (canManageHierarchy && assignBtn) {
    assignBtn.addEventListener('click', () => {
      renderAssignEmployeeModal();
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      renderTeamManagementPage(state.teamHierarchy.page || 1);
    });
  }

  if (canManageHierarchy && state.teamHierarchyFilters.viewMode === 'tree') {
    setupTreeDragAndDrop();
  }

  if (canManageHierarchy) {
    document.querySelectorAll('.tm-edit-btn').forEach(btn => {
      btn.addEventListener('click', (event) => {
        const recordId = event.currentTarget.dataset.id;
        const employeeId = event.currentTarget.dataset.employee;
        const currentRow = event.currentTarget.closest('tr');
        const managerCell = currentRow?.querySelector('td:nth-child(3)');
        const currentManagerId = managerCell?.textContent?.trim();
        renderEditManagerModal(recordId, employeeId, currentManagerId);
      });
    });

    document.querySelectorAll('.tm-delete-btn').forEach(btn => {
      btn.addEventListener('click', (event) => {
        const recordId = event.currentTarget.dataset.id;
        handleDelete(recordId);
      });
    });
  }

  const prevBtn = document.getElementById('tm-prev');
  const nextBtn = document.getElementById('tm-next');
  if (prevBtn) {
    prevBtn.addEventListener('click', () => {
      const target = Number(prevBtn.dataset.targetPage) || 1;
      renderTeamManagementPage(target);
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      const target = Number(nextBtn.dataset.targetPage) || 1;
      renderTeamManagementPage(target);
    });
  }
};

export const renderTeamManagementPage = async (page = 1) => {
  try {
    await ensureEmployeesCache();
    const filters = state.teamHierarchyFilters || {};
    const viewMode = filters.viewMode || 'table';
    const canManageHierarchy = canManageTeamHierarchy();

    const query = {
      page,
      pageSize: TEAM_PAGE_SIZE,
      search: filters.search || '',
      manager: filters.manager || '',
      department: filters.department || '',
      groupByManager: viewMode === 'tree' ? true : !!filters.groupByManager
    };

    const loadingHTML = `
      <div class="card team-management-card">
        <div class="tm-filter-shell" style="margin-bottom: 10px;">
          <div class="team-management-filters">
            <div class="filter-field filter-search">
              <label>Search</label>
              <div class="input-with-icon">
                <div class="skeleton skeleton-text" style="height: 30px; width: 100%; border-radius: 999px;"></div>
              </div>
            </div>
            <div class="filter-field">
              <label>Manager</label>
              <div class="skeleton skeleton-pill" style="height: 30px; width: 100%;"></div>
            </div>
            <div class="filter-field">
              <label>Department</label>
              <div class="skeleton skeleton-pill" style="height: 30px; width: 100%;"></div>
            </div>
            <div class="filter-field filter-toggle">
              <label>Group by Manager</label>
              <div class="skeleton skeleton-pill" style="height: 30px; width: 140px;"></div>
            </div>
          </div>
        </div>
        <div class="table-container" style="margin-top: 6px; min-height: 260px;">
          <div class="skeleton skeleton-chart-line"></div>
        </div>
      </div>`;
    document.getElementById('app-content').innerHTML = getPageContentHTML('Team Management', loadingHTML, '');

    const data = await listHierarchy(query);
    const {
      items = [],
      total = 0,
      page: returnedPage = page,
      pageSize = TEAM_PAGE_SIZE,
      grouped = false
    } = data || {};

    // Resolve names on the client using cached employee masters when missing or equal to ID
    let resolvedItems = [];
    let resolvedGroups = [];
    if (grouped) {
      resolvedGroups = (items || []).map(g => ({
        ...g,
        managerName: (g.managerName && g.managerName !== g.managerId) ? g.managerName : (getEmpNameById(g.managerId) || g.managerId),
        members: (g.members || []).map(m => ({
          ...m,
          employeeName: (m.employeeName && m.employeeName !== m.employeeId) ? m.employeeName : (getEmpNameById(m.employeeId) || m.employeeId)
        }))
      }));
    } else {
      resolvedItems = (items || []).map(r => ({
        ...r,
        employeeName: (r.employeeName && r.employeeName !== r.employeeId) ? r.employeeName : (getEmpNameById(r.employeeId) || r.employeeId),
        managerName: (r.managerName && r.managerName !== r.managerId) ? r.managerName : (getEmpNameById(r.managerId) || r.managerId)
      }));
    }

    state.teamHierarchy = {
      items: grouped ? [] : resolvedItems,
      groups: grouped ? resolvedGroups : [],
      total: grouped ? (data?.total || (items || []).length) : total,
      page: returnedPage,
      pageSize,
      grouped
    };

    const controls = `
      <div class="team-management-controls">
        ${canManageHierarchy ? '<button id="tm-assign-btn" class="btn btn-primary"><i class="fa-solid fa-user-plus"></i> Assign Employee</button>' : '<span class="subtle" style="font-size:0.85rem;">View-only access</span>'}
        <button id="tm-refresh-btn" class="btn btn-secondary"><i class="fa-solid fa-rotate"></i> Refresh</button>
      </div>
    `;

    const filtersHtml = `
      <div class="tm-filter-shell">
        <div class="team-management-filters">
          <div class="filter-field filter-search">
            <label for="tm-search">Search</label>
            <div class="inline-search" style="width:100%;">
              <i class="fa-solid fa-search"></i>
              <input type="text" id="tm-search" placeholder="Search by employee name or ID" value="${filters.search || ''}">
            </div>
          </div>
          <div class="filter-field">
            <label for="tm-filter-manager">Manager</label>
            <select id="tm-filter-manager">${getManagerOptionsHTML(filters.manager || '')}</select>
          </div>
          <div class="filter-field">
            <label for="tm-filter-department">Department</label>
            <select id="tm-filter-department">${getDepartmentOptionsHTML(filters.department || '')}</select>
          </div>
          <div class="filter-field filter-toggle">
            <div class="filter-toggle-top">
              <div class="filter-toggle-label">
                <label for="tm-group-toggle">Group by Manager</label>
                <label class="filter-checkbox">
                  <input type="checkbox" id="tm-group-toggle" ${filters.groupByManager ? 'checked' : ''} ${viewMode === 'tree' ? 'disabled' : ''}>
                  <span>Enable grouping</span>
                </label>
              </div>
              <div class="tm-view-toggle" role="group" aria-label="Select view">
                <button type="button" id="tm-view-table" class="view-toggle-btn ${viewMode === 'table' ? 'active' : ''}">
                  <i class="fa-solid fa-list"></i><span>List</span>
                </button>
                <button type="button" id="tm-view-tree" class="view-toggle-btn ${viewMode === 'tree' ? 'active' : ''}">
                  <i class="fa-solid fa-sitemap"></i><span>Tree</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    let bodyContent = '';

    if (viewMode === 'tree') {
      bodyContent = `
        ${filtersHtml}
        ${buildTreeView(state.teamHierarchy.groups)}
      `;
    } else if (state.teamHierarchy.grouped) {
      bodyContent = `
        ${filtersHtml}
        <div class="team-groups-wrapper">
          ${buildGroupedView(state.teamHierarchy.groups, canManageHierarchy)}
        </div>
      `;
    } else {
      const table = `
        <div class="table-container">
          <table class="table">
            <thead>
              <tr>
                <th>Employee ID</th>
                <th>Employee Name</th>
                <th>Manager ID</th>
                <th>Manager Name</th>
                <th style="width:120px;">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${buildTableRows(state.teamHierarchy.items, canManageHierarchy)}
            </tbody>
          </table>
        </div>
        ${buildPagination(state.teamHierarchy.page, state.teamHierarchy.total, state.teamHierarchy.pageSize)}
      `;
      bodyContent = `${filtersHtml}${table}`;
    }

    // Scoped styles to make layout more breathable and modern without affecting other pages
    const styles = `
      <style>
        .team-management-card { padding: 12px 16px; }
        .team-management-controls { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; margin-bottom: 10px; }
        .team-management-controls .btn { padding: 6px 12px; font-size: 0.8rem; }
        
        /* Filter section */
        .tm-filter-shell { 
          padding: 16px 18px; 
          border: 1px solid var(--border-color); 
          border-radius: 14px; 
          background: var(--surface-color); 
          box-shadow: 0 10px 30px rgba(15,23,42,0.06); 
          margin-bottom: 12px; 
        }
        .team-management-filters { 
          display: grid; 
          grid-template-columns: minmax(240px, 1.6fr) minmax(180px, 1fr) minmax(180px, 1fr) minmax(240px, 1.1fr); 
          column-gap: 20px; 
          row-gap: 16px;
          align-items: stretch; 
        }
        .team-management-filters .filter-field { display: flex; flex-direction: column; gap: 10px; height: 100%; }
        .team-management-filters label { font-weight: 600; color: var(--text-secondary); font-size: 0.7rem; margin-bottom: 0; text-transform: uppercase; letter-spacing: 0.04em; }
        .team-management-filters .filter-search .inline-search {
          width: 100%;
          max-width: 420px;
          height: 42px;
        }
        .team-management-filters .inline-search input {
          height: 42px;
          font-size: 0.82rem;
        }
        .team-management-filters .inline-search i {
          font-size: 0.78rem;
        }
        .team-management-filters .input-with-icon { 
          display: flex; 
          align-items: center; 
          gap: 10px; 
          padding: 0 12px; 
          border: 1px solid #d1d5db; 
          border-radius: 10px; 
          height: 42px; 
          background: var(--surface-color); 
          transition: all 0.2s ease; 
        }
        .team-management-filters .input-with-icon:focus-within { 
          border-color: var(--primary-color); 
          box-shadow: 0 0 0 2px rgba(59,130,246,0.12); 
        }
        .team-management-filters .input-with-icon i { color: var(--text-muted); font-size: 0.75rem; }
        .team-management-filters input { 
          border: none; 
          outline: none; 
          font-size: 0.8rem;
          width: 100%; 
          height: 100%; 
          color: var(--text-primary);
        }
        .team-management-filters select { 
          width: 100%; 
          height: 42px; 
          border-radius: 10px; 
          border: 1px solid #d1d5db; 
          padding: 0 12px; 
          font-size: 0.82rem; 
          background: var(--surface-color); 
          transition: all 0.2s ease; 
          color: var(--text-primary);
        }
        .team-management-filters select:focus { 
          border-color: var(--primary-color); 
          box-shadow: 0 0 0 2px rgba(59,130,246,0.12); 
          outline: none; 
        }
        .filter-toggle-top {
          display: grid;
          grid-template-columns: 1fr auto;
          column-gap: 16px;
          row-gap: 10px;
          align-items: center;
          padding: 12px 14px;
          background: #f8fafc;
          border: 1px solid var(--border-color);
          border-radius: 14px;
          min-height: 42px;
        }
        .filter-field.filter-toggle { height: 100%; }
        .filter-toggle-label { display: grid; row-gap: 6px; align-content: start; }
        .filter-checkbox { display: inline-flex; align-items: center; gap: 8px; font-size: 0.75rem; color: var(--text-secondary); padding: 0; background: transparent; border-radius: 8px; }
        .filter-checkbox input { margin: 0; width: 16px; height: 16px; cursor: pointer; }
        .filter-toggle label { margin-bottom: 0; }
        .tm-view-toggle {
          display: inline-flex;
          flex-direction: column;
          align-items: stretch;
          gap: 6px;
          padding: 8px;
          border-radius: 18px;
          background: linear-gradient(135deg, rgba(99,102,241,0.12), rgba(14,165,233,0.08));
          border: 1px solid rgba(99,102,241,0.35);
          box-shadow: inset 0 0 0 1px rgba(255,255,255,0.45), 0 8px 22px rgba(15,23,42,0.12);
        }
        .view-toggle-btn {
          border: none;
          background: transparent;
          color: var(--text-secondary);
          border-radius: 12px;
          padding: 8px 16px;
          font-size: 0.72rem;
          font-weight: 600;
          letter-spacing: 0.02em;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          cursor: pointer;
          transition: all 0.18s ease;
          min-width: 140px;
          height: 38px;
          justify-content: center;
        }
        .view-toggle-btn:hover {
          color: var(--text-primary);
        }
        .view-toggle-btn:focus-visible {
          outline: none;
          box-shadow: 0 0 0 2px rgba(99,102,241,0.35);
        }
        .view-toggle-btn.active {
          background: linear-gradient(135deg, #4f46e5, #6366f1);
          color: #ffffff;
          box-shadow: 0 10px 20px rgba(79,70,229,0.35);
          transform: translateY(-1px);
        }
        .view-toggle-btn i {
          font-size: 0.75rem;
        }

        @media (max-width: 1024px) {
          .team-management-filters {
            grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
          }
          .team-management-filters .filter-toggle {
            grid-column: 1 / -1;
          }
          .filter-toggle-top {
            flex-wrap: wrap;
          }
          .tm-view-toggle {
            width: 100%;
            justify-content: flex-start;
          }
        }
        @media (max-width: 640px) {
          .team-management-filters {
            grid-template-columns: 1fr;
          }
          .filter-toggle-top { align-items: flex-start; }
          .tm-view-toggle { justify-content: flex-start; flex-wrap: wrap; }
        }

        /* Ultra-compact table with optimized columns */
        .table-container { 
          overflow-x: auto; 
          border: 1px solid var(--border-color); 
          border-radius: 8px; 
          background: var(--surface-color); 
          box-shadow: 0 1px 10px rgba(15,23,42,0.4); 
          max-height: calc(100vh - 250px);
        }
        .table { 
          width: 100%; 
          border-collapse: separate; 
          border-spacing: 0; 
          font-size: 0.78rem; 
        }
        .table thead th { 
          position: sticky; 
          top: 0; 
          background: linear-gradient(to bottom, var(--surface-alt), var(--surface-color)); 
          z-index: 2; 
          text-align: center; 
          font-size: 0.68rem; 
          padding: 6px 8px; 
          letter-spacing: 0.05em; 
          text-transform: uppercase;
          color: var(--text-secondary);
          font-weight: 700;
          border-bottom: 1px solid #e5e7eb;
          white-space: nowrap;
          line-height: 1.2;
        }
        .table th:nth-child(1), .table td:nth-child(1) { width: 11%; text-align: center; } /* Employee ID */
        .table th:nth-child(2), .table td:nth-child(2) { width: 30%; text-align: center; } /* Employee Name */
        .table th:nth-child(3), .table td:nth-child(3) { width: 11%; text-align: center; } /* Manager ID */
        .table th:nth-child(4), .table td:nth-child(4) { width: 30%; text-align: center; } /* Manager Name */
        .table th:nth-child(5), .table td:nth-child(5) { width: 90px; text-align: center; } /* Actions */
        
        .table th, .table td { 
          padding: 6px 8px; 
          line-height: 1.3; 
          vertical-align: middle;
        }
        .table tbody tr { 
          border-bottom: 1px solid #f3f4f6; 
          transition: background-color 0.1s ease;
        }
        .table tbody tr:hover { background: var(--surface-hover); }
        .table tbody tr:last-child { border-bottom: none; }
        .table tbody td { color: var(--text-primary); font-size: 0.78rem; }
        
        .actions-cell { 
          text-align: center !important; 
          vertical-align: middle !important;
        }
        .actions-cell > div {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 4px;
        }
        .icon-btn { 
          border: none; 
          background: transparent; 
          cursor: pointer; 
          padding: 6px 8px;
          margin: 0 2px;
          border-radius: 6px;
          transition: all 0.15s ease;
          color: var(--text-secondary);
          font-size: 0.85rem;
          min-width: 32px;
          height: 32px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        .icon-btn:hover { background: var(--surface-hover); color: var(--text-primary); }
        .icon-btn.tm-delete-btn:hover { background: #fee2e2; color: #dc2626; }
        
        /* Team group cards - ultra compact */
        .team-groups-wrapper { 
          display: grid; 
          gap: 12px; 
        }
        .team-group-card { 
          border: 1px solid var(--border-color); 
          border-radius: 8px; 
          background: var(--surface-color); 
          overflow: hidden; 
          box-shadow: 0 1px 10px rgba(15,23,42,0.4);
        }
        .team-group-header { 
          display: flex; 
          justify-content: space-between; 
          align-items: center; 
          padding: 10px 12px; 
          background: linear-gradient(to right, var(--surface-alt), var(--surface-color)); 
          border-bottom: 1px solid var(--border-color); 
        }
        .team-group-header h3 { 
          margin: 0 0 2px; 
          font-size: 0.9rem; 
          color: var(--text-primary);
          font-weight: 600;
        }
        .team-group-header p { 
          margin: 0; 
          color: var(--text-secondary); 
          font-size: 0.7rem; 
        }
        .team-group-count { 
          background: #dbeafe; 
          color: #1e40af; 
          padding: 3px 8px; 
          border-radius: 999px; 
          font-size: 0.7rem; 
          font-weight: 700; 
        }
        .team-tree-wrapper {
          display: flex;
          flex-direction: column;
          gap: 18px;
          margin-top: 8px;
        }
        .team-tree-card {
          border: 1px solid var(--border-color);
          border-radius: 24px;
          padding: 18px 20px 20px;
          background: radial-gradient(circle at top, rgba(148,163,184,0.28), transparent 58%), var(--surface-color);
          box-shadow: 0 8px 22px rgba(15,23,42,0.6);
        }
        .tree-root {
          display: flex;
          justify-content: center;
          margin-bottom: 10px;
        }
        .tree-node {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
        }
        .manager-node .avatar-circle {
          width: 70px;
          height: 70px;
        }
        .member-node .avatar-circle {
          width: 56px;
          height: 56px;
        }
        .avatar-circle {
          border-radius: 999px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 700;
          font-size: 1rem;
          box-shadow: 0 4px 12px rgba(15,23,42,0.6);
          border: 2px solid rgba(148,163,184,0.6);
        }
        .manager-avatar {
          background: radial-gradient(circle at 30% 20%, #f97316, #fb7185);
          color: #0f172a;
        }
        .member-avatar {
          background: radial-gradient(circle at 30% 20%, #38bdf8, #4f46e5);
          color: #0f172a;
        }
        .node-pill {
          min-width: 160px;
          max-width: 220px;
          padding: 6px 14px 7px;
          border-radius: 999px;
          background: rgba(15,23,42,0.92);
          box-shadow: 0 3px 10px rgba(15,23,42,0.7);
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 2px;
        }
        .node-name {
          font-size: 0.82rem;
          font-weight: 600;
          color: #e5e7eb;
        }
        .node-role {
          font-size: 0.7rem;
          color: #9ca3af;
        }
        .tree-level {
          margin-top: 8px;
          display: flex;
          flex-direction: column;
          align-items: stretch;
          gap: 10px;
        }
        .tree-horizontal-line {
          height: 2px;
          margin: 0 32px;
          background: linear-gradient(to right, #6ee7b7, #f97316, #4f46e5);
          opacity: 0.85;
          position: relative;
        }
        .tree-children {
          margin-top: 10px;
          display: flex;
          flex-wrap: wrap;
          justify-content: center;
          gap: 20px 32px;
        }
        .tree-child {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
        }
        .tree-child-line {
          width: 2px;
          height: 16px;
          background: linear-gradient(to bottom, #6ee7b7, #4f46e5);
          opacity: 0.9;
        }
        
        .placeholder-text { 
          color: var(--text-secondary); 
          text-align: center; 
          padding: 16px; 
          font-size: 0.85rem;
        }
        .loading-state, .error-state { 
          display: flex; 
          align-items: center; 
          gap: 10px; 
          padding: 20px; 
          justify-content: center;
        }
        .pagination { 
          display: flex; 
          justify-content: center; 
          align-items: center; 
          gap: 10px; 
          margin-top: 10px; 
        }
        .pagination .btn { padding: 5px 10px; font-size: 0.8rem; }
        .page-indicator { 
          color: var(--text-secondary); 
          font-weight: 600; 
          font-size: 0.8rem;
        }
        
        /* Responsive adjustments */
        @media (max-width: 1200px) {
          .team-management-filters { 
            grid-template-columns: 1fr 1fr; 
          }
        }
        @media (max-width: 900px) {
          .tree-row {
            flex-direction: column;
            align-items: flex-start;
          }
          .team-tree-card {
            border-radius: 16px;
          }
        }
        @media (max-width: 768px) {
          .team-management-filters { 
            grid-template-columns: 1fr; 
          }
        }
      </style>
    `;

    const content = `
      ${styles}
      <div class="card team-management-card">
        ${bodyContent}
      </div>
    `;

    document.getElementById('app-content').innerHTML = getPageContentHTML('Team Management', content, controls);
    attachEventHandlers(canManageHierarchy);
  } catch (err) {
    console.error('Failed to render team management page:', err);
    const errorHTML = `
      <div class="card">
        <div class="error-state">
          <i class="fa-solid fa-triangle-exclamation"></i>
          <div>
            <h3>Failed to load team hierarchy</h3>
            <p>${err?.message || 'Unexpected error occurred while fetching hierarchy data.'}</p>
            <button class="btn btn-primary" id="tm-retry-btn">Retry</button>
          </div>
        </div>
      </div>
    `;
    document.getElementById('app-content').innerHTML = getPageContentHTML('Team Management', errorHTML, '');
    document.getElementById('tm-retry-btn')?.addEventListener('click', () => renderTeamManagementPage(1));
  }
};
