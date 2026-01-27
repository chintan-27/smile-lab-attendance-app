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
let hoursCurrentDate = new Date();
hoursCurrentDate.setHours(0, 0, 0, 0);
let matrixWeekStart = getMonday(new Date());
console.log(matrixWeekStart, new Date());

function getMonday(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  date.setDate(diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

// ─────────────────────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initTabs();
  initSearch();
  initForms();
  initHeaderButtons();
  loadDashboard();
  checkAuth();
});

function initHeaderButtons() {
  const themeBtn = document.getElementById('theme-toggle-btn');
  const logoutBtn = document.getElementById('logout-btn');

  if (themeBtn) {
    themeBtn.addEventListener('click', toggleTheme);
  }

  if (logoutBtn) {
    logoutBtn.addEventListener('click', logout);
  }
}

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
  try {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const newTheme = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);

    // Re-render charts with new theme colors
    if (charts.weekly) {
      loadCharts();
    }
  } catch (error) {
    console.error('Theme toggle error:', error);
  }
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
    }

    // Load student hours chart
    await loadStudentHoursChart();
    initHoursNavigation();

    // Load weekly matrix
    await loadWeeklyMatrix();
    initMatrixNavigation();
  } catch (error) {
    console.error('Failed to load charts:', error);
  }
}

function initHoursNavigation() {
  const prevBtn = document.getElementById('hours-prev-btn');
  const nextBtn = document.getElementById('hours-next-btn');

  if (prevBtn) {
    prevBtn.onclick = async () => {
      hoursCurrentDate.setDate(hoursCurrentDate.getDate() - 1);
      await loadStudentHoursChart();
    };
  }

  if (nextBtn) {
    nextBtn.onclick = async () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const candidate = new Date(hoursCurrentDate);
      candidate.setDate(candidate.getDate() + 1);

      if (candidate <= today) {
        hoursCurrentDate = candidate;
        await loadStudentHoursChart();
      }
    };
  }
}

