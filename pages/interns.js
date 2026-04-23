import { state } from '../state.js';
import { getPageContentHTML } from '../utils.js';
import { renderModal, closeModal } from '../components/modal.js';
import { listInterns, createIntern } from '../features/internApi.js';
import { listEmployees } from '../features/employeeApi.js';

let internPage = 1;
const INTERN_PAGE_SIZE = 10;
let internViewMode = 'card';
let internSearch = '';
let internTotalCount = 0;
let internPageSize = INTERN_PAGE_SIZE;
let internEmployeeMap = {};

const getFilteredInterns = (filter = internSearch) => {
  const normalizedFilter = String(filter || '').trim().toLowerCase();
  return (state.interns || []).filter((intern) => {
    const employeeName = intern.employee_id
      ? (internEmployeeMap[intern.employee_id.toUpperCase()] || '')
      : '';
    const value = `${intern.intern_id || ''} ${intern.employee_id || ''} ${employeeName}`.toLowerCase();
    return value.includes(normalizedFilter);
  });
};

const buildInternCards = (filtered) => filtered.map((intern) => {
  const employeeName = intern.employee_id ? (internEmployeeMap[intern.employee_id.toUpperCase()] || intern.employee_id) : 'Intern';
  const initials = employeeName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) || 'IN';
  return `
    <div class="employee-card">
      <div class="employee-card-header">
        <div class="employee-card-info">
          <div class="employee-avatar">${initials}</div>
          <div>
            <div class="employee-name">${employeeName}</div>
            <div class="employee-meta">Employee: ${intern.employee_id || '—'}</div>
            <div class="employee-meta subtle">Created: ${formatDate(intern.created_on)}</div>
          </div>
        </div>
        <button class="icon-btn intern-view-btn" data-intern-id="${intern.intern_id}" title="View Details"><i class="fa-solid fa-eye"></i></button>
      </div>
      ${
        intern.employee_id
          ? `<div class="employee-card-footer">
              <a class="link-muted onboarding-progress-link" href="${buildOnboardingLink(intern.employee_id)}">
                <i class="fa-solid fa-route"></i> Onboarding progress
              </a>
            </div>`
          : ''
      }
    </div>
  `;
}).join('') || '<div class="placeholder-text">No interns found. Try searching by name, Intern ID, or Employee ID.</div>';

const buildInternTableRows = (filtered) => filtered.map((intern) => {
  const employeeName = intern.employee_id ? (internEmployeeMap[intern.employee_id.toUpperCase()] || intern.employee_id) : '—';
  return `
    <tr>
      <td>${employeeName}</td>
      <td>${intern.employee_id || '—'}</td>
      <td>${formatDate(intern.created_on)}</td>
      <td>
        <div class="intern-table-actions">
          <button class="icon-btn intern-view-btn" data-intern-id="${intern.intern_id}" title="View Details"><i class="fa-solid fa-eye"></i></button>
          ${
            intern.employee_id
              ? `<a class="link-muted onboarding-progress-link" href="${buildOnboardingLink(intern.employee_id)}" title="View onboarding progress">
                  <i class="fa-solid fa-route"></i>
                </a>`
              : ''
          }
        </div>
      </td>
    </tr>
  `;
}).join('') || '<tr><td colspan="4" class="placeholder-text">No interns found. Try searching by name, Intern ID, or Employee ID.</td></tr>';

const buildInternPaginator = (filteredCount) => {
  if (internSearch && internSearch.trim().length > 0) {
    return `
      <div class="pagination">
        <span class="page-indicator">${filteredCount} result${filteredCount === 1 ? '' : 's'}</span>
      </div>
    `;
  }

  const totalPages = internTotalCount ? Math.max(1, Math.ceil(internTotalCount / internPageSize)) : undefined;
  const prevPage = Math.max(1, internPage - 1);
  const nextPage = totalPages ? Math.min(totalPages, internPage + 1) : internPage + 1;
  const prevDisabled = internPage <= 1 ? 'disabled' : '';
  const nextDisabled = totalPages && internPage >= totalPages ? 'disabled' : '';
  return `
    <div class="pagination">
      <button class="btn intern-pagination-btn" data-target-page="${prevPage}" ${prevDisabled}><i class="fa-solid fa-chevron-left"></i> Prev</button>
      <span class="page-indicator">Page ${internPage}${totalPages ? ` of ${totalPages}` : ''}</span>
      <button class="btn intern-pagination-btn" data-target-page="${nextPage}" ${nextDisabled}>Next <i class="fa-solid fa-chevron-right"></i></button>
    </div>
  `;
};

