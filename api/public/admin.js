/**
 * Web Admin Dashboard JavaScript
 * Handles all admin functionality using fetch API
 */

// State
let currentStudentPage = 1;
let currentAttendancePage = 1;
const PAGE_SIZE = 25;
let searchDebounceTimer = null;
let charts = {};

// ─────────────────────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initTabs();
  initSearch();
  initForms();
  loadDashboard();
  checkAuth();
});

async function checkAuth() {
  try {
    const response = await fetch('/api/admin/me');
    if (!response.ok) {
      window.location.href = '/login';
      return;
    }
    const data = await response.json();
    if (!data.authenticated) {
      window.location.href = '/login';
      return;
    }
    document.getElementById('user-info').textContent = data.username || 'Admin';
  } catch (error) {
    console.error('Auth check failed:', error);
    window.location.href = '/login';
  }
}

// ─────────────────────────────────────────────────────────────
// Theme
// ─────────────────────────────────────────────────────────────

function initTheme() {
  const savedTheme = localStorage.getItem('theme') || 'light';
  document.documentElement.setAttribute('data-theme', savedTheme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const newTheme = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', newTheme);
  localStorage.setItem('theme', newTheme);
}

// ─────────────────────────────────────────────────────────────
// Tabs
// ─────────────────────────────────────────────────────────────

function initTabs() {
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.tab;
      switchTab(tabName);
    });
  });
}

function switchTab(tabName) {
  // Update nav tabs
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');

  // Update content
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(`${tabName}-tab`).classList.add('active');

  // Load tab data
  switch (tabName) {
    case 'dashboard':
      loadDashboard();
      break;
    case 'students':
      loadStudents();
      break;
    case 'attendance':
      loadAttendance();
      break;
    case 'pending':
      loadPending();
      break;
  }
}

// ─────────────────────────────────────────────────────────────
// Search
// ─────────────────────────────────────────────────────────────

function initSearch() {
  // Students search
  document.getElementById('students-search').addEventListener('input', (e) => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      currentStudentPage = 1;
      loadStudents();
    }, 300);
  });

  // Attendance search
  document.getElementById('attendance-search').addEventListener('input', (e) => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      currentAttendancePage = 1;
      loadAttendance();
    }, 300);
  });

  // Attendance date filter
  document.getElementById('attendance-date').addEventListener('change', () => {
    currentAttendancePage = 1;
    loadAttendance();
  });
}

// ─────────────────────────────────────────────────────────────
// Dashboard
// ─────────────────────────────────────────────────────────────

async function loadDashboard() {
  try {
    const response = await fetch('/api/admin/data/stats');
    const data = await response.json();

    if (data.success) {
      const stats = data.stats;
      document.getElementById('stat-total-students').textContent = stats.totalStudents;
      document.getElementById('stat-signed-in').textContent = stats.currentlySignedIn;
      document.getElementById('stat-today-visits').textContent = stats.todaysVisits;
      document.getElementById('stat-week-visits').textContent = stats.weeklyVisits;
      document.getElementById('stat-pending').textContent = stats.pendingSignouts;
      document.getElementById('stat-total-records').textContent = stats.totalRecords;
    }

    // Load charts
    await loadCharts();
  } catch (error) {
    console.error('Failed to load dashboard:', error);
    showToast('Failed to load dashboard statistics', 'error');
  }
}

async function loadCharts() {
  try {
    const response = await fetch('/api/admin/data/charts');
    const data = await response.json();

    if (data.success) {
      renderWeeklyChart(data.weeklyData);
      renderTopStudentsChart(data.topStudents);
    }
  } catch (error) {
    console.error('Failed to load charts:', error);
  }
}

function renderWeeklyChart(weeklyData) {
  const ctx = document.getElementById('weekly-chart');
  if (!ctx) return;

  // Destroy existing chart
  if (charts.weekly) {
    charts.weekly.destroy();
  }

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const textColor = isDark ? '#e2e8f0' : '#64748b';
  const gridColor = isDark ? '#334155' : '#e2e8f0';

  charts.weekly = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: weeklyData.map(d => d.date),
      datasets: [
        {
          label: 'Sign Ins',
          data: weeklyData.map(d => d.signIns),
          backgroundColor: 'rgba(0, 33, 165, 0.8)',
          borderColor: '#0021A5',
          borderWidth: 1
        },
        {
          label: 'Sign Outs',
          data: weeklyData.map(d => d.signOuts),
          backgroundColor: 'rgba(250, 70, 22, 0.8)',
          borderColor: '#FA4616',
          borderWidth: 1
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'top',
          labels: { color: textColor }
        }
      },
      scales: {
        x: {
          ticks: { color: textColor },
          grid: { color: gridColor }
        },
        y: {
          beginAtZero: true,
          ticks: {
            color: textColor,
            stepSize: 1
          },
          grid: { color: gridColor }
        }
      }
    }
  });
}

