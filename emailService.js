const nodemailer = require('nodemailer');
const cron = require('node-cron');
const path = require('path');

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

class EmailService {
    constructor(dataManager) {
        this.dataManager = dataManager;
        this.scheduledTask = null;
        this.testTask = null;
        this.schedulerRunning = false;
        this.initializeScheduler();
    }

    createTransporter(emailConfig) {
        return nodemailer.createTransport({
            host: emailConfig.smtp,
            port: emailConfig.port,
            secure: emailConfig.secure,
            auth: {
                user: emailConfig.email,
                pass: emailConfig.password
            }
        });
    }

    async captureWeeklyTimeBandsChartDataUrl() {
        const { BrowserWindow } = require('electron');

        let win;
        try {
            win = new BrowserWindow({
                show: false,
                width: 1400,
                height: 900,
                webPreferences: {
                    // Use the same preload you use for the admin window so window.electronAPI exists
                    preload: path.join(__dirname, 'preload.js'),
                    contextIsolation: true,
                }
            });

            await win.loadFile(path.join(__dirname, 'admin.html'));

            // Run in the page context: open Reports, render, then export canvas
            const dataUrl = await win.webContents.executeJavaScript(`
        (async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));

        // 1) Force Reports visible (Chart.js must see a visible canvas)
        document.querySelectorAll('.page-section').forEach(s => s.classList.remove('active'));
        const reports = document.getElementById('reports-section');
        if (reports) reports.classList.add('active');

        // 2) Ensure Chart.js is loaded
        for (let i = 0; i < 50; i++) {
            if (window.Chart) break;
            await wait(100);
        }

        // 3) Ensure report page JS ran and charts were rendered
        if (typeof loadReports === 'function') {
            await loadReports();
        }

        if (typeof renderTimeBands === 'function') {
            await renderTimeBands({ day: new Date() });
        }

        // 4) Wait a tick for paint/layout and chart animation
        for (let i = 0; i < 30; i++) {
            await wait(100);
            const c = document.getElementById('timeBandsChart');
            if (!c) continue;

            // If Chart.js chart instance exists, force a resize + update (helps in hidden windows)
            const chart = window.Chart?.getChart?.(c);
            if (chart) {
            chart.resize();
            chart.update('none');
            }

            const url = c.toDataURL('image/png');
            if (url && url.startsWith('data:image/png;base64,') && url.length > 5000) {
            return url;
            }
        }

        return null;
        })();
        `);


            return dataUrl;
        } finally {
            if (win && !win.isDestroyed()) win.destroy();
        }
    }

