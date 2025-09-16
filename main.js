const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const DataManager = require('./data.js')
const EmailService = require('./emailService.js')
const GoogleSheetsService = require('./googleSheetsService.js')

let mainWindow;
let dataManager;
let emailService;
let googleSheetsService;

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 500,
    height: 700,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false
    },
    show: false,
    titleBarStyle: 'default',
    resizable: true,
    minimizable: true,
    maximizable: true,
    closable: true
  })

  mainWindow.loadFile('index.html')
  
  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    if (message.includes('Autofill.enable') || message.includes('Autofill.setAddresses')) {
      return;
    }
    console.log(`Console [${level}]: ${message}`);
  });
}

if (process.platform === 'darwin') {
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
}

app.whenReady().then(() => {
  dataManager = new DataManager();
  emailService = new EmailService(dataManager);
  googleSheetsService = new GoogleSheetsService(dataManager);
  
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Attendance handlers
ipcMain.handle('sign-in', async (event, data) => {
  try {
    const result = dataManager.addAttendanceWithValidation(data.ufid, data.name, 'signin');
    if (result.success) {
      const config = dataManager.getConfig();
      if (config.googleSheets?.enabled && config.googleSheets?.autoSync) {
        await googleSheetsService.syncSingleRecord(result.record);
      }
      
      return { 
        success: true, 
        message: `Welcome ${result.studentName}! You have signed in successfully.`,
        studentName: result.studentName
      };
    } else {
      return { 
        success: false, 
        message: result.error,
        unauthorized: result.unauthorized,
        duplicate: result.duplicate,
        noSignIn: result.noSignIn
      };
    }
  } catch (error) {
    return { success: false, message: 'Error: ' + error.message };
  }
});

ipcMain.handle('sign-out', async (event, data) => {
  try {
    const result = dataManager.addAttendanceWithValidation(data.ufid, data.name, 'signout');
    if (result.success) {
      const config = dataManager.getConfig();
      if (config.googleSheets?.enabled && config.googleSheets?.autoSync) {
        await googleSheetsService.syncSingleRecord(result.record);
      }
      
      return { 
        success: true, 
        message: `Goodbye ${result.studentName}! You have signed out successfully.`,
        studentName: result.studentName
      };
    } else {
      return { 
        success: false, 
        message: result.error,
        unauthorized: result.unauthorized,
        duplicate: result.duplicate,
        noSignIn: result.noSignIn
      };
    }
  } catch (error) {
    return { success: false, message: 'Error: ' + error.message };
  }
});

ipcMain.handle('check-student', async (event, ufid) => {
  try {
    const student = dataManager.isStudentAuthorized(ufid);
    return student ? { authorized: true, name: student.name } : { authorized: false };
  } catch (error) {
    return { authorized: false, error: error.message };
  }
});

ipcMain.handle('get-student-status', async (event, ufid) => {
  try {
    const student = dataManager.isStudentAuthorized(ufid);
    if (!student) {
      return { authorized: false };
    }
    
    const status = dataManager.getCurrentStatus(ufid);
    return { 
      authorized: true, 
      name: student.name,
      status: status 
    };
  } catch (error) {
    return { authorized: false, error: error.message };
  }
});

// Admin handlers
ipcMain.handle('verify-admin', async (event, password) => {
  try {
    return dataManager.verifyAdmin(password);
  } catch (error) {
    console.error('Admin verification error:', error);
    return false;
  }
});

ipcMain.handle('change-admin-password', async (event, newPassword) => {
  try {
    return dataManager.changeAdminPassword(newPassword);
  } catch (error) {
    console.error('Change password error:', error);
    return { success: false, error: error.message };
  }
});

// Stats handlers
ipcMain.handle('get-stats', async (event) => {
  try {
    return dataManager.getStats();
  } catch (error) {
    console.error('Stats error:', error);
    return {};
  }
});

ipcMain.handle('get-enhanced-stats', async (event) => {
  try {
    return dataManager.getEnhancedStats();
  } catch (error) {
    console.error('Enhanced stats error:', error);
    return {};
  }
});

// Student management handlers
ipcMain.handle('get-students', async (event) => {
  try {
    return dataManager.getStudents();
  } catch (error) {
    console.error('Get students error:', error);
    return [];
  }
});

ipcMain.handle('add-student', async (event, student) => {
  try {
    return dataManager.addStudent(student.ufid, student.name, student.email);
  } catch (error) {
    console.error('Add student error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('remove-student', async (event, ufid) => {
  try {
    return dataManager.removeStudent(ufid);
  } catch (error) {
    console.error('Remove student error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-currently-signed-in', async (event) => {
  try {
    return dataManager.getCurrentlySignedIn();
  } catch (error) {
    console.error('Get currently signed in error:', error);
    return [];
  }
});

// Attendance and reports handlers
ipcMain.handle('get-attendance', async (event) => {
  try {
    return dataManager.getAttendance();
  } catch (error) {
    console.error('Get attendance error:', error);
    return [];
  }
});

ipcMain.handle('get-todays-attendance', async (event) => {
  try {
    return dataManager.getTodaysAttendance();
  } catch (error) {
    console.error('Get todays attendance error:', error);
    return [];
  }
});

ipcMain.handle('delete-attendance-record', async (event, recordId) => {
  try {
    return dataManager.deleteAttendanceRecord(recordId);
  } catch (error) {
    console.error('Delete record error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('generate-weekly-report', async (event) => {
  try {
    return dataManager.saveWeeklyReportToFile();
  } catch (error) {
    console.error('Generate report error:', error);
    return { success: false, error: error.message };
  }
});

// Email service handlers
ipcMain.handle('send-weekly-report', async (event) => {
  try {
    return await emailService.sendWeeklyReport();
  } catch (error) {
    console.error('Send weekly report error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('test-email-config', async (event, emailConfig) => {
  try {
    return await emailService.testEmailConfig(emailConfig);
  } catch (error) {
    console.error('Test email config error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('start-email-scheduler', async (event) => {
  try {
    console.log('IPC: Starting email scheduler...');
    const result = emailService.startScheduler();
    console.log('Scheduler start result:', result);
    return result;
  } catch (error) {
    console.error('Start scheduler error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('stop-email-scheduler', async (event) => {
  try {
    console.log('IPC: Stopping email scheduler...');
    const result = emailService.stopScheduler();
    console.log('Scheduler stop result:', result);
    return result;
  } catch (error) {
    console.error('Stop scheduler error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-scheduler-status', async (event) => {
  try {
    const status = emailService.getSchedulerStatus();
    console.log('Current scheduler status:', status);
    return status;
  } catch (error) {
    console.error('Get scheduler status error:', error);
    return { running: false, error: error.message };
  }
});

ipcMain.handle('start-test-scheduler', async (event) => {
  try {
    console.log('IPC: Starting test scheduler...');
    const result = emailService.startTestScheduler();
    console.log('Test scheduler result:', result);
    return result;
  } catch (error) {
    console.error('Test scheduler error:', error);
    return { success: false, error: error.message };
  }
});

// Google Sheets service handlers
ipcMain.handle('sync-to-sheets', async (event) => {
  try {
    return await googleSheetsService.syncAttendanceToSheets();
  } catch (error) {
    console.error('Sync to sheets error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('sync-todays-attendance', async (event) => {
  try {
    return await googleSheetsService.syncTodaysAttendance();
  } catch (error) {
    console.error('Sync todays attendance error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('test-sheets-connection', async (event) => {
  try {
    return await googleSheetsService.testConnection();
  } catch (error) {
    console.error('Test sheets connection error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('save-google-credentials', async (event, credentials) => {
  try {
    return googleSheetsService.saveCredentials(credentials);
  } catch (error) {
    console.error('Save credentials error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-sheets-sync-status', async (event) => {
  try {
    return googleSheetsService.getSyncStatus();
  } catch (error) {
    console.error('Get sync status error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('create-new-spreadsheet', async (event, title) => {
  try {
    return await googleSheetsService.createSpreadsheet(title);
  } catch (error) {
    console.error('Create spreadsheet error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('enable-auto-sync', async (event) => {
  try {
    return await googleSheetsService.enableAutoSync();
  } catch (error) {
    console.error('Enable auto sync error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('disable-auto-sync', async (event) => {
  try {
    return await googleSheetsService.disableAutoSync();
  } catch (error) {
    console.error('Disable auto sync error:', error);
    return { success: false, error: error.message };
  }
});

// Configuration handlers
ipcMain.handle('update-email-config', async (event, emailConfig) => {
  try {
    return dataManager.updateEmailConfig(emailConfig);
  } catch (error) {
    console.error('Update email config error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('update-sheets-config', async (event, sheetsConfig) => {
  try {
    return dataManager.updateSheetsConfig(sheetsConfig);
  } catch (error) {
    console.error('Update sheets config error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-config', async (event) => {
  try {
    return dataManager.getConfig();
  } catch (error) {
    console.error('Get config error:', error);
    return {};
  }
});

// Backup handlers
ipcMain.handle('backup-data', async (event) => {
  try {
    return dataManager.backupData();
  } catch (error) {
    console.error('Backup error:', error);
    return { success: false, error: error.message };
  }
});

// App lifecycle
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('web-contents-created', (event, contents) => {
  contents.on('console-message', (event, level, message) => {
    const harmlessMessages = [
      'Autofill.enable',
      'Autofill.setAddresses',
      'IMKCFRunLoopWakeUpReliable'
    ];
    
    if (!harmlessMessages.some(msg => message.includes(msg))) {
      console.log(`Console: ${message}`);
    }
  });
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

app.on('before-quit', () => {
  if (emailService) {
    emailService.stopScheduler();
  }
});

if (process.env.NODE_ENV === 'development') {
  app.on('ready', () => {
    console.log('Lab Attendance System started in development mode');
    console.log('Data directory:', path.join(__dirname, 'data'));
  });
}