function renderTopStudentsChart(topStudents) {
  const ctx = document.getElementById('top-students-chart');
  if (!ctx) return;

  // Destroy existing chart
  if (charts.topStudents) {
    charts.topStudents.destroy();
  }

  if (!topStudents || topStudents.length === 0) {
    ctx.parentElement.innerHTML = '<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-secondary);">No data available</div>';
    return;
  }

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const textColor = isDark ? '#e2e8f0' : '#64748b';
  const gridColor = isDark ? '#334155' : '#e2e8f0';

  charts.topStudents = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: topStudents.map(s => s.name),
      datasets: [{
        label: 'Sign Ins This Week',
        data: topStudents.map(s => s.count),
        backgroundColor: 'rgba(0, 33, 165, 0.8)',
        borderColor: '#0021A5',
        borderWidth: 1
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false
        }
      },
      scales: {
        x: {
          beginAtZero: true,
          ticks: {
            color: textColor,
            stepSize: 1
          },
          grid: { color: gridColor }
        },
        y: {
          ticks: { color: textColor },
          grid: { color: gridColor }
        }
      }
    }
  });
}

// ─────────────────────────────────────────────────────────────
// Students
// ─────────────────────────────────────────────────────────────

async function loadStudents() {
  const container = document.getElementById('students-table-container');
  const search = document.getElementById('students-search').value;

  container.innerHTML = '<div class="loading"><div class="spinner"></div>Loading students...</div>';

  try {
    const params = new URLSearchParams({
      page: currentStudentPage,
      pageSize: PAGE_SIZE,
      search
    });

    const response = await fetch(`/api/admin/data/students?${params}`);
    const data = await response.json();

    if (data.success) {
      renderStudentsTable(data.students);
      renderPagination('students', data.page, data.totalPages, data.totalCount);
    } else {
      container.innerHTML = `<div class="loading">Error: ${data.error}</div>`;
    }
  } catch (error) {
    console.error('Failed to load students:', error);
    container.innerHTML = '<div class="loading">Failed to load students</div>';
  }
}

function renderStudentsTable(students) {
  const container = document.getElementById('students-table-container');

  if (students.length === 0) {
    container.innerHTML = '<div class="loading">No students found</div>';
    return;
  }

  const html = `
    <table>
      <thead>
        <tr>
          <th>UFID</th>
          <th>Name</th>
          <th>Email</th>
          <th>Role</th>
          <th>Expected Hours</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${students.map(s => `
          <tr>
            <td>${escapeHtml(s.ufid)}</td>
            <td>${escapeHtml(s.name)}</td>
            <td>${escapeHtml(s.email || '-')}</td>
            <td><span class="badge badge-success">${escapeHtml(s.role || 'volunteer')}</span></td>
            <td>${s.expectedHoursPerWeek || 0}</td>
            <td>
              <button class="btn btn-secondary" onclick="editStudent('${s.ufid}')">Edit</button>
              <button class="btn btn-danger" onclick="deleteStudent('${s.ufid}')">Delete</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  container.innerHTML = html;
}

function showAddStudentModal() {
  document.getElementById('student-modal-title').textContent = 'Add Student';
  document.getElementById('student-form').reset();
  document.getElementById('student-ufid').disabled = false;
  document.getElementById('student-modal').classList.add('visible');
}

function closeStudentModal() {
  document.getElementById('student-modal').classList.remove('visible');
}

async function editStudent(ufid) {
  try {
    const response = await fetch(`/api/admin/data/students?search=${ufid}`);
    const data = await response.json();

    if (data.success && data.students.length > 0) {
      const student = data.students.find(s => s.ufid === ufid);
      if (student) {
        document.getElementById('student-modal-title').textContent = 'Edit Student';
        document.getElementById('student-ufid').value = student.ufid;
        document.getElementById('student-ufid').disabled = true;
        document.getElementById('student-name').value = student.name;
        document.getElementById('student-email').value = student.email || '';
        document.getElementById('student-role').value = student.role || 'volunteer';
        document.getElementById('student-hours').value = student.expectedHoursPerWeek || 0;
        document.getElementById('student-modal').classList.add('visible');
      }
    }
  } catch (error) {
    showToast('Failed to load student data', 'error');
  }
}

async function deleteStudent(ufid) {
  if (!confirm(`Are you sure you want to delete student ${ufid}?`)) {
    return;
  }

  try {
    const response = await fetch(`/api/admin/data/students/${ufid}`, {
      method: 'DELETE'
    });

    const data = await response.json();

    if (data.success) {
      showToast('Student deleted successfully', 'success');
      loadStudents();
      loadDashboard();
    } else {
      showToast(data.error || 'Failed to delete student', 'error');
    }
  } catch (error) {
    showToast('Failed to delete student', 'error');
  }
}

