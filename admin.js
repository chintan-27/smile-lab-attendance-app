let currentTab = 'students';

async function loadStudents() {
    const students = await window.electronAPI.getStudents();
    const studentList = document.getElementById('studentList');
    
    if (students.length === 0) {
        studentList.innerHTML = '<p style="text-align: center; color: #718096; padding: 2rem;">No students added yet</p>';
        return;
    }
    
    studentList.innerHTML = students.map(student => `
        <div class="student-item">
            <div class="student-info">
                <strong>${student.name}</strong><br>
                <small>ID: ${student.ufid} ${student.email ? `• ${student.email}` : ''}</small>
            </div>
            <button class="btn btn-danger remove-btn" data-ufid="${student.ufid}">Remove</button>
        </div>
    `).join('');

    const removeButtons = document.querySelectorAll('.remove-btn');
    removeButtons.forEach(btn => {
        btn.addEventListener('click', function() {
            const ufid = this.getAttribute('data-ufid');
            removeStudent(ufid);
        });
    });
}

async function addStudent() {
    const ufid = document.getElementById('newUfid').value.trim();
    const name = document.getElementById('newName').value.trim();
    const email = document.getElementById('newEmail').value.trim();
    
    if (!ufid || !name) {
        showSettingsNotification('Please enter both UF ID and name', 'error');
        return;
    }
    
    if (!/^\d{8}$/.test(ufid)) {
        showSettingsNotification('UF ID must be exactly 8 digits', 'error');
        return;
    }
    
    const result = await window.electronAPI.addStudent({ ufid, name, email });
    
    if (result.success) {
        document.getElementById('newUfid').value = '';
        document.getElementById('newName').value = '';
        document.getElementById('newEmail').value = '';
        
        loadStudents();
        showSettingsNotification('Student added successfully!', 'success');
    } else {
        showSettingsNotification('Error adding student: ' + result.error, 'error');
    }
}

async function removeStudent(ufid) {
    if (confirm('Are you sure you want to remove this student?')) {
        const result = await window.electronAPI.removeStudent(ufid);
        if (result.success) {
            loadStudents();
            showSettingsNotification('Student removed successfully!', 'success');
        } else {
            showSettingsNotification('Error removing student: ' + result.error, 'error');
        }
    }
}

async function loadEnhancedStats() {
    const stats = await window.electronAPI.getEnhancedStats();
    const statsGrid = document.getElementById('statsGrid');
    
    statsGrid.innerHTML = `
        <div class="stat-card">
            <div class="stat-number">${stats.totalStudents}</div>
            <div>Total Students</div>
        </div>
        <div class="stat-card">
            <div class="stat-number">${stats.currentlySignedIn}</div>
            <div>Currently Signed In</div>
        </div>
        <div class="stat-card">
            <div class="stat-number">${stats.todaySignIns}</div>
            <div>Today's Sign-ins</div>
        </div>
        <div class="stat-card">
            <div class="stat-number">${stats.todaySignOuts}</div>
            <div>Today's Sign-outs</div>
        </div>
        <div class="stat-card">
            <div class="stat-number">${stats.todaysRecords}</div>
            <div>Today's Total Records</div>
        </div>
        <div class="stat-card">
            <div class="stat-number">${stats.totalRecords}</div>
            <div>All-Time Records</div>
        </div>
    `;

    if (stats.signedInStudents.length > 0) {
        const signedInHtml = `
            <div style="margin-top: 2rem;">
                <h4>Currently Signed In:</h4>
                <div style="background: white; padding: 1rem; border-radius: 8px; margin-top: 1rem;">
                    ${stats.signedInStudents.map(student => `
                        <div style="display: flex; justify-content: space-between; padding: 0.5rem; border-bottom: 1px solid #e2e8f0;">
                            <span><strong>${student.name}</strong> (${student.ufid})</span>
                            <small>Since: ${new Date(student.signInTime).toLocaleTimeString()}</small>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
        statsGrid.innerHTML += signedInHtml;
    }
}

