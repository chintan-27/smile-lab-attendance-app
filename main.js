const { app, BrowserWindow, ipcMain, screen, dialog } = require('electron')
const path = require('path')
const { autoUpdater } = require('electron-updater');

const DataManager = require('./data.js')
const EmailService = require('./emailService.js')
delete require.cache[require.resolve('./googleSheetsService.js')];
const GoogleSheetsService = require('./googleSheetsService.js');
const DropboxService = require('./dropboxService.js')
const PendingSignoutService = require('./pendingSignoutService.js')
const Logger = require('./logger.js')
const cron = require('node-cron')
const log = require('electron-log');
log.transports.file.level = 'info';

let mainWindow;
let dataManager;
let emailService;
let googleSheetsService;
let dropboxService;
let pendingSignoutService;

let syncTimer = null;
let syncing = false;

async function safeSyncByMode(tag) {
  if (syncing) return; // single-flight
  syncing = true;
  try {
    const cfg = dataManager.getConfig();
    const isMasterMode = !!cfg.dropbox?.masterMode;

    // Standard sync (pull or push based on mode)
    const res = await dropboxService.syncByMode(dataManager.dataDir);
    dataManager.logger.info('dropbox', `${tag}: ${JSON.stringify(res)}`, 'system');

    // After pull in master mode, handle SQLite reload from JSON
    if (isMasterMode && res.success) {
      // Check if any files were actually pulled
      const pulledFiles = res.results?.filter(r => r.action === 'pull') || [];

      if (pulledFiles.length > 0) {
        // Files were pulled from Dropbox - reload SQLite from the local JSON files
        dataManager.logger.info('dropbox', `${tag}: Pulled ${pulledFiles.length} files, reloading SQLite from JSON`, 'system');
        const reloadResult = await dataManager.reloadFromJson();
        if (reloadResult.success) {
          dataManager.logger.info('dropbox',
            `${tag}: Reloaded SQLite from JSON (${reloadResult.students} students, ${reloadResult.attendance} records)`, 'system');
        } else {
          dataManager.logger.warning('dropbox', `${tag}: Failed to reload SQLite from JSON: ${reloadResult.error}`, 'system');
        }
      } else {
        // No files pulled - check if Dropbox has SQLite we should download
        const formatInfo = await dropboxService.detectDropboxDataFormat();
        dataManager.logger.info('dropbox', `${tag}: No JSON pulled, Dropbox format: ${JSON.stringify(formatInfo)}`, 'system');

        if (formatInfo.hasSqlite) {
          // Dropbox has SQLite - download and replace local
          const sqliteDbPath = path.join(dataManager.dataDir, 'attendance.db');
          const dlResult = await dropboxService.downloadSqliteDb(sqliteDbPath);
          if (dlResult.success) {
            dataManager.logger.info('dropbox', `${tag}: Downloaded SQLite DB from Dropbox (${dlResult.size} bytes)`, 'system');
            // Re-initialize the database manager with the new file
            if (dataManager.dbManager) {
              await dataManager.dbManager.initialize();
              dataManager.logger.info('dropbox', `${tag}: Re-initialized SQLite from downloaded DB`, 'system');
            }
          } else {
            dataManager.logger.warning('dropbox', `${tag}: Failed to download SQLite: ${dlResult.error}`, 'system');
          }
        } else if (formatInfo.hasJson) {
          // Dropbox has JSON but pull didn't get it - try reloading from local JSON anyway
          dataManager.logger.info('dropbox', `${tag}: Attempting to reload SQLite from existing local JSON`, 'system');
          const reloadResult = await dataManager.reloadFromJson();
          if (reloadResult.success) {
            dataManager.logger.info('dropbox',
              `${tag}: Reloaded SQLite from JSON (${reloadResult.students} students, ${reloadResult.attendance} records)`, 'system');
          } else {
            dataManager.logger.warning('dropbox', `${tag}: Failed to reload SQLite from JSON: ${reloadResult.error}`, 'system');
          }
        }
      }
    }
  } catch (e) {
    dataManager.logger.error('dropbox', `${tag} failed: ${e.message}`, 'system');
  } finally {
    syncing = false;
  }
}

/**
 * Sync students and attendance data to the web dashboard
 */
async function syncToWebDashboard() {
  try {
    const config = dataManager.getConfig();
    const webSync = config.webSync || {};

    if (!webSync.enabled) {
      return { success: false, error: 'Web sync is not enabled' };
    }

    if (!webSync.apiUrl || !webSync.apiKey) {
      return { success: false, error: 'API URL and API Key are required' };
    }

    const fetch = require('node-fetch');
    const baseUrl = webSync.apiUrl.replace(/\/$/, ''); // Remove trailing slash

    // Get all students and attendance from the database
    const students = dataManager.getStudents();
    const attendance = dataManager.getAttendance();

    dataManager.logger.info('websync', `Syncing ${students.length} students and ${attendance.length} attendance records`, 'system');

    // Sync students
    const studentsRes = await fetch(`${baseUrl}/api/admin/data/sync/students`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': webSync.apiKey,
        'Cookie': `admin_token=${webSync.authToken || ''}`
      },
      body: JSON.stringify({ students })
    });

    if (!studentsRes.ok) {
      const text = await studentsRes.text();
      throw new Error(`Failed to sync students: ${studentsRes.status} - ${text}`);
    }

    // Sync attendance
    const attendanceRes = await fetch(`${baseUrl}/api/admin/data/sync/attendance`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': webSync.apiKey,
        'Cookie': `admin_token=${webSync.authToken || ''}`
      },
      body: JSON.stringify({ attendance })
    });

    if (!attendanceRes.ok) {
      const text = await attendanceRes.text();
      throw new Error(`Failed to sync attendance: ${attendanceRes.status} - ${text}`);
    }

    const studentsResult = await studentsRes.json();
    const attendanceResult = await attendanceRes.json();

    dataManager.logger.info('websync',
      `Web sync completed: ${studentsResult.count || students.length} students, ${attendanceResult.count || attendance.length} records`,
      'system');

    return {
      success: true,
      students: studentsResult.count || students.length,
      attendance: attendanceResult.count || attendance.length
    };
  } catch (error) {
    dataManager.logger.error('websync', `Web sync failed: ${error.message}`, 'system');
    return { success: false, error: error.message };
  }
}