// ─────────────────────────────────────────────────────────────
// Attendance
// ─────────────────────────────────────────────────────────────

async function loadAttendance() {
  const container = document.getElementById('attendance-table-container');
  const search = document.getElementById('attendance-search').value;
  const dateFilter = document.getElementById('attendance-date').value;

  container.innerHTML = '<div class="loading"><div class="spinner"></div>Loading attendance...</div>';

  try {
    const params = new URLSearchParams({
      page: currentAttendancePage,
      pageSize: PAGE_SIZE,
      search
    });

    if (dateFilter) {
      params.append('startDate', dateFilter);
      params.append('endDate', dateFilter);
    }

    const response = await fetch(`/api/admin/data/attendance?${params}`);
    const data = await response.json();

    if (data.success) {
      renderAttendanceTable(data.records);
      renderPagination('attendance', data.page, data.totalPages, data.totalCount);
    } else {
      container.innerHTML = `<div class="loading">Error: ${data.error}</div>`;
    }
  } catch (error) {
    console.error('Failed to load attendance:', error);
    container.innerHTML = '<div class="loading">Failed to load attendance</div>';
  }
}

function renderAttendanceTable(records) {
  const container = document.getElementById('attendance-table-container');

  if (records.length === 0) {
    container.innerHTML = '<div class="loading">No records found</div>';
    return;
  }

  const html = `
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Time</th>
          <th>Name</th>
          <th>UFID</th>
          <th>Action</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${records.map(r => {
          const date = new Date(r.timestamp);
          const dateStr = date.toLocaleDateString('en-US', { timeZone: 'America/New_York' });
          const timeStr = date.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'America/New_York'
          });
          const actionClass = r.action === 'signin' ? 'badge-success' : 'badge-warning';
          const statusBadge = r.synthetic
            ? '<span class="badge badge-warning">Auto</span>'
            : r.pendingTimestamp
              ? '<span class="badge badge-error">Pending</span>'
              : '';

          return `
            <tr>
              <td>${dateStr}</td>
              <td>${timeStr}</td>
              <td>${escapeHtml(r.name || '-')}</td>
              <td>${escapeHtml(r.ufid)}</td>
              <td><span class="badge ${actionClass}">${r.action}</span></td>
              <td>${statusBadge}</td>
              <td>
                <button class="btn btn-danger" onclick="deleteAttendance('${r.id}')">Delete</button>
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;

  container.innerHTML = html;
}

async function deleteAttendance(id) {
  if (!confirm('Are you sure you want to delete this record?')) {
    return;
  }

  try {
    const response = await fetch(`/api/admin/data/attendance/${id}`, {
      method: 'DELETE'
    });

    const data = await response.json();

    if (data.success) {
      showToast('Record deleted successfully', 'success');
      loadAttendance();
      loadDashboard();
    } else {
      showToast(data.error || 'Failed to delete record', 'error');
    }
  } catch (error) {
    showToast('Failed to delete record', 'error');
  }
}

// ─────────────────────────────────────────────────────────────
// Pending Sign-Outs
// ─────────────────────────────────────────────────────────────

async function loadPending() {
  const container = document.getElementById('pending-table-container');
  container.innerHTML = '<div class="loading"><div class="spinner"></div>Loading pending...</div>';

  try {
    const response = await fetch('/api/admin/data/pending');
    const data = await response.json();

    if (data.success) {
      renderPendingTable(data.pending);
    } else {
      container.innerHTML = `<div class="loading">Error: ${data.error}</div>`;
    }
  } catch (error) {
    console.error('Failed to load pending:', error);
    container.innerHTML = '<div class="loading">Failed to load pending sign-outs</div>';
  }
}

function renderPendingTable(pending) {
  const container = document.getElementById('pending-table-container');

  // Filter to show only pending status
  const pendingOnly = pending.filter(p => p.status === 'pending');

  if (pendingOnly.length === 0) {
    container.innerHTML = '<div class="loading">No pending sign-outs</div>';
    return;
  }

  const html = `
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Name</th>
          <th>Email</th>
          <th>Sign-In Time</th>
          <th>Deadline</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${pendingOnly.map(p => {
          const signInDate = new Date(p.signInTimestamp);
          const deadline = new Date(p.deadline);
          const dateStr = signInDate.toLocaleDateString('en-US', { timeZone: 'America/New_York' });
          const signInTime = signInDate.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'America/New_York'
          });
          const deadlineStr = deadline.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'America/New_York'
          });
          const isOverdue = new Date() > deadline;

          return `
            <tr>
              <td>${dateStr}</td>
              <td>${escapeHtml(p.name)}</td>
              <td>${escapeHtml(p.email || '-')}</td>
              <td>${signInTime}</td>
              <td>
                <span class="${isOverdue ? 'badge badge-error' : ''}">${deadlineStr}</span>
              </td>
              <td>
                <button class="btn btn-primary" onclick="showResolveModal('${p.id}')">Resolve</button>
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;

  container.innerHTML = html;
}

