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
  syncAdminToCloud: (password) => ipcRenderer.invoke('sync-admin-to-cloud', password),
  getStats: () => ipcRenderer.invoke('get-stats'),
  getEnhancedStats: () => ipcRenderer.invoke('get-enhanced-stats'),

  // Students
  getStudents: () => ipcRenderer.invoke('get-students'),
  getStudentsPaginated: (page, pageSize, filters) =>
    ipcRenderer.invoke('get-students-paginated', { page, pageSize, filters }),
  addStudent: (student) => ipcRenderer.invoke('add-student', student),
  updateStudent: (student) => ipcRenderer.invoke('update-student', student),
  removeStudent: (ufid) => ipcRenderer.invoke('remove-student', ufid),
  getCurrentlySignedIn: () => ipcRenderer.invoke('get-currently-signed-in'),

  // Reports & Records
  getAttendance: () => ipcRenderer.invoke('get-attendance'),
  getAttendancePaginated: (page, pageSize, filters) =>
    ipcRenderer.invoke('get-attendance-paginated', { page, pageSize, filters }),
  getStorageInfo: () => ipcRenderer.invoke('get-storage-info'),
  getTodaysAttendance: () => ipcRenderer.invoke('get-todays-attendance'),
  deleteAttendanceRecord: (recordId) => ipcRenderer.invoke('delete-attendance-record', recordId),
  generateWeeklyReport: () => ipcRenderer.invoke('generate-weekly-report'),

  // Email Service
  sendWeeklyReport: (bandsImageDataUrl) => ipcRenderer.invoke('send-weekly-report', bandsImageDataUrl),
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
  enableAutoSync: () => ipcRenderer.invoke('enable-auto-sync'),
  disableAutoSync: () => ipcRenderer.invoke('disable-auto-sync'),
  generateDailySummary: (dateISO, policy) => ipcRenderer.invoke('generate-daily-summary', dateISO, policy),
  getDailySummary: (dateLike, policy) => ipcRenderer.invoke('get-daily-summary', { dateLike, policy }),
  pushDailySummaryToSheets: (dateLike, summarySheetName) => ipcRenderer.invoke('push-daily-summary-to-sheets', { dateLike, summarySheetName }),
  backfillDailySummary: (opts) => ipcRenderer.invoke('sheets-backfill-daily-summary', opts),
  computeHoursWorkedToday: (dateLike) => ipcRenderer.invoke('compute-hours-worked-today', dateLike),

  // Dropbox Service
  dropboxOAuthConnect: () => ipcRenderer.invoke('dropbox-oauth-connect'),
  testDropboxConnection: () => ipcRenderer.invoke('test-dropbox-connection'),
  createDropboxDefaultFolders: () => ipcRenderer.invoke('create-dropbox-default-folders'),
  uploadToDropbox: (type) => ipcRenderer.invoke('upload-to-dropbox', type),
  getDropboxSpace: () => ipcRenderer.invoke('get-dropbox-space'),
  listDropboxFiles: (folder) => ipcRenderer.invoke('list-dropbox-files', folder),

  // Live Syncing
  dropboxSyncNow: () => ipcRenderer.invoke('dropbox-sync-now'),
  getDropboxSyncStatus: () => ipcRenderer.invoke('get-dropbox-sync-status'),
  applyDropboxSyncConfig: () => ipcRenderer.invoke('apply-dropbox-sync-config'),
  reloadSqliteFromJson: () => ipcRenderer.invoke('reload-sqlite-from-json'),

  // Encryption
  enableEncryption: (password) => ipcRenderer.invoke('enable-encryption', password),
  disableEncryption: (password) => ipcRenderer.invoke('disable-encryption', password),
  verifyEncryptionPassword: (password) => ipcRenderer.invoke('verify-encryption-password', password),
  createEncryptedBackup: (password) => ipcRenderer.invoke('create-encrypted-backup', password),
  getEncryptionStatus: () => ipcRenderer.invoke('get-encryption-status'),

  // Pending Sign-Outs
  getPendingSignouts: () => ipcRenderer.invoke('get-pending-signouts'),
  adminResolvePending: (id, signOutTime, presentOnly) => ipcRenderer.invoke('admin-resolve-pending', { id, signOutTime, presentOnly }),
  resendPendingEmail: (id) => ipcRenderer.invoke('resend-pending-email', id),
  getPendingServerStatus: () => ipcRenderer.invoke('get-pending-server-status'),
  triggerPendingProcessing: () => ipcRenderer.invoke('trigger-pending-processing'),
  getOpenSessions: () => ipcRenderer.invoke('get-open-sessions'),
  createPendingForStudent: (ufid, signInRecordId) => ipcRenderer.invoke('create-pending-for-student', { ufid, signInRecordId }),
  syncPendingFromCloud: () => ipcRenderer.invoke('sync-pending-from-cloud'),
  testPendingCron: () => ipcRenderer.invoke('test-pending-cron'),

  // Configuration
  updateEmailConfig: (emailConfig) => ipcRenderer.invoke('update-email-config', emailConfig),
  updateSheetsConfig: (sheetsConfig) => ipcRenderer.invoke('update-sheets-config', sheetsConfig),
  updateDropboxConfig: (config) => ipcRenderer.invoke('update-dropbox-config', config),
  updateWebSyncConfig: (config) => ipcRenderer.invoke('update-web-sync-config', config),
  getConfig: () => ipcRenderer.invoke('get-config'),

  // Web Dashboard Sync
  webSyncNow: () => ipcRenderer.invoke('web-sync-now'),
  testWebSyncConnection: () => ipcRenderer.invoke('test-web-sync-connection'),

  // System Logs
  getSystemLogs: (options) => ipcRenderer.invoke('get-system-logs', options),
  clearSystemLogs: () => ipcRenderer.invoke('clear-system-logs'),
  exportSystemLogs: (days) => ipcRenderer.invoke('export-system-logs', days),

  // Backup
  backupData: () => ipcRenderer.invoke('backup-data')
})