async function loadReportsWithDeletion() {
    const todaysAttendance = await window.electronAPI.getTodaysAttendance();
    const reportsDiv = document.getElementById('attendanceReports');
    
    if (todaysAttendance.length === 0) {
        reportsDiv.innerHTML = '<p>No attendance records for today</p>';
        return;
    }
    
    const recent = todaysAttendance.reverse();
    reportsDiv.innerHTML = `
        <h4>Today's Activity (${todaysAttendance.length} records)</h4>
        <p style="color: #718096; margin-bottom: 1rem;">You can delete records if someone made a mistake</p>
        <div style="max-height: 400px; overflow-y: auto;">
            ${recent.map(record => `
                <div class="student-item">
                    <div>
                        <strong>${record.name}</strong> (${record.ufid})<br>
                        <small>${record.action} • ${new Date(record.timestamp).toLocaleString()}</small>
                    </div>
                    <button class="btn btn-danger delete-record-btn" data-record-id="${record.id}">Delete</button>
                </div>
            `).join('')}
        </div>
    `;

    const deleteButtons = document.querySelectorAll('.delete-record-btn');
    deleteButtons.forEach(btn => {
        btn.addEventListener('click', function() {
            const recordId = parseInt(this.getAttribute('data-record-id'));
            deleteAttendanceRecord(recordId);
        });
    });
}

async function deleteAttendanceRecord(recordId) {
    if (confirm('Are you sure you want to delete this attendance record? This action cannot be undone.')) {
        const result = await window.electronAPI.deleteAttendanceRecord(recordId);
        if (result.success) {
            loadReportsWithDeletion();
            showSettingsNotification('Record deleted successfully!', 'success');
        } else {
            showSettingsNotification('Error deleting record: ' + result.error, 'error');
        }
    }
}

async function loadSettings() {
    try {
        const config = await window.electronAPI.getConfig();
        
        const emailSettings = config.emailSettings || {};
        document.getElementById('emailEnabled').checked = emailSettings.enabled || false;
        document.getElementById('smtpServer').value = emailSettings.smtp || '';
        document.getElementById('smtpPort').value = emailSettings.port || 587;
        document.getElementById('senderEmail').value = emailSettings.email || '';
        document.getElementById('senderPassword').value = emailSettings.password || '';
        document.getElementById('recipientEmail').value = emailSettings.recipientEmail || '';
        document.getElementById('recipientName').value = emailSettings.recipientName || '';
        
        toggleEmailForm();
        
        const sheetsSettings = config.googleSheets || {};
        document.getElementById('sheetsEnabled').checked = sheetsSettings.enabled || false;
        document.getElementById('spreadsheetId').value = sheetsSettings.spreadsheetId || '';
        document.getElementById('sheetName').value = sheetsSettings.sheetName || 'Attendance';
        document.getElementById('autoSyncEnabled').checked = sheetsSettings.autoSync || false;
        
        toggleSheetsForm();
        
        document.getElementById('labName').value = config.labName || 'University of Florida Lab';
        
        await updateServiceStatus();
        await updateSchedulerStatus();
        
    } catch (error) {
        showSettingsNotification('Error loading settings: ' + error.message, 'error');
    }
}

function toggleEmailForm() {
    const enabled = document.getElementById('emailEnabled').checked;
    const form = document.getElementById('emailConfigForm');
    form.style.display = enabled ? 'block' : 'none';
    updateServiceStatus();
}

function toggleSheetsForm() {
    const enabled = document.getElementById('sheetsEnabled').checked;
    const form = document.getElementById('sheetsConfigForm');
    form.style.display = enabled ? 'block' : 'none';
    updateServiceStatus();
}