function getNYDate(d = new Date()) {
  return new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
}
function ymd(date) {
  const d = getNYDate(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}
// Normalize a Date to local midnight (00:00:00.000)
function atMidnight(dt) {
  const d = new Date(dt);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Normalize a Date to America/New_York midnight (00:00 ET)
function atMidnightNY(dt) {
  const ny = new Date(new Date(dt).toLocaleString('en-US', { timeZone: 'America/New_York' }));
  ny.setHours(0, 0, 0, 0);
  return ny;
}

function initAutoUpdate() {
  // Log whether Electron thinks this is a packaged build
  const packaged = app.isPackaged;
  console.log('[updates] initAutoUpdate called, isPackaged =', packaged);
  log.info('[updates] initAutoUpdate called, isPackaged = ' + packaged);

  if (!packaged) {
    console.log('[updates] Skipping auto-update: not a packaged build');
    log.info('[updates] Skipping auto-update: not a packaged build');
    return;
  }

  // Let electron-updater log into the same file
  autoUpdater.logger = log;
  autoUpdater.logger.transports.file.level = 'info';

  // Make sure we’re not auto-downloading so we can offer Download/Later
  autoUpdater.autoDownload = false;

  // --- Event handlers so we SEE what’s happening ---

  autoUpdater.on('checking-for-update', () => {
    console.log('[updates] Checking for update…');
    log.info('[updates] Checking for update…');
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[updates] Update available:', info.version);
    log.info('[updates] Update available:', info.version);

    const choice = dialog.showMessageBoxSync({
      type: 'info',
      title: 'Update Available',
      message: `A new version (${info.version}) is available.`,
      detail: 'Do you want to download it now?',
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1
    });

    if (choice === 0) {
      console.log('[updates] User chose to download update');
      log.info('[updates] User chose to download update');
      autoUpdater.downloadUpdate();
    } else {
      console.log('[updates] User postponed download');
      log.info('[updates] User postponed download');
    }
  });

  autoUpdater.on('update-not-available', (info) => {
    console.log('[updates] No update available.', info && info.version);
    log.info('[updates] No update available.', info && info.version);

    // dialog.showMessageBox({
    //   type: 'info',
    //   title: 'No Updates',
    //   message: 'You are already on the latest version.'
    // });
  });

  autoUpdater.on('error', (err) => {
    const msg = err ? (err.stack || err.message || String(err)) : 'Unknown error';
    console.error('[updates] Error:', msg);
    log.error('[updates] Error:', msg);
    dialog.showErrorBox('Update Error', msg);
  });

  autoUpdater.on('download-progress', (p) => {
    console.log('[updates] Download progress:', p && p.percent);
    log.info('[updates] Download progress:', p && p.percent);
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[updates] Update downloaded:', info.version);
    log.info('[updates] Update downloaded:', info.version);

    const choice = dialog.showMessageBoxSync({
      type: 'info',
      title: 'Update Ready',
      message: `Version ${info.version} has been downloaded.`,
      detail: 'Restart the app now to install the update?',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1
    });

    if (choice === 0) {
      console.log('[updates] User chose to restart and install');
      log.info('[updates] User chose to restart and install');
      autoUpdater.quitAndInstall();
    } else {
      console.log('[updates] User postponed install');
      log.info('[updates] User postponed install');
    }
  });

  console.log('[updates] Calling checkForUpdates()…');
  log.info('[updates] Calling checkForUpdates()…');
  autoUpdater.checkForUpdates();
}


const createWindow = () => {
  const { height } = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: height,
    height: height,
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

  mainWindow.maximize();

  mainWindow.loadFile('index.html')

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    if (dataManager && dataManager.logger) {
      dataManager.logger.info('system', 'Main window displayed', 'system');
    }
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

app.whenReady().then(async () => {
  // Initialize services
  dataManager = new DataManager();
  await dataManager.initialize(); // Initialize SQLite asynchronously
  emailService = new EmailService(dataManager);
  googleSheetsService = new GoogleSheetsService(dataManager);
  dropboxService = new DropboxService(dataManager);
  pendingSignoutService = new PendingSignoutService(dataManager, emailService);

  if (!dataManager.logger) {
    dataManager.logger = new Logger(dataManager);
  }

  // Start the pending sign-out web server
  pendingSignoutService.startServer();

  // Log application startup
  dataManager.logger.info('system', 'Lab Attendance System starting up', 'system');
  dataManager.logger.info('system', 'All services initialized successfully', 'system');

  let backupJobStarted = false;
  let dailySummaryJobStarted = false;
  let dailySummaryRunning = false; // Lock to prevent concurrent runs

  function getNYDateIso(when = new Date()) {
    // Convert "now" to America/New_York calendar date (midnight) in ISO
    const ny = new Date(
      when.toLocaleString('en-US', { timeZone: 'America/New_York' })
    );
    ny.setHours(0, 0, 0, 0);
    return ny.toISOString();
  }
  // --- Catch up missed jobs at startup ---
  try {
    const fs = require('fs');
    const cfg = dataManager.getConfig();
    cfg.jobMeta = cfg.jobMeta || {};
    const saveCfg = () => fs.writeFileSync(dataManager.configFile, JSON.stringify(cfg, null, 2));

    // ===== Daily Summary Catch-up (only full past days) =====
    const todayNY = getNYDate();
    const yesterdayNY = addDays(todayNY, -1);
    const yesterdayYMD = ymd(yesterdayNY);

    // If never summarized, start two days ago so we pick up at least yesterday.
    let lastSummarized = cfg.jobMeta.lastDailySummaryDate || ymd(addDays(todayNY, -2));

    let cur = addDays(new Date(lastSummarized + 'T00:00:00'), 1);
    while (ymd(cur) <= yesterdayYMD) {
      const dateIso = new Date(ymd(cur) + 'T00:00:00Z').toISOString();

      // Choose ONE policy:
      // A) Cap open sessions at 5 PM (no mutation)
      const res = dataManager.saveDailySummaryCSV(dateIso, {
        closeOpenAtHour: null,
        autoWriteSignOutAtHour: 17
      });

      // // B) Or actually auto-signout at 5 PM (writes synthetic records)
      // const res = dataManager.saveDailySummaryCSV(dateIso, {
      //   closeOpenAtHour: null,
      //   autoWriteSignOutAtHour: 17
      // });

      if (res.success) {
        dataManager.logger.info('report', `Catch-up daily summary generated for ${ymd(cur)}: ${res.filePath}`, 'system');
        cfg.jobMeta.lastDailySummaryDate = ymd(cur);
        saveCfg();

        // Push the hours/A to the "Daily Summary" tab
        try {
          const { summaries } = dataManager.computeDailySummary(
            new Date(ymd(cur) + 'T00:00:00Z'),   // same day as CSV
            { closeOpenAtHour: 17, autoWriteSignOutAtHour: null }
          );
          if (cfg.googleSheets?.enabled) {
            await googleSheetsService.upsertDailyHours({
              dateLike: new Date(ymd(cur) + 'T00:00:00Z'),
              summaries,
              summarySheetName: 'Daily Summary'
            });
          }
        } catch (e) {
          dataManager.logger.warning('report', `Catch-up: upsertDailyHours failed for ${ymd(cur)}: ${e.message}`, 'system');
        }

        // Append that day's raw attendance rows to the main Attendance tab
        try {
          if (cfg.googleSheets?.enabled) {
            const r = await googleSheetsService.syncAttendanceForDate(new Date(ymd(cur) + 'T00:00:00Z'));
            if (!r.success) {
              dataManager.logger.warning('sync', `Catch-up: per-day Sheets sync failed for ${ymd(cur)}: ${r.error}`, 'system');
            }
          }
        } catch (e) {
          dataManager.logger.warning('sync', `Catch-up: per-day Sheets sync error for ${ymd(cur)}: ${e.message}`, 'system');
        }
      } else {
        // ...
      }


      cur = addDays(cur, 1);
    }

    // ===== Backup Catch-up (if >24h since last backup) =====
    const lastBackupAt = cfg.jobMeta.lastBackupAt ? new Date(cfg.jobMeta.lastBackupAt) : null;
    const hoursSince = lastBackupAt ? (Date.now() - lastBackupAt.getTime()) / 36e5 : Infinity;
    const dbx = cfg.dropbox || {};
    if (dbx.enabled && dbx.autoBackup && hoursSince > 24) {
      try {
        const r = await dropboxService.backupToDropbox();
        if (r.success) {
          cfg.jobMeta.lastBackupAt = new Date().toISOString();
          saveCfg();
          dataManager.logger.info('backup', 'Catch-up backup completed', 'system');
        } else {
          dataManager.logger.error('backup', `Catch-up backup failed: ${r.error}`, 'system');
        }
      } catch (e) {
        dataManager.logger.error('backup', `Catch-up backup error: ${e.message}`, 'system');
      }
    }
  } catch (e) {
    dataManager.logger.error('system', `Startup catch-up error: ${e.message}`, 'system');
  }

  // Schedule daily backup to Dropbox at 2 AM ET
  if (!backupJobStarted) {
    cron.schedule('0 2 * * *', async () => {
      try {
        dataManager.logger.info('backup', 'Starting scheduled daily backup to Dropbox', 'system');
        const config = dataManager.getConfig();
        if (config.dropbox?.enabled && config.dropbox?.autoBackup) {
          const result = await dropboxService.backupToDropbox();
          if (result.success) {
            dataManager.logger.info('backup', 'Daily backup completed successfully', 'system');
          } else {
            dataManager.logger.error('backup', `Daily backup failed: ${result.error}`, 'system');
          }
        } else {
          dataManager.logger.info('backup', 'Skipping daily backup - Dropbox not enabled or configured', 'system');
        }

        // Also sync to web dashboard if enabled
        if (config.webSync?.enabled) {
          dataManager.logger.info('websync', 'Starting scheduled web dashboard sync', 'system');
          const webResult = await syncToWebDashboard();
          if (webResult.success) {
            dataManager.logger.info('websync', `Web sync completed: ${webResult.students} students, ${webResult.attendance} records`, 'system');
          } else {
            dataManager.logger.error('websync', `Web sync failed: ${webResult.error}`, 'system');
          }
        }
      } catch (error) {
        dataManager.logger.error('backup', `Daily backup error: ${error.message}`, 'system');
      }
    }, { scheduled: true, timezone: 'America/New_York' });
    backupJobStarted = true;
  }

  // Real-time web dashboard sync every 10 minutes
  cron.schedule('*/10 * * * *', async () => {
    try {
      const config = dataManager.getConfig();
      if (config.webSync?.enabled) {
        dataManager.logger.info('websync', 'Starting 10-minute web dashboard sync', 'system');
        const result = await syncToWebDashboard();
        if (result.success) {
          dataManager.logger.info('websync', `Web sync completed: ${result.students} students, ${result.attendance} attendance records`, 'system');
        } else {
          dataManager.logger.error('websync', `Web sync failed: ${result.error}`, 'system');
        }
      }
    } catch (error) {
      dataManager.logger.error('websync', `10-minute web sync error: ${error.message}`, 'system');
    }
  });

  // Check for updates every day at 9 AM ET
  cron.schedule('0 9 * * *', () => {
    try {
      console.log('[updates] Scheduled 9 AM update check triggered');
      log.info('[updates] Scheduled 9 AM update check triggered');

      if (app.isPackaged) {
        autoUpdater.checkForUpdates();
      } else {
        console.log('[updates] Skipping scheduled update check (not packaged)');
      }
    } catch (e) {
      console.error('[updates] Scheduled update check error:', e);
      log.error('[updates] Scheduled update check error:', e.message);
    }
  }, { timezone: 'America/New_York' });

  // Daily summary at 11:45 PM ET - Now uses pending sign-out system
  if (!dailySummaryJobStarted) {
    cron.schedule('45 23 * * *', async () => {
      // Prevent concurrent runs
      if (dailySummaryRunning) {
        dataManager.logger.warning('pending', 'Daily summary job already running, skipping duplicate trigger', 'system');
        return;
      }
      dailySummaryRunning = true;

      try {
        // Use the ET calendar date for the summary
        const dateIso = getNYDateIso(new Date());

        // Get students with open sessions (signed in but not signed out)
        const openSessions = dataManager.getOpenSessionsForDate(dateIso);
        dataManager.logger.info('pending', `Found ${openSessions.length} open sessions at end of day`, 'system');

        // Track processed sign-in IDs to prevent duplicates within this run
        const processedSignInIds = new Set();

        // Process each open session
        for (const signInRecord of openSessions) {
          // Skip if already processed in this run (guard against duplicate entries)
          if (processedSignInIds.has(signInRecord.id)) {
            dataManager.logger.warning('pending',
              `Skipping duplicate sign-in record ${signInRecord.id} for ${signInRecord.name}`, 'system');
            continue;
          }
          processedSignInIds.add(signInRecord.id);

          const students = dataManager.getStudents();
          const student = students.find(s => s.ufid === signInRecord.ufid);

          if (student && student.email) {
            // Create pending sign-out and send email
            const pendingResult = await pendingSignoutService.createPendingSignout(student, signInRecord);
            if (pendingResult.success) {
              const emailStatus = pendingResult.emailSent ? `email sent to ${student.email}` : `email FAILED: ${pendingResult.emailError || 'unknown'}`;
              dataManager.logger.info('pending',
                `Pending sign-out created for ${student.name}, ${emailStatus}`, 'system');

              // Write a temporary "pending" signout record at the sign-in time
              // This marks them as signed out with 0 hours until they submit their actual time
              dataManager.addAttendanceRecord({
                id: Date.now() + Math.floor(Math.random() * 1000),
                ufid: signInRecord.ufid,
                name: signInRecord.name,
                action: 'signout',
                timestamp: signInRecord.timestamp, // Same as sign-in = 0 hours
                synthetic: true,
                pendingTimestamp: true, // Flag to indicate time is pending
                pendingRecordId: pendingResult.record.id
              });
              dataManager.logger.info('pending',
                `Temporary pending signout written for ${student.name} (0 hours until resolved)`, 'system');
            } else {
              dataManager.logger.warning('pending',
                `Failed to create pending for ${student.name}: ${pendingResult.error}`, 'system');
            }
          } else {
            // Fallback: No email - use existing auto-signout policy
            dataManager.logger.warning('pending',
              `Student ${signInRecord.name || signInRecord.ufid} has no email - using auto-signout`, 'system');

            // Apply the old auto-signout for students without email
            const signInTime = new Date(signInRecord.timestamp);
            const cutoffHour = 17; // 5 PM
            let effectiveOut;

            if (signInTime.getHours() < cutoffHour) {
              effectiveOut = new Date(signInTime);
              effectiveOut.setHours(cutoffHour, 0, 0, 0);
            } else {
              effectiveOut = new Date(signInTime.getTime() + 60 * 60 * 1000); // +60 min
              const eod = new Date(signInTime);
              eod.setHours(23, 59, 0, 0);
              if (effectiveOut > eod) effectiveOut = eod;
            }

            dataManager.addAttendanceRecord({
              id: Date.now(),
              ufid: signInRecord.ufid,
              name: signInRecord.name,
              action: 'signout',
              timestamp: effectiveOut.toISOString(),
              synthetic: true,
              autoSignout: true
            });
          }
        }

        // Generate daily summary for completed sessions (those with sign-outs)
        const res = dataManager.saveDailySummaryCSV(dateIso, {
          closeOpenAtHour: null,
          autoWriteSignOutAtHour: null,
          autoPolicy: null // Don't auto-signout - we handle it above
        });

        if (res.success) {
          dataManager.logger.info('report', `Daily attendance summary generated: ${res.filePath}`, 'system');
        } else {
          dataManager.logger.error('report', `Daily summary failed: ${res.error}`, 'system');
        }

        // Push to Google Sheets
        const { summaries } = dataManager.computeDailySummary(dateIso, {
          closeOpenAtHour: null,
          autoWriteSignOutAtHour: null,
          autoPolicy: null
        });
        await googleSheetsService.upsertDailyHours({ dateLike: dateIso, summaries, summarySheetName: 'Daily Summary' });

        // Sort attendance after any synthetic sign-outs were written
        const sr = dataManager.sortAttendanceByTimestamp?.();
        if (!sr?.success) {
          dataManager.logger.warning('attendance', `Post-summary sort failed: ${sr?.error || 'unknown'}`, 'system');
        }
      } catch (err) {
        dataManager.logger.error('report', `Daily summary job error: ${err.message}`, 'system');
      } finally {
        dailySummaryRunning = false;
      }
    }, { scheduled: true, timezone: 'America/New_York' });
    dailySummaryJobStarted = true;
  }

  // Process expired pending sign-outs at 5 PM ET (deadline)
  cron.schedule('0 17 * * *', async () => {
    try {
      dataManager.logger.info('pending', 'Processing expired pending sign-outs (5 PM deadline)', 'system');

      const result = await pendingSignoutService.processExpiredPending();

      if (result.expiredCount > 0) {
        dataManager.logger.info('pending',
          `Expired ${result.expiredCount} pending sign-outs (marked as 0 hours, present only)`, 'system');

        // Regenerate daily summaries for affected dates
        for (const dateStr of result.affectedDates) {
          const dateIso = new Date(dateStr + 'T00:00:00Z').toISOString();

          // Regenerate CSV
          dataManager.saveDailySummaryCSV(dateIso, {
            closeOpenAtHour: null,
            autoWriteSignOutAtHour: null,
            autoPolicy: null
          });

          // Update Google Sheets
          const config = dataManager.getConfig();
          if (config.googleSheets?.enabled) {
            const { summaries } = dataManager.computeDailySummary(dateIso, {
              closeOpenAtHour: null,
              autoWriteSignOutAtHour: null,
              autoPolicy: null
            });
            await googleSheetsService.upsertDailyHours({
              dateLike: dateIso,
              summaries,
              summarySheetName: 'Daily Summary'
            });
          }
        }
      } else {
        dataManager.logger.info('pending', 'No expired pending sign-outs to process', 'system');
      }
    } catch (err) {
      dataManager.logger.error('pending', `Expired pending processing error: ${err.message}`, 'system');
    }
  }, { scheduled: true, timezone: 'America/New_York' });

  // Hourly sync from cloud for pending signouts (12 AM to 5 PM ET)
  // This ensures student-submitted signout times are synced to attendance
  cron.schedule('0 0-17 * * *', async () => {
    try {
      dataManager.logger.info('pending', 'Hourly sync: checking for resolved pending signouts from cloud', 'system');
      const result = await pendingSignoutService.syncResolvedFromCloud();
      if (result.success) {
        dataManager.logger.info('pending', `Hourly sync completed: ${result.synced} records checked`, 'system');
      }
    } catch (err) {
      dataManager.logger.error('pending', `Hourly sync error: ${err.message}`, 'system');
    }
  }, { scheduled: true, timezone: 'America/New_York' });

  const cfg = dataManager.getConfig();
  if (cfg.dropbox?.enabled) {
    // One immediate sync respecting mode:
    // - masterMode true  => pull
    // - masterMode false => push
    await safeSyncByMode('startup-sync');

    // Periodic job (minutes, not seconds)
    const mins = Math.max(2, parseInt(cfg.dropbox.syncIntervalMinutes || 10, 10));
    syncTimer = setInterval(() => safeSyncByMode('interval-sync'), mins * 60 * 1000);
  }
  createWindow();
  initAutoUpdate();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      dataManager.logger.info('system', 'Creating new window on activate', 'system');
      createWindow();
    }
  })
})

