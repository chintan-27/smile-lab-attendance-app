let currentSection = 'dashboard';
let studentsData = [];
let attendanceData = [];
let logsData = [];
let charts = window.charts || (window.charts = {});

// Reporting state (Attendance)
let currentWeekStart = startOfWeek(new Date());          // Monday of current week
let currentMonthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let reportMode = 'week'; // 'week' | 'month'
let dashboardChartDaysCount = 7;
function yesterday() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    d.setHours(0, 0, 0, 0);
    return d;
}

let analyticsCurrentDay = yesterday();
let analyticsCurrentWeekStart = startOfWeek(new Date());

const HEAT_BUCKETS = [
    { max: 0.0, label: '0h', color: '#eef2ff' },
    { max: 2.0, label: '<2h', color: '#c7d2fe' },
    { max: 4.0, label: '2–4h', color: '#a5b4fc' },
    { max: 6.0, label: '4–6h', color: '#818cf8' },
    { max: Infinity, label: '>6h', color: '#6366f1' }
];
function colorForHours(h) {
    for (const b of HEAT_BUCKETS) if (h <= b.max) return b.color;
    return HEAT_BUCKETS[HEAT_BUCKETS.length - 1].color;
}
function renderHeatLegend() {
    const el = document.getElementById('heatLegend');
    if (!el) return;
    el.innerHTML = HEAT_BUCKETS.map(b =>
        `<span style="display:inline-flex; align-items:center; gap:6px">
       <span style="width:14px; height:14px; background:${b.color}; border:1px solid #e2e8f0; border-radius:3px"></span>
       <span>${b.label}</span>
     </span>`).join('');
}
function fmtShort(d) {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ----- Date helpers (put near top of admin.js) -----
function addDays(d, n) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() + n);
    x.setHours(0, 0, 0, 0);
    return x;
}

// Monday = start of week (weekStartsOn = 1). Change to 0 if you want Sunday.
function startOfWeek(d, weekStartsOn = 1) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const day = (x.getDay() - weekStartsOn + 7) % 7;
    x.setDate(x.getDate() - day);
    x.setHours(0, 0, 0, 0);
    return x;
}

function startOfMonth(d) {
    return new Date(d.getFullYear(), d.getMonth(), 1);
}

// --- tiny DOM helpers ---
const $ = (id) => document.getElementById(id);
const setVal = (id, v) => { const el = $(id); if (el) el.value = v ?? ''; };

// Navigation
function showSection(sectionName) {
    document.querySelectorAll('.page-section').forEach(section => {
        section.classList.remove('active');
    });
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
    });
    document.getElementById(sectionName + '-section').classList.add('active');
    document.querySelector(`[data-section="${sectionName}"]`).classList.add('active');
    currentSection = sectionName;
    loadSectionData(sectionName);
}

async function loadSectionData(sectionName) {
    switch (sectionName) {
        case 'dashboard':
            await loadDashboard();
            break;
        case 'students':
            await loadStudents();
            break;
        case 'attendance':
            await loadAttendance();
            break;
        case 'reports':
            await loadReports();
            break;
        case 'settings':
            await loadSettings();
            break;
        case 'logs':
            await loadLogs();
            break;
    }
}

// Dashboard Functions
async function loadDashboard() {
    try {
        const stats = await window.electronAPI.getEnhancedStats();
        const students = await window.electronAPI.getStudents();
        const todaysAttendance = await window.electronAPI.getTodaysAttendance();

        document.getElementById('totalStudents').textContent = stats.totalStudents;
        document.getElementById('currentlyPresent').textContent = stats.currentlySignedIn;
        document.getElementById('todaySignIns').textContent = stats.todaySignIns;
        document.getElementById('todaySignOuts').textContent = stats.todaySignOuts;
        document.getElementById('studentCount').textContent = stats.totalStudents;

        //loadRecentActivity(todaysAttendance.slice(-10));
        loadCurrentlyPresent(stats.signedInStudents);
        await loadDashboardCharts();
    } catch (error) {
        showNotification('Error loading dashboard: ' + error.message, 'error');
    }
}

// function loadRecentActivity(activities) {
//     const tbody = document.getElementById('recentActivityTable');
//     if (!activities || activities.length === 0) {
//         tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: #64748b;">No recent activity</td></tr>';
//         return;
//     }
// 
//     tbody.innerHTML = activities.reverse().map(activity => `
//         <tr>
//             <td>
//                 <div style="font-weight: 500;">${activity.name}</div>
//                 <div style="font-size: 0.75rem; color: #64748b;">${activity.ufid}</div>
//             </td>
//             <td>
//                 <span class="badge ${activity.action === 'signin' ? 'success' : 'warning'}">
//                     ${activity.action === 'signin' ? 'Sign In' : 'Sign Out'}
//                 </span>
//             </td>
//             <td style="font-size: 0.875rem;">${new Date(activity.timestamp).toLocaleTimeString()}</td>
//             <td>
//                 <button class="btn btn-secondary delete-record-btn" style="padding: 0.25rem 0.5rem; font-size: 0.75rem;" data-record-id="${activity.id}">
//                     <i class="fas fa-trash"></i>
//                 </button>
//             </td>
//         </tr>
//     `).join('');
// 
//     // Add event listeners to delete buttons
//     document.querySelectorAll('.delete-record-btn').forEach(btn => {
//         btn.addEventListener('click', function () {
//             const recordId = parseInt(this.getAttribute('data-record-id'));
//             deleteRecord(recordId);
//         });
//     });
// }

function loadCurrentlyPresent(presentStudents) {
    const container = document.getElementById('currentlyPresentList');
    if (!presentStudents || presentStudents.length === 0) {
        container.innerHTML = '<p style="text-align: center; color: #64748b;">No students currently present</p>';
        return;
    }

    container.innerHTML = presentStudents.map(student => `
        <div style="display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem; border-bottom: 1px solid #f1f5f9;">
            <div class="user-avatar" style="width: 32px; height: 32px;">
                ${student.name.charAt(0).toUpperCase()}
            </div>
            <div style="flex: 1;">
                <div style="font-weight: 500; font-size: 0.875rem;">${student.name}</div>
                <div style="font-size: 0.75rem; color: #64748b;">Since ${new Date(student.signInTime).toLocaleTimeString()}</div>
            </div>
            <div class="badge success">Present</div>
        </div>
    `).join('');
}

// Fix Chart.js loading issue
function waitForChart() {
    return new Promise((resolve) => {
        if (typeof Chart !== 'undefined') {
            resolve();
        } else {
            setTimeout(() => {
                waitForChart().then(resolve);
            }, 100);
        }
    });
}

function initStudentsNav() {
    const dayPrev = document.getElementById('hoursPrevBtn');
    const dayNext = document.getElementById('hoursNextBtn');

    if (!dayPrev || !dayNext) {
        console.warn('Student Hours nav buttons not found');
        return;
    }

    // ---- Daily student hours (left chart) ----
    dayPrev.onclick = async () => {
        analyticsCurrentDay = addDays(analyticsCurrentDay, -1);
        await renderStudentHoursForDay(analyticsCurrentDay);
    };

    dayNext.onclick = async () => {
        const candidate = addDays(analyticsCurrentDay, 1);

        const now = new Date();
        const todayOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        todayOnly.setHours(0, 0, 0, 0);

        // don’t go past today
        if (candidate <= todayOnly) {
            analyticsCurrentDay = candidate;
            await renderStudentHoursForDay(analyticsCurrentDay);
        }
    };
}


async function loadDashboardCharts() {
    try {
        await waitForChart(); // Wait for Chart.js to load
        const attendance = await window.electronAPI.getAttendance();
        const ctx = document.getElementById('chart');
        if (!ctx) return;

        const last7Days = [];
        for (let i = dashboardChartDaysCount - 1; i >= 0; i--) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            last7Days.push(date.toDateString());
        }

        const signInsByDay = last7Days.map(day => {
            return attendance.filter(record =>
                new Date(record.timestamp).toDateString() === day && record.action === 'signin'
            ).length;
        });

        const signOutsByDay = last7Days.map(day => {
            return attendance.filter(record =>
                new Date(record.timestamp).toDateString() === day && record.action === 'signout'
            ).length;
        });

        if (charts.attendance) {
            charts.attendance.destroy();
        }

        charts.attendance = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: last7Days.map(day => new Date(day).toLocaleDateString('en-US', { weekday: 'short' })),
                datasets: [{
                    label: 'Sign Ins',
                    data: signInsByDay,
                    borderColor: '#0021A5', // UF Blue instead of green
                    backgroundColor: 'rgba(0, 33, 165, 1)', // Light blue
                    tension: 0.4
                }, {
                    label: 'Sign Outs',
                    data: signOutsByDay,
                    borderColor: '#FA4616', // UF Orange instead of yellow
                    backgroundColor: 'rgba(250, 70, 22, 1)', // Light orange
                    tension: 0.4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'top',
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            stepSize: 1
                        }
                    }
                }
            }
        });
        await renderStudentHoursForDay(analyticsCurrentDay);
        initStudentsNav();
    } catch (error) {
        console.error('Error loading charts:', error);
        const chartContainer = document.getElementById('attendanceChart');
        if (chartContainer) {
            chartContainer.innerHTML = '<p style="text-align: center; color: #64748b;">Chart loading failed. Please refresh the page.</p>';
        }
    }
}

// Students Management
async function loadStudents() {
    try {
        studentsData = await window.electronAPI.getStudents();
        populateStudentFilter();
        displayStudents(studentsData);
    } catch (error) {
        showNotification('Error loading students: ' + error.message, 'error');
    }
}

function displayStudents(students) {
    const tbody = document.getElementById('studentsTable');
    if (!students || students.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: #64748b;">No students found</td></tr>';
        return;
    }

    tbody.innerHTML = students.map(student => `
        <tr>
            <td>
                <input type="checkbox" class="student-checkbox" value="${student.ufid}">
            </td>
            <td style="font-family: monospace; font-weight: 500;">${student.ufid}</td>
            <td>
                <div style="font-weight: 500;">${student.name}</div>
            </td>
            <td style="color: #64748b;">${student.email || 'N/A'}</td>
            <td>
                <span class="badge ${student.active ? 'success' : 'error'}">
                    ${student.active ? 'Active' : 'Inactive'}
                </span>
            </td>
            <td style="font-size: 0.875rem; color: #64748b;">
                ${student.addedDate ? new Date(student.addedDate).toLocaleDateString() : 'N/A'}
            </td>
            <td>
                <div style="display: flex; gap: 0.5rem;">
                    <button class="btn btn-secondary edit-student-btn" style="padding: 0.25rem 0.5rem; font-size: 0.75rem;" data-ufid="${student.ufid}">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button class="btn btn-secondary delete-student-btn" style="padding: 0.25rem 0.5rem; font-size: 0.75rem; color: #ef4444;" data-ufid="${student.ufid}">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </td>
        </tr>
    `).join('');

    // Add event listeners to dynamically created buttons
    document.querySelectorAll('.edit-student-btn').forEach(btn => {
        btn.addEventListener('click', function () {
            const ufid = this.getAttribute('data-ufid');
            editStudent(ufid);
        });
    });

    document.querySelectorAll('.delete-student-btn').forEach(btn => {
        btn.addEventListener('click', function () {
            const ufid = this.getAttribute('data-ufid');
            deleteStudent(ufid);
        });
    });
}

function populateStudentFilter() {
    const filter = document.getElementById('studentFilter');
    if (filter) {
        filter.innerHTML = '<option value="">All Students</option>' +
            studentsData.map(student => `<option value="${student.ufid}">${student.name}</option>`).join('');
    }
}

function setupStudentSearch() {
    const searchInput = document.getElementById('studentSearch');
    const statusFilter = document.getElementById('statusFilter');

    if (searchInput) {
        searchInput.addEventListener('input', filterStudents);
    }
    if (statusFilter) {
        statusFilter.addEventListener('change', filterStudents);
    }
}

function filterStudents() {
    const searchTerm = document.getElementById('studentSearch')?.value.toLowerCase() || '';
    const statusFilter = document.getElementById('statusFilter')?.value || '';

    let filtered = studentsData.filter(student => {
        const matchesSearch = student.name.toLowerCase().includes(searchTerm) ||
            student.ufid.includes(searchTerm) ||
            (student.email && student.email.toLowerCase().includes(searchTerm));

        const matchesStatus = !statusFilter ||
            (statusFilter === 'active' && student.active) ||
            (statusFilter === 'inactive' && !student.active);

        return matchesSearch && matchesStatus;
    });

    displayStudents(filtered);
}

