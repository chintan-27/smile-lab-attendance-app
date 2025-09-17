const nodemailer = require('nodemailer');
const cron = require('node-cron');
const path = require('path');

class EmailService {
    constructor(dataManager) {
        this.dataManager = dataManager;
        this.scheduledTask = null;
        this.testTask = null;
        this.initializeScheduler();
    }

    createTransporter(emailConfig) {
        return nodemailer.createTransporter({
            host: emailConfig.smtp,
            port: emailConfig.port,
            secure: emailConfig.secure,
            auth: {
                user: emailConfig.email,
                pass: emailConfig.password
            }
        });
    }

    generateEmailHTML(reportData) {
        const startDate = new Date(reportData.startDate).toLocaleDateString();
        const endDate = new Date(reportData.endDate).toLocaleDateString();

        let studentRows = '';
        Object.keys(reportData.studentReports).forEach(ufid => {
            const student = reportData.studentReports[ufid];
            if (student.signIns > 0 || student.signOuts > 0) {
                studentRows += `
                    <tr>
                        <td style="padding: 8px; border: 1px solid #ddd;">${ufid}</td>
                        <td style="padding: 8px; border: 1px solid #ddd;">${student.name}</td>
                        <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${student.signIns}</td>
                        <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${student.signOuts}</td>
                        <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${student.totalHours}h</td>
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
                                    <th style="padding: 12px; text-align: left; border: 1px solid #ddd;">UF ID</th>
                                    <th style="padding: 12px; text-align: left; border: 1px solid #ddd;">Name</th>
                                    <th style="padding: 12px; text-align: center; border: 1px solid #ddd;">Sign Ins</th>
                                    <th style="padding: 12px; text-align: center; border: 1px solid #ddd;">Sign Outs</th>
                                    <th style="padding: 12px; text-align: center; border: 1px solid #ddd;">Hours</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${studentRows}
                            </tbody>
                        </table>
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

    async sendWeeklyReport() {
        try {
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

            const mailOptions = {
                from: {
                    name: 'UF Lab Attendance System',
                    address: config.emailSettings.email
                },
                to: config.emailSettings.recipientEmail,
                subject: `Weekly Lab Attendance Report - ${new Date().toLocaleDateString()}`,
                html: emailHTML,
                attachments: [{
                    filename: path.basename(reportResult.filePath),
                    path: reportResult.filePath
                }]
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
                filePath: reportResult.filePath
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
                    name: 'UF Lab Attendance System',
                    address: emailConfig.email
                },
                to: emailConfig.recipientEmail || emailConfig.email,
                subject: 'Test Email - Lab Attendance System',
                html: `
                    <h2>Email Configuration Test</h2>
                    <p>This is a test email from your Lab Attendance System.</p>
                    <p><strong>If you received this, your email configuration is working correctly!</strong></p>
                    <p><em>Sent at: ${new Date().toLocaleString()}</em></p>
                `
            };

            const info = await transporter.sendMail(mailOptions);
            return { success: true, messageId: info.messageId };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    initializeScheduler() {
        this.scheduledTask = cron.schedule('0 8 * * 6', async () => {
            console.log('Running weekly attendance report...');
            const result = await this.sendWeeklyReport();
            if (result.success) {
                console.log('Weekly report sent successfully:', result.messageId);
            } else {
                console.error('Failed to send weekly report:', result.error);
            }
        }, {
            scheduled: false,
            timezone: "America/New_York"
        });

        console.log('Email scheduler initialized');
    }

    startScheduler() {
        try {
            if (!this.scheduledTask) {
                this.initializeScheduler();
            }

            if (this.scheduledTask) {
                this.scheduledTask.start();
                console.log('Email scheduler started successfully');
                return { success: true, message: 'Weekly email scheduler started successfully' };
            }
            return { success: false, message: 'Failed to initialize scheduler' };
        } catch (error) {
            console.error('Error starting scheduler:', error);
            return { success: false, message: 'Error starting scheduler: ' + error.message };
        }
    }

    stopScheduler() {
        try {
            if (this.scheduledTask) {
                this.scheduledTask.stop();
                console.log('Email scheduler stopped');
                return { success: true, message: 'Weekly email scheduler stopped successfully' };
            }
            return { success: false, message: 'Scheduler not running' };
        } catch (error) {
            console.error('Error stopping scheduler:', error);
            return { success: false, message: 'Error stopping scheduler: ' + error.message };
        }
    }

    getSchedulerStatus() {
        const isRunning = this.scheduledTask ? this.scheduledTask.running : false;
        const nextRun = isRunning ? 'Every Saturday at 8:00 AM (EST)' : 'Not scheduled';

        console.log('Scheduler status:', isRunning ? 'Running' : 'Stopped');

        return {
            running: isRunning,
            nextRun: nextRun,
            initialized: !!this.scheduledTask
        };
    }

    startTestScheduler() {
        try {
            if (this.testTask) {
                this.testTask.destroy();
            }

            this.testTask = cron.schedule('*/10 * * * * *', async () => {
                console.log('Test scheduler running...');
                const result = await this.sendWeeklyReport();
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
            return { success: false, message: 'Error starting test scheduler: ' + error.message };
        }
    }
}

module.exports = EmailService;