    generateEmailHTML(reportData) {
        const startDate = new Date(reportData.startDate).toLocaleDateString();
        const endDate = new Date(reportData.endDate).toLocaleDateString();

        let studentRows = '';
        Object.keys(reportData.studentReports).forEach(ufid => {
            const s = reportData.studentReports[ufid];
            if (s.signIns > 0 || s.signOuts > 0) {
                const expH = Number(s.expectedHoursPerWeek ?? 0);
                const expD = Number(s.expectedDaysPerWeek ?? 0);

                const hoursText = expH > 0 ? `${s.totalHours}h / ${expH}h` : `${s.totalHours}h / —`;
                const daysText = expD > 0 ? `${s.daysAttended} / ${expD}` : `${s.daysAttended} / —`;

                studentRows += `
                        <tr>
                            <td style="padding: 10px; border: 1px solid #ddd;">
                            <div style="font-weight: 600;">${s.name}
                                <span style="font-weight: normal; color:#64748b;"> (${s.role || 'volunteer'})</span>
                            </div>
                            <div style="color:#64748b; font-size: 12px;">${s.email || ''}</div>
                            </td>
                            <td style="padding: 10px; border: 1px solid #ddd; text-align:center; font-variant-numeric: tabular-nums;">
                            ${hoursText}
                            </td>
                            <td style="padding: 10px; border: 1px solid #ddd; text-align:center; font-variant-numeric: tabular-nums;">
                            ${daysText}
                            </td>
                        </tr>
                        `;
            }
        });


        return `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>Weekly Lab Attendance Report</title>
            </head>
            <body style="font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f4f4f4;">
                <div style="max-width: 800px; margin: 0 auto; background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
                    <div style="text-align: center; margin-bottom: 30px;">
                        <h1 style="color: #333; margin-bottom: 10px;">Weekly Lab Attendance Report</h1>
                        <h2 style="color: #667eea; font-weight: normal;">University of Florida Lab</h2>
                        <p style="color: #666; font-size: 16px;">Report Period: ${startDate} - ${endDate}</p>
                    </div>

                    <div style="margin-bottom: 30px;">
                        <h3 style="color: #333; border-bottom: 2px solid #667eea; padding-bottom: 10px;">Weekly Summary</h3>
                        <div style="display: flex; flex-wrap: wrap; gap: 20px; margin-top: 20px;">
                            <div style="background: #f8f9fa; padding: 15px; border-radius: 6px; flex: 1; min-width: 200px;">
                                <h4 style="margin: 0; color: #667eea;">Total Records</h4>
                                <p style="margin: 5px 0 0 0; font-size: 24px; font-weight: bold; color: #333;">${reportData.totalRecords}</p>
                            </div>
                            <div style="background: #f8f9fa; padding: 15px; border-radius: 6px; flex: 1; min-width: 200px;">
                                <h4 style="margin: 0; color: #48bb78;">Active Students</h4>
                                <p style="margin: 5px 0 0 0; font-size: 24px; font-weight: bold; color: #333;">${reportData.studentsWithActivity}</p>
                            </div>
                        </div>
                    </div>

                    <div style="margin-bottom: 30px;">
                        <h3 style="color: #333; border-bottom: 2px solid #667eea; padding-bottom: 10px;">Student Activity</h3>
                        <table style="width: 100%; border-collapse: collapse; margin-top: 20px;">
                            <thead>
                                <tr style="background-color: #667eea; color: white;">
                                <th style="padding: 12px; text-align: left; border: 1px solid #ddd;">Student</th>
                                <th style="padding: 12px; text-align: center; border: 1px solid #ddd;">Hours (attended / expected)</th>
                                <th style="padding: 12px; text-align: center; border: 1px solid #ddd;">Days (attended / expected)</th>
                                </tr>

                            </thead>
                            <tbody>
                                ${studentRows}
                            </tbody>
                        </table>
                    </div>
                    <div style="margin-bottom: 30px;">
                        <h3 style="color: #333; border-bottom: 2px solid #667eea; padding-bottom: 10px;">Visualization</h3>
                        <img src="cid:timeBandsChart"
                            alt="Weekly time bands"
                            style="max-width:100%; border-radius:6px;" />
                    </div>

                    <div style="text-align: center; margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee;">
                        <p style="color: #666; font-size: 14px;">
                            Report generated automatically on ${new Date().toLocaleString()}<br>
                            University of Florida Lab Attendance System
                        </p>
                    </div>
                </div>
            </body>
            </html>
        `;
    }