function clearFilters() {
    document.getElementById('studentSearch').value = '';
    document.getElementById('statusFilter').value = '';
    displayStudents(studentsData);
}

// Bulk Import Functions
function setupBulkImport() {
    const csvFile = document.getElementById('csvFile');
    if (csvFile) {
        csvFile.addEventListener('change', previewCSV);
    }
}

function previewCSV() {
    const file = document.getElementById('csvFile').files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
        const csv = e.target.result;
        const lines = csv.split('\n');
        const preview = document.getElementById('csvPreview');

        if (lines.length > 1) {
            const headers = lines[0].split(',');
            const sampleRows = lines.slice(1, 6);

            let html = '<table style="width: 100%; font-size: 0.875rem;"><thead><tr>';
            headers.forEach(header => {
                html += `<th style="padding: 0.5rem; border-bottom: 1px solid #e2e8f0;">${header.trim()}</th>`;
            });
            html += '</tr></thead><tbody>';

            sampleRows.forEach(row => {
                if (row.trim()) {
                    const cells = row.split(',');
                    html += '<tr>';
                    cells.forEach(cell => {
                        html += `<td style="padding: 0.5rem; border-bottom: 1px solid #f8fafc;">${cell.trim()}</td>`;
                    });
                    html += '</tr>';
                }
            });
            html += '</tbody></table>';
            preview.innerHTML = html;
        }
    };
    reader.readAsText(file);
}

async function importStudents() {
    const file = document.getElementById('csvFile').files[0];
    if (!file) {
        showNotification('Please select a CSV file', 'error');
        return;
    }

    const reader = new FileReader();
    reader.onload = async function (e) {
        try {
            const csv = e.target.result;
            const lines = csv.split('\n');
            const headers = lines[0].split(',').map(h => h.trim().toLowerCase());

            const requiredHeaders = ['uf_id', 'name'];
            const hasRequiredHeaders = requiredHeaders.every(header =>
                headers.some(h => h.includes(header))
            );

            if (!hasRequiredHeaders) {
                showNotification('CSV must contain UF_ID and Name columns', 'error');
                return;
            }

            const ufidIndex = headers.findIndex(h => h.includes('uf') && h.includes('id'));
            const nameIndex = headers.findIndex(h => h.includes('name'));
            const emailIndex = headers.findIndex(h => h.includes('email'));

            let imported = 0;
            let skipped = 0;

            for (let i = 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;

                const cells = line.split(',');
                const ufid = cells[ufidIndex]?.trim();
                const name = cells[nameIndex]?.trim();
                const email = cells[emailIndex]?.trim() || '';

                if (ufid && name && /^\d{8}$/.test(ufid)) {
                    const result = await window.electronAPI.addStudent({ ufid, name, email });
                    if (result.success) {
                        imported++;
                    } else {
                        skipped++;
                    }
                } else {
                    skipped++;
                }
            }

            showNotification(`Import completed: ${imported} imported, ${skipped} skipped`, 'success');
            closeModal('bulkImportModal');
            await loadStudents();
        } catch (error) {
            showNotification('Error importing CSV: ' + error.message, 'error');
        }
    };
    reader.readAsText(file);
}

// Attendance Management
async function loadAttendance() {
    try {
        attendanceData = await window.electronAPI.getAttendance();
        await initAttendanceReporting();
        // initAttendanceReportingNav();           // new
        populateStudentFilter();
        displayAttendance(attendanceData);
        setDefaultDateRange();
    } catch (error) {
        showNotification('Error loading attendance: ' + error.message, 'error');
    }
}

function setDefaultDateRange() {
    const today = new Date();
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

    document.getElementById('fromDate').value = weekAgo.toISOString().split('T')[0];
    document.getElementById('toDate').value = today.toISOString().split('T')[0];
}

function displayAttendance(attendance) {
    const tbody = document.getElementById('attendanceTable');
    if (!attendance || attendance.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: #64748b;">No attendance records found</td></tr>';
        return;
    }

    const recordsWithDuration = attendance.map((record, index) => {
        let duration = '';
        if (record.action === 'signout') {
            for (let i = index - 1; i >= 0; i--) {
                if (attendance[i].ufid === record.ufid && attendance[i].action === 'signin') {
                    const signInTime = new Date(attendance[i].timestamp);
                    const signOutTime = new Date(record.timestamp);
                    const diffMs = signOutTime - signInTime;
                    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
                    const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
                    duration = `${diffHours}h ${diffMins}m`;
                    break;
                }
            }
        }
        return { ...record, duration };
    });

    tbody.innerHTML = recordsWithDuration.reverse().map(record => `
        <tr>
            <td style="font-size: 0.875rem;">${new Date(record.timestamp).toLocaleDateString()}</td>
            <td style="font-size: 0.875rem;">${new Date(record.timestamp).toLocaleTimeString()}</td>
            <td>
                <div style="font-weight: 500;">${record.name}</div>
            </td>
            <td style="font-family: monospace; font-size: 0.875rem;">${record.ufid}</td>
            <td>
                <span class="badge ${record.action === 'signin' ? 'success' : 'warning'}">
                    ${record.action === 'signin' ? 'Sign In' : 'Sign Out'}
                </span>
            </td>
            <td style="font-size: 0.875rem; color: #64748b;">${record.duration || '-'}</td>
            <td>
                <button class="btn btn-secondary delete-attendance-record-btn" style="padding: 0.25rem 0.5rem; font-size: 0.75rem; color: #ef4444;" data-record-id="${record.id}">
                    <i class="fas fa-trash"></i>
                </button>
            </td>
        </tr>
    `).join('');

    // Add event listeners to delete buttons
    document.querySelectorAll('.delete-attendance-record-btn').forEach(btn => {
        btn.addEventListener('click', function () {
            const recordId = parseInt(this.getAttribute('data-record-id'));
            deleteRecord(recordId);
        });
    });
}

function applyAttendanceFilters() {
    const fromDate = new Date(document.getElementById('fromDate').value);
    const toDate = new Date(document.getElementById('toDate').value);
    const studentId = document.getElementById('studentFilter').value;
    const action = document.getElementById('actionFilter').value;

    let filtered = attendanceData.filter(record => {
        const recordDate = new Date(record.timestamp);
        const matchesDate = recordDate >= fromDate && recordDate <= toDate;
        const matchesStudent = !studentId || record.ufid === studentId;
        const matchesAction = !action || record.action === action;

        return matchesDate && matchesStudent && matchesAction;
    });

    displayAttendance(filtered);
}

function clearAttendanceFilters() {
    setDefaultDateRange();
    document.getElementById('studentFilter').value = '';
    document.getElementById('actionFilter').value = '';
    displayAttendance(attendanceData);
}

// ----- Attendance Reporting -----
function initAttendanceReporting() {
    const prevBtn = document.getElementById('reportPrevBtn');
    const nextBtn = document.getElementById('reportNextBtn');
    const modeBtn = document.getElementById('reportModeToggle');
    const weeklyPane = document.getElementById('weeklyMatrixPane');
    const monthlyPane = document.getElementById('monthlyHeatmapPane');

    if (!prevBtn || !nextBtn || !modeBtn || !weeklyPane || !monthlyPane) {
        console.warn('Reporting UI elements not found');
        return;
    }

    async function refreshView() {
        if (reportMode === 'week') {
            weeklyPane.style.display = '';
            monthlyPane.style.display = 'none';
            modeBtn.textContent = 'Week view';
            await renderWeeklyMatrix(currentWeekStart);
        } else {
            weeklyPane.style.display = 'none';
            monthlyPane.style.display = '';
            modeBtn.textContent = 'Month view';
            await renderMonthlyHeatmap(currentMonthStart);
        }
    }

    modeBtn.onclick = () => {
        reportMode = (reportMode === 'week') ? 'month' : 'week';
        refreshView();
    };

    prevBtn.onclick = async () => {
        if (reportMode === 'week') {
            currentWeekStart = addDays(currentWeekStart, -7);
            await renderWeeklyMatrix(currentWeekStart);
        } else {
            currentMonthStart = new Date(
                currentMonthStart.getFullYear(),
                currentMonthStart.getMonth() - 1,
                1
            );
            await renderMonthlyHeatmap(currentMonthStart);
        }
    };

    nextBtn.onclick = async () => {
        if (reportMode === 'week') {
            const thisWeek = startOfWeek(new Date());
            const candidate = addDays(currentWeekStart, 7);
            if (candidate <= thisWeek) {
                currentWeekStart = candidate;
                await renderWeeklyMatrix(currentWeekStart);
            }
        } else {
            const thisMonthStart = startOfMonth(new Date());
            const candidate = new Date(
                currentMonthStart.getFullYear(),
                currentMonthStart.getMonth() + 1,
                1
            );
            if (candidate <= thisMonthStart) {
                currentMonthStart = candidate;
                await renderMonthlyHeatmap(currentMonthStart);
            }
        }
    };

    // initial render
    refreshView();
}



function fmtYMD(d) { return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
function setWeekLabel(weekStart) {
    const weekEnd = addDays(weekStart, 6);
    const isThisWeek = startOfWeek(new Date()).getTime() === weekStart.getTime();
    document.getElementById('weekLabel').textContent =
        isThisWeek ? 'This Week' : `${fmtYMD(weekStart)} – ${fmtYMD(weekEnd)}`;
    // disable/enable next button
    const weekNext = document.getElementById('weekNextBtn');
    weekNext.disabled = !(addDays(weekStart, 7) <= startOfWeek(new Date()));
}

function setMonthLabel(monthStart) {
    const nowMonthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const label = monthStart.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    document.getElementById('monthLabel').textContent =
        (monthStart.getTime() === nowMonthStart.getTime()) ? 'This Month' : label;
    // disable/enable next button
    document.getElementById('monthNextBtn').disabled = !(new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1) <= nowMonthStart);
}

function fmtTime(dt) {
    if (!dt) return '—';
    const d = new Date(dt);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function normalizeSessions(s) {
    // Prefer the sessions array you already use in renderTimeBands()
    if (Array.isArray(s.sessions) && s.sessions.length) {
        return s.sessions.map(sess => ({
            in: sess.in ?? sess.signInAt ?? sess.clockInAt ?? sess.startTime ?? sess.inTime ?? null,
            out: sess.out ?? sess.signOutAt ?? sess.clockOutAt ?? sess.endTime ?? sess.outTime ?? null
        }));
    }

    // Fallback: sometimes summary might have one pair on the summary itself
    const inT = s.in ?? s.signInAt ?? s.clockInAt ?? s.startTime ?? s.inTime ?? null;
    const outT = s.out ?? s.signOutAt ?? s.clockOutAt ?? s.endTime ?? s.outTime ?? null;
    return (inT || outT) ? [{ in: inT, out: outT }] : [];
}

function renderSessionsHtml(sessions) {
    if (!sessions || !sessions.length) return '';
    return `<div style="margin-top:4px; font-size:0.75rem; color:#475569; line-height:1.2;">
        ${sessions.map(sess =>
        `<div>${fmtTime(sess.in)} – ${fmtTime(sess.out)}</div>`
    ).join('')}
    </div>`;
}

// Build Mon–Sun matrix (alphabetical, neutral)
async function renderWeeklyMatrix(weekStart) {
    const labelEl = document.getElementById('reportRangeLabel');
    const nextBtn = document.getElementById('reportNextBtn');

    const days = Array.from({ length: 7 }, (_, i) =>
        new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + i)
    );

    // Label
    const thisWeek = startOfWeek(new Date());
    const weekEnd = addDays(weekStart, 6);
    labelEl.textContent =
        (weekStart.getTime() === thisWeek.getTime())
            ? 'This week'
            : `${fmtShort(weekStart)} – ${fmtShort(weekEnd)}`;

    // Disable next if we would go past this week
    nextBtn.disabled = addDays(weekStart, 7) > thisWeek;

    // Fetch summaries per day
    const perDay = await Promise.all(days.map(async (d) => {
        const iso = new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
        const res = await window.electronAPI.getDailySummary(iso, 'cap');
        return (res && res.success && Array.isArray(res.summaries)) ? res.summaries : [];
    }));

    // Map: studentKey -> [{hours, sessions[]}, ... x7]
    const map = new Map();

    perDay.forEach((summaries, dayIdx) => {
        summaries.forEach(s => {
            const key = s.name || s.ufid || `UFID-${dayIdx}`;
            const row = map.get(key) || Array.from({ length: 7 }, () => ({ hours: 0, sessions: [] }));

            const hours = (typeof s.totalHours === 'number') ? s.totalHours : 0;
            const sessions = normalizeSessions(s);

            row[dayIdx] = { hours, sessions };
            map.set(key, row);
        });
    });

    const header = document.getElementById('weeklyHeader');
    const body = document.getElementById('weeklyBody');

    header.innerHTML =
        `<tr>
            <th style="text-align:left">Student</th>
            ${days.map(d => `<th>${d.toLocaleDateString(undefined, { weekday: 'short' })}</th>`).join('')}
            <th>Total</th>
        </tr>`;

    const rows = Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));

    body.innerHTML = rows.map(([name, weekCells]) => {
        const total = weekCells.reduce((sum, c) => sum + (c.hours || 0), 0);

        return `<tr>
            <td style="text-align:left">${escapeHtml(name)}</td>
            ${weekCells.map(cell => {
                const h = (cell.hours || 0);
                const sessHtml = renderSessionsHtml(cell.sessions);
                return `<td style="vertical-align:top;">
                    <div style="font-variant-numeric: tabular-nums;">${h.toFixed(2)}h</div>
                    ${sessHtml}
                </td>`;
            }).join('')}
            <td style="vertical-align:top;"><strong>${total.toFixed(2)}h</strong></td>
        </tr>`;
    }).join('');
}