async function updateServiceStatus() {
    const emailEnabled = document.getElementById('emailEnabled').checked;
    const emailStatus = document.getElementById('emailStatus');
    const emailStatusText = document.getElementById('emailStatusText');
    
    if (emailEnabled) {
        emailStatus.className = 'status-indicator connected';
        emailStatusText.textContent = 'Configured';
    } else {
        emailStatus.className = 'status-indicator disconnected';
        emailStatusText.textContent = 'Disabled';
    }
    
    try {
        const sheetsStatus = await window.electronAPI.getSheetsSyncStatus();
        const sheetsIndicator = document.getElementById('sheetsStatus');
        const sheetsStatusText = document.getElementById('sheetsStatusText');
        
        if (sheetsStatus.enabled && sheetsStatus.hasCredentials) {
            sheetsIndicator.className = 'status-indicator connected';
            sheetsStatusText.textContent = 'Connected';
        } else if (sheetsStatus.enabled) {
            sheetsIndicator.className = 'status-indicator disconnected';
            sheetsStatusText.textContent = 'Missing Credentials';
        } else {
            sheetsIndicator.className = 'status-indicator disconnected';
            sheetsStatusText.textContent = 'Disabled';
        }
    } catch (error) {
        console.error('Error updating sheets status:', error);
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

function showSettingsNotification(message, type = 'info') {
    const notification = document.getElementById('settingsNotification');
    notification.textContent = message;
    notification.className = `notification ${type}`;
    notification.style.display = 'block';
    
    setTimeout(() => {
        notification.style.display = 'none';
    }, 5000);
}

async function saveEmailConfig() {
    const emailConfig = {
        enabled: document.getElementById('emailEnabled').checked,
        smtp: document.getElementById('smtpServer').value,
        port: parseInt(document.getElementById('smtpPort').value),
        secure: false,
        email: document.getElementById('senderEmail').value,
        password: document.getElementById('senderPassword').value,
        recipientEmail: document.getElementById('recipientEmail').value,
        recipientName: document.getElementById('recipientName').value
    };
    
    const result = await window.electronAPI.updateEmailConfig(emailConfig);
    
    if (result.success) {
        showSettingsNotification('Email configuration saved successfully!', 'success');
        await updateServiceStatus();
    } else {
        showSettingsNotification('Error saving email config: ' + result.error, 'error');
    }
}

async function testEmail() {
    const emailConfig = {
        smtp: document.getElementById('smtpServer').value,
        port: parseInt(document.getElementById('smtpPort').value),
        secure: false,
        email: document.getElementById('senderEmail').value,
        password: document.getElementById('senderPassword').value,
        recipientEmail: document.getElementById('recipientEmail').value,
        recipientName: document.getElementById('recipientName').value
    };
    
    showSettingsNotification('Sending test email...', 'info');
    
    const result = await window.electronAPI.testEmailConfig(emailConfig);
    
    if (result.success) {
        showSettingsNotification('Test email sent successfully! Check your inbox.', 'success');
    } else {
        showSettingsNotification('Test email failed: ' + result.error, 'error');
    }
}

async function sendWeeklyReportNow() {
    showSettingsNotification('Generating and sending weekly report...', 'info');
    
    const result = await window.electronAPI.sendWeeklyReport();
    
    if (result.success) {
        showSettingsNotification('Weekly report sent successfully!', 'success');
    } else {
        showSettingsNotification('Failed to send report: ' + result.error, 'error');
    }
}

async function saveSheetsConfig() {
    const sheetsConfig = {
        enabled: document.getElementById('sheetsEnabled').checked,
        spreadsheetId: document.getElementById('spreadsheetId').value,
        sheetName: document.getElementById('sheetName').value,
        autoSync: document.getElementById('autoSyncEnabled').checked
    };
    
    const result = await window.electronAPI.updateSheetsConfig(sheetsConfig);
    
    if (result.success) {
        showSettingsNotification('Google Sheets configuration saved successfully!', 'success');
        await updateServiceStatus();
    } else {
        showSettingsNotification('Error saving sheets config: ' + result.error, 'error');
    }
}

async function testSheetsConnection() {
    showSettingsNotification('Testing Google Sheets connection...', 'info');
    
    const result = await window.electronAPI.testSheetsConnection();
    
    if (result.success) {
        showSettingsNotification(`Connected successfully to: ${result.spreadsheetTitle}`, 'success');
    } else {
        showSettingsNotification('Connection failed: ' + result.error, 'error');
    }
}

async function syncAllData() {
    showSettingsNotification('Syncing all attendance data to Google Sheets...', 'info');
    
    const result = await window.electronAPI.syncToSheets();
    
    if (result.success) {
        showSettingsNotification(`Synced ${result.recordsSynced} records successfully!`, 'success');
    } else {
        showSettingsNotification('Sync failed: ' + result.error, 'error');
    }
}

async function syncTodaysData() {
    showSettingsNotification('Syncing today\'s attendance data...', 'info');
    
    const result = await window.electronAPI.syncTodaysAttendance();
    
    if (result.success) {
        showSettingsNotification('Today\'s data synced successfully!', 'success');
    } else {
        showSettingsNotification('Sync failed: ' + result.error, 'error');
    }
}

async function saveSystemSettings() {
    const labName = document.getElementById('labName').value;
    
    const result = await window.electronAPI.updateEmailConfig({
        labName: labName
    });
    
    if (result.success) {
        showSettingsNotification('System settings saved successfully!', 'success');
    } else {
        showSettingsNotification('Error saving settings: ' + result.error, 'error');
    }
}

async function changeAdminPassword() {
    const newPassword = document.getElementById('newAdminPassword').value;
    
    if (!newPassword || newPassword.length < 6) {
        showSettingsNotification('Password must be at least 6 characters long', 'error');
        return;
    }
    
    if (confirm('Are you sure you want to change the admin password?')) {
        const result = await window.electronAPI.changeAdminPassword(newPassword);
        
        if (result.success) {
            document.getElementById('newAdminPassword').value = '';
            showSettingsNotification('Admin password changed successfully!', 'success');
        } else {
            showSettingsNotification('Error changing password: ' + result.error, 'error');
        }
    }
}

async function backupDataNow() {
    showSettingsNotification('Creating data backup...', 'info');
    
    const result = await window.electronAPI.backupData();
    
    if (result.success) {
        showSettingsNotification('Data backed up successfully!', 'success');
    } else {
        showSettingsNotification('Backup failed: ' + result.error, 'error');
    }
}

async function startScheduler() {
    console.log('Admin: Starting scheduler...');
    showSettingsNotification('Starting email scheduler...', 'info');
    
    try {
        const result = await window.electronAPI.startEmailScheduler();
        console.log('Start scheduler result:', result);
        
        if (result.success) {
            showSettingsNotification('Email scheduler started successfully!', 'success');
            setTimeout(async () => {
                await updateSchedulerStatus();
            }, 1000);
        } else {
            showSettingsNotification('Error: ' + result.message, 'error');
        }
    } catch (error) {
        console.error('Error in startScheduler:', error);
        showSettingsNotification('Error starting scheduler: ' + error.message, 'error');
    }
}

async function stopScheduler() {
    console.log('Admin: Stopping scheduler...');
    showSettingsNotification('Stopping email scheduler...', 'info');
    
    try {
        const result = await window.electronAPI.stopEmailScheduler();
        console.log('Stop scheduler result:', result);
        
        if (result.success) {
            showSettingsNotification('Email scheduler stopped successfully!', 'success');
            setTimeout(async () => {
                await updateSchedulerStatus();
            }, 1000);
        } else {
            showSettingsNotification('Error: ' + result.message, 'error');
        }
    } catch (error) {
        console.error('Error in stopScheduler:', error);
        showSettingsNotification('Error stopping scheduler: ' + error.message, 'error');
    }
}

async function startTestScheduler() {
    showSettingsNotification('Starting test scheduler (will run in 10 seconds)...', 'info');
    
    try {
        const result = await window.electronAPI.startTestScheduler();
        
        if (result.success) {
            showSettingsNotification('Test scheduler started: ' + result.message, 'success');
        } else {
            showSettingsNotification('Test failed: ' + result.error, 'error');
        }
    } catch (error) {
        showSettingsNotification('Error starting test: ' + error.message, 'error');
    }
}

function handleCredentialsUpload() {
    const fileInput = document.getElementById('credentialsFile');
    const file = fileInput.files[0];
    
    if (file) {
        const reader = new FileReader();
        reader.onload = async function(e) {
            try {
                const credentials = JSON.parse(e.target.result);
                const result = await window.electronAPI.saveGoogleCredentials(credentials);
                
                if (result.success) {
                    document.getElementById('credentialsUploadText').textContent = 'Credentials uploaded successfully';
                    showSettingsNotification('Google credentials saved successfully!', 'success');
                    await updateServiceStatus();
                } else {
                    showSettingsNotification('Error saving credentials: ' + result.error, 'error');
                }
            } catch (error) {
                showSettingsNotification('Invalid JSON file: ' + error.message, 'error');
            }
        };
        reader.readAsText(file);
    }
}

function showTab(tabName) {
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.style.display = 'none';
    });
    
    document.querySelectorAll('.tab').forEach(tab => {
        tab.classList.remove('active');
    });
    
    document.getElementById(tabName + 'Tab').style.display = 'block';
    document.getElementById(tabName + 'TabBtn').classList.add('active');
    
    currentTab = tabName;
    
    if (tabName === 'students') {
        loadStudents();
    } else if (tabName === 'stats') {
        loadEnhancedStats();
    } else if (tabName === 'reports') {
        loadReportsWithDeletion();
    } else if (tabName === 'settings') {
        loadSettings();
    }
}