    async sendWeeklyReport(bandsImageDataUrl) {
        try {
            if (!bandsImageDataUrl) {
                bandsImageDataUrl = await this.captureWeeklyTimeBandsChartDataUrl();
            }
            const config = this.dataManager.getConfig();

            if (!config.emailSettings || !config.emailSettings.enabled) {
                return { success: false, error: 'Email not configured or disabled' };
            }

            const reportResult = this.dataManager.saveWeeklyReportToFile();
            if (!reportResult.success) {
                return { success: false, error: 'Failed to generate report: ' + reportResult.error };
            }

            const transporter = this.createTransporter(config.emailSettings);
            const emailHTML = this.generateEmailHTML(reportResult.reportData);
            const attachments = [];

            if (bandsImageDataUrl && bandsImageDataUrl.startsWith('data:image/png;base64,')) {
                const base64 = bandsImageDataUrl.replace(/^data:image\/png;base64,/, '');
                attachments.push({
                    filename: 'weekly-time-bands.png',
                    content: Buffer.from(base64, 'base64'),
                    cid: 'timeBandsChart',
                    contentType: 'image/png',
                    contentDisposition: 'inline',

                });
            }

            attachments.push({
                filename: path.basename(reportResult.filePath),
                path: reportResult.filePath
            });


            const mailOptions = {
                from: {
                    name: 'SMILE Lab Attendance',
                    address: config.emailSettings.email
                },
                to: config.emailSettings.recipientEmail,
                subject: `Weekly Lab Attendance Report — ${new Date().toLocaleDateString()}`,
                text: `Weekly Lab Attendance Report\nPeriod: ${reportResult.reportData.startDate} to ${reportResult.reportData.endDate}\nActive students: ${reportResult.reportData.studentsWithActivity}\nTotal records: ${reportResult.reportData.totalRecords}\n\nSee attached CSV for full details.`,
                html: emailHTML,
                attachments: attachments,
                headers: {
                    'List-Unsubscribe': `<mailto:${config.emailSettings.email}?subject=unsubscribe>`,
                    'Precedence': 'bulk',
                    'Auto-Submitted': 'auto-generated',
                    'Feedback-ID': 'weekly-report:smile-lab:attendance'
                }
            };

            const info = await transporter.sendMail(mailOptions);

            // Also upload to Dropbox if enabled
            const dropboxConfig = config.dropbox;
            if (dropboxConfig?.enabled && dropboxConfig?.autoReports) {
                try {
                    const DropboxService = require('./dropboxService.js');
                    const dropboxService = new DropboxService(this.dataManager);
                    await dropboxService.uploadWeeklyReport();
                } catch (dropboxError) {
                    console.log('Dropbox upload failed, but email sent successfully');
                }
            }

            return {
                success: true,
                messageId: info.messageId,
                filePath: reportResult.filePath,
                weekReport: reportResult.reportData
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async testEmailConfig(emailConfig) {
        try {
            const transporter = this.createTransporter(emailConfig);

            const mailOptions = {
                from: {
                    name: 'SMILE Lab Attendance',
                    address: emailConfig.email
                },
                to: emailConfig.recipientEmail || emailConfig.email,
                subject: 'SMILE Lab Attendance — email test',
                text: `Email configuration test.\n\nIf you received this, your email configuration is working correctly.\n\nSent at: ${new Date().toLocaleString()}`,
                html: `
                    <h2>Email Configuration Test</h2>
                    <p>This is a test email from your Lab Attendance System.</p>
                    <p><strong>If you received this, your email configuration is working correctly!</strong></p>
                    <p><em>Sent at: ${new Date().toLocaleString()}</em></p>
                `,
                headers: {
                    'Auto-Submitted': 'auto-generated'
                }
            };

            const info = await transporter.sendMail(mailOptions);
            return { success: true, messageId: info.messageId };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    initializeScheduler() {
        this.scheduledTask = cron.schedule('0 8 * * 6', async () => {
            let bandsImageDataUrl = null;

            try {
                bandsImageDataUrl = await this.captureWeeklyTimeBandsChartDataUrl();
            } catch (e) {
                console.error('Failed to capture time bands chart:', e);
            }

            const result = await this.sendWeeklyReport(bandsImageDataUrl);

            if (result.success) {
                console.log('Weekly report sent successfully:', result.messageId);
                if (result.weekReport) {
                    const config = this.dataManager.getConfig();
                    await this.checkAndSendAttendanceWarnings(result.weekReport, config);
                }
            } else {
                console.error('Failed to send weekly report:', result.error);
            }
        }, {
            scheduled: false,
            timezone: "America/New_York"
        });
    }

    startScheduler() {
        try {
            if (!this.scheduledTask) this.initializeScheduler();
            this.scheduledTask.start();
            this.schedulerRunning = true; // set true here
            return { success: true, message: 'Weekly email scheduler started successfully' };
        } catch (error) {
            console.error('Error starting scheduler:', error);
            return { success: false, message: 'Error starting scheduler: ' + error.message };
        }
    }

    stopScheduler() {
        try {
            if (this.scheduledTask) {
                this.scheduledTask.stop();
                this.schedulerRunning = false; // and false here
                return { success: true, message: 'Weekly email scheduler stopped successfully' };
            }
            return { success: false, message: 'Scheduler not running' };
        } catch (error) {
            console.error('Error stopping scheduler:', error);
            return { success: false, message: 'Error stopping scheduler: ' + error.message };
        }
    }

    // Optional: compute a friendly next-run string
    getNextRunText() {
        // Compute current NY local date/time
        const nowNY = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const target = new Date(nowNY);

        const dow = target.getDay(); // 0=Sun ... 6=Sat
        let daysToSat = (6 - dow + 7) % 7;

        // If it's already Saturday and past 8:00 AM NY time, schedule next Saturday
        const pastEight = nowNY.getHours() > 8 || (nowNY.getHours() === 8 && (nowNY.getMinutes() > 0 || nowNY.getSeconds() > 0));
        if (daysToSat === 0 && pastEight) daysToSat = 7;

        target.setDate(target.getDate() + daysToSat);
        target.setHours(8, 0, 0, 0); // 8:00 AM

        // Format a friendly NY-time string
        const fmt = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            weekday: 'short',
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            timeZoneName: 'short'
        });

        return fmt.format(target); // e.g., "Sat, Oct 5, 2025, 8:00 AM EDT"
    }

    getSchedulerStatus() {
        const isRunning = this.schedulerRunning;
        const nextRun = isRunning ? this.getNextRunText() : 'Not scheduled';
        // console.log('Scheduler status:', isRunning ? 'Running' : 'Stopped')
        return { running: isRunning, nextRun, initialized: !!this.scheduledTask };
    }

    generateAttendanceWarningHTML(student, streak, weekSummary) {
        const { startDate, actualHours, expectedHours } = weekSummary;
        const weekLabel = new Date(startDate).toLocaleDateString('en-US', {
            month: 'long', day: 'numeric', year: 'numeric'
        });

        let toneHeader, toneMessage, borderColor;
        if (streak === 1) {
            toneHeader = 'Attendance Heads-Up';
            toneMessage = `Just a heads up — you were a bit short on hours this week. You logged <strong>${actualHours}h</strong> against your expected <strong>${expectedHours}h</strong>. No worries, just something to keep in mind going forward.`;
            borderColor = '#FA4616';
        } else if (streak === 2) {
            toneHeader = 'Second Week Below Expectations';
            toneMessage = `This is the second week in a row that your hours have fallen below expectations. You logged <strong>${actualHours}h</strong> against your expected <strong>${expectedHours}h</strong>. Please make sure you're planning enough lab time in the coming week.`;
            borderColor = '#e67e22';
        } else {
            toneHeader = `${streak} Consecutive Weeks Below Expectations`;
            toneMessage = `This is your <strong>${streak}th consecutive week</strong> below the expected hours. You logged <strong>${actualHours}h</strong> against your expected <strong>${expectedHours}h</strong>. Continued underperformance may result in a review of your lab participation status. Please reach out to your supervisor if you are facing any difficulties.`;
            borderColor = '#c0392b';
        }

        return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; margin: 0; padding: 20px; background-color: #f4f4f4;">
  <div style="max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
    <div style="text-align: center; margin-bottom: 30px;">
      <div style="background: linear-gradient(135deg, #0021A5, #001A85); width: 60px; height: 60px; border-radius: 12px; margin: 0 auto 15px; display: flex; align-items: center; justify-content: center;">
        <span style="color: white; font-size: 28px; font-weight: bold;">S</span>
      </div>
      <h1 style="color: #0021A5; margin: 0; font-size: 22px;">${toneHeader}</h1>
      <p style="color: #64748b; margin: 6px 0 0; font-size: 14px;">Week of ${weekLabel}</p>
    </div>

    <p style="color: #333; font-size: 16px; line-height: 1.6;">Hello <strong>${student.name}</strong>,</p>

    <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid ${borderColor};">
      <p style="margin: 0; color: #333; font-size: 15px; line-height: 1.6;">${toneMessage}</p>
    </div>

    <div style="background: #f0f4ff; padding: 16px; border-radius: 8px; margin: 20px 0; text-align: center;">
      <p style="margin: 0; color: #0021A5; font-size: 15px;">
        <strong>${actualHours}h</strong> logged &nbsp;·&nbsp; <strong>${expectedHours}h</strong> expected
      </p>
    </div>

    <hr style="margin: 30px 0; border: none; border-top: 1px solid #e2e8f0;">

    <p style="color: #64748b; font-size: 12px; text-align: center; margin: 0;">
      SMILE Lab Attendance System<br>
      University of Florida<br>
      <span style="color: #94a3b8;">This is an automated message.</span>
    </p>
  </div>
</body>
</html>
        `;
    }

    async sendAttendanceWarningEmail(transporter, emailConfig, student, streak, weekSummary) {
        const { startDate } = weekSummary;
        const weekLabel = new Date(startDate).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric'
        });

        const html = this.generateAttendanceWarningHTML(student, streak, weekSummary);

        const mailOptions = {
            from: { name: 'SMILE Lab Attendance', address: emailConfig.email },
            to: student.email,
            subject: `${student.name}, attendance reminder — week of ${weekLabel}`,
            text: `Hello ${student.name},\n\nYour hours this week: ${weekSummary.actualHours}h (expected: ${weekSummary.expectedHours}h).\nThis is week ${streak} below expectations.\n\nPlease ensure you are meeting your lab time commitment.\n\n—\nSMILE Lab Attendance System\nUniversity of Florida`,
            html,
            headers: {
                'List-Unsubscribe': `<mailto:${emailConfig.email}?subject=unsubscribe>`,
                'Precedence': 'bulk',
                'Auto-Submitted': 'auto-generated',
                'Feedback-ID': 'attendance-warning:smile-lab:attendance'
            }
        };

        const info = await transporter.sendMail(mailOptions);
        return { success: true, messageId: info.messageId };
    }

    async checkAndSendAttendanceWarnings(weekReport, config) {
        try {
            if (!config.emailSettings?.enabled || !config.emailSettings?.email) return;

            const transporter = this.createTransporter(config.emailSettings);
            const students = this.dataManager.getStudents();
            const studentMap = {};
            for (const s of students) studentMap[s.ufid] = s;

            for (const [ufid, rep] of Object.entries(weekReport.studentReports)) {
                const expectedHours = Number(rep.expectedHoursPerWeek ?? 0);
                if (expectedHours === 0) continue;
                if (!rep.email) continue;

                const actualHours = Number(rep.totalHours ?? 0);
                const threshold = expectedHours * 0.80;
                const student = studentMap[ufid];
                if (!student) continue;

                const currentStreak = Number(student.weeklyWarningStreak ?? 0);
                let newStreak;

                if (actualHours >= threshold) {
                    newStreak = 0;
                } else {
                    newStreak = currentStreak + 1;
                }

                await this.dataManager.updateStudent(ufid, { weeklyWarningStreak: newStreak });

                if (newStreak > 0) {
                    const weekSummary = {
                        startDate: weekReport.startDate,
                        actualHours: Math.round(actualHours * 100) / 100,
                        expectedHours
                    };
                    try {
                        await this.sendAttendanceWarningEmail(transporter, config.emailSettings, rep, newStreak, weekSummary);
                        console.log(`Attendance warning (streak ${newStreak}) sent to ${rep.email}`);
                    } catch (err) {
                        console.error(`Failed to send attendance warning to ${rep.email}:`, err.message);
                    }
                }
            }
        } catch (err) {
            console.error('Error in checkAndSendAttendanceWarnings:', err.message);
        }
    }

    startTestScheduler() {
        try {
            if (this.testTask) {
                this.testTask.destroy();
            }

            this.testTask = cron.schedule('*/10 * * * * *', async () => {
                let bandsImageDataUrl = null;

                try {
                    bandsImageDataUrl = await this.captureWeeklyTimeBandsChartDataUrl();
                } catch (e) {
                    console.error('Failed to capture time bands chart:', e);
                }
                const result = await this.sendWeeklyReport(bandsImageDataUrl);
                if (result.success) {
                    console.log('Test report sent successfully');
                } else {
                    console.error('Test report failed:', result.error);
                }
                this.testTask.destroy();
            }, {
                scheduled: true
            });

            return { success: true, message: 'Test scheduler will run in 10 seconds' };
        } catch (error) {
            return { success: false, message: 'Error starting test scheduler: ' + error.message }
        }
    }
}

module.exports = EmailService;