function refreshPending() {
  loadPending();
  loadDashboard();
}

let currentResolvePending = null;

function showResolveModal(id) {
  // Find the pending record
  fetch('/api/admin/data/pending')
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        const record = data.pending.find(p => p.id === id);
        if (record) {
          currentResolvePending = record;
          document.getElementById('resolve-id').value = id;

          const signInDate = new Date(record.signInTimestamp);
          const signInTime = signInDate.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'America/New_York'
          });

          document.getElementById('resolve-info').innerHTML = `
            <p><strong>Student:</strong> ${escapeHtml(record.name)}</p>
            <p><strong>Sign-In:</strong> ${signInTime}</p>
          `;

          document.getElementById('resolve-time').value = '';
          document.getElementById('resolve-present-only').checked = false;
          document.getElementById('resolve-modal').classList.add('visible');
        }
      }
    });
}

function closeResolveModal() {
  document.getElementById('resolve-modal').classList.remove('visible');
  currentResolvePending = null;
}

// ─────────────────────────────────────────────────────────────
// Forms
// ─────────────────────────────────────────────────────────────

function initForms() {
  // Student form
  document.getElementById('student-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const student = {
      ufid: document.getElementById('student-ufid').value,
      name: document.getElementById('student-name').value,
      email: document.getElementById('student-email').value,
      role: document.getElementById('student-role').value,
      expectedHoursPerWeek: parseInt(document.getElementById('student-hours').value) || 0
    };

    try {
      const response = await fetch('/api/admin/data/students', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(student)
      });

      const data = await response.json();

      if (data.success) {
        showToast(data.message || 'Student saved successfully', 'success');
        closeStudentModal();
        loadStudents();
        loadDashboard();
      } else {
        showToast(data.error || 'Failed to save student', 'error');
      }
    } catch (error) {
      showToast('Failed to save student', 'error');
    }
  });

  // Resolve form
  document.getElementById('resolve-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const id = document.getElementById('resolve-id').value;
    const signOutTime = document.getElementById('resolve-time').value;
    const presentOnly = document.getElementById('resolve-present-only').checked;

    if (!presentOnly && !signOutTime) {
      showToast('Please enter a sign-out time or mark as present only', 'error');
      return;
    }

    try {
      let signOutTimestamp = null;
      if (!presentOnly && signOutTime && currentResolvePending) {
        // Convert time to full timestamp
        const signInDate = new Date(currentResolvePending.signInTimestamp);
        const [hours, minutes] = signOutTime.split(':').map(Number);
        signInDate.setHours(hours, minutes, 0, 0);
        signOutTimestamp = signInDate.toISOString();
      }

      const response = await fetch(`/api/admin/data/pending/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signOutTime: signOutTimestamp,
          presentOnly
        })
      });

      const data = await response.json();

      if (data.success) {
        showToast('Pending sign-out resolved', 'success');
        closeResolveModal();
        loadPending();
        loadDashboard();
      } else {
        showToast(data.error || 'Failed to resolve', 'error');
      }
    } catch (error) {
      showToast('Failed to resolve pending sign-out', 'error');
    }
  });
}

// ─────────────────────────────────────────────────────────────
// Pagination
// ─────────────────────────────────────────────────────────────

function renderPagination(type, page, totalPages, totalCount) {
  const container = document.getElementById(`${type}-pagination`);

  const startItem = (page - 1) * PAGE_SIZE + 1;
  const endItem = Math.min(page * PAGE_SIZE, totalCount);

  container.innerHTML = `
    <div class="pagination-info">
      Showing ${startItem}-${endItem} of ${totalCount}
    </div>
    <div class="pagination-buttons">
      <button class="btn btn-secondary" ${page <= 1 ? 'disabled' : ''} onclick="goToPage('${type}', ${page - 1})">
        Previous
      </button>
      <button class="btn btn-secondary" ${page >= totalPages ? 'disabled' : ''} onclick="goToPage('${type}', ${page + 1})">
        Next
      </button>
    </div>
  `;
}

function goToPage(type, page) {
  if (type === 'students') {
    currentStudentPage = page;
    loadStudents();
  } else if (type === 'attendance') {
    currentAttendancePage = page;
    loadAttendance();
  }
}

// ─────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 4000);
}

async function logout() {
  try {
    await fetch('/api/admin/logout', { method: 'POST' });
    window.location.href = '/login';
  } catch (error) {
    window.location.href = '/login';
  }
}