function goBack() {
    window.location.href = 'index.html';
}

document.addEventListener('DOMContentLoaded', function() {
    const studentsTabBtn = document.getElementById('studentsTabBtn');
    const statsTabBtn = document.getElementById('statsTabBtn');
    const reportsTabBtn = document.getElementById('reportsTabBtn');
    const settingsTabBtn = document.getElementById('settingsTabBtn');

    if (studentsTabBtn) {
        studentsTabBtn.addEventListener('click', () => showTab('students'));
    }
    if (statsTabBtn) {
        statsTabBtn.addEventListener('click', () => showTab('stats'));
    }
    if (reportsTabBtn) {
        reportsTabBtn.addEventListener('click', () => showTab('reports'));
    }
    if (settingsTabBtn) {
        settingsTabBtn.addEventListener('click', () => showTab('settings'));
    }

    const backBtn = document.getElementById('backBtn');
    if (backBtn) {
        backBtn.addEventListener('click', goBack);
    }

    const addStudentBtn = document.getElementById('addStudentBtn');
    if (addStudentBtn) {
        addStudentBtn.addEventListener('click', addStudent);
    }

    const newUfidInput = document.getElementById('newUfid');
    const newNameInput = document.getElementById('newName');
    const newEmailInput = document.getElementById('newEmail');

    [newUfidInput, newNameInput, newEmailInput].forEach(input => {
        if (input) {
            input.addEventListener('keypress', function(e) {
                if (e.key === 'Enter') {
                    addStudent();
                }
            });
        }
    });

    const emailEnabledToggle = document.getElementById('emailEnabled');
    const sheetsEnabledToggle = document.getElementById('sheetsEnabled');
    
    if (emailEnabledToggle) {
        emailEnabledToggle.addEventListener('change', toggleEmailForm);
    }
    if (sheetsEnabledToggle) {
        sheetsEnabledToggle.addEventListener('change', toggleSheetsForm);
    }

    const saveEmailConfigBtn = document.getElementById('saveEmailConfig');
    const testEmailBtn = document.getElementById('testEmail');
    const sendWeeklyReportBtn = document.getElementById('sendWeeklyReport');
    
    if (saveEmailConfigBtn) {
        saveEmailConfigBtn.addEventListener('click', saveEmailConfig);
    }
    if (testEmailBtn) {
        testEmailBtn.addEventListener('click', testEmail);
    }
    if (sendWeeklyReportBtn) {
        sendWeeklyReportBtn.addEventListener('click', sendWeeklyReportNow);
    }

    const saveSheetsConfigBtn = document.getElementById('saveSheetsConfig');
    const testSheetsConnectionBtn = document.getElementById('testSheetsConnection');
    const syncAllDataBtn = document.getElementById('syncAllData');
    const syncTodaysDataBtn = document.getElementById('syncTodaysData');
    
    if (saveSheetsConfigBtn) {
        saveSheetsConfigBtn.addEventListener('click', saveSheetsConfig);
    }
    if (testSheetsConnectionBtn) {
        testSheetsConnectionBtn.addEventListener('click', testSheetsConnection);
    }
    if (syncAllDataBtn) {
        syncAllDataBtn.addEventListener('click', syncAllData);
    }
    if (syncTodaysDataBtn) {
        syncTodaysDataBtn.addEventListener('click', syncTodaysData);
    }

    const saveSystemSettingsBtn = document.getElementById('saveSystemSettings');
    const changePasswordBtn = document.getElementById('changePassword');
    const backupDataBtn = document.getElementById('backupData');
    
    if (saveSystemSettingsBtn) {
        saveSystemSettingsBtn.addEventListener('click', saveSystemSettings);
    }
    if (changePasswordBtn) {
        changePasswordBtn.addEventListener('click', changeAdminPassword);
    }
    if (backupDataBtn) {
        backupDataBtn.addEventListener('click', backupDataNow);
    }

    const startSchedulerBtn = document.getElementById('startScheduler');
    const stopSchedulerBtn = document.getElementById('stopScheduler');
    const testSchedulerBtn = document.getElementById('testScheduler');
    
    if (startSchedulerBtn) {
        startSchedulerBtn.addEventListener('click', startScheduler);
    }
    if (stopSchedulerBtn) {
        stopSchedulerBtn.addEventListener('click', stopScheduler);
    }
    if (testSchedulerBtn) {
        testSchedulerBtn.addEventListener('click', startTestScheduler);
    }

    const credentialsFileInput = document.getElementById('credentialsFile');
    if (credentialsFileInput) {
        credentialsFileInput.addEventListener('change', handleCredentialsUpload);
    }

    const autoSyncToggle = document.getElementById('autoSyncEnabled');
    if (autoSyncToggle) {
        autoSyncToggle.addEventListener('change', async function() {
            if (this.checked) {
                await window.electronAPI.enableAutoSync();
                showSettingsNotification('Auto-sync enabled', 'success');
            } else {
                await window.electronAPI.disableAutoSync();
                showSettingsNotification('Auto-sync disabled', 'info');
            }
        });
    }

    loadStudents();
});

function validateEmail(email) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
}

function validateUFID(ufid) {
    return /^\d{8}$/.test(ufid);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        loadStudents,
        addStudent,
        removeStudent,
        loadSettings,
        saveEmailConfig,
        saveSheetsConfig
    };
}