async function loadStudentHoursChart() {
  try {
    // Format date as YYYY-MM-DD in local timezone (not UTC)
    const year = hoursCurrentDate.getFullYear();
    const month = String(hoursCurrentDate.getMonth() + 1).padStart(2, '0');
    const day = String(hoursCurrentDate.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;

    const response = await fetch(`/api/admin/data/student-hours?date=${dateStr}`);
    const data = await response.json();

    // Update date label
    const labelEl = document.getElementById('hours-date-label');
    const nextBtn = document.getElementById('hours-next-btn');
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (hoursCurrentDate.getTime() === today.getTime()) {
      labelEl.textContent = 'Today';
    } else {
      labelEl.textContent = hoursCurrentDate.toLocaleDateString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric'
      });
    }

    // Disable next button if at today
    nextBtn.disabled = hoursCurrentDate.getTime() >= today.getTime();

    if (data.success) {
      renderStudentHoursChart(data.studentHours);
    }
  } catch (error) {
    console.error('Failed to load student hours:', error);
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

function initMatrixNavigation() {
  const prevBtn = document.getElementById('matrix-prev-btn');
  const nextBtn = document.getElementById('matrix-next-btn');

  if (prevBtn) {
    prevBtn.onclick = async () => {
      matrixWeekStart.setDate(matrixWeekStart.getDate() - 7);
      await loadWeeklyMatrix();
    };
  }

  if (nextBtn) {
    nextBtn.onclick = async () => {
      const thisWeek = getMonday(new Date());
      const candidate = new Date(matrixWeekStart);
      candidate.setDate(candidate.getDate() + 7);

      if (candidate <= thisWeek) {
        matrixWeekStart = candidate;
        await loadWeeklyMatrix();
      }
    };
  }
}

// Helper
function toLocalYMD(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}


async function loadWeeklyMatrix() {
  const container = document.getElementById('weekly-matrix-container');
  const labelEl = document.getElementById('matrix-week-label');
  const nextBtn = document.getElementById('matrix-next-btn');

  try {
    const dateStr1 = matrixWeekStart.toISOString().split('T')[0];
    const dateStr = await toLocalYMD(matrixWeekStart);

    console.log(dateStr1, dateStr)
    const response = await fetch(`/api/admin/data/weekly-matrix?weekStart=${dateStr}`);
    const data = await response.json();

    // Update label
    const thisWeek = getMonday(new Date());
    if (matrixWeekStart.getTime() === thisWeek.getTime()) {
      labelEl.textContent = 'This Week';
    } else {
      const weekEnd = new Date(matrixWeekStart);
      weekEnd.setDate(weekEnd.getDate() + 6);
      labelEl.textContent = `${formatShortDate(matrixWeekStart)} – ${formatShortDate(weekEnd)}`;
    }

    // Disable next if at current week
    nextBtn.disabled = matrixWeekStart.getTime() >= thisWeek.getTime();

    if (data.success) {
      renderWeeklyMatrix(data);
    } else {
      container.innerHTML = '<div class="loading">Failed to load weekly matrix</div>';
    }
  } catch (error) {
    console.error('Failed to load weekly matrix:', error);
    container.innerHTML = '<div class="loading">Failed to load weekly matrix</div>';
  }
}

function formatShortDate(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function renderWeeklyMatrix(data) {
  const container = document.getElementById('weekly-matrix-container');

  if (!data.matrix || data.matrix.length === 0) {
    container.innerHTML = '<div class="loading">No attendance data for this week</div>';
    return;
  }

  const html = `
    <table>
      <thead>
        <tr>
          <th style="text-align: left;">Student</th>
          ${data.dayLabels.map(day => `<th style="text-align: center;">${day}</th>`).join('')}
          <th style="text-align: center;">Total</th>
        </tr>
      </thead>
      <tbody>
        ${data.matrix.map(row => `
          <tr>
            <td style="text-align: left;">
              <div style="font-weight: 500;">${escapeHtml(row.name)}</div>
              <div style="font-size: 0.75rem; color: var(--text-secondary);">${escapeHtml(row.role || '')}</div>
            </td>
            ${row.days.map(hours => `
              <td style="text-align: center; ${hours > 0 ? 'background: rgba(0, 33, 165, 0.1);' : ''}">
                ${hours > 0 ? hours.toFixed(2) + 'h' : '-'}
              </td>
            `).join('')}
            <td style="text-align: center; font-weight: 600; background: rgba(0, 33, 165, 0.15);">
              ${row.total.toFixed(2)}h
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  container.innerHTML = html;
}

function renderStudentHoursChart(studentHours) {
  const container = document.getElementById('student-hours-container');
  if (!container) return;

  // Destroy existing chart
  if (charts.studentHours) {
    charts.studentHours.destroy();
    charts.studentHours = null;
  }

  if (!studentHours || studentHours.length === 0) {
    container.innerHTML = '<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-secondary);">No attendance data for this day</div>';
    return;
  }

  // Always recreate the canvas
  container.innerHTML = '<canvas id="student-hours-chart"></canvas>';

  // Dynamically set container height based on number of students
  const minHeightPerStudent = 35;
  const minChartHeight = 200;
  const calculatedHeight = Math.max(minChartHeight, studentHours.length * minHeightPerStudent);
  container.style.height = `${calculatedHeight}px`;

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const textColor = isDark ? '#e2e8f0' : '#64748b';
  const gridColor = isDark ? '#334155' : '#e2e8f0';

  // Color by role
  const roleColors = {
    'postdoc': 'rgba(139, 92, 246, 0.8)',  // Purple
    'phd': 'rgba(59, 130, 246, 0.8)',      // Blue
    'lead': 'rgba(16, 185, 129, 0.8)',     // Green
    'member': 'rgba(0, 33, 165, 0.8)',     // UF Blue
    'volunteer': 'rgba(107, 114, 128, 0.8)' // Gray
  };

  const backgroundColors = studentHours.map(s => roleColors[s.role?.toLowerCase()] || roleColors.volunteer);

  const canvasEl = document.getElementById('student-hours-chart');
  charts.studentHours = new Chart(canvasEl, {
    type: 'bar',
    data: {
      labels: studentHours.map(s => s.name),
      datasets: [{
        label: 'Hours',
        data: studentHours.map(s => s.totalHours),
        backgroundColor: backgroundColors,
        borderWidth: 1,
        barThickness: 20,
        maxBarThickness: 25
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(context) {
              const student = studentHours[context.dataIndex];
              let label = `${student.totalHours} hours`;
              if (student.stillSignedIn) {
                label += ' (still signed in)';
              }
              return label;
            }
          }
        }
      },
      scales: {
        x: {
          beginAtZero: true,
          ticks: { color: textColor },
          grid: { color: gridColor },
          title: {
            display: true,
            text: 'Hours',
            color: textColor
          }
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
    await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' });
  } catch (error) {
    console.error('Logout error:', error);
  }
  // Always redirect to login
  window.location.href = '/login';
}

// Expose functions globally for onclick handlers
window.toggleTheme = toggleTheme;
window.logout = logout;
window.showAddStudentModal = showAddStudentModal;
window.closeStudentModal = closeStudentModal;
window.editStudent = editStudent;
window.deleteStudent = deleteStudent;
window.deleteAttendance = deleteAttendance;
window.refreshPending = refreshPending;
window.showResolveModal = showResolveModal;
window.closeResolveModal = closeResolveModal;
window.goToPage = goToPage;
