import {
  getHolidays,
  createHoliday,
  updateHoliday,
  deleteHoliday,
} from "../features/holidaysApi.js";
import { getPageContentHTML } from '../utils.js';
import { renderModal, closeModal } from '../components/modal.js';
import { showToast } from '../components/toast.js';
import { getUserAccessContext } from '../utils/accessControl.js';

let editId = null;
let canManageHolidays = false;

const renderHolidayModal = (data = null) => {
  if (!canManageHolidays) {
    showToast('Only admin can modify holidays', 'warning');
    return;
  }
  const isEdit = !!data;

  const modalBody = `
    <div class="modal-form modern-form holiday-form">
      <div class="form-section">
        <div class="form-section-header">
          <div>
            <p class="form-eyebrow">HOLIDAYS</p>
            <h3>${isEdit ? 'Edit holiday' : 'Add new holiday'}</h3>
          </div>
        </div>
        <div class="form-grid two-col">
          <div class="form-field">
            <label class="form-label" for="holiday-date">Holiday Date <span class="required">*</span></label>
            <input class="input-control" type="date" id="holiday-date" value="${data?.crc6f_date?.split('T')[0] || ''}" required />
          </div>
          <div class="form-field">
            <label class="form-label" for="holiday-name">Holiday Name <span class="required">*</span></label>
            <input class="input-control" type="text" id="holiday-name" value="${data?.crc6f_holidayname || ''}" placeholder="e.g., Independence Day" maxlength="100" required />
          </div>
        </div>
      </div>
    </div>
  `;

  renderModal(
    isEdit ? 'Edit Holiday' : 'Add New Holiday',
    modalBody,
    'save-holiday-btn',
    'normal',
    isEdit ? 'Update' : 'Save'
  );

  setTimeout(() => {
    const form = document.getElementById('modal-form');
    if (form) {
      form.addEventListener('submit', handleSaveHoliday);
    }
  }, 50);
};

const handleSaveHoliday = async (event) => {
  event.preventDefault();

  if (!canManageHolidays) {
    showToast('Only admin can modify holidays', 'warning');
    return;
  }

  const date = document.getElementById('holiday-date')?.value?.trim();
  const name = document.getElementById('holiday-name')?.value?.trim();

  if (!date || !name) {
    showToast('Please fill in all required fields', 'warning');
    return;
  }

  if (name.length > 100) {
    showToast('Holiday name must be 100 characters or fewer', 'warning');
    return;
  }

  const payload = {
    crc6f_date: date,
    crc6f_holidayname: name,
  };

  try {
    document.getElementById('save-holiday-btn').disabled = true;

    if (editId) {
      await updateHoliday(editId, payload);
      showToast('Holiday updated successfully', 'success');
    } else {
      await createHoliday(payload);
      showToast('Holiday added successfully', 'success');
    }

    closeModal();
    editId = null;
    await loadHolidays();
  } catch (err) {
    console.error('Failed to save holiday:', err);
    showToast(err?.message || 'Failed to save holiday', 'error');
    document.getElementById('save-holiday-btn').disabled = false;
  }
};

const handleDeleteHoliday = async (id) => {
  if (!canManageHolidays) {
    showToast('Only admin can modify holidays', 'warning');
    return;
  }

  const confirmed = confirm('Are you sure you want to delete this holiday?');
  if (!confirmed) return;

  try {
    await deleteHoliday(id);
    showToast('Holiday deleted successfully', 'success');
    await loadHolidays();
  } catch (err) {
    console.error('Failed to delete holiday:', err);
    showToast(err?.message || 'Failed to delete holiday', 'error');
  }
};

const loadHolidays = async () => {
  const tbody = document.getElementById('holidays-tbody');
  if (!tbody) return;

  try {
    tbody.innerHTML = '<tr><td colspan="4" class="placeholder-text">Loading holidays...</td></tr>';

    const holidays = await getHolidays();
    tbody.innerHTML = '';

    if (!holidays || holidays.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="placeholder-text">No holidays found. Add your first holiday!</td></tr>';
      return;
    }

    // Sort holidays by date
    holidays.sort((a, b) => new Date(a.crc6f_date) - new Date(b.crc6f_date));

    holidays.forEach((h) => {
      const row = document.createElement('tr');
      const date = new Date(h.crc6f_date);
      const formattedDate = date.toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
      });
      const dayName = date.toLocaleDateString('en-IN', { weekday: 'long' });
      const monthDay = date.getDate();
      const month = date.toLocaleDateString('en-IN', { month: 'short' });

      row.innerHTML = `
        <td>
          <div class="holiday-date-cell">
            <div class="holiday-date-badge">
              <div class="holiday-date-day">${monthDay}</div>
              <div class="holiday-date-month">${month}</div>
            </div>
            <div class="holiday-date-info">
              <div class="holiday-date-full">${formattedDate}</div>
              <div class="holiday-date-weekday">${dayName}</div>
            </div>
          </div>
        </td>
        <td class="holiday-name-cell">
          <i class="fa-solid fa-calendar-check holiday-icon"></i>
          ${h.crc6f_holidayname}
        </td>
        <td class="holiday-actions-cell">
          ${canManageHolidays ? `
          <button class="icon-btn holiday-edit-btn" title="Edit" data-id="${h.crc6f_hr_holidaysid}">
            <i class="fa-solid fa-pen-to-square"></i>
          </button>
          <button class="icon-btn holiday-delete-btn" title="Delete" data-id="${h.crc6f_hr_holidaysid}">
            <i class="fa-solid fa-trash"></i>
          </button>
          ` : '<span>-</span>'}
        </td>
      `;
      tbody.appendChild(row);
    });

    // Attach admin-only event listeners
    if (canManageHolidays) {
      document.querySelectorAll('.holiday-edit-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          const id = e.currentTarget.dataset.id;
          const record = holidays.find((h) => h.crc6f_hr_holidaysid === id);
          editId = id;
          renderHolidayModal(record);
        });
      });

      document.querySelectorAll('.holiday-delete-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          const id = e.currentTarget.dataset.id;
          handleDeleteHoliday(id);
        });
      });
    }
  } catch (err) {
    console.error('Failed to load holidays:', err);
    tbody.innerHTML = '<tr><td colspan="4" class="placeholder-text error-message">Failed to load holidays. Please try again.</td></tr>';
  }
};

export async function renderHolidaysPage() {
  const { isAdmin } = getUserAccessContext();
  canManageHolidays = Boolean(isAdmin);

  const controls = `
    <div class="employee-controls">
      <div class="employee-control-actions">
        ${canManageHolidays ? '<button id="add-holiday-btn" class="btn btn-primary"><i class="fa-solid fa-plus"></i> ADD HOLIDAY</button>' : ''}
      </div>
    </div>
  `;

  const content = `
    <div class="card">
      <div class="holidays-table-container">
        <table class="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Holiday Name</th>
              <th class="holiday-actions-header">Actions</th>
            </tr>
          </thead>
          <tbody id="holidays-tbody">
            <tr><td colspan="4" class="placeholder-text">Loading holidays...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('app-content').innerHTML = getPageContentHTML('Holidays Management', content, controls);

  // Attach event listeners
  document.getElementById('add-holiday-btn')?.addEventListener('click', () => {
    editId = null;
    renderHolidayModal();
  });

  await loadHolidays();
}
