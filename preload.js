const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // Attendance
  signIn: (data) => ipcRenderer.invoke('sign-in', data),
  signOut: (data) => ipcRenderer.invoke('sign-out', data),
  checkStudent: (ufid) => ipcRenderer.invoke('check-student', ufid),
  getStudentStatus: (ufid) => ipcRenderer.invoke('get-student-status', ufid),
  
  // Admin
  verifyAdmin: (password) => ipcRenderer.invoke('verify-admin', password),
  changeAdminPassword: (newPassword) => ipcRenderer.invoke('change-admin-password', newPassword),
  getStats: () => ipcRenderer.invoke('get-stats'),
  getEnhancedStats: () => ipcRenderer.invoke('get-enhanced-stats'),
  
  // Students
  getStudents: () => ipcRenderer.invoke('get-students'),
  addStudent: (student) => ipcRenderer.invoke('add-student', student),
  removeStudent: (ufid) => ipcRenderer.invoke('remove-student', ufid),
  getCurrentlySignedIn: () => ipcRenderer.invoke('get-currently-signed-in'),
  
  // Reports & Records
  getAttendance: () => ipcRenderer.invoke('get-attendance'),
  getTodaysAttendance: () => ipcRenderer.invoke('get-todays-attendance'),
  deleteAttendanceRecord: (recordId) => ipcRenderer.invoke('delete-attendance-record', recordId),
  generateWeeklyReport: () => ipcRenderer.invoke('generate-weekly-report'),
  
  // Email Service
  sendWeeklyReport: () => ipcRenderer.invoke('send-weekly-report'),
  testEmailConfig: (emailConfig) => ipcRenderer.invoke('test-email-config', emailConfig),
  startEmailScheduler: () => ipcRenderer.invoke('start-email-scheduler'),
  stopEmailScheduler: () => ipcRenderer.invoke('stop-email-scheduler'),
  getSchedulerStatus: () => ipcRenderer.invoke('get-scheduler-status'),
  startTestScheduler: () => ipcRenderer.invoke('start-test-scheduler'),
  
  // Google Sheets Service
  syncToSheets: () => ipcRenderer.invoke('sync-to-sheets'),
  syncTodaysAttendance: () => ipcRenderer.invoke('sync-todays-attendance'),
  testSheetsConnection: () => ipcRenderer.invoke('test-sheets-connection'),
  saveGoogleCredentials: (credentials) => ipcRenderer.invoke('save-google-credentials', credentials),
  getSheetsSyncStatus: () => ipcRenderer.invoke('get-sheets-sync-status'),
  createNewSpreadsheet: (title) => ipcRenderer.invoke('create-new-spreadsheet', title),
  enableAutoSync: () => ipcRenderer.invoke('enable-auto-sync'),
  disableAutoSync: () => ipcRenderer.invoke('disable-auto-sync'),
  
  // Configuration
  updateEmailConfig: (emailConfig) => ipcRenderer.invoke('update-email-config', emailConfig),
  updateSheetsConfig: (sheetsConfig) => ipcRenderer.invoke('update-sheets-config', sheetsConfig),
  getConfig: () => ipcRenderer.invoke('get-config'),
  
  // Backup
  backupData: () => ipcRenderer.invoke('backup-data')
})