const updateInternResults = () => {
  const filtered = getFilteredInterns(internSearch);
  const cardView = document.getElementById('intern-card-view');
  const tableBody = document.getElementById('intern-table-body');
  const pagination = document.getElementById('intern-pagination');
  if (cardView) cardView.innerHTML = buildInternCards(filtered);
  if (tableBody) tableBody.innerHTML = buildInternTableRows(filtered);
  if (pagination) pagination.innerHTML = buildInternPaginator(filtered.length);
  attachInternEvents();
};

const formatDate = (iso) => {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-IN', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
};

const buildOnboardingLink = (employeeId) =>
  employeeId ? `#/onboarding?employee=${encodeURIComponent(employeeId)}` : '#/onboarding';

const fieldIds = [
  { id: 'internId', label: 'Intern ID', required: true },
  { id: 'employeeId', label: 'Employee ID', required: true },
  { id: 'unpaidDuration', label: 'Unpaid Duration' },
  { id: 'unpaidStart', label: 'Unpaid Start', type: 'date' },
  { id: 'unpaidEnd', label: 'Unpaid End', type: 'date' },
  { id: 'paidDuration', label: 'Paid Training Duration' },
  { id: 'paidStart', label: 'Paid Training Start', type: 'date' },
  { id: 'paidEnd', label: 'Paid Training End', type: 'date' },
  { id: 'paidSalary', label: 'Paid Training Salary', type: 'number' },
  { id: 'probationDuration', label: 'Probation Duration' },
  { id: 'probationStart', label: 'Probation Start', type: 'date' },
  { id: 'probationEnd', label: 'Probation End', type: 'date' },
  { id: 'probationSalary', label: 'Probation Salary', type: 'number' },
  { id: 'postprobDuration', label: 'Post Probation Duration' },
  { id: 'postprobStart', label: 'Post Probation Start', type: 'date' },
  { id: 'postprobEnd', label: 'Post Probation End', type: 'date' },
  { id: 'postprobSalary', label: 'Post Probation Salary', type: 'number' },
];

const inputControl = ({ id, label, required, type = 'text' }) => `
  <div class="form-field">
    <label class="form-label" for="${id}">${label}${required ? ' *' : ''}</label>
    <input class="input-control" type="${type}" id="${id}" ${required ? 'required' : ''}>
  </div>
`;

export const showAddInternModal = () => {
  const formHTML = `
    <div class="modal-form modern-form intern-form">
      <div class="form-section">
        <div class="form-section-header">
          <div>
            <p class="form-eyebrow">New Intern</p>
            <h3>Primary Details</h3>
          </div>
        </div>
        <div class="form-grid two-col">
          ${fieldIds.slice(0, 2).map(inputControl).join('')}
        </div>
      </div>
      <div class="form-section">
        <div class="form-section-header">
          <div>
            <p class="form-eyebrow">Internship Phases</p>
            <h3>Timeline Information</h3>
          </div>
        </div>
        <div class="form-grid two-col">
          ${fieldIds.slice(2).map(inputControl).join('')}
        </div>
      </div>
    </div>
  `;
  renderModal('Add Intern', formHTML, 'save-intern-btn', 'large', 'Create');
};