app.on('before-quit', async () => {
  try {
    const cfg = dataManager.getConfig();
    // Push-on-close only makes sense when we're in push mode (masterMode=false)
    if (cfg.dropbox?.enabled && !cfg.dropbox?.masterMode) {
      await dropboxService.pushAll(dataManager.dataDir);
      dataManager.logger.info('dropbox', 'push-on-close completed', 'system');
    }
  } catch (err) {
    dataManager.logger.warning('dropbox', `push-on-close error: ${err.message}`, 'system');
  }
});


// Attendance handlers
ipcMain.handle('sign-in', async (event, data) => {
  try {
    dataManager.logger.info('attendance', `Sign-in attempt for UFID: ${data.ufid}`, 'system');

    const result = dataManager.addAttendanceWithValidation(data.ufid, data.name, 'signin');

    if (result.success) {
      dataManager.logger.info('attendance', `${result.studentName} (${data.ufid}) signed in successfully`, 'system');

      const config = dataManager.getConfig();
      if (config.googleSheets?.enabled && config.googleSheets?.autoSync) {
        try {
          await googleSheetsService.syncSingleRecord(result.record);
          dataManager.logger.info('sync', `Attendance synced to Google Sheets for ${result.studentName}`, 'system');
        } catch (syncError) {
          dataManager.logger.warning('sync', `Failed to sync to Google Sheets for ${result.studentName}: ${syncError.message}`, 'system');
        }
      }

      return {
        success: true,
        message: `Welcome ${result.studentName}! You have signed in successfully.`,
        studentName: result.studentName
      };
    } else {
      dataManager.logger.warning('attendance', `Failed sign-in for UFID ${data.ufid}: ${result.error}`, 'system');

      return {
        success: false,
        message: result.error,
        unauthorized: result.unauthorized,
        duplicate: result.duplicate,
        noSignIn: result.noSignIn
      };
    }
  } catch (error) {
    dataManager.logger.error('attendance', `Sign-in error for UFID ${data.ufid}: ${error.message}`, 'system');
    return { success: false, message: 'Error: ' + error.message };
  }
});