function startOfWeek(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const day = (x.getDay() + 6) % 7; // make Monday 0
    x.setDate(x.getDate() - day);
    x.setHours(0, 0, 0, 0);
    return x;
}

// Month heatmap: render as a grid chart (bar heights=1, color by hours bucket)
async function renderMonthlyHeatmap(monthStart) {
    const labelEl = document.getElementById('reportRangeLabel');
    const nextBtn = document.getElementById('reportNextBtn');

    const nowMonthStart = startOfMonth(new Date());
    if (monthStart.getTime() === nowMonthStart.getTime()) {
        labelEl.textContent = 'This month';
    } else {
        labelEl.textContent = monthStart.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    }
    nextBtn.disabled = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1) > nowMonthStart;

    const year = monthStart.getFullYear();
    const month = monthStart.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const perDay = await Promise.all(
        Array.from({ length: daysInMonth }, (_, i) => {
            const d = new Date(year, month, i + 1);
            return window.electronAPI.getDailySummary(d.toISOString(), 'autosignout');
        })
    );

    const map = new Map();
    perDay.forEach((r, dayIdx) => {
        const summaries = (r && r.success && Array.isArray(r.summaries)) ? r.summaries : [];
        summaries.forEach(s => {
            const key = s.name || s.ufid;
            const row = map.get(key) || Array(daysInMonth).fill(0);
            row[dayIdx] = (typeof s.totalHours === 'number') ? s.totalHours : 0;
            map.set(key, row);
        });
    });

    const names = Array.from(map.keys()).sort((a, b) => a.localeCompare(b));
    const data = names.map(n => map.get(n) || Array(daysInMonth).fill(0));

    const ctx = document.getElementById('monthlyHeatmap');
    if (!ctx) return;
    if (charts.monthHeatmap) charts.monthHeatmap.destroy();

    charts.monthHeatmap = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: names,
            datasets: Array.from({ length: daysInMonth }, (_, dayIdx) => ({
                label: String(dayIdx + 1),
                data: names.map((_, rowIdx) => data[rowIdx][dayIdx] || 0),
                stack: 'month',
                backgroundColor: (ctx) => colorForHours(ctx.raw), // uses your legend buckets
                borderWidth: 0,
                fill: true
            }))
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: 'y',
            layout: {
                padding: { top: 10, right: 16, bottom: 10, left: 0 }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        title: (items) => names[items[0].dataIndex],
                        label: (item) => `Day ${item.dataset.label}: ${item.raw.toFixed(2)}h`
                    }
                }
            },
            scales: {
                x: { stacked: true, display: false },
                y: { stacked: true }
            }
        }
    });

    // make sure legend text exists (if you added heatLegend in HTML)
    renderHeatLegend?.();
}


// System Logs
async function loadLogs() {
    try {
        const result = await window.electronAPI.getSystemLogs({ limit: 200 });
        if (result.success) {
            logsData = result.logs;
            displayLogs(logsData);
        } else {
            showNotification('Error loading logs: ' + result.error, 'error');
        }
    } catch (error) {
        showNotification('Error loading logs: ' + error.message, 'error');
    }
}

function displayLogs(logs) {
    const tbody = document.getElementById('logsTable');
    if (!logs || logs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #64748b;">No logs found</td></tr>';
        return;
    }

    tbody.innerHTML = logs.map(log => `
        <tr>
            <td style="font-size: 0.875rem; font-family: monospace;">${new Date(log.timestamp).toLocaleString()}</td>
            <td>
                <span class="badge ${log.level === 'error' ? 'error' : log.level === 'warning' ? 'warning' : 'success'}">
                    ${log.level.toUpperCase()}
                </span>
            </td>
            <td style="font-size: 0.875rem;">${log.category}</td>
            <td style="font-size: 0.875rem;">${log.message}</td>
            <td style="font-size: 0.875rem;">${log.user}</td>
        </tr>
    `).join('');
}

function filterLogs() {
    const level = document.getElementById('logLevel').value;
    const category = document.getElementById('logCategory').value;
    const date = document.getElementById('logDate').value;

    let filtered = logsData.filter(log => {
        const matchesLevel = !level || log.level === level;
        const matchesCategory = !category || log.category === category;
        const matchesDate = !date || new Date(log.timestamp).toDateString() === new Date(date).toDateString();

        return matchesLevel && matchesCategory && matchesDate;
    });

    displayLogs(filtered);
}

// Reports and Analytics
async function loadReports() {
    await loadAnalyticsCharts();
}

async function loadAnalyticsCharts() {
    try {
        await waitForChart(); // Wait for Chart.js to load
        const attendance = await window.electronAPI.getAttendance();

        const trendsCtx = document.getElementById('trendsChart');
        if (trendsCtx && attendance.length > 0) {
            const last30Days = [];
            for (let i = 29; i >= 0; i--) {
                const date = new Date();
                date.setDate(date.getDate() - i);
                last30Days.push(date.toDateString());
            }

            const dailySignIns = last30Days.map(day => {
                return attendance.filter(record =>
                    new Date(record.timestamp).toDateString() === day && record.action === 'signin'
                ).length;
            });

            if (charts.trends) charts.trends.destroy();
            charts.trends = new Chart(trendsCtx, {
                type: 'line',
                data: {
                    labels: last30Days.map(day => new Date(day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })),
                    datasets: [{
                        label: 'Daily Sign-ins',
                        data: dailySignIns,
                        borderColor: '#0021A5', // UF Blue
                        backgroundColor: 'rgba(0, 33, 165, 0.1)', // Light blue
                        tension: 0.4,
                        fill: true
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            display: false
                        }
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            ticks: {
                                stepSize: 1
                            }
                        },
                        x: {
                            ticks: {
                                maxTicksLimit: 10
                            }
                        }
                    }
                }
            });
        }

        const hoursCtx = document.getElementById('hoursChart');
        if (hoursCtx && attendance.length > 0) {
            const hourlyData = new Array(24).fill(0);
            attendance.forEach(record => {
                if (record.action === 'signin') {
                    const hour = new Date(record.timestamp).getHours();
                    hourlyData[hour]++;
                }
            });

            if (charts.hours) charts.hours.destroy();
            charts.hours = new Chart(hoursCtx, {
                type: 'bar',
                data: {
                    labels: Array.from({ length: 24 }, (_, i) => i + ':00'),
                    datasets: [{
                        label: 'Sign-ins by Hour',
                        data: hourlyData,
                        backgroundColor: 'rgba(0, 33, 165, 0.8)', // UF Blue
                        borderColor: '#0021A5',
                        borderWidth: 1
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            display: false
                        }
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            ticks: {
                                stepSize: 1
                            }
                        }
                    }
                }
            });
        }
        analyticsCurrentDay = new Date();
        analyticsCurrentDay.setDate(analyticsCurrentDay.getDate() - 1);
        analyticsCurrentDay.setHours(0, 0, 0, 0);
        analyticsCurrentWeekStart = startOfWeek(new Date());
        await renderTimeBands({ day: analyticsCurrentWeekStart, startHour: 8, endHour: 20 });

        initAnalyticsDetailNav();
    } catch (error) {
        console.error('Error loading analytics charts:', error);
        const trendsChart = document.getElementById('trendsChart');
        const hoursChart = document.getElementById('hoursChart');
        if (trendsChart) {
            trendsChart.parentElement.innerHTML = '<p style="text-align: center; color: #64748b;">Trends chart loading failed.</p>';
        }
        if (hoursChart) {
            hoursChart.parentElement.innerHTML = '<p style="text-align: center; color: #64748b;">Hours chart loading failed.</p>';
        }
    }
}
// ----- Analytics helpers -----
function minutes(h, m = 0) { return h * 60 + m; }
function minToLabel(min) {
    const h = Math.floor(min / 60), mm = min % 60;
    const h12 = ((h + 11) % 12) + 1, ampm = h < 12 ? 'AM' : 'PM';
    return `${h12}:${String(mm).padStart(2, '0')} ${ampm}`;
}

function studentColor(index, variant) {
    const hue = (index * 47) % 360;   // spread hues around color wheel
    const sat = 70;
    const light = variant === 'in' ? 72 : 45; // lighter for sign-in, darker for sign-out
    return `hsl(${hue}, ${sat}%, ${light}%)`;
}

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}



// Hours per student (today)
function initAnalyticsDetailNav() {
    const weekPrev = document.getElementById('bandsPrevBtn');
    const weekNext = document.getElementById('bandsNextBtn');

    if (!weekPrev || !weekNext) {
        console.warn('Analytics nav buttons not found');
        return;
    }

    // ---- Weekly time bands (right chart) ----
    weekPrev.onclick = async () => {
        analyticsCurrentWeekStart = addDays(analyticsCurrentWeekStart, -7);
        await renderTimeBands({ day: analyticsCurrentWeekStart, startHour: 8, endHour: 20 });
    };

    weekNext.onclick = async () => {
        const thisWeekStart = startOfWeek(new Date());
        const candidate = addDays(analyticsCurrentWeekStart, 7);
        // don’t step into a future week
        if (candidate <= thisWeekStart) {
            analyticsCurrentWeekStart = candidate;
            await renderTimeBands({ day: analyticsCurrentWeekStart, startHour: 8, endHour: 20 });
        }
    };
}


async function renderStudentHoursForDay(day = new Date()) {
    console.log("rendering start")
    const ctx = document.getElementById('studentHoursChart');
    if (!ctx) return;

    const labelEl = document.getElementById('hoursRangeLabel');
    const nextBtn = document.getElementById('hoursNextBtn');

    // normalize to midnight
    const d = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    const today = new Date();
    const todayOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());

    // Label: "Today" or "Thu, Nov 14"
    if (d.getTime() === todayOnly.getTime()) {
        labelEl.textContent = 'Today';
    } else {
        labelEl.textContent = d.toLocaleDateString(undefined, {
            weekday: 'short', month: 'short', day: 'numeric'
        });
    }
    // disable next if we’d go into the future
    nextBtn.disabled = d.getTime() >= todayOnly.getTime();
    const dateISO = d.toISOString();
    let res = {"summaries": []};

    if (d.getTime() == todayOnly.getTime()) {   
        res = await window.electronAPI.computeHoursWorkedToday(dateISO);
    } else {
        res = await window.electronAPI.getDailySummary(dateISO, 'autosignout'); // or 'autosignout' if you prefer
    }
    console.log(res)
    const summaries = (res && Array.isArray(res.summaries)) ? res.summaries : [];

    const rows = summaries.slice().sort((a, b) =>
        (a.name || a.ufid).localeCompare(b.name || b.ufid)
    );

    if (charts.studentHours) charts.studentHours.destroy();
    charts.studentHours = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: rows.map(r => r.name || r.ufid),
            datasets: [{
                label: 'Hours',
                data: rows.map(r => r.totalHours),
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,  // like trendsChart
            indexAxis: 'y',
            plugins: { legend: { display: false } },
            scales: {
                x: { title: { display: true, text: 'Hours' } },
                y: { title: { display: false } }
            }
        }
    });
}