export const handleAddIntern = async (e) => {
  e.preventDefault();
  const getVal = (id) => {
    const el = document.getElementById(id);
    return (el && el.value && el.value.trim()) || '';
  };

  const payload = {
    intern_id: getVal('internId'),
    employee_id: getVal('employeeId'),
    unpaid_duration: getVal('unpaidDuration'),
    unpaid_start: getVal('unpaidStart'),
    unpaid_end: getVal('unpaidEnd'),
    paid_duration: getVal('paidDuration'),
    paid_start: getVal('paidStart'),
    paid_end: getVal('paidEnd'),
    paid_salary: getVal('paidSalary'),
    probation_duration: getVal('probationDuration'),
    probation_start: getVal('probationStart'),
    probation_end: getVal('probationEnd'),
    probation_salary: getVal('probationSalary'),
    postprob_duration: getVal('postprobDuration'),
    postprob_start: getVal('postprobStart'),
    postprob_end: getVal('postprobEnd'),
    postprob_salary: getVal('postprobSalary'),
  };

  if (!payload.intern_id || !payload.employee_id) {
    alert('Intern ID and Employee ID are required.');
    return;
  }

  try {
    await createIntern(payload);
    closeModal();
    alert('Intern created successfully');
    renderInternsPage();
  } catch (err) {
    console.error('Failed to create intern', err);
    alert(err.message || 'Failed to create intern');
  }
};

const navigateToInternDetail = (internId) => {
  if (!internId) return;
  state.selectedInternId = internId;
  window.location.hash = `#/interns/${encodeURIComponent(internId)}`;
};

const attachInternEvents = () => {
  const searchInput = document.getElementById('intern-search-input');
  if (searchInput) {
    if (!searchInput.dataset.bound) {
      searchInput.addEventListener('input', (e) => {
        internSearch = e.target.value || '';
        internPage = 1;
        updateInternResults();
      });
      searchInput.dataset.bound = 'true';
    }
  }

  const addBtn = document.getElementById('add-intern-btn');
  if (addBtn) {
    addBtn.addEventListener('click', (e) => {
      e.preventDefault();
      showAddInternModal();
    });
  }

  document.querySelectorAll('.intern-view-btn').forEach((btn) => {
    if (!btn.dataset.bound) {
      btn.addEventListener('click', () => {
        const internId = btn.getAttribute('data-intern-id');
        if (internId) navigateToInternDetail(internId);
      });
      btn.dataset.bound = 'true';
    }
  });

  const cardBtn = document.getElementById('intern-card-view-btn');
  const tableBtn = document.getElementById('intern-table-view-btn');
  const cardView = document.getElementById('intern-card-view');
  const tableView = document.getElementById('intern-table-view');
  if (cardBtn && tableBtn && cardView && tableView) {
    const applyViewState = (mode) => {
      const showTable = mode === 'table';
      internViewMode = showTable ? 'table' : 'card';
      cardBtn.classList.toggle('active', !showTable);
      tableBtn.classList.toggle('active', showTable);
      cardView.classList.toggle('view-mode-visible', !showTable);
      tableView.classList.toggle('view-mode-visible', showTable);
    };
    if (!cardBtn.dataset.bound) {
      cardBtn.addEventListener('click', () => applyViewState('card'));
      cardBtn.dataset.bound = 'true';
    }
    if (!tableBtn.dataset.bound) {
      tableBtn.addEventListener('click', () => applyViewState('table'));
      tableBtn.dataset.bound = 'true';
    }
    applyViewState(internViewMode);
  }

  document.querySelectorAll('.intern-pagination-btn').forEach((btn) => {
    if (!btn.dataset.bound) {
      btn.addEventListener('click', () => {
        const targetPage = parseInt(btn.getAttribute('data-target-page'), 10);
        if (!Number.isNaN(targetPage)) {
          renderInternsPage(internSearch, targetPage);
        }
      });
      btn.dataset.bound = 'true';
    }
  });
};