ipcMain.handle('sign-out', async (event, data) => {
  try {
    dataManager.logger.info('attendance', `Sign-out attempt for UFID: ${data.ufid}`, 'system');

    const result = dataManager.addAttendanceWithValidation(data.ufid, data.name, 'signout');

    if (result.success) {
      dataManager.logger.info('attendance', `${result.studentName} (${data.ufid}) signed out successfully`, 'system');

      const config = dataManager.getConfig();
      if (config.googleSheets?.enabled && config.googleSheets?.autoSync) {
        try {
          await googleSheetsService.syncSingleRecord(result.record);
          dataManager.logger.info('sync', `Attendance synced to Google Sheets for ${result.studentName}`, 'system');
        } catch (syncError) {
          dataManager.logger.warning('sync', `Failed to sync to Google Sheets for ${result.studentName}: ${syncError.message}`, 'system');
        }
      }

      return {
        success: true,
        message: `Goodbye ${result.studentName}! You have signed out successfully.`,
        studentName: result.studentName
      };
    } else {
      dataManager.logger.warning('attendance', `Failed sign-out for UFID ${data.ufid}: ${result.error}`, 'system');

      return {
        success: false,
        message: result.error,
        unauthorized: result.unauthorized,
        duplicate: result.duplicate,
        noSignIn: result.noSignIn
      };
    }
  } catch (error) {
    dataManager.logger.error('attendance', `Sign-out error for UFID ${data.ufid}: ${error.message}`, 'system');
    return { success: false, message: 'Error: ' + error.message };
  }
});

ipcMain.handle('check-student', async (event, ufid) => {
  try {
    const student = dataManager.isStudentAuthorized(ufid);
    const result = student ? { authorized: true, name: student.name } : { authorized: false };

    if (result.authorized) {
      dataManager.logger.info('auth', `Student check successful for UFID: ${ufid}`, 'system');
    } else {
      dataManager.logger.warning('auth', `Student check failed for UFID: ${ufid} - not authorized`, 'system');
    }

    return result;
  } catch (error) {
    dataManager.logger.error('auth', `Student check error for UFID ${ufid}: ${error.message}`, 'system');
    return { authorized: false, error: error.message };
  }
});

ipcMain.handle('get-student-status', async (event, ufid) => {
  try {
    const student = dataManager.isStudentAuthorized(ufid);
    if (!student) {
      dataManager.logger.warning('auth', `Status check failed for UFID: ${ufid} - not authorized`, 'system');
      return { authorized: false };
    }

    const status = dataManager.getCurrentStatus(ufid);
    dataManager.logger.info('auth', `Status check for ${student.name} (${ufid}): ${status}`, 'system');

    return {
      authorized: true,
      name: student.name,
      status: status
    };
  } catch (error) {
    dataManager.logger.error('auth', `Status check error for UFID ${ufid}: ${error.message}`, 'system');
    return { authorized: false, error: error.message };
  }
});

// Admin handlers
ipcMain.handle('verify-admin', async (event, password) => {
  try {
    dataManager.logger.info('auth', 'Admin login attempt', 'system');

    if (dataManager && dataManager.verifyAdmin) {
      const isValid = dataManager.verifyAdmin(password);

      if (isValid) {
        dataManager.logger.info('auth', 'Admin login successful', 'admin');
      } else {
        dataManager.logger.warning('auth', 'Failed admin login attempt - invalid password', 'system');
      }

      return { success: isValid };
    } else {
      dataManager.logger.error('auth', 'Admin verification failed - DataManager not initialized', 'system');
      return { success: false, error: 'DataManager not initialized' };
    }
  } catch (error) {
    dataManager.logger.error('auth', `Admin verification error: ${error.message}`, 'system');
    return { success: false, error: error.message };
  }
});

ipcMain.handle('change-admin-password', async (event, newPassword) => {
  try {
    dataManager.logger.info('admin', 'Admin password change attempt', 'admin');

    const result = dataManager.changeAdminPassword(newPassword);

    if (result.success) {
      dataManager.logger.info('admin', 'Admin password changed successfully', 'admin');
    } else {
      dataManager.logger.warning('admin', `Admin password change failed: ${result.error}`, 'admin');
    }

    return result;
  } catch (error) {
    dataManager.logger.error('admin', `Admin password change error: ${error.message}`, 'admin');
    return { success: false, error: error.message };
  }
});

// Sync admin credentials to cloud API
ipcMain.handle('sync-admin-to-cloud', async (event, password) => {
  try {
    dataManager.logger.info('admin', 'Syncing admin credentials to cloud', 'admin');
    const result = await dataManager.syncAdminToCloud(password);
    return result;
  } catch (error) {
    dataManager.logger.error('admin', `Admin credential sync error: ${error.message}`, 'admin');
    return { success: false, error: error.message };
  }
});

// Stats handlers
ipcMain.handle('get-stats', async (event) => {
  try {
    const stats = dataManager.getStats();
    dataManager.logger.info('system', 'Stats retrieved', 'admin');
    return stats;
  } catch (error) {
    dataManager.logger.error('system', `Stats retrieval error: ${error.message}`, 'admin');
    return {};
  }
});

ipcMain.handle('get-enhanced-stats', async (event) => {
  try {
    const stats = dataManager.getEnhancedStats();
    dataManager.logger.info('system', 'Enhanced stats retrieved', 'admin');
    return stats;
  } catch (error) {
    dataManager.logger.error('system', `Enhanced stats error: ${error.message}`, 'admin');
    return {};
  }
});

// Student management handlers
ipcMain.handle('get-students', async (event) => {
  try {
    const students = dataManager.getStudents();
    dataManager.logger.info('student', `Retrieved ${students.length} students`, 'admin');
    return students;
  } catch (error) {
    dataManager.logger.error('student', `Get students error: ${error.message}`, 'admin');
    return [];
  }
});

// Paginated students endpoint for admin UI
ipcMain.handle('get-students-paginated', async (event, { page, pageSize, filters }) => {
  try {
    const offset = (page - 1) * pageSize;
    const result = dataManager.getStudentsPaginated(offset, pageSize, filters);
    dataManager.logger.info('student', `Retrieved page ${page} of students (${result.students.length}/${result.totalCount})`, 'admin');
    return result;
  } catch (error) {
    dataManager.logger.error('student', `Get students paginated error: ${error.message}`, 'admin');
    return { students: [], totalCount: 0 };
  }
});