// “Two dots of a bar” (dumbbell) per student for selected day
// Weekly “two dots of a bar” per student (time bands)
// “Two dots of a bar” per student, per day for the week containing `day`
// Weekly scatter: every sign-in/sign-out is a point
async function renderTimeBands({ day = new Date(), startHour = 8, endHour = 20 } = {}) {
    const ctx = document.getElementById('timeBandsChart');
    if (!ctx) return;

    const labelEl = document.getElementById('bandsRangeLabel');
    const nextBtn = document.getElementById('bandsNextBtn');

    const xMin = minutes(startHour);
    const xMax = minutes(endHour);

    // ----- figure out the week -----
    const base = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    const weekStart = startOfWeek(base);
    const thisWeekStart = startOfWeek(new Date());
    const weekEnd = addDays(weekStart, 6);

    // Update label text
    if (labelEl) {
        if (weekStart.getTime() === thisWeekStart.getTime()) {
            labelEl.textContent = 'This week';
        } else {
            labelEl.textContent =
                `${weekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ` +
                `${weekEnd.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
        }
    }

    // Enable/disable "next" button (can’t go into future week)
    if (nextBtn) {
        nextBtn.disabled = addDays(weekStart, 7) > thisWeekStart;
    }

    const weekDays = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(weekStart);
        d.setDate(weekStart.getDate() + i);
        d.setHours(0, 0, 0, 0);
        return d;
    });

    const dayLabels = weekDays.map(d =>
        d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    );

    // ----- fetch summaries for each day in the week -----
    const now = new Date();
    const todayOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    todayOnly.setHours(0, 0, 0, 0);

    const perDaySummaries = await Promise.all(
        weekDays.map(async (d) => {
            // skip today and any future day in this week
            const dayOnly = new Date(d.getFullYear(), d.getMonth(), d.getDate());
            if (dayOnly.getTime() > todayOnly.getTime()) {
                return [];  // no points for today / future
            }

            // use whatever date format you’re already using here:
            // if you’re on toISOString:
            const dayISO = d.toISOString();
            // or, if you switched to a YYYY-MM-DD string:
            // const dayISO = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

            const res = await window.electronAPI.getDailySummary(dayISO, 'autosignout');
            return (res && Array.isArray(res.summaries)) ? res.summaries : [];
        })
    );

    // ----- collect all sessions as points -----
    const toMin = iso => {
        const t = new Date(iso);
        return t.getHours() * 60 + t.getMinutes();
    };

    const allStudents = new Set();
    const signInPoints = [];
    const signOutPoints = [];


    perDaySummaries.forEach((summaries, dayIdx) => {
        summaries.forEach(s => {
            if (!s.sessions || !s.sessions.length) return;
            const name = s.name || s.ufid;
            allStudents.add(name);

            s.sessions.forEach(sess => {
                // sign-in
                if (sess.in) {
                    const m = toMin(sess.in);
                    if (m >= xMin && m <= xMax) {
                        signInPoints.push({ x: m, name, dayIndex: dayIdx });
                    }
                }
                // sign-out
                if (sess.out) {
                    const m = toMin(sess.out);
                    if (m >= xMin && m <= xMax) {
                        signOutPoints.push({ x: m, name, dayIndex: dayIdx });
                    }
                }
            });
        });
    });

    const names = Array.from(allStudents).sort((a, b) => a.localeCompare(b));
    const nameToIndex = new Map();
    names.forEach((n, i) => nameToIndex.set(n, i));

    // map names to y index
    const signinData = signInPoints.map(p => ({
        x: p.x,
        y: nameToIndex.get(p.name),
        dayIndex: p.dayIndex
    }));
    const signoutData = signOutPoints.map(p => ({
        x: p.x,
        y: nameToIndex.get(p.name),
        dayIndex: p.dayIndex
    }));

    // ----- build chart -----
    if (charts.timeBands) charts.timeBands.destroy();

    charts.timeBands = new Chart(ctx, {
        type: 'scatter',
        data: {
            // we use a numeric y-axis and map ticks to names,
            // so labels array isn't critical here, but keep for clarity:
            labels: names,
            datasets: [
                {
                    label: 'Sign in',
                    data: signinData,
                    parsing: false,
                    pointRadius: 4,
                    hoverRadius: 6,
                    backgroundColor: (ctx) => {
                        const raw = ctx.raw;
                        let rowIndex = 0;

                        if (raw && typeof raw.y === 'number') {
                            rowIndex = raw.y;
                        } else {
                            // Fallback: look at the underlying data array
                            const ds = ctx.chart.data.datasets[ctx.datasetIndex];
                            const datum = ds && ds.data ? ds.data[ctx.dataIndex] : null;
                            if (datum && typeof datum.y === 'number') {
                                rowIndex = datum.y;
                            }
                        }

                        return studentColor(rowIndex, 'in'); // for Sign in dataset
                    }
                },
                {
                    label: 'Sign out',
                    data: signoutData,
                    parsing: false,
                    pointRadius: 4,
                    hoverRadius: 6,
                    backgroundColor: (ctx) => {
                        const raw = ctx.raw;
                        let rowIndex = 0;

                        if (raw && typeof raw.y === 'number') {
                            rowIndex = raw.y;
                        } else {
                            const ds = ctx.chart.data.datasets[ctx.datasetIndex];
                            const datum = ds && ds.data ? ds.data[ctx.dataIndex] : null;
                            if (datum && typeof datum.y === 'number') {
                                rowIndex = datum.y;
                            }
                        }

                        return studentColor(rowIndex, 'out'); // darker variant
                    }
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: true, position: 'top' },
                tooltip: {
                    callbacks: {
                        title: items => {
                            const raw = items[0].raw;
                            const studentName = names[raw.y] || '';
                            const dayLabel = dayLabels[raw.dayIndex] || '';
                            return `${studentName} – ${dayLabel}`;
                        },
                        label: item => {
                            const raw = item.raw;
                            const timeLabel = minToLabel(raw.x);
                            return `${item.dataset.label}: ${timeLabel}`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    min: xMin,
                    max: xMax,
                    ticks: {
                        callback: v => minToLabel(v)
                    },
                    title: {
                        display: true,
                        text: 'Time of day'
                    }
                },
                y: {
                    type: 'linear',
                    display: true,
                    min: -0.5,
                    max: names.length - 0.5,
                    offset: true,
                    ticks: {
                        stepSize: 1,
                        autoSkip: false,
                        callback: (value, index) => {
                            // index is 0..N-1 in order, use that to index names[]
                            return names[index] || '';
                        }
                    },
                    title: { display: false },
                    grid: {
                        display: false
                    }
                }
            }
        }
    });
}




// Settings Management
async function loadSettings() {
    try {
        const config = await window.electronAPI.getConfig();
        const emailSettings = config.emailSettings || {};

        document.getElementById('smtpServer').value = emailSettings.smtp || '';
        document.getElementById('emailAddress').value = emailSettings.email || '';
        document.getElementById('recipientEmail').value = emailSettings.recipientEmail || '';
        document.getElementById('smtpPassword').value = emailSettings.password || '';

        await loadDropboxSettings();
        await loadSheetsSettings();
        await loadEncryptionSettings();

        document.getElementById('labName').value = config.labName || 'University of Florida Lab';

        await updateSettingsStatus();
        await updateSchedulerStatus();
    } catch (error) {
        showNotification('Error loading settings: ' + error.message, 'error');
    }
}

async function updateSettingsStatus() {
    try {
        const config = await window.electronAPI.getConfig();
        const emailStatus = document.getElementById('emailStatus');

        if (config.emailSettings && config.emailSettings.enabled) {
            emailStatus.textContent = 'Connected';
            emailStatus.className = 'badge success';
        } else {
            emailStatus.textContent = 'Disconnected';
            emailStatus.className = 'badge error';
        }
    } catch (error) {
        console.error('Error updating settings status:', error);
    }
}

async function updateSchedulerStatus() {
    try {
        const status = await window.electronAPI.getSchedulerStatus();
        const schedulerStatus = document.getElementById('schedulerStatus');
        const nextRunTime = document.getElementById('nextRunTime');

        if (status.running) {
            schedulerStatus.textContent = 'Running';
            schedulerStatus.style.color = '#22543d';
        } else {
            schedulerStatus.textContent = 'Stopped';
            schedulerStatus.style.color = '#742a2a';
        }

        nextRunTime.textContent = status.nextRun || 'Every Saturday at 8:00 AM';

        if (!status.initialized) {
            schedulerStatus.textContent = 'Not Initialized';
            schedulerStatus.style.color = '#dd6b20';
        }
    } catch (error) {
        document.getElementById('schedulerStatus').textContent = 'Error checking status';
    }
}

// Dropbox Functions
if (typeof window.setDropboxMsg !== 'function') {
    window.setDropboxMsg = function (text) {
        const el = document.getElementById('dropboxMsg');
        if (el) el.textContent = text || '';
    };
}

if (typeof window.setDropboxStatus !== 'function') {
    window.setDropboxStatus = function (text, ok = null) {
        const el = document.getElementById('dropboxStatus');
        if (!el) return;
        el.textContent = text || '';
        el.classList.remove('success', 'warning', 'error');
        if (ok === true) el.classList.add('success');
        if (ok === false) el.classList.add('warning');
    };
}

async function refreshDropboxBadges() {
    try {
        const cfg = await window.electronAPI.getConfig();
        const dbx = cfg?.dropbox || {};
        const status = await window.electronAPI.getDropboxSyncStatus?.();

        const mode = !dbx.enabled ? 'off' : (dbx.masterMode ? 'pull' : 'push');

        const statusBadge = document.getElementById('dropboxStatus');      // header badge
        const syncBadge = document.getElementById('dropboxSyncStatus');  // "Status: ..."
        const nextRunSpan = document.getElementById('dropboxNextRun');     // "Next pull: ..."

        // Header badge
        if (statusBadge) {
            statusBadge.classList.remove('success', 'warning', 'error');
            if (!dbx.enabled) {
                statusBadge.textContent = 'Disconnected';
                statusBadge.classList.add('error');
            } else {
                statusBadge.textContent = `Connected (${mode})`;
                statusBadge.classList.add('success');
            }
        }

        // Sync badge + next run
        if (syncBadge) {
            if (!dbx.enabled) {
                syncBadge.textContent = 'Status: Disabled';
                syncBadge.className = 'badge warning';
            } else if (dbx.masterMode) {
                syncBadge.textContent = status?.running ? 'Status: Pulling (timer ON)' : 'Status: Pulling (timer OFF)';
                syncBadge.className = 'badge info';
            } else {
                syncBadge.textContent = 'Status: Push on Save/Close';
                syncBadge.className = 'badge info';
            }
        }

        if (nextRunSpan) {
            nextRunSpan.textContent = (dbx.enabled && dbx.masterMode) ? (status?.nextRun || '—') : '—';
        }
    } catch (e) {
        console.error('refreshDropboxBadges error:', e);
    }
}


async function loadDropboxSettings() {
    try {
        const config = await window.electronAPI.getConfig();
        const d = (config && config.dropbox) ? config.dropbox : {};

        const keyEl = document.getElementById('dropboxAppKey');
        if (keyEl) keyEl.value = d.appKey || '';

        const secretEl = document.getElementById('dropboxAppSecret');
        if (secretEl) secretEl.value = d.appSecret || '';

        const tokenEl = document.getElementById('dropboxRefreshToken');
        if (tokenEl) tokenEl.value = d.refreshToken || '';

        const folderEl = document.getElementById('dropboxFolder');
        if (folderEl) folderEl.value = '/UF-Lab-Attendance';

        const autoBackupEl = document.getElementById('dropboxAutoBackup');
        if (autoBackupEl) autoBackupEl.checked = !!d.autoBackup;

        const autoReportsEl = document.getElementById('dropboxAutoReports');
        if (autoReportsEl) autoReportsEl.checked = !!d.autoReports;

        const masterEl = document.getElementById('dropboxMasterMode');
        if (masterEl) masterEl.checked = !!d.masterMode;

        const intervalEl = document.getElementById('dropboxSyncInterval');
        if (intervalEl) intervalEl.value = (typeof d.syncIntervalMinutes === 'number' ? d.syncIntervalMinutes : 10);

        // NEW: load simple sync status from main (optional)
        try {
            const status = await window.electronAPI.getDropboxSyncStatus?.();
            const statusEl = document.getElementById('dropboxSyncStatus');
            const nextRunEl = document.getElementById('dropboxNextRun');
            if (statusEl) statusEl.textContent = status?.lastSyncAt ? `Last sync: ${new Date(status.lastSyncAt).toLocaleTimeString()}` : 'Status: —';
            if (nextRunEl) nextRunEl.textContent = status?.nextRun ? `Next pull: ${status.nextRun}` : 'Next pull: —';
        } catch { }
        await refreshDropboxBadges();
    } catch (error) {
        console.error('Error loading Dropbox settings:', error);
        setDropboxMsg?.('Error loading Dropbox settings: ' + (error?.message || error));
    }
}
async function connectDropbox() {
    try {
        setDropboxMsg && setDropboxMsg('Opening Dropbox authorization...');
        const res = await window.electronAPI.dropboxOAuthConnect();
        if (res?.success) {
            setDropboxMsg && setDropboxMsg('Connected! Refresh token saved.');
            setDropboxStatus && setDropboxStatus('Connected', true);
            await loadDropboxSettings();        // <-- refresh fields from config.json
            try { await window.electronAPI.getDropboxSyncStatus?.(); } catch { }
        } else {
            setDropboxMsg && setDropboxMsg('Connect failed: ' + (res?.error || 'Unknown error'));
            setDropboxStatus && setDropboxStatus('Disconnected', false);
        }
    } catch (e) {
        setDropboxMsg && setDropboxMsg('Connect error: ' + e.message);
        setDropboxStatus && setDropboxStatus('Disconnected', false);
    }
}

async function updateDropboxStatus() {
    try {
        const result = await window.electronAPI.testDropboxConnection();
        const statusElement = document.getElementById('dropboxStatus');

        if (result.success) {
            statusElement.textContent = `Connected (${result.user})`;
            statusElement.className = 'badge success';
        } else {
            statusElement.textContent = 'Disconnected';
            statusElement.className = 'badge error';
        }
    } catch (error) {
        document.getElementById('dropboxStatus').textContent = 'Error';
        document.getElementById('dropboxStatus').className = 'badge error';
    }
}

async function updateDropboxUsage() {
    try {
        const result = await window.electronAPI.getDropboxSpace();
        const usageElement = document.getElementById('dropboxUsage');

        if (result.success) {
            const usedGB = (result.used / (1024 * 1024 * 1024)).toFixed(2);
            const totalGB = (result.allocated / (1024 * 1024 * 1024)).toFixed(2);
            usageElement.innerHTML = `
                <div>${usedGB} GB / ${totalGB} GB used (${result.usedPercent}%)</div>
                <div style="background: #e2e8f0; height: 6px; border-radius: 3px; margin-top: 0.5rem;">
                    <div style="background: #10b981; height: 100%; width: ${result.usedPercent}%; border-radius: 3px;"></div>
                </div>
            `;
        } else {
            usageElement.textContent = 'Unable to fetch usage data';
        }
    } catch (error) {
        document.getElementById('dropboxUsage').textContent = 'Error fetching usage';
    }
}

// Safe Dropbox settings save (no-crash, friendly messages, fallback IDs)
async function saveDropboxSettings() {
    // Try multiple possible IDs for each field so small HTML mismatches don't break things
    const getFirstEl = (ids) => {
        for (const id of ids) {
            const el = document.getElementById(id);
            if (el) return el;
        }
        return null;
    };
    const getFirstVal = (ids) => {
        const el = getFirstEl(ids);
        return el ? (el.value || '').trim() : null;
    };

    // Known/fallback IDs
    const APP_KEY_IDS = ['dropboxAppKey', 'dbxAppKey', 'appKey'];
    const APP_SECRET_IDS = ['dropboxAppSecret', 'dbxAppSecret', 'appSecret'];
    const REFRESH_IDS = ['dropboxRefreshToken', 'dbxRefreshToken', 'refreshToken'];
    const AUTO_BACKUP_IDS = ['dropboxAutoBackup', 'dbxAutoBackup'];
    const AUTO_REPORTS_IDS = ['dropboxAutoReports', 'dbxAutoReports'];


    const appKeyEl = getFirstEl(APP_KEY_IDS);
    const appSecretEl = getFirstEl(APP_SECRET_IDS);
    const refreshEl = getFirstEl(REFRESH_IDS);

    const appKey = getFirstVal(APP_KEY_IDS);
    const appSecret = getFirstVal(APP_SECRET_IDS);
    const refreshToken = getFirstVal(REFRESH_IDS); // may be empty the first time

    const getFirstChecked = (ids) => {
        const el = getFirstEl(ids);
        return el ? !!el.checked : false;
    };

    const autoBackup = getFirstChecked(AUTO_BACKUP_IDS);
    const autoReports = getFirstChecked(AUTO_REPORTS_IDS);


    // If inputs are missing, don't crash—tell the user exactly what's missing.
    const missing = [];
    if (!appKeyEl) missing.push(`#${APP_KEY_IDS[0]}`);
    if (!appSecretEl) missing.push(`#${APP_SECRET_IDS[0]}`);
    // refresh token field is optional to render, so we don't mark as missing

    if (missing.length) {
        const msg = `Dropbox inputs not found: ${missing.join(', ')}. Please add these elements in admin.html or adjust IDs.`;
        if (typeof setDropboxMsg === 'function') setDropboxMsg(msg);
        if (typeof showNotification === 'function') showNotification(msg, 'error');
        return;
    }

    if (!appKey || !appSecret) {
        const msg = 'Please enter both App Key and App Secret.';
        if (typeof setDropboxMsg === 'function') setDropboxMsg(msg);
        if (typeof showNotification === 'function') showNotification(msg, 'error');
        return;
    }

    try {
        if (typeof setDropboxMsg === 'function') setDropboxMsg('Saving Dropbox settings...');
        const folder = getDropboxFolderOrDefault();
        const partial = {
            enabled: true,
            appKey,
            appSecret,
            autoBackup,     // <— new
            autoReports,
            folder,

        };
        if (refreshToken) partial.refreshToken = refreshToken; // if user already pasted one

        const res = await window.electronAPI.updateDropboxConfig(partial);
        if (res?.success) {
            if (typeof setDropboxMsg === 'function') setDropboxMsg('Dropbox settings saved.');
            if (typeof setDropboxStatus === 'function') setDropboxStatus('Saved', true);
            // Apply timers and refresh UI state
            await window.electronAPI.applyDropboxSyncConfig?.();
            await refreshDropboxBadges();
        } else {
            const msg = 'Save failed: ' + (res?.error || 'Unknown error');
            if (typeof setDropboxMsg === 'function') setDropboxMsg(msg);
            if (typeof setDropboxStatus === 'function') setDropboxStatus('Error', false);
            if (typeof showNotification === 'function') showNotification(msg, 'error');
        }
    } catch (e) {
        const msg = 'Save error: ' + e.message;
        if (typeof setDropboxMsg === 'function') setDropboxMsg(msg);
        if (typeof setDropboxStatus === 'function') setDropboxStatus('Error', false);
        if (typeof showNotification === 'function') showNotification(msg, 'error');
    }
}

async function testDropboxConnection() {
    try {
        if (typeof setDropboxMsg === 'function') setDropboxMsg('Testing Dropbox connection...');
        const result = await window.electronAPI.testDropboxConnection();
        if (result.success) {
            if (typeof showNotification === 'function') showNotification(`Connected to Dropbox as ${result.user}`, 'success');
            if (typeof setDropboxStatus === 'function') setDropboxStatus(`Connected (${result.user})`, true);
        } else {
            if (typeof showNotification === 'function') showNotification('Dropbox connection failed: ' + result.error, 'error');
            if (typeof setDropboxStatus === 'function') setDropboxStatus('Disconnected', false);
        }
    } catch (error) {
        if (typeof showNotification === 'function') showNotification('Connection test failed: ' + error.message, 'error');
        if (typeof setDropboxStatus === 'function') setDropboxStatus('Error', false);
    }
}


async function uploadToDropbox(type) {
    const typeText = type === 'backup' ? 'backup' : 'weekly report';
    showNotification(`Uploading ${typeText} to Dropbox...`, 'info');

    try {
        const result = await window.electronAPI.uploadToDropbox(type);
        if (result.success) {
            showNotification(`${typeText.charAt(0).toUpperCase() + typeText.slice(1)} uploaded successfully!`, 'success');
        } else {
            showNotification(`Upload failed: ${result.error}`, 'error');
        }
    } catch (error) {
        showNotification(`Upload error: ${error.message}`, 'error');
    }
}

async function viewDropboxFiles() {
    try {
        const result = await window.electronAPI.listDropboxFiles(getDropboxFolderOrDefault());
        if (result.success) {
            displayDropboxFiles(result.files);
            openModal('dropboxFilesModal');
        } else {
            showNotification('Error loading files: ' + result.error, 'error');
        }
    } catch (error) {
        showNotification('Error loading files: ' + error.message, 'error');
    }
}
function getDropboxFolderOrDefault() {
    const el = document.getElementById('dropboxFolder');
    const v = (el && el.value && el.value.trim()) ? el.value.trim() : '/UF-Lab-Attendance';
    return v;
}

async function listDropboxFiles() {
    try {
        if (typeof setDropboxMsg === 'function') setDropboxMsg('Loading files...');
        const folder = getDropboxFolderOrDefault();
        const res = await window.electronAPI.listDropboxFiles(folder);
        if (res?.success) {
            displayDropboxFiles(res.files);
            document.getElementById('dropboxFilesWrap').style.display = 'block';
            if (typeof setDropboxMsg === 'function') setDropboxMsg(`Loaded ${res.files?.length || 0} item(s).`);
        } else {
            if (typeof setDropboxMsg === 'function') setDropboxMsg('Error loading files: ' + (res?.error || 'Unknown error'));
        }
    } catch (e) {
        if (typeof setDropboxMsg === 'function') setDropboxMsg('List error: ' + e.message);
    }
}

async function createDropboxDefaultFolders() {
    try {
        if (typeof setDropboxMsg === 'function') setDropboxMsg('Ensuring default folders...');
        const res = await window.electronAPI.createDropboxDefaultFolders();
        if (res?.success) {
            if (typeof setDropboxMsg === 'function') setDropboxMsg(res.created ? 'Folders created.' : 'Folders already existed.');
        } else {
            if (typeof setDropboxMsg === 'function') setDropboxMsg('Ensure folders failed: ' + (res?.error || 'Unknown error'));
        }
    } catch (e) {
        if (typeof setDropboxMsg === 'function') setDropboxMsg('Ensure folders error: ' + e.message);
    }
}

async function showDropboxSpace() {
    try {
        if (typeof setDropboxMsg === 'function') setDropboxMsg('Fetching space usage...');
        const res = await window.electronAPI.getDropboxSpace();
        if (res?.success) {
            const usedGB = (res.used / (1024 * 1024 * 1024)).toFixed(2);
            const totalGB = (res.allocated / (1024 * 1024 * 1024)).toFixed(2);
            if (typeof setDropboxMsg === 'function') setDropboxMsg(`Used ${usedGB} GB / ${totalGB} GB (${res.usedPercent}%).`);
        } else {
            if (typeof setDropboxMsg === 'function') setDropboxMsg('Space usage failed: ' + (res?.error || 'Unknown error'));
        }
    } catch (e) {
        if (typeof setDropboxMsg === 'function') setDropboxMsg('Space usage error: ' + e.message);
    }
}
function displayDropboxFiles(files) {
    const tbody = document.getElementById('dropboxFilesBody'); // <-- correct tbody ID
    if (!tbody) return;

    if (!files || files.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#64748b;">No files found</td></tr>';
        return;
    }

    tbody.innerHTML = files.map(f => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${f.name}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${f.path || '-'}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${f.type || '-'}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${f.modified ? new Date(f.modified).toLocaleString() : '-'}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right;">${typeof f.size === 'number' ? (f.size / 1024).toFixed(1) + ' KB' : '-'}</td>
    </tr>
  `).join('');
}

async function refreshDropboxFiles() {
    await listDropboxFiles();
}

// Live Syncing
async function saveDropboxMasterSettings() {
    try {
        const masterMode = !!document.getElementById('dropboxMasterMode')?.checked;
        const syncIntervalMinutes = Math.max(2, parseInt(document.getElementById('dropboxSyncInterval')?.value || '10', 10));

        // Persist new values
        const res = await window.electronAPI.updateDropboxConfig({ masterMode, syncIntervalMinutes });
        if (!res?.success) throw new Error(res?.error || 'Save failed');

        // Ask main to immediately (re)apply timers & do one reconcile
        await window.electronAPI.applyDropboxSyncConfig?.();

        showNotification('Dropbox sync settings saved', 'success');
        await loadDropboxSettings(); // refresh badges/values
        await refreshDropboxBadges();
    } catch (err) {
        showNotification('Error saving Dropbox sync settings: ' + err.message, 'error');
    }
}

async function dropboxSyncNowAction() {
    const btn = document.getElementById('syncNowBtn');
    const statusEl = document.getElementById('dropboxSyncStatus');
    try {
        if (btn) btn.disabled = true;
        if (statusEl) statusEl.textContent = 'Status: syncing…';

        const res = await window.electronAPI.dropboxSyncNow?.();
        if (res?.success) {
            const ts = new Date().toLocaleTimeString();
            if (statusEl) statusEl.textContent = `Last sync: ${ts}`;
            showNotification('Sync completed', 'success');
        } else {
            throw new Error(res?.error || 'Unknown error');
        }
    } catch (err) {
        showNotification('Sync failed: ' + err.message, 'error');
        if (statusEl) statusEl.textContent = 'Status: error';
    } finally {
        if (btn) btn.disabled = false;
    }
}

// Google sheets Functions
async function loadSheetsSettings() {
    try {
        const cfg = await window.electronAPI.getConfig();
        const s = cfg.googleSheets || {};

        setVal('sheetsSpreadsheetId', s.spreadsheetId || '');
        setVal('sheetsAttendanceSheet', s.attendanceSheet || 'Attendance');
        setVal('sheetsStudentsSheet', s.studentsSheet || 'Students');
        const autoEl = document.getElementById('sheetsAutoSync');
        if (autoEl) autoEl.checked = !!s.autoSync;

        // Status
        try {
            const st = await window.electronAPI.getSheetsSyncStatus?.();
            const statusEl = document.getElementById('sheetsSyncStatus');
            const lastEl = document.getElementById('sheetsLastSync');
            if (statusEl) statusEl.textContent = st?.running ? 'Status: Running' : 'Status: Idle';
            if (lastEl) lastEl.textContent = 'Last sync: ' + (st?.lastSyncAt ? new Date(st.lastSyncAt).toLocaleString() : '—');

            const badge = document.getElementById('sheetsStatus');
            if (badge) {
                const connected = !!(s.spreadsheetId);
                badge.textContent = connected ? 'Configured' : 'Disconnected';
                badge.className = 'badge ' + (connected ? 'success' : 'error');
            }
        } catch { }
    } catch (e) {
        showNotification('Error loading Sheets settings: ' + e.message, 'error');
    }
}

function extractSpreadsheetId(input) {
    // Accept a bare ID or a full Sheets URL
    if (!input) return '';
    const m = String(input).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    return m ? m[1] : input.trim();
}

async function saveSheetsSettings() {
    const rawId = document.getElementById('sheetsSpreadsheetId')?.value.trim();
    const payload = {
        spreadsheetId: extractSpreadsheetId(rawId),
        attendanceSheet: document.getElementById('sheetsAttendanceSheet')?.value.trim() || 'Attendance',
        studentsSheet: document.getElementById('sheetsStudentsSheet')?.value.trim() || 'Students',
        autoSync: !!document.getElementById('sheetsAutoSync')?.checked
    };
    try {
        const res = await window.electronAPI.updateSheetsConfig(payload);
        if (!res?.success) throw new Error(res?.error || 'Save failed');

        if (payload.autoSync) await window.electronAPI.enableAutoSync?.();
        else await window.electronAPI.disableAutoSync?.();

        showNotification('Google Sheets settings saved', 'success');
        await loadSheetsSettings();
    } catch (e) {
        showNotification('Error saving Sheets settings: ' + e.message, 'error');
    }
}

async function saveSheetsCredentials() {
    const txt = document.getElementById('gcpCredsText')?.value.trim();
    if (!txt) return showNotification('Paste Service Account JSON first', 'error');

    let creds;
    try { creds = JSON.parse(txt); }
    catch { return showNotification('Invalid JSON', 'error'); }

    try {
        const res = await window.electronAPI.saveGoogleCredentials(creds);
        if (!res?.success) throw new Error(res?.error || 'Save failed');
        showNotification('Credentials saved', 'success');
    } catch (e) {
        showNotification('Save credentials error: ' + e.message, 'error');
    }
}

async function testSheetsConnection() {
    try {
        const res = await window.electronAPI.testSheetsConnection();
        if (res?.success) {
            showNotification('Connected to Google Sheets', 'success');
            const badge = document.getElementById('sheetsStatus');
            if (badge) { badge.textContent = 'Connected'; badge.className = 'badge success'; }
        } else {
            throw new Error(res?.error || 'Test failed');
        }
    } catch (e) {
        showNotification('Test connection error: ' + e.message, 'error');
        const badge = document.getElementById('sheetsStatus');
        if (badge) { badge.textContent = 'Disconnected'; badge.className = 'badge error'; }
    }
}

async function sheetsSyncNow() {
    try {
        const res = await window.electronAPI.syncToSheets();
        if (!res?.success) throw new Error(res?.error || 'Sync failed');
        showNotification(`Synced ${res.recordsSynced} records to Google Sheets`, 'success');
        const lastEl = document.getElementById('sheetsLastSync');
        if (lastEl) lastEl.textContent = 'Last sync: ' + new Date().toLocaleString();
    } catch (e) {
        showNotification('Sync error: ' + e.message, 'error');
    }
}

async function sheetsSyncTodayOnly() {
    try {
        const res = await window.electronAPI.syncTodaysAttendance();
        if (!res?.success) throw new Error(res?.error || 'Sync failed');
        showNotification(`Synced ${res.recordsSynced} today’s records`, 'success');
        const lastEl = document.getElementById('sheetsLastSync');
        if (lastEl) lastEl.textContent = 'Last sync: ' + new Date().toLocaleString();
    } catch (e) {
        showNotification('Sync today error: ' + e.message, 'error');
    }
}

// Encryption Functions
async function loadEncryptionSettings() {
    try {
        const result = await window.electronAPI.getEncryptionStatus();
        if (result.success) {
            const enabled = result.enabled;
            const statusElement = document.getElementById('encryptionStatus');

            if (enabled) {
                statusElement.textContent = `Enabled (${result.algorithm})`;
                statusElement.className = 'badge success';
                document.getElementById('encryptionDisabled').style.display = 'none';
                document.getElementById('encryptionEnabled').style.display = 'block';
            } else {
                statusElement.textContent = 'Disabled';
                statusElement.className = 'badge error';
                document.getElementById('encryptionDisabled').style.display = 'block';
                document.getElementById('encryptionEnabled').style.display = 'none';
            }
        }
    } catch (error) {
        console.error('Error loading encryption settings:', error);
    }
}

async function enableEncryption() {
    const password = document.getElementById('encryptionPassword').value;
    const confirmPassword = document.getElementById('confirmEncryptionPassword').value;

    if (!password || password.length < 8) {
        showNotification('Password must be at least 8 characters long', 'error');
        return;
    }

    if (password !== confirmPassword) {
        showNotification('Passwords do not match', 'error');
        return;
    }

    if (!confirm('Are you sure you want to enable encryption? Make sure to remember your password as it cannot be recovered.')) {
        return;
    }

    try {
        showNotification('Enabling encryption...', 'info');
        const result = await window.electronAPI.enableEncryption(password);
        if (result.success) {
            showNotification('Encryption enabled successfully!', 'success');
            document.getElementById('encryptionPassword').value = '';
            document.getElementById('confirmEncryptionPassword').value = '';
            await loadEncryptionSettings();
        } else {
            showNotification('Error enabling encryption: ' + result.error, 'error');
        }
    } catch (error) {
        showNotification('Encryption error: ' + error.message, 'error');
    }
}

async function disableEncryption() {
    const password = document.getElementById('currentEncryptionPassword').value;

    if (!password) {
        showNotification('Please enter current encryption password', 'error');
        return;
    }

    if (!confirm('Are you sure you want to disable encryption? This will decrypt all your data.')) {
        return;
    }

    try {
        showNotification('Disabling encryption...', 'info');
        const result = await window.electronAPI.disableEncryption(password);
        if (result.success) {
            showNotification('Encryption disabled successfully!', 'success');
            document.getElementById('currentEncryptionPassword').value = '';
            await loadEncryptionSettings();
        } else {
            showNotification('Error disabling encryption: ' + result.error, 'error');
        }
    } catch (error) {
        showNotification('Encryption error: ' + error.message, 'error');
    }
}

async function testEncryptionPassword() {
    const password = document.getElementById('currentEncryptionPassword').value;

    if (!password) {
        showNotification('Please enter password to test', 'error');
        return;
    }

    try {
        const result = await window.electronAPI.verifyEncryptionPassword(password);
        if (result.success && result.valid) {
            showNotification('Password is correct!', 'success');
        } else {
            showNotification('Invalid password', 'error');
        }
    } catch (error) {
        showNotification('Error verifying password: ' + error.message, 'error');
    }
}

async function createEncryptedBackup() {
    const password = document.getElementById('currentEncryptionPassword').value;

    if (!password) {
        showNotification('Please enter encryption password', 'error');
        return;
    }

    try {
        showNotification('Creating encrypted backup...', 'info');
        const result = await window.electronAPI.createEncryptedBackup(password);
        if (result.success) {
            showNotification('Encrypted backup created successfully!', 'success');
        } else {
            showNotification('Backup failed: ' + result.error, 'error');
        }
    } catch (error) {
        showNotification('Backup error: ' + error.message, 'error');
    }
}

// Modal Functions
function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.add('active');
        document.body.style.overflow = 'hidden';
    }
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.remove('active');
        document.body.style.overflow = 'auto';
        if (modalId === 'addStudentModal') {
            document.getElementById('addStudentForm').reset();
        }
    }
}

// Student Management Functions
async function addStudent() {
    const ufid = document.getElementById('modalUfid').value.trim();
    const name = document.getElementById('modalName').value.trim();
    const email = document.getElementById('modalEmail').value.trim();

    if (!ufid || !name) {
        showNotification('Please enter both UF ID and name', 'error');
        return;
    }

    if (!/^\d{8}$/.test(ufid)) {
        showNotification('UF ID must be exactly 8 digits', 'error');
        return;
    }

    try {
        const result = await window.electronAPI.addStudent({ ufid, name, email });
        if (result.success) {
            showNotification('Student added successfully!', 'success');
            closeModal('addStudentModal');
            await loadStudents();
            await loadDashboard();
        } else {
            showNotification('Error adding student: ' + result.error, 'error');
        }
    } catch (error) {
        showNotification('Error adding student: ' + error.message, 'error');
    }
}

async function deleteStudent(ufid) {
    if (confirm('Are you sure you want to remove this student? This action cannot be undone.')) {
        try {
            const result = await window.electronAPI.removeStudent(ufid);
            if (result.success) {
                showNotification('Student removed successfully!', 'success');
                await loadStudents();
                await loadDashboard();
            } else {
                showNotification('Error removing student: ' + result.error, 'error');
            }
        } catch (error) {
            showNotification('Error removing student: ' + error.message, 'error');
        }
    }
}

async function deleteRecord(recordId) {
    if (confirm('Are you sure you want to delete this attendance record?')) {
        try {
            const result = await window.electronAPI.deleteAttendanceRecord(recordId);
            if (result.success) {
                showNotification('Record deleted successfully!', 'success');
                await loadAttendance();
                await loadDashboard();
            } else {
                showNotification('Error deleting record: ' + result.error, 'error');
            }
        } catch (error) {
            showNotification('Error deleting record: ' + error.message, 'error');
        }
    }
}

// Export Functions
async function exportData() {
    try {
        const result = await window.electronAPI.generateWeeklyReport();
        if (result.success && result.csvContent) {
            // Download to the user's default Downloads folder
            const blob = new Blob([result.csvContent], { type: 'text/csv' });
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            const today = new Date().toISOString().split('T')[0];
            a.href = url;
            a.download = `weekly-report-${today}.csv`;
            a.click();
            window.URL.revokeObjectURL(url);

            showNotification('Weekly report saved to Downloads!', 'success');
        } else {
            showNotification('Export failed: ' + (result.error || 'No CSV content'), 'error');
        }
    } catch (error) {
        showNotification('Export error: ' + error.message, 'error');
    }
}

async function exportStudents() {
    try {
        const students = await window.electronAPI.getStudents();
        const csvContent = 'UF_ID,Name,Email,Status,Added_Date\n' +
            students.map(student =>
                `${student.ufid},${student.name},${student.email || ''},${student.active ? 'Active' : 'Inactive'},${student.addedDate || ''}`
            ).join('\n');

        const blob = new Blob([csvContent], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `students-export-${new Date().toISOString().split('T')[0]}.csv`;
        a.click();
        window.URL.revokeObjectURL(url);

        showNotification('Students exported successfully!', 'success');
    } catch (error) {
        showNotification('Export error: ' + error.message, 'error');
    }
}

// Cloud and Sync Functions
async function syncToSheets() {
    try {
        showNotification('Syncing to Google Sheets...', 'info');
        const result = await window.electronAPI.syncToSheets();
        if (result.success) {
            showNotification(`Synced ${result.recordsSynced} records to Google Sheets!`, 'success');
        } else {
            showNotification('Sync failed: ' + result.error, 'error');
        }
    } catch (error) {
        showNotification('Sync error: ' + error.message, 'error');
    }
}

async function cloudBackup() {
    try {
        showNotification('Creating cloud backup...', 'info');
        const result = await window.electronAPI.uploadToDropbox('backup');
        if (result.success) {
            showNotification('Cloud backup completed successfully!', 'success');
        } else {
            showNotification('Backup failed: ' + result.error, 'error');
        }
    } catch (error) {
        showNotification('Backup error: ' + error.message, 'error');
    }
}

// Report Generation
async function generateWeeklyReport() {
    try {
        showNotification('Generating weekly report...', 'info');
        const result = await window.electronAPI.sendWeeklyReport();
        if (result.success) {
            showNotification('Weekly report generated and sent!', 'success');
        } else {
            showNotification('Report generation failed: ' + result.error, 'error');
        }
    } catch (error) {
        showNotification('Report error: ' + error.message, 'error');
    }
}

// Settings Functions
async function saveEmailSettings() {
    const emailConfig = {
        enabled: true,
        smtp: document.getElementById('smtpServer').value,
        email: document.getElementById('emailAddress').value,
        recipientEmail: document.getElementById('recipientEmail').value,
        password: document.getElementById('smtpPassword').value,
        port: 587,
        secure: false
    };

    try {
        const result = await window.electronAPI.updateEmailConfig(emailConfig);
        if (result.success) {
            showNotification('Email settings saved successfully!', 'success');
            await updateSettingsStatus();
        } else {
            showNotification('Error saving settings: ' + result.error, 'error');
        }
    } catch (error) {
        showNotification('Error saving settings: ' + error.message, 'error');
    }
}

async function testEmail() {
    try {
        showNotification('Sending test email...', 'info');
        const emailConfig = {
            smtp: document.getElementById('smtpServer').value,
            email: document.getElementById('emailAddress').value,
            recipientEmail: document.getElementById('recipientEmail').value,
            password: document.getElementById('smtpPassword').value,
            port: 587,
            secure: false
        };

        const result = await window.electronAPI.testEmailConfig(emailConfig);
        if (result.success) {
            showNotification('Test email sent successfully!', 'success');
        } else {
            showNotification('Test email failed: ' + result.error, 'error');
        }
    } catch (error) {
        showNotification('Test email error: ' + error.message, 'error');
    }
}

async function sendWeeklyReportNow() {
    try {
        let bandsImageDataUrl = null;

        const canvas = document.getElementById('timeBandsChart');
        if (canvas && typeof canvas.toDataURL === 'function') {
            // Grab current Time Bands scatter as PNG
            bandsImageDataUrl = canvas.toDataURL('image/png');
        }

        showNotification('Sending weekly report...', 'info');
        const result = await window.electronAPI.sendWeeklyReport(bandsImageDataUrl);

        if (result.success) {
            showNotification('Weekly report generated and sent!', 'success');
        } else {
            showNotification('Report email failed: ' + result.error, 'error');
        }
    } catch (error) {
        showNotification('Test email error: ' + error.message, 'error');
    }
}

async function saveSystemSettings() {
    try {
        const labName = document.getElementById('labName').value;
        const result = await window.electronAPI.updateEmailConfig({
            labName: labName
        });

        if (result.success) {
            showNotification('System settings saved successfully!', 'success');
        } else {
            showNotification('Error saving settings: ' + result.error, 'error');
        }
    } catch (error) {
        showNotification('Error saving settings: ' + error.message, 'error');
    }
}

async function changePassword() {
    const newPassword = document.getElementById('newPassword').value;

    if (!newPassword || newPassword.length < 6) {
        showNotification('Password must be at least 6 characters long', 'error');
        return;
    }

    if (confirm('Are you sure you want to change the admin password?')) {
        try {
            const result = await window.electronAPI.changeAdminPassword(newPassword);
            if (result.success) {
                document.getElementById('newPassword').value = '';
                showNotification('Admin password changed successfully!', 'success');
            } else {
                showNotification('Error changing password: ' + result.error, 'error');
            }
        } catch (error) {
            showNotification('Error changing password: ' + error.message, 'error');
        }
    }
}

async function backupDataNow() {
    try {
        showNotification('Creating data backup...', 'info');
        const result = await window.electronAPI.backupData();
        if (result.success) {
            showNotification('Data backed up successfully!', 'success');
        } else {
            showNotification('Backup failed: ' + result.error, 'error');
        }
    } catch (error) {
        showNotification('Backup error: ' + error.message, 'error');
    }
}

// Scheduler Functions
async function startScheduler() {
    showNotification('Starting email scheduler...', 'info');
    try {
        const result = await window.electronAPI.startEmailScheduler();
        if (result.success) {
            showNotification('Email scheduler started successfully!', 'success');
            setTimeout(async () => {
                await updateSchedulerStatus();
            }, 1000);
        } else {
            showNotification('Error: ' + result.message, 'error');
        }
    } catch (error) {
        console.error('Error in startScheduler:', error);
        showNotification('Error starting scheduler: ' + error.message, 'error');
    }
}

async function stopScheduler() {
    showNotification('Stopping email scheduler...', 'info');
    try {
        const result = await window.electronAPI.stopEmailScheduler();
        if (result.success) {
            showNotification('Email scheduler stopped successfully!', 'success');
            setTimeout(async () => {
                await updateSchedulerStatus();
            }, 1000);
        } else {
            showNotification('Error: ' + result.message, 'error');
        }
    } catch (error) {
        console.error('Error in stopScheduler:', error);
        showNotification('Error stopping scheduler: ' + error.message, 'error');
    }
}

async function startTestScheduler() {
    showNotification('Starting test scheduler (will run in 10 seconds)...', 'info');
    try {
        const result = await window.electronAPI.startTestScheduler();
        if (result.success) {
            showNotification('Test scheduler started: ' + result.message, 'success');
        } else {
            showNotification('Test failed: ' + result.error, 'error');
        }
    } catch (error) {
        showNotification('Error starting test: ' + error.message, 'error');
    }
}

// Utility Functions
function showNotification(message, type = 'info') {
    const notification = document.getElementById('notification');
    notification.textContent = message;
    notification.className = `notification ${type}`;
    notification.classList.add('show');

    setTimeout(() => {
        notification.classList.remove('show');
    }, 4000);
}

function refreshActivity() {
    loadDashboard();
    showNotification('Activity refreshed', 'success');
}

function refreshLogs() {
    loadLogs();
    showNotification('Logs refreshed', 'success');
}

async function exportLogs() {
    try {
        const csvContent = 'Timestamp,Level,Category,Message,User\n' +
            logsData.map(log =>
                `"${log.timestamp}","${log.level}","${log.category}","${log.message}","${log.user}"`
            ).join('\n');

        const blob = new Blob([csvContent], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `system-logs-${new Date().toISOString().split('T')[0]}.csv`;
        a.click();
        window.URL.revokeObjectURL(url);

        showNotification('Logs exported successfully!', 'success');
    } catch (error) {
        showNotification('Export error: ' + error.message, 'error');
    }
}

async function clearLogs() {
    if (confirm('Are you sure you want to clear all system logs? This action cannot be undone.')) {
        try {
            const result = await window.electronAPI.clearSystemLogs();
            if (result && result.success) {
                showNotification('System logs cleared successfully!', 'success');
                await loadLogs();
            } else {
                showNotification('Error clearing logs', 'error');
            }
        } catch (error) {
            showNotification('Error clearing logs: ' + error.message, 'error');
        }
    }
}

// Search Functions
function setupGlobalSearch() {
    const searchInput = document.getElementById('globalSearch');
    if (searchInput) {
        searchInput.addEventListener('input', performGlobalSearch);
    }
}

async function performGlobalSearch() {
    const searchTerm = document.getElementById('globalSearch').value.toLowerCase();
    if (!searchTerm) return;

    if (currentSection === 'students') {
        const searchInput = document.getElementById('studentSearch');
        if (searchInput) {
            searchInput.value = searchTerm;
            filterStudents();
        }
    }
}

// UI Functions
function toggleSelectAll() {
    const selectAll = document.getElementById('selectAll');
    const checkboxes = document.querySelectorAll('.student-checkbox');
    checkboxes.forEach(checkbox => {
        checkbox.checked = selectAll.checked;
    });
}

function toggleDarkMode() {
    document.body.classList.toggle('dark-mode');
    showNotification('Dark mode toggled', 'info');
}

function showNotifications() {
    showNotification('No new notifications', 'info');
}

function goBack() {
    window.location.href = 'index.html';
}

async function changeChartPeriod(period) {
    if(period == "week"){
        dashboardChartDaysCount = 7;
        await loadDashboardCharts();
        showNotification(`Chart period changed to ${period}`, 'info');
    } else if (period == "month") {
        dashboardChartDaysCount = 30;
        await loadDashboardCharts();
        showNotification(`Chart period changed to ${period}`, 'info');
    } else {
       showNotification(`Invalid period ${period}`, 'error'); 
    }
}

function openAnalytics() {
    showSection('reports');
}

function editStudent(ufid) {
    showNotification('Edit student functionality coming soon', 'info');
}

// Initialization
document.addEventListener('DOMContentLoaded', function () {
    // Setup navigation
    document.querySelectorAll('.nav-item[data-section]').forEach(item => {
        item.addEventListener('click', function () {
            const section = this.getAttribute('data-section');
            showSection(section);
        });
    });

    // Setup forms
    const addStudentForm = document.getElementById('addStudentForm');
    if (addStudentForm) {
        addStudentForm.addEventListener('submit', function (e) {
            e.preventDefault();
            addStudent();
        });
    }

    // Setup search and filters
    setupStudentSearch();
    setupGlobalSearch();
    setupBulkImport();

    // Setup modal close on backdrop click
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', function (e) {
            if (e.target === modal) {
                closeModal(modal.id);
            }
        });
    });

    // Setup input validation
    const ufidInput = document.getElementById('modalUfid');
    if (ufidInput) {
        ufidInput.addEventListener('input', function () {
            this.value = this.value.replace(/\D/g, '').slice(0, 8);
        });
    }

    // Header buttons
    const notificationBtn = document.getElementById('notificationBtn');
    const darkModeBtn = document.getElementById('darkModeBtn');
    const backToAppBtn = document.getElementById('backToAppBtn');

    if (notificationBtn) {
        notificationBtn.addEventListener('click', showNotifications);
    }
    if (darkModeBtn) {
        darkModeBtn.addEventListener('click', toggleDarkMode);
    }
    if (backToAppBtn) {
        backToAppBtn.addEventListener('click', goBack);
    }

    // Dashboard buttons
    const addStudentBtn = document.getElementById('addStudentBtn');
    const addStudentBtn2 = document.getElementById('addStudentBtn2');
    const exportDataBtn = document.getElementById('exportDataBtn');
    const refreshActivityBtn = document.getElementById('refreshActivityBtn');
    const weekChartBtn = document.getElementById('weekChartBtn');
    const monthChartBtn = document.getElementById('monthChartBtn');

    if (addStudentBtn) {
        addStudentBtn.addEventListener('click', () => openModal('addStudentModal'));
    }
    if (addStudentBtn2) {
        addStudentBtn2.addEventListener('click', () => openModal('addStudentModal'));
    }
    if (exportDataBtn) {
        exportDataBtn.addEventListener('click', exportData);
    }
    if (refreshActivityBtn) {
        refreshActivityBtn.addEventListener('click', refreshActivity);
    }
    if (weekChartBtn) {
        weekChartBtn.addEventListener('click', () => changeChartPeriod('week'));
    }
    if (monthChartBtn) {
        monthChartBtn.addEventListener('click', () => changeChartPeriod('month'));
    }

    // Students page buttons
    const bulkImportBtn = document.getElementById('bulkImportBtn');
    const exportStudentsBtn = document.getElementById('exportStudentsBtn');
    const clearFiltersBtn = document.getElementById('clearFiltersBtn');
    const selectAllBtn = document.getElementById('selectAll');

    if (bulkImportBtn) {
        bulkImportBtn.addEventListener('click', () => openModal('bulkImportModal'));
    }
    if (exportStudentsBtn) {
        exportStudentsBtn.addEventListener('click', exportStudents);
    }
    if (clearFiltersBtn) {
        clearFiltersBtn.addEventListener('click', clearFilters);
    }
    if (selectAllBtn) {
        selectAllBtn.addEventListener('change', toggleSelectAll);
    }

    // Attendance page buttons
    const syncToSheetsBtn = document.getElementById('syncToSheetsBtn');
    const generateReportBtn = document.getElementById('generateReportBtn');
    const applyFiltersBtn = document.getElementById('applyFiltersBtn');
    const clearAttendanceFiltersBtn = document.getElementById('clearAttendanceFiltersBtn');

    if (syncToSheetsBtn) {
        syncToSheetsBtn.addEventListener('click', syncToSheets);
    }
    if (generateReportBtn) {
        generateReportBtn.addEventListener('click', exportData);
    }
    if (applyFiltersBtn) {
        applyFiltersBtn.addEventListener('click', applyAttendanceFilters);
    }
    if (clearAttendanceFiltersBtn) {
        clearAttendanceFiltersBtn.addEventListener('click', clearAttendanceFilters);
    }

    // Reports page buttons
    const generateWeeklyReportBtn = document.getElementById('generateWeeklyReportBtn');
    const cloudBackupBtn = document.getElementById('cloudBackupBtn');
    const openAnalyticsBtn = document.getElementById('openAnalyticsBtn');

    if (generateWeeklyReportBtn) {
        generateWeeklyReportBtn.addEventListener('click', generateWeeklyReport);
    }
    if (cloudBackupBtn) {
        cloudBackupBtn.addEventListener('click', cloudBackup);
    }
    if (openAnalyticsBtn) {
        openAnalyticsBtn.addEventListener('click', openAnalytics);
    }

    // Settings buttons - Email
    const saveEmailBtn = document.getElementById('saveEmailBtn');
    const testEmailBtn = document.getElementById('testEmailBtn');
    const sendReportBtn = document.getElementById('sendReportBtn');

    if (saveEmailBtn) {
        saveEmailBtn.addEventListener('click', saveEmailSettings);
    }
    if (testEmailBtn) {
        testEmailBtn.addEventListener('click', testEmail);
    }
    if (sendReportBtn) {
        sendReportBtn.addEventListener('click', sendWeeklyReportNow);
    }

    // Settings buttons - Dropbox
    const saveDropboxBtn = document.getElementById('saveDropboxBtn');
    const testDropboxBtn = document.getElementById('testDropboxBtn');
    const connectDropboxBtn = document.getElementById('connectDropboxBtn');
    const createDropboxFoldersBtn = document.getElementById('createDropboxFoldersBtn');
    const spaceDropboxBtn = document.getElementById('spaceDropboxBtn');
    const listDropboxBtn = document.getElementById('listDropboxBtn');
    const uploadReportDropboxBtn = document.getElementById('uploadReportDropboxBtn');
    const backupDropboxBtn = document.getElementById('backupDropboxBtn');
    const saveDropboxMasterBtn = document.getElementById('saveDropboxMasterBtn');
    const syncNowBtn = document.getElementById('syncNowBtn');

    if (saveDropboxBtn) saveDropboxBtn.addEventListener('click', (e) => { e.preventDefault(); saveDropboxSettings(); });
    if (testDropboxBtn) testDropboxBtn.addEventListener('click', (e) => { e.preventDefault(); testDropboxConnection(); });
    if (connectDropboxBtn) connectDropboxBtn.addEventListener('click', (e) => { e.preventDefault(); connectDropbox(); });
    if (createDropboxFoldersBtn) createDropboxFoldersBtn.addEventListener('click', (e) => { e.preventDefault(); createDropboxDefaultFolders(); });
    if (spaceDropboxBtn) spaceDropboxBtn.addEventListener('click', (e) => { e.preventDefault(); showDropboxSpace(); });
    if (listDropboxBtn) listDropboxBtn.addEventListener('click', (e) => { e.preventDefault(); listDropboxFiles(); });
    if (uploadReportDropboxBtn) uploadReportDropboxBtn.addEventListener('click', (e) => { e.preventDefault(); uploadToDropbox('report'); });
    if (backupDropboxBtn) backupDropboxBtn.addEventListener('click', (e) => { e.preventDefault(); uploadToDropbox('backup'); });
    if (saveDropboxMasterBtn) { saveDropboxMasterBtn.addEventListener('click', (e) => { e.preventDefault(); saveDropboxMasterSettings(); }); }
    if (syncNowBtn) { syncNowBtn.addEventListener('click', (e) => { e.preventDefault(); dropboxSyncNowAction(); }); }

    // Settings buttons – Google Sheets
    const sheetsSaveCredsBtn = document.getElementById('sheetsSaveCredsBtn');
    const sheetsTestBtn = document.getElementById('sheetsTestBtn');
    const sheetsSaveCfgBtn = document.getElementById('sheetsSaveCfgBtn');
    const sheetsSyncNowBtn = document.getElementById('sheetsSyncNowBtn');
    const sheetsEnableAutoBtn = document.getElementById('sheetsEnableAutoBtn');
    const sheetsDisableAutoBtn = document.getElementById('sheetsDisableAutoBtn');
    const sheetsSyncTodayBtn = document.getElementById('sheetsSyncTodayBtn');
    const btn = document.getElementById('rebuildSummaryBtn');
    const statusEl = document.getElementById('rebuildSummaryStatus');
    const startEl = document.getElementById('rebuildStart');
    const endEl = document.getElementById('rebuildEnd');
    const policyEl = document.getElementById('rebuildPolicy');

    btn?.addEventListener('click', async () => {
        try {
            btn.disabled = true;
            statusEl.textContent = 'Running…';

            // Collect optional range
            const startISO = startEl?.value ? new Date(startEl.value).toISOString() : undefined;
            const endISO = endEl?.value ? new Date(endEl.value).toISOString() : undefined;
            const policy = policyEl?.value || 'autosignout';

            const res = await window.electronAPI.backfillDailySummary({
                startISO, endISO, policy,
                summarySheetName: 'Daily Summary',
                colorAbsences: true,
            });

            if (res.success) {
                statusEl.className = 'badge success';
                statusEl.textContent = `Done: ${res.daysProcessed} day(s)`;
            } else {
                statusEl.className = 'badge warning';
                if (res.failures?.length) {
                    statusEl.textContent = `Partial: ${res.daysProcessed} processed, ${res.failures.length} failed`;
                    console.warn('Backfill failures:', res.failures);
                } else {
                    statusEl.textContent = `Failed`;
                }
            }
        } catch (e) {
            statusEl.className = 'badge error';
            statusEl.textContent = `Error: ${e.message}`;
            console.error(e);
        } finally {
            btn.disabled = false;
        }
    });

    if (sheetsSaveCredsBtn) sheetsSaveCredsBtn.addEventListener('click', saveSheetsCredentials);
    if (sheetsTestBtn) sheetsTestBtn.addEventListener('click', testSheetsConnection);
    if (sheetsSaveCfgBtn) sheetsSaveCfgBtn.addEventListener('click', saveSheetsSettings);
    if (sheetsSyncNowBtn) sheetsSyncNowBtn.addEventListener('click', sheetsSyncNow);
    if (sheetsEnableAutoBtn) sheetsEnableAutoBtn.addEventListener('click', async () => {
        const r = await window.electronAPI.enableAutoSync?.();
        showNotification(r?.success ? 'Auto sync enabled' : 'Enable auto sync failed', r?.success ? 'success' : 'error');
        loadSheetsSettings();
    });
    if (sheetsDisableAutoBtn) sheetsDisableAutoBtn.addEventListener('click', async () => {
        const r = await window.electronAPI.disableAutoSync?.();
        showNotification(r?.success ? 'Auto sync disabled' : 'Disable auto sync failed', r?.success ? 'success' : 'error');
        loadSheetsSettings();
    });
    if (sheetsSyncTodayBtn) sheetsSyncTodayBtn.addEventListener('click', sheetsSyncTodayOnly);


    // Settings buttons - Encryption
    const enableEncryptionBtn = document.getElementById('enableEncryptionBtn');
    const disableEncryptionBtn = document.getElementById('disableEncryptionBtn');
    const createEncryptedBackupBtn = document.getElementById('createEncryptedBackupBtn');
    const testEncryptionBtn = document.getElementById('testEncryptionBtn');

    if (enableEncryptionBtn) {
        enableEncryptionBtn.addEventListener('click', enableEncryption);
    }
    if (disableEncryptionBtn) {
        disableEncryptionBtn.addEventListener('click', disableEncryption);
    }
    if (createEncryptedBackupBtn) {
        createEncryptedBackupBtn.addEventListener('click', createEncryptedBackup);
    }
    if (testEncryptionBtn) {
        testEncryptionBtn.addEventListener('click', testEncryptionPassword);
    }

    // Settings buttons - System
    const saveSystemBtn = document.getElementById('saveSystemBtn');
    const changePasswordBtn = document.getElementById('changePasswordBtn');
    const backupDataBtn = document.getElementById('backupDataBtn');

    if (saveSystemBtn) {
        saveSystemBtn.addEventListener('click', saveSystemSettings);
    }
    if (changePasswordBtn) {
        changePasswordBtn.addEventListener('click', changePassword);
    }
    if (backupDataBtn) {
        backupDataBtn.addEventListener('click', backupDataNow);
    }

    // Scheduler buttons
    const startSchedulerBtn = document.getElementById('startSchedulerBtn');
    const stopSchedulerBtn = document.getElementById('stopSchedulerBtn');
    const testSchedulerBtn = document.getElementById('testSchedulerBtn');

    if (startSchedulerBtn) {
        startSchedulerBtn.addEventListener('click', startScheduler);
    }
    if (stopSchedulerBtn) {
        stopSchedulerBtn.addEventListener('click', stopScheduler);
    }
    if (testSchedulerBtn) {
        testSchedulerBtn.addEventListener('click', startTestScheduler);
    }

    // Logs buttons
    const refreshLogsBtn = document.getElementById('refreshLogsBtn');
    const exportLogsBtn = document.getElementById('exportLogsBtn');
    const clearLogsBtn = document.getElementById('clearLogsBtn');
    const filterLogsBtn = document.getElementById('filterLogsBtn');

    if (refreshLogsBtn) {
        refreshLogsBtn.addEventListener('click', refreshLogs);
    }
    if (exportLogsBtn) {
        exportLogsBtn.addEventListener('click', exportLogs);
    }
    if (clearLogsBtn) {
        clearLogsBtn.addEventListener('click', clearLogs);
    }
    if (filterLogsBtn) {
        filterLogsBtn.addEventListener('click', filterLogs);
    }

    // Modal buttons
    const closeAddStudentModal = document.getElementById('closeAddStudentModal');
    const cancelAddStudentBtn = document.getElementById('cancelAddStudentBtn');
    const closeBulkImportModal = document.getElementById('closeBulkImportModal');
    const cancelBulkImportBtn = document.getElementById('cancelBulkImportBtn');
    const importStudentsBtn = document.getElementById('importStudentsBtn');
    const closeDropboxFilesModal = document.getElementById('closeDropboxFilesModal');
    const refreshDropboxFilesBtn = document.getElementById('refreshDropboxFilesBtn');

    if (closeAddStudentModal) {
        closeAddStudentModal.addEventListener('click', () => closeModal('addStudentModal'));
    }
    if (cancelAddStudentBtn) {
        cancelAddStudentBtn.addEventListener('click', () => closeModal('addStudentModal'));
    }
    if (closeBulkImportModal) {
        closeBulkImportModal.addEventListener('click', () => closeModal('bulkImportModal'));
    }
    if (cancelBulkImportBtn) {
        cancelBulkImportBtn.addEventListener('click', () => closeModal('bulkImportModal'));
    }
    if (importStudentsBtn) {
        importStudentsBtn.addEventListener('click', importStudents);
    }
    if (closeDropboxFilesModal) {
        closeDropboxFilesModal.addEventListener('click', () => closeModal('dropboxFilesModal'));
    }
    if (refreshDropboxFilesBtn) {
        refreshDropboxFilesBtn.addEventListener('click', refreshDropboxFiles);
    }

    // Load initial data
    loadDashboard();
    refreshDropboxBadges();
});

// Wait for scripts to load before initializing charts
window.addEventListener('load', function () {
    // Chart.js should be loaded by now
    if (currentSection === 'dashboard') {
        setTimeout(() => {
            loadDashboardCharts();
        }, 500);
    }
});

// Auto-refresh data every 30 seconds
setInterval(() => {
    if (currentSection === 'dashboard') {
        loadDashboard();
    }
}, 30000);

// Export functions for potential use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        showSection,
        loadDashboard,
        loadStudents,
        addStudent,
        deleteStudent,
        showNotification
    };
}