export const renderInternsPage = async (filter = internSearch, page = internPage) => {
  const isTableMode = internViewMode === 'table';
  const controls = `
    <div class="employee-controls">
      <div class="employee-view-toggle" aria-label="Toggle interns view">
        <button id="intern-card-view-btn" class="view-toggle-btn ${isTableMode ? '' : 'active'}" title="Card view">
          <i class="fa-solid fa-grip"></i>
        </button>
        <button id="intern-table-view-btn" class="view-toggle-btn ${isTableMode ? 'active' : ''}" title="Table view">
          <i class="fa-solid fa-table"></i>
        </button>
      </div>
      <div class="employee-control-actions">
      </div>
    </div>
  `;

  const skeleton = `
    <div class="card">
      <div class="page-controls">
        <div class="inline-search">
          <div class="skeleton skeleton-text" style="height: 36px; width: 100%; border-radius: 999px;"></div>
        </div>
      </div>
      <div class="employee-card-grid view-mode view-mode-visible">
        ${Array.from({ length: 3 }).map(() => `
          <div class="employee-card">
            <div class="employee-card-header">
              <div class="employee-card-info">
                <div class="skeleton skeleton-circle" style="width:40px;height:40px;"></div>
                <div>
                  <div class="skeleton skeleton-list-line-lg"></div>
                  <div class="skeleton skeleton-list-line-sm" style="margin-top: 4px;"></div>
                </div>
              </div>
              <div class="skeleton skeleton-badge"></div>
            </div>
            <div class="employee-card-body">
              <div class="skeleton skeleton-list-line-lg"></div>
              <div class="skeleton skeleton-list-line-sm"></div>
            </div>
          </div>`).join('')}
      </div>
    </div>
  `;

  document.getElementById('app-content').innerHTML = getPageContentHTML('Interns', skeleton, controls);

  let fetchedItems = [];
  let employeeMap = {};
  try {
    // Fetch employees and interns in parallel
    const [internsData, employeesData] = await Promise.all([
      (async () => {
        const fetchAll = filter && filter.trim().length > 0;
        const fetchPageSize = fetchAll ? 10000 : INTERN_PAGE_SIZE;
        const fetchPage = fetchAll ? 1 : page;
        return await listInterns(fetchPage, fetchPageSize);
      })(),
      listEmployees(1, 5000)
    ]);

    const { items, total, page: curPage, pageSize } = internsData;
    internPage = (filter && filter.trim().length > 0) ? 1 : (curPage || page);
    internPageSize = pageSize || INTERN_PAGE_SIZE;
    fetchedItems = items || [];
    internTotalCount = typeof total === 'number' ? total : fetchedItems.length;
    state.interns = fetchedItems;

    // Build employee map: employee_id -> full name
    (employeesData.items || []).forEach(emp => {
      if (emp.employee_id) {
        const fullName = `${emp.first_name || ''} ${emp.last_name || ''}`.trim();
        employeeMap[emp.employee_id.toUpperCase()] = fullName || emp.employee_id;
      }
    });
    internEmployeeMap = employeeMap;
  } catch (err) {
    console.error('Failed to load interns', err);
    document.getElementById('app-content').innerHTML = getPageContentHTML('Interns', `<div class="card error-card">${err.message || err}</div>`, controls);
    return;
  }

  const filtered = getFilteredInterns(filter);

  const content = `
    <div class="card employees-card-shell">
      <div class="page-controls">
        <div class="inline-search">
          <i class="fa-solid fa-search"></i>
          <input type="text" id="intern-search-input" placeholder="Search by name, Intern ID, or Employee ID" value="${filter}">
        </div>
      </div>
      <div id="intern-card-view" class="employee-card-grid view-mode ${isTableMode ? '' : 'view-mode-visible'}">
        ${buildInternCards(filtered)}
      </div>
      <div id="intern-table-view" class="view-mode ${isTableMode ? 'view-mode-visible' : ''}">
        <div class="employee-table-wrapper">
          <div class="employee-table-scroll">
            <table class="table employees-table">
              <thead>
                <tr>
                  <th>Employee Name</th>
                  <th>Employee ID</th>
                  <th>Created On</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody id="intern-table-body">${buildInternTableRows(filtered)}</tbody>
            </table>
          </div>
        </div>
      </div>
      <div id="intern-pagination">${buildInternPaginator(filtered.length)}</div>
    </div>
  `;

  document.getElementById('app-content').innerHTML = getPageContentHTML('Interns', content, controls);
  attachInternEvents();
};