ipcMain.handle('add-student', async (event, student) => {
  try {
    dataManager.logger.info('student', `Adding new student: ${student.name} (${student.ufid})`, 'admin');
    const result = dataManager.addStudent(
      student.ufid,
      student.name,
      student.email,
      {
        role: student.role,
        expectedHoursPerWeek: student.expectedHoursPerWeek,
        expectedDaysPerWeek: student.expectedDaysPerWeek
      }
    );

    if (result.success) {
      dataManager.logger.info('student', `Student added successfully: ${student.name} (${student.ufid})`, 'admin');
    } else {
      dataManager.logger.warning('student', `Failed to add student ${student.ufid}: ${result.error}`, 'admin');
    }

    return result;
  } catch (error) {
    dataManager.logger.error('student', `Add student error for ${student.ufid}: ${error.message}`, 'admin');
    return { success: false, error: error.message };
  }
});
ipcMain.handle('update-student', async (event, payload) => {
  try {
    return dataManager.updateStudent(payload.ufid, payload);
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('remove-student', async (event, ufid) => {
  try {
    dataManager.logger.info('student', `Removing student with UFID: ${ufid}`, 'admin');

    const result = dataManager.removeStudent(ufid);

    if (result.success) {
      dataManager.logger.info('student', `Student removed successfully: ${ufid}`, 'admin');
    } else {
      dataManager.logger.warning('student', `Failed to remove student ${ufid}: ${result.error}`, 'admin');
    }

    return result;
  } catch (error) {
    dataManager.logger.error('student', `Remove student error for ${ufid}: ${error.message}`, 'admin');
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-currently-signed-in', async (event) => {
  try {
    const signedIn = dataManager.getCurrentlySignedIn();
    dataManager.logger.info('attendance', `Retrieved ${signedIn.length} currently signed-in students`, 'admin');
    return signedIn;
  } catch (error) {
    dataManager.logger.error('attendance', `Get currently signed in error: ${error.message}`, 'admin');
    return [];
  }
});

// Attendance and reports handlers
ipcMain.handle('get-attendance', async (event) => {
  try {
    const attendance = dataManager.getAttendance();
    dataManager.logger.info('attendance', `Retrieved ${attendance.length} attendance records`, 'admin');
    return attendance;
  } catch (error) {
    dataManager.logger.error('attendance', `Get attendance error: ${error.message}`, 'admin');
    return [];
  }
});

// Paginated attendance endpoint for admin UI
ipcMain.handle('get-attendance-paginated', async (event, { page, pageSize, filters }) => {
  try {
    const offset = (page - 1) * pageSize;
    const result = dataManager.getAttendancePaginated(offset, pageSize, filters);
    dataManager.logger.info('attendance', `Retrieved page ${page} of attendance (${result.records.length}/${result.totalCount})`, 'admin');
    return result;
  } catch (error) {
    dataManager.logger.error('attendance', `Get attendance paginated error: ${error.message}`, 'admin');
    return { records: [], totalCount: 0 };
  }
});

// Storage info endpoint
ipcMain.handle('get-storage-info', async (event) => {
  try {
    return dataManager.getStorageInfo();
  } catch (error) {
    dataManager.logger.error('system', `Get storage info error: ${error.message}`, 'system');
    return { mode: 'unknown', error: error.message };
  }
});

ipcMain.handle('get-todays-attendance', async (event) => {
  try {
    const todaysAttendance = dataManager.getTodaysAttendance();
    dataManager.logger.info('attendance', `Retrieved ${todaysAttendance.length} today's attendance records`, 'admin');
    return todaysAttendance;
  } catch (error) {
    dataManager.logger.error('attendance', `Get today's attendance error: ${error.message}`, 'admin');
    return [];
  }
});

ipcMain.handle('delete-attendance-record', async (event, recordId) => {
  try {
    dataManager.logger.info('attendance', `Deleting attendance record: ${recordId}`, 'admin');

    const result = dataManager.deleteAttendanceRecord(recordId);

    if (result.success) {
      dataManager.logger.info('attendance', `Attendance record deleted successfully: ${recordId}`, 'admin');
    } else {
      dataManager.logger.warning('attendance', `Failed to delete record ${recordId}: ${result.error}`, 'admin');
    }

    return result;
  } catch (error) {
    dataManager.logger.error('attendance', `Delete record error for ${recordId}: ${error.message}`, 'admin');
    return { success: false, error: error.message };
  }
});

ipcMain.handle('generate-weekly-report', async (event) => {
  try {
    dataManager.logger.info('report', 'Generating weekly report', 'admin');

    const result = dataManager.saveWeeklyReportToFile();

    if (result.success) {
      dataManager.logger.info('report', `Weekly report generated: ${result.filePath}`, 'admin');
    } else {
      dataManager.logger.error('report', `Weekly report generation failed: ${result.error}`, 'admin');
    }

    return result;
  } catch (error) {
    dataManager.logger.error('report', `Generate weekly report error: ${error.message}`, 'admin');
    return { success: false, error: error.message };
  }
});

// Email service handlers
ipcMain.handle('send-weekly-report', async (event, bandsImageDataUrl) => {
  try {
    dataManager.logger.info('email', 'Sending weekly report', 'admin');

    const result = await emailService.sendWeeklyReport(bandsImageDataUrl);

    if (result.success) {
      dataManager.logger.info('email', 'Weekly report sent successfully', 'admin');
    } else {
      dataManager.logger.error('email', `Weekly report send failed: ${result.error}`, 'admin');
    }

    return result;
  } catch (error) {
    dataManager.logger.error('email', `Send weekly report error: ${error.message}`, 'admin');
    return { success: false, error: error.message };
  }
});

ipcMain.handle('test-email-config', async (event, emailConfig) => {
  try {
    dataManager.logger.info('email', 'Testing email configuration', 'admin');

    const result = await emailService.testEmailConfig(emailConfig);

    if (result.success) {
      dataManager.logger.info('email', 'Email configuration test successful', 'admin');
    } else {
      dataManager.logger.warning('email', `Email configuration test failed: ${result.error}`, 'admin');
    }

    return result;
  } catch (error) {
    dataManager.logger.error('email', `Test email config error: ${error.message}`, 'admin');
    return { success: false, error: error.message };
  }
});

ipcMain.handle('start-email-scheduler', async (event) => {
  try {
    dataManager.logger.info('scheduler', 'Starting email scheduler', 'admin');

    const result = emailService.startScheduler();

    if (result.success) {
      dataManager.logger.info('scheduler', 'Email scheduler started successfully', 'admin');
    } else {
      dataManager.logger.error('scheduler', `Failed to start email scheduler: ${result.message}`, 'admin');
    }

    return result;
  } catch (error) {
    dataManager.logger.error('scheduler', `Start scheduler error: ${error.message}`, 'admin');
    return { success: false, error: error.message };
  }
});

ipcMain.handle('stop-email-scheduler', async (event) => {
  try {
    dataManager.logger.info('scheduler', 'Stopping email scheduler', 'admin');

    const result = emailService.stopScheduler();

    if (result.success) {
      dataManager.logger.info('scheduler', 'Email scheduler stopped successfully', 'admin');
    } else {
      dataManager.logger.error('scheduler', `Failed to stop email scheduler: ${result.message}`, 'admin');
    }

    return result;
  } catch (error) {
    dataManager.logger.error('scheduler', `Stop scheduler error: ${error.message}`, 'admin');
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-scheduler-status', async (event) => {
  try {
    const status = emailService.getSchedulerStatus();
    dataManager.logger.info('scheduler', `Scheduler status checked: ${status.running ? 'running' : 'stopped'}`, 'admin');
    return status;
  } catch (error) {
    dataManager.logger.error('scheduler', `Get scheduler status error: ${error.message}`, 'admin');
    return { running: false, error: error.message };
  }
});

ipcMain.handle('start-test-scheduler', async (event) => {
  try {
    dataManager.logger.info('scheduler', 'Starting test scheduler (10 seconds)', 'admin');

    const result = emailService.startTestScheduler();

    if (result.success) {
      dataManager.logger.info('scheduler', 'Test scheduler started successfully', 'admin');
    } else {
      dataManager.logger.error('scheduler', `Test scheduler failed: ${result.error}`, 'admin');
    }

    return result;
  } catch (error) {
    dataManager.logger.error('scheduler', `Test scheduler error: ${error.message}`, 'admin');
    return { success: false, error: error.message };
  }
});

// Pending Sign-Out handlers
ipcMain.handle('get-pending-signouts', async () => {
  try {
    const pending = await pendingSignoutService.getPendingSignouts();
    const stats = await pendingSignoutService.getPendingStats();
    return { success: true, pending, stats };
  } catch (error) {
    dataManager.logger.error('pending', `Get pending signouts error: ${error.message}`, 'admin');
    return { success: false, error: error.message };
  }
});

ipcMain.handle('admin-resolve-pending', async (event, { id, signOutTime, presentOnly }) => {
  try {
    dataManager.logger.info('pending', `Admin resolving pending ${id}`, 'admin');
    const result = await pendingSignoutService.adminResolvePending(id, signOutTime, presentOnly);

    if (result.success) {
      dataManager.logger.info('pending', `Admin resolved pending for ${result.record.name}`, 'admin');
    } else {
      dataManager.logger.error('pending', `Admin resolve failed: ${result.error}`, 'admin');
    }

    return result;
  } catch (error) {
    dataManager.logger.error('pending', `Admin resolve error: ${error.message}`, 'admin');
    return { success: false, error: error.message };
  }
});

ipcMain.handle('resend-pending-email', async (event, id) => {
  try {
    const pending = await pendingSignoutService.getPendingSignouts();
    const record = pending.find(p => p.id === id);

    if (!record) {
      return { success: false, error: 'Pending record not found' };
    }

    dataManager.logger.info('pending', `Resending pending email to ${record.email}`, 'admin');
    const result = await pendingSignoutService.sendPendingSignoutEmail(record);

    if (result.success) {
      dataManager.logger.info('pending', `Pending email resent to ${record.email}`, 'admin');
    }

    return result;
  } catch (error) {
    dataManager.logger.error('pending', `Resend pending email error: ${error.message}`, 'admin');
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-pending-server-status', async () => {
  try {
    return {
      success: true,
      running: pendingSignoutService.isServerRunning(),
      port: pendingSignoutService.port
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('sync-pending-from-cloud', async () => {
  try {
    dataManager.logger.info('pending', 'Manually syncing resolved records from cloud', 'admin');
    const result = await pendingSignoutService.syncResolvedFromCloud();
    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Get open sessions (students signed in but not signed out today)
ipcMain.handle('get-open-sessions', async () => {
  try {
    const today = new Date();
    const openSessions = dataManager.getOpenSessionsForDate(today);
    const students = dataManager.getStudents();

    // Enrich with student details
    const enrichedSessions = openSessions.map(session => {
      const student = students.find(s => s.ufid === session.ufid);
      return {
        ...session,
        email: student?.email || null,
        studentName: student?.name || session.name,
        hasEmail: !!student?.email
      };
    });

    return { success: true, sessions: enrichedSessions };
  } catch (error) {
    dataManager.logger.error('pending', `Get open sessions error: ${error.message}`, 'admin');
    return { success: false, error: error.message };
  }
});

// Create pending signout for a single student (for testing)
ipcMain.handle('create-pending-for-student', async (event, { ufid, signInRecordId }) => {
  try {
    const students = dataManager.getStudents();
    const student = students.find(s => s.ufid === ufid);

    if (!student) {
      return { success: false, error: 'Student not found' };
    }

    if (!student.email) {
      return { success: false, error: 'Student has no email address' };
    }

    // Find the sign-in record
    const today = new Date();
    const openSessions = dataManager.getOpenSessionsForDate(today);
    const signInRecord = openSessions.find(s => s.id === signInRecordId || s.ufid === ufid);

    if (!signInRecord) {
      return { success: false, error: 'Sign-in record not found' };
    }

    dataManager.logger.info('pending', `Manually creating pending for ${student.name}`, 'admin');

    // Create pending signout and send email
    const pendingResult = await pendingSignoutService.createPendingSignout(student, signInRecord);

    if (pendingResult.success) {
      // Write temporary signout record (same as cron does)
      dataManager.addAttendanceRecord({
        id: Date.now() + Math.floor(Math.random() * 1000),
        ufid: signInRecord.ufid,
        name: signInRecord.name,
        action: 'signout',
        timestamp: signInRecord.timestamp,
        synthetic: true,
        pendingTimestamp: true,
        pendingRecordId: pendingResult.record.id
      });

      if (pendingResult.emailSent) {
        dataManager.logger.info('pending',
          `Pending sign-out created for ${student.name}, email sent to ${student.email}`, 'admin');
      } else {
        dataManager.logger.warning('pending',
          `Pending sign-out created for ${student.name}, but email failed: ${pendingResult.emailError}`, 'admin');
      }

      return {
        success: true,
        record: pendingResult.record,
        emailSent: pendingResult.emailSent,
        emailError: pendingResult.emailError
      };
    } else {
      dataManager.logger.warning('pending',
        `Failed to create pending for ${student.name}: ${pendingResult.error}`, 'admin');
      return pendingResult;
    }
  } catch (error) {
    dataManager.logger.error('pending', `Create pending error: ${error.message}`, 'admin');
    return { success: false, error: error.message };
  }
});

ipcMain.handle('trigger-pending-processing', async () => {
  try {
    dataManager.logger.info('pending', 'Manually triggering pending sign-out processing', 'admin');

    // Get open sessions for today
    const today = new Date();
    const openSessions = dataManager.getOpenSessionsForDate(today);
    const students = dataManager.getStudents();

    let processed = 0;
    let emailsSent = 0;
    const errors = [];

    for (const signInRecord of openSessions) {
      const student = students.find(s => s.ufid === signInRecord.ufid);

      if (student && student.email) {
        const pendingResult = await pendingSignoutService.createPendingSignout(student, signInRecord);

        if (pendingResult.success) {
          processed++;

          // Write temporary signout record (same as cron does)
          dataManager.addAttendanceRecord({
            id: Date.now() + Math.floor(Math.random() * 1000),
            ufid: signInRecord.ufid,
            name: signInRecord.name,
            action: 'signout',
            timestamp: signInRecord.timestamp,
            synthetic: true,
            pendingTimestamp: true,
            pendingRecordId: pendingResult.record.id
          });

          if (pendingResult.emailSent) {
            dataManager.logger.info('pending',
              `Pending sign-out created for ${student.name}, email sent to ${student.email}`, 'admin');
            emailsSent++;
          } else {
            errors.push(`${student.name}: Email failed - ${pendingResult.emailError}`);
            dataManager.logger.warning('pending',
              `Pending sign-out created for ${student.name}, but email failed: ${pendingResult.emailError}`, 'admin');
          }
        } else {
          errors.push(`${student.name}: ${pendingResult.error}`);
          dataManager.logger.warning('pending',
            `Failed to create pending for ${student.name}: ${pendingResult.error}`, 'admin');
        }
      } else if (student && !student.email) {
        errors.push(`${student.name}: No email address`);
      }
    }

    return {
      success: true,
      processedCount: processed,
      emailsSent,
      openSessionsCount: openSessions.length,
      errors: errors.length > 0 ? errors : null
    };
  } catch (error) {
    dataManager.logger.error('pending', `Manual pending processing error: ${error.message}`, 'admin');
    return { success: false, error: error.message };
  }
});

// Google Sheets service handlers
ipcMain.handle('sync-to-sheets', async (event) => {
  try {
    dataManager.logger.info('sync', 'Starting sync to Google Sheets', 'admin');

    const result = await googleSheetsService.syncAttendanceToSheets();

    if (result.success) {
      dataManager.logger.info('sync', `Synced ${result.recordsSynced} records to Google Sheets`, 'admin');
    } else {
      dataManager.logger.error('sync', `Google Sheets sync failed: ${result.error}`, 'admin');
    }

    return result;
  } catch (error) {
    dataManager.logger.error('sync', `Sync to sheets error: ${error.message}`, 'admin');
    return { success: false, error: error.message };
  }
});

ipcMain.handle('sheets-backfill-daily-summary', async (event, args = {}) => {
  const {
    startISO,                // optional: ISO string
    endISO,                  // optional: ISO string
    policy = 'autosignout',          // 'cap' or 'autosignout'
    summarySheetName = 'Daily Summary',
    colorAbsences = true,
  } = args;

  try {
    // Default range: last 30 full days up to yesterday
    const today = new Date();
    const end = endISO ? new Date(endISO) : atMidnightNY(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1));
    const start = startISO ? new Date(startISO) : atMidnightNY(new Date(end.getFullYear(), end.getMonth(), end.getDate() - 29));

    const options =
      policy === 'autosignout'
        ? { closeOpenAtHour: null, autoWriteSignOutAtHour: 17 }
        : { closeOpenAtHour: 17, autoWriteSignOutAtHour: null };

    let daysProcessed = 0;
    let failures = [];

    for (
      let d = atMidnightNY(new Date(start));
      d <= atMidnightNY(new Date(end));
      d.setDate(d.getDate() + 1)
    ) {
      try {
        // compute summary for that day
        const { summaries } = dataManager.computeDailySummary(new Date(d), options);

        // write a column into "Daily Summary"
        const res = await googleSheetsService.upsertDailyHours({
          dateLike: new Date(d),
          summaries,
          summarySheetName,
          colorAbsences,
        });

        if (!res.success) {
          failures.push({ date: new Date(d).toISOString().slice(0, 10), error: res.error || 'unknown' });
        }
        daysProcessed++;
      } catch (e) {
        failures.push({ date: new Date(d).toISOString().slice(0, 10), error: e.message });
      }
    }

    return {
      success: failures.length === 0,
      daysProcessed,
      failures,
      range: {
        start: atMidnightNY(start).toISOString(),
        end: atMidnightNY(end).toISOString(),
      },
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('sync-todays-attendance', async (event) => {
  try {
    dataManager.logger.info('sync', 'Syncing today\'s attendance to Google Sheets', 'admin');

    const result = await googleSheetsService.syncTodaysAttendance();

    if (result.success) {
      dataManager.logger.info('sync', `Synced ${result.recordsSynced} today's records to Google Sheets`, 'admin');
    } else {
      dataManager.logger.error('sync', `Today's attendance sync failed: ${result.error}`, 'admin');
    }

    return result;
  } catch (error) {
    dataManager.logger.error('sync', `Sync today's attendance error: ${error.message}`, 'admin');
    return { success: false, error: error.message };
  }
});

ipcMain.handle('test-sheets-connection', async () => {
  try {
    const cfg = dataManager.getConfig();
    const s = cfg.googleSheets || {};
    const missing = [];

    if (!googleSheetsService?.hasCredentials?.()) missing.push('Service Account credentials');
    if (!s.spreadsheetId) missing.push('Spreadsheet ID');
    if (!s.attendanceSheet) missing.push('Attendance sheet name');
    if (!s.studentsSheet) missing.push('Students sheet name');

    if (missing.length) {
      const msg = `Not configured: ${missing.join(', ')}`;
      dataManager.logger?.warning('sync', msg, 'admin');
      return { success: false, error: msg };
    }

    const result = await googleSheetsService.testConnection();
    if (!result?.success) {
      // Make sure we bubble up WHY (permission, 404, etc.)
      const err = result?.error || 'Unknown error from testConnection';
      dataManager.logger?.warning('sync', `Sheets test failed: ${err}`, 'admin');
      return { success: false, error: err };
    }

    return { success: true };
  } catch (error) {
    dataManager.logger?.error('sync', `Sheets test exception: ${error.message}`, 'admin');
    return { success: false, error: error.message };
  }
});


ipcMain.handle('save-google-credentials', async (event, credentials) => {
  try {
    dataManager.logger.info('sync', 'Saving Google credentials', 'admin');

    const result = googleSheetsService.saveCredentials(credentials);

    if (result.success) {
      dataManager.logger.info('sync', 'Google credentials saved successfully', 'admin');
    } else {
      dataManager.logger.error('sync', `Failed to save Google credentials: ${result.error}`, 'admin');
    }

    return result;
  } catch (error) {
    dataManager.logger.error('sync', `Save credentials error: ${error.message}`, 'admin');
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-sheets-sync-status', async (event) => {
  try {
    const result = googleSheetsService.getSyncStatus();
    dataManager.logger.info('sync', 'Google Sheets sync status retrieved', 'admin');
    return result;
  } catch (error) {
    dataManager.logger.error('sync', `Get sync status error: ${error.message}`, 'admin');
    return { success: false, error: error.message };
  }
});

ipcMain.handle('enable-auto-sync', async (event) => {
  try {
    dataManager.logger.info('sync', 'Enabling auto-sync to Google Sheets', 'admin');

    const result = await googleSheetsService.enableAutoSync();

    if (result.success) {
      dataManager.logger.info('sync', 'Auto-sync enabled successfully', 'admin');
    } else {
      dataManager.logger.error('sync', `Failed to enable auto-sync: ${result.error}`, 'admin');
    }

    return result;
  } catch (error) {
    dataManager.logger.error('sync', `Enable auto sync error: ${error.message}`, 'admin');
    return { success: false, error: error.message };
  }
});

ipcMain.handle('disable-auto-sync', async (event) => {
  try {
    dataManager.logger.info('sync', 'Disabling auto-sync to Google Sheets', 'admin');

    const result = await googleSheetsService.disableAutoSync();

    if (result.success) {
      dataManager.logger.info('sync', 'Auto-sync disabled successfully', 'admin');
    } else {
      dataManager.logger.error('sync', `Failed to disable auto-sync: ${result.error}`, 'admin');
    }

    return result;
  } catch (error) {
    dataManager.logger.error('sync', `Disable auto sync error: ${error.message}`, 'admin');
    return { success: false, error: error.message };
  }
});

ipcMain.handle('generate-daily-summary', async (event, isoDateOrNull, policy = { capAtHour: null, autosignoutHour: 17 }) => {
  try {
    const date = isoDateOrNull ? new Date(isoDateOrNull) : new Date();
    const res = dataManager.saveDailySummaryCSV(date, {
      closeOpenAtHour: policy.capAtHour ?? null,
      autoWriteSignOutAtHour: policy.autosignoutHour ?? 17
    });
    return res;
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('push-daily-summary-to-sheets', async (event, { dateLike, summarySheetName }) => {
  try {
    // Hybrid rule: auto sign-out at 5 PM only if they never signed out
    const { summaries } = dataManager.computeDailySummary(dateLike, {
      closeOpenAtHour: 17,
      autoWriteSignOutAtHour: null
    });

    const res = await googleSheetsService.upsertDailyHours({
      dateLike,
      summaries,
      summarySheetName: summarySheetName || 'Daily Summary'
    });

    dataManager.logger.info('sync', `Daily summary pushed to Google Sheets for ${dateLike}`, 'admin');
    return res;
  } catch (e) {
    dataManager.logger.error('sync', `Daily summary push failed: ${e.message}`, 'admin');
    return { success: false, error: e.message };
  }
});
ipcMain.handle('get-daily-summary', async (event, { dateLike, policy = 'cap' } = {}) => {
  try {
    let options;
    if (policy === 'autosignout') {
      // write-mode (persist synthetic sign-outs)
      options = { closeOpenAtHour: null, autoWriteSignOutAtHour: 17 };
    } else if (policy === 'hybrid') {
      // your 5pm/+60 after 5pm, capped at 23:59 policy (also writes)
      options = {
        closeOpenAtHour: null,
        autoWriteSignOutAtHour: null,
        autoPolicy: { cutoffHour: 17, eodHour: 23, eodMinute: 59, after5Minutes: 60 }
      };
    } else {
      // cap-only (no mutation)
      options = { closeOpenAtHour: 17, autoWriteSignOutAtHour: null };
    }

    const { date, summaries } = dataManager.computeDailySummary(dateLike || new Date(), options);
    return { success: true, date, summaries };
  } catch (err) {
    dataManager.logger?.error('report', `get-daily-summary failed: ${err.message}`, 'admin');
    return { success: false, error: err.message, summaries: [] };
  }
});

ipcMain.handle('compute-hours-worked-today', async (event, { dateLike } = {}) => {
  try {
    const { date, summaries } = dataManager.computeHoursWorkedToday(dateLike || new Date());
    return { success: true, date, summaries };
  } catch (err) {
    dataManager.logger?.error('report', `compute-hours-worked-today failed: ${err.message}`, 'admin');
    return { success: false, error: err.message, summaries: [] };
  }
});
// Dropbox service handlers

ipcMain.handle('update-dropbox-config', async (event, partial) => {
  try {
    // Let DataManager perform a proper merge + normalization + write
    const result = dataManager.updateDropboxConfig(partial);
    if (result?.success) {
      dataManager.logger.info('dropbox', 'Dropbox config updated via DataManager', 'admin');
      return { success: true };
    } else {
      const err = result?.error || 'Unknown error from updateDropboxConfig';
      dataManager.logger.error('dropbox', `Failed to update config: ${err}`, 'admin');
      return { success: false, error: err };
    }
  } catch (e) {
    dataManager.logger.error('dropbox', `Failed to update config: ${e.message}`, 'admin');
    return { success: false, error: e.message };
  }
});


ipcMain.handle('dropbox-oauth-connect', async () => {
  try {
    dataManager.logger.info('dropbox', 'Starting OAuth connect', 'admin');
    const res = await dropboxService.interactiveConnect();
    if (res.success) {
      dataManager.logger.info('dropbox', 'OAuth connect succeeded', 'admin');
    } else {
      dataManager.logger.warning('dropbox', `OAuth connect failed: ${res.error}`, 'admin');
    }
    return res;
  } catch (e) {
    dataManager.logger.error('dropbox', `OAuth connect error: ${e.message}`, 'admin');
    return { success: false, error: e.message };
  }
});

ipcMain.handle('test-dropbox-connection', async () => {
  try {
    dataManager.logger.info('dropbox', 'Testing Dropbox connection', 'admin');
    const init = dropboxService.initializeFromConfig();
    if (!init.success) return { success: false, error: init.error || 'Dropbox not configured' };
    const result = await dropboxService.testConnection();
    if (result.success) {
      dataManager.logger.info('dropbox', `Connected as ${result.user}`, 'admin');
    } else {
      dataManager.logger.warning('dropbox', `Test failed: ${result.error}`, 'admin');
    }
    return result;
  } catch (e) {
    dataManager.logger.error('dropbox', `Connection test error: ${e.message}`, 'admin');
    return { success: false, error: e.message };
  }
});

ipcMain.handle('create-dropbox-default-folders', async () => {
  try {
    const init = dropboxService.initializeFromConfig();
    if (!init.success) return { success: false, error: init.error || 'Dropbox not configured' };
    return await dropboxService.createDefaultFolders();
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('upload-to-dropbox', async (event, type) => {
  try {
    dataManager.logger.info('dropbox', `Uploading type=${type}`, 'admin');
    let result;
    if (type === 'report') result = await dropboxService.uploadWeeklyReport();
    else if (type === 'backup') result = await dropboxService.backupToDropbox();
    else return { success: false, error: 'Invalid upload type' };

    if (result.success) {
      dataManager.logger.info('dropbox', `Upload done: ${result.path}`, 'admin');
    } else {
      dataManager.logger.warning('dropbox', `Upload failed: ${result.error}`, 'admin');
    }
    return result;
  } catch (e) {
    dataManager.logger.error('dropbox', `Upload error: ${e.message}`, 'admin');
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get-dropbox-space', async () => {
  try {
    const init = dropboxService.initializeFromConfig();
    if (!init.success) return { success: false, error: init.error || 'Dropbox not configured' };
    return await dropboxService.getSpaceUsage();
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('list-dropbox-files', async (event, folderPath) => {
  try {
    const folder = folderPath || '/UF-Lab-Attendance';
    const init = dropboxService.initializeFromConfig();
    if (!init.success) return { success: false, error: init.error || 'Dropbox not configured' };
    // pass null to let the service default to the configured base folder
    return await dropboxService.listFiles(folder, { recursive: true });
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Live Syncing Handlers
function scheduleSyncTimer() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  const cfg = dataManager.getConfig();
  if (!cfg.dropbox?.enabled) return;

  const mins = Math.max(2, parseInt(cfg.dropbox.syncIntervalMinutes || 10, 10));
  syncTimer = setInterval(() => safeSyncByMode('interval-sync'), mins * 60 * 1000);
}

// Manual “Sync Now”
ipcMain.handle('dropbox-sync-now', async () => {
  const cfg = dataManager.getConfig();
  if (!cfg.dropbox?.enabled) {
    return { success: false, error: 'Dropbox is not enabled' };
  }
  try {
    await safeSyncByMode('manual-sync');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Status for Admin UI
ipcMain.handle('get-dropbox-sync-status', async () => {
  const cfg = dataManager.getConfig();
  const enabled = !!cfg.dropbox?.enabled;
  const running = !!(enabled && syncTimer);
  const mode = cfg.dropbox?.masterMode ? 'pull' : 'push';
  const nextRun = running
    ? `Every ${Math.max(2, parseInt(cfg.dropbox.syncIntervalMinutes || 10, 10))} minutes`
    : null;
  return { enabled, running, mode, lastSyncAt: null, nextRun };
});

// Re-apply after settings saved (and do one immediate sync)
ipcMain.handle('apply-dropbox-sync-config', async () => {
  const cfg = dataManager.getConfig();
  if (cfg.dropbox?.enabled) {
    await safeSyncByMode('apply-config-sync');
    scheduleSyncTimer();
  } else {
    if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  }
  return { success: true };
});

// Manual SQLite reload from JSON (for admin use)
ipcMain.handle('reload-sqlite-from-json', async () => {
  try {
    dataManager.logger.info('system', 'Manual SQLite reload from JSON requested', 'admin');
    const result = await dataManager.reloadFromJson();
    if (result.success) {
      dataManager.logger.info('system',
        `Manual SQLite reload completed: ${result.students} students, ${result.attendance} records`, 'admin');
    } else {
      dataManager.logger.error('system', `Manual SQLite reload failed: ${result.error}`, 'admin');
    }
    return result;
  } catch (error) {
    dataManager.logger.error('system', `Manual SQLite reload error: ${error.message}`, 'admin');
    return { success: false, error: error.message };
  }
});




// Encryption handlers
ipcMain.handle('enable-encryption', async (event, password) => {
  try {
    dataManager.logger.info('encryption', 'Enabling data encryption', 'admin');

    const result = dataManager.updateEncryptionSettings(true, password);

    if (result.success) {
      dataManager.encryptionPassword = password;
      dataManager.logger.info('encryption', 'Data encryption enabled successfully', 'admin');
      return { success: true, message: 'Encryption enabled successfully' };
    } else {
      dataManager.logger.error('encryption', `Failed to enable encryption: ${result.error}`, 'admin');
    }

    return result;
  } catch (error) {
    dataManager.logger.error('encryption', `Enable encryption error: ${error.message}`, 'admin');
    return { success: false, error: error.message };
  }
});

ipcMain.handle('disable-encryption', async (event, password) => {
  try {
    dataManager.logger.info('encryption', 'Disabling data encryption', 'admin');

    if (!dataManager.verifyEncryptionPassword(password)) {
      dataManager.logger.warning('encryption', 'Failed to disable encryption - invalid password', 'admin');
      return { success: false, error: 'Invalid password' };
    }

    const result = dataManager.updateEncryptionSettings(false);

    if (result.success) {
      dataManager.logger.info('encryption', 'Data encryption disabled successfully', 'admin');
    } else {
      dataManager.logger.error('encryption', `Failed to disable encryption: ${result.error}`, 'admin');
    }

    return result;
  } catch (error) {
    dataManager.logger.error('encryption', `Disable encryption error: ${error.message}`, 'admin');
    return { success: false, error: error.message };
  }
});

ipcMain.handle('verify-encryption-password', async (event, password) => {
  try {
    const isValid = dataManager.verifyEncryptionPassword(password);

    if (isValid) {
      dataManager.logger.info('encryption', 'Encryption password verification successful', 'admin');
    } else {
      dataManager.logger.warning('encryption', 'Encryption password verification failed', 'admin');
    }

    return { success: true, valid: isValid };
  } catch (error) {
    dataManager.logger.error('encryption', `Encryption password verification error: ${error.message}`, 'admin');
    return { success: false, error: error.message };
  }
});

ipcMain.handle('create-encrypted-backup', async (event, password) => {
  try {
    dataManager.logger.info('backup', 'Creating encrypted backup', 'admin');

    const result = dataManager.createEncryptedBackup(password);

    if (result.success) {
      dataManager.logger.info('backup', `Encrypted backup created: ${result.backupFile}`, 'admin');
    } else {
      dataManager.logger.error('backup', `Encrypted backup failed: ${result.error}`, 'admin');
    }

    return result;
  } catch (error) {
    dataManager.logger.error('backup', `Create encrypted backup error: ${error.message}`, 'admin');
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-encryption-status', async (event) => {
  try {
    const config = dataManager.getConfig();
    const status = {
      success: true,
      enabled: config.encryption?.enabled || false,
      algorithm: config.encryption?.algorithm || 'AES-256',
      lastUpdated: config.encryption?.lastUpdated || null
    };

    dataManager.logger.info('encryption', `Encryption status retrieved: ${status.enabled ? 'enabled' : 'disabled'}`, 'admin');
    return status;
  } catch (error) {
    dataManager.logger.error('encryption', `Get encryption status error: ${error.message}`, 'admin');
    return { success: false, error: error.message };
  }
});

// Configuration handlers
ipcMain.handle('update-email-config', async (event, emailConfig) => {
  try {
    dataManager.logger.info('config', 'Updating email configuration', 'admin');

    const result = dataManager.updateEmailConfig(emailConfig);

    if (result.success) {
      dataManager.logger.info('config', 'Email configuration updated successfully', 'admin');
    } else {
      dataManager.logger.error('config', `Email configuration update failed: ${result.error}`, 'admin');
    }

    return result;
  } catch (error) {
    dataManager.logger.error('config', `Update email config error: ${error.message}`, 'admin');
    return { success: false, error: error.message };
  }
});

ipcMain.handle('update-sheets-config', async (event, sheetsConfig) => {
  try {
    // Apply sane defaults if missing
    if (!sheetsConfig.attendanceSheet) sheetsConfig.attendanceSheet = 'Attendance';
    if (!sheetsConfig.studentsSheet) sheetsConfig.studentsSheet = 'Students';

    dataManager.logger.info('config', 'Updating Google Sheets configuration', 'admin');
    const result = dataManager.updateSheetsConfig(sheetsConfig);
    if (result.success) {
      dataManager.logger.info('config', 'Google Sheets configuration updated successfully', 'admin');
    } else {
      dataManager.logger.error('config', `Google Sheets configuration update failed: ${result.error}`, 'admin');
    }
    return result;
  } catch (error) {
    dataManager.logger.error('config', `Update sheets config error: ${error.message}`, 'admin');
    return { success: false, error: error.message };
  }
});

// ipcMain.handle('update-dropbox-config', async (event, dropboxConfig) => {
//   try {
//     dataManager.logger.info('config', 'Updating Dropbox configuration', 'admin');

//     const result = dataManager.updateDropboxConfig(dropboxConfig);

//     if (result.success) {
//       dataManager.logger.info('config', 'Dropbox configuration updated successfully', 'admin');
//     } else {
//       dataManager.logger.error('config', `Dropbox configuration update failed: ${result.error}`, 'admin');
//     }

//     return result;
//   } catch (error) {
//     dataManager.logger.error('config', `Update Dropbox config error: ${error.message}`, 'admin');
//     return { success: false, error: error.message };
//   }
// });

ipcMain.handle('get-config', async (event) => {
  try {
    const config = dataManager.getConfig();
    dataManager.logger.info('config', 'Configuration retrieved', 'admin');
    return config;
  } catch (error) {
    dataManager.logger.error('config', `Get config error: ${error.message}`, 'admin');
    return {};
  }
});

// Web Dashboard Sync handlers
ipcMain.handle('update-web-sync-config', async (event, config) => {
  try {
    dataManager.logger.info('config', 'Updating web sync configuration', 'admin');
    const result = dataManager.updateWebSyncConfig(config);
    if (result.success) {
      dataManager.logger.info('config', 'Web sync configuration updated successfully', 'admin');
    } else {
      dataManager.logger.error('config', `Web sync configuration update failed: ${result.error}`, 'admin');
    }
    return result;
  } catch (error) {
    dataManager.logger.error('config', `Update web sync config error: ${error.message}`, 'admin');
    return { success: false, error: error.message };
  }
});

ipcMain.handle('web-sync-now', async (event) => {
  try {
    dataManager.logger.info('websync', 'Starting manual web sync', 'admin');
    const result = await syncToWebDashboard();
    return result;
  } catch (error) {
    dataManager.logger.error('websync', `Manual web sync error: ${error.message}`, 'admin');
    return { success: false, error: error.message };
  }
});

ipcMain.handle('test-web-sync-connection', async (event) => {
  try {
    const config = dataManager.getConfig();
    const webSync = config.webSync || {};

    if (!webSync.apiUrl || !webSync.apiKey) {
      return { success: false, error: 'API URL and API Key are required' };
    }

    // Test connection using health check endpoint
    const fetch = require('node-fetch');
    const baseUrl = webSync.apiUrl.replace(/\/$/, '');
    const response = await fetch(`${baseUrl}/api/admin/data/sync/health`, {
      method: 'GET',
      headers: {
        'X-API-Key': webSync.apiKey
      }
    });

    if (response.ok) {
      return { success: true, message: 'Connection successful' };
    } else {
      const text = await response.text();
      return { success: false, error: `Server responded with ${response.status}: ${text}` };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Backup handlers
ipcMain.handle('backup-data', async (event) => {
  try {
    dataManager.logger.info('backup', 'Starting data backup', 'admin');

    const result = dataManager.backupData();

    if (result.success) {
      dataManager.logger.info('backup', `Data backup created: ${result.backupFile}`, 'admin');
    } else {
      dataManager.logger.error('backup', `Data backup failed: ${result.error}`, 'admin');
    }

    return result;
  } catch (error) {
    dataManager.logger.error('backup', `Backup data error: ${error.message}`, 'admin');
    return { success: false, error: error.message };
  }
});

// System logs handlers
ipcMain.handle('get-system-logs', async (event, options = {}) => {
  try {
    if (dataManager && dataManager.logger) {
      const logs = dataManager.logger.getRecentLogs(
        options.limit || 100,
        options.level || null,
        options.category || null
      );

      // Don't log this operation to avoid recursive logging
      return { success: true, logs: logs };
    } else {
      return { success: false, error: 'Logger not initialized', logs: [] };
    }
  } catch (error) {
    console.error('Error getting system logs:', error);
    return { success: false, error: error.message, logs: [] };
  }
});

ipcMain.handle('clear-system-logs', async () => {
  try {
    if (dataManager && dataManager.logger) {
      const result = dataManager.logger.clearLogs();

      // Log this action after clearing
      if (result.success) {
        dataManager.logger.info('system', 'System logs cleared by admin', 'admin');
      }

      return result;
    } else {
      return { success: false, error: 'Logger not initialized' };
    }
  } catch (error) {
    console.error('Error clearing logs:', error);
    return { success: false, error: error.message };
  }
});

// App lifecycle
app.on('window-all-closed', () => {
  if (dataManager && dataManager.logger) {
    dataManager.logger.info('system', 'All windows closed', 'system');
  }

  if (process.platform !== 'darwin') {
    app.quit();
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

// Global error handling with logging
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  if (dataManager && dataManager.logger) {
    dataManager.logger.error('system', `Uncaught exception: ${error.message}`, 'system');
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  if (dataManager && dataManager.logger) {
    dataManager.logger.error('system', `Unhandled rejection: ${reason}`, 'system');
  }
});

app.on('before-quit', () => {
  if (dataManager && dataManager.logger) {
    dataManager.logger.info('system', 'Application shutting down', 'system');
  }

  if (emailService) {
    emailService.stopScheduler();
  }
});

if (process.env.NODE_ENV === 'development') {
  app.on('ready', () => {
    console.log('Lab Attendance System started in development mode');
    console.log('Data directory:', path.join(__dirname, 'data'));

    if (dataManager && dataManager.logger) {
      dataManager.logger.info('system', 'Application started in development mode', 'system');
      dataManager.logger.info('system', `Data directory: ${path.join(__dirname, 'data')}`, 'system');
    }
  });
}