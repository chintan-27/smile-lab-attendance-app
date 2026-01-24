/**
 * Pending Sign-Out Service
 *
 * Handles the workflow for students who forget to sign out:
 * - Creates pending records with unique tokens
 * - Syncs with cloud API for sign-out form submissions
 * - Sends reminder emails via EmailService
 * - Processes expired records at deadline
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Cloud API URL - Update this after deploying to Vercel
const API_BASE_URL = process.env.PENDING_API_URL || 'https://smile-lab-attendance-app.vercel.app/';

class PendingSignoutService {
  constructor(dataManager, emailService) {
    this.dataManager = dataManager;
    this.emailService = emailService;
    this.apiBaseUrl = API_BASE_URL;
    this.pendingFile = path.join(dataManager.dataDir, 'pendingSignouts.json');
    this.initializeData();
  }

  // ─────────────────────────────────────────────────────────────
  // Data Layer (Local cache + Cloud sync)
  // ─────────────────────────────────────────────────────────────

  initializeData() {
    if (!fs.existsSync(this.pendingFile)) {
      fs.writeFileSync(this.pendingFile, '[]', 'utf8');
    }
  }

  // Local cache operations
  getLocalPendingSignouts() {
    try {
      const data = fs.readFileSync(this.pendingFile, 'utf8');
      return JSON.parse(data);
    } catch (err) {
      console.error('Error reading local pending signouts:', err);
      return [];
    }
  }

  saveLocalPendingSignouts(data) {
    try {
      fs.writeFileSync(this.pendingFile, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch (err) {
      console.error('Error saving local pending signouts:', err);
      return false;
    }
  }

  // Cloud API operations
  async fetchFromCloud() {
    try {
      const response = await fetch(`${this.apiBaseUrl}/api/pending`);
      const result = await response.json();
      if (result.success) {
        // Update local cache
        this.saveLocalPendingSignouts(result.pending);
        return result.pending;
      }
      return this.getLocalPendingSignouts();
    } catch (err) {
      console.error('Error fetching from cloud:', err);
      return this.getLocalPendingSignouts();
    }
  }

  async pushToCloud(record) {
    try {
      const response = await fetch(`${this.apiBaseUrl}/api/pending`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record)
      });
      return await response.json();
    } catch (err) {
      console.error('Error pushing to cloud:', err);
      return { success: false, error: err.message };
    }
  }

  async updateInCloud(id, updates) {
    try {
      const response = await fetch(`${this.apiBaseUrl}/api/pending/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
      return await response.json();
    } catch (err) {
      console.error('Error updating in cloud:', err);
      return { success: false, error: err.message };
    }
  }

  // Combined getter - fetches from cloud and syncs locally
  async getPendingSignouts() {
    return await this.fetchFromCloud();
  }

  // Sync resolved records from cloud to local attendance
  async syncResolvedFromCloud() {
    try {
      const cloudPending = await this.fetchFromCloud();
      const localPending = this.getLocalPendingSignouts();

      for (const cloudRecord of cloudPending) {
        const localRecord = localPending.find(p => p.id === cloudRecord.id);

        // If cloud record is resolved, ensure we have the attendance record
        if (cloudRecord.status === 'resolved' && cloudRecord.submittedSignOutTime &&
            cloudRecord.submittedSignOutTime !== cloudRecord.signInTimestamp) {

          // Try to update existing temporary record first
          const updateResult = this.dataManager.updateAttendanceByPendingId(cloudRecord.id, {
            timestamp: cloudRecord.submittedSignOutTime,
            synthetic: false,
            fromPendingResolution: true,
            resolvedBy: cloudRecord.resolvedBy || 'student'
          });

          if (!updateResult.success) {
            // Check if a signout record already exists for this sign-in
            const existingSignout = this.dataManager.findSignoutForSignin(
              cloudRecord.ufid,
              cloudRecord.signInTimestamp
            );

            if (!existingSignout) {
              // Create new record if no signout exists
              this.dataManager.addAttendanceRecord({
                id: Date.now(),
                ufid: cloudRecord.ufid,
                name: cloudRecord.name,
                action: 'signout',
                timestamp: cloudRecord.submittedSignOutTime,
                synthetic: false,
                fromPendingResolution: true,
                pendingRecordId: cloudRecord.id
              });

              this.dataManager.logger?.info('pending',
                `Created sign-out record for ${cloudRecord.name} from cloud resolution`, 'system');
            }
          } else {
            this.dataManager.logger?.info('pending',
              `Updated sign-out record for ${cloudRecord.name} from cloud`, 'system');
          }
        }
      }

      // Update local cache
      this.saveLocalPendingSignouts(cloudPending);
      return { success: true, synced: cloudPending.length };
    } catch (err) {
      console.error('Error syncing from cloud:', err);
      return { success: false, error: err.message };
    }
  }

  generateToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  // ─────────────────────────────────────────────────────────────
  // Pending Record Management
  // ─────────────────────────────────────────────────────────────

  /**
   * Get ET timezone offset in minutes
   */
  getETOffset(date) {
    const etDate = new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
    return (utcDate - etDate) / 60000;
  }

  /**
   * Create a pending sign-out record for a student with an open session
   * @param {Object} student - Student object with ufid, name, email
   * @param {Object} signInRecord - The sign-in attendance record
   * @returns {Object} - { success, record?, error? }
   */
  async createPendingSignout(student, signInRecord) {
    try {
      const pending = await this.getPendingSignouts();

      // Check if already has pending for this sign-in
      const existing = pending.find(p =>
        p.signInRecordId === signInRecord.id && p.status === 'pending'
      );
      if (existing) {
        return { success: false, error: 'Pending record already exists for this session' };
      }

      // Calculate deadline: 5 PM ET next day
      const now = new Date();
      const deadline = new Date(now);
      deadline.setDate(deadline.getDate() + 1);
      deadline.setHours(17, 0, 0, 0); // 5 PM

      // Adjust for ET timezone
      const etOffset = this.getETOffset(deadline);
      deadline.setMinutes(deadline.getMinutes() + deadline.getTimezoneOffset() - etOffset);

      const record = {
        id: `${Date.now()}-${student.ufid}`,
        ufid: student.ufid,
        name: student.name,
        email: student.email,
        signInTimestamp: signInRecord.timestamp,
        signInRecordId: signInRecord.id,
        token: this.generateToken(),
        createdAt: now.toISOString(),
        deadline: deadline.toISOString(),
        status: 'pending',
        resolvedAt: null,
        submittedSignOutTime: null,
        resolvedBy: null
      };

      // Push to cloud
      const cloudResult = await this.pushToCloud(record);
      if (!cloudResult.success) {
        console.error('Failed to push to cloud:', cloudResult.error);
      }

      // Also save locally as backup
      pending.push(record);
      this.saveLocalPendingSignouts(pending);

      // Send email and track result
      let emailSent = false;
      let emailError = null;
      if (student.email) {
        const emailResult = await this.sendPendingSignoutEmail(record);
        emailSent = emailResult.success;
        if (!emailResult.success) {
          emailError = emailResult.error;
          this.dataManager.logger?.warning('email',
            `Failed to send pending email to ${student.email}: ${emailError}`, 'system');
        }
      }

      this.dataManager.logger?.info('pending',
        `Created pending sign-out for ${student.name} (${student.ufid})${emailSent ? ', email sent' : ''}`, 'system');

      return { success: true, record, emailSent, emailError };
    } catch (err) {
      console.error('Error creating pending signout:', err);
      return { success: false, error: err.message };
    }
  }

  /**
   * Admin resolves a pending sign-out manually
   * @param {string} id - Pending record ID
   * @param {string} signOutTime - Time string or null for present-only
   * @param {boolean} presentOnly - Mark as present with 0 hours
   * @returns {Object} - { success, record?, error? }
   */
  async adminResolvePending(id, signOutTime, presentOnly = false) {
    try {
      const pending = await this.getPendingSignouts();
      const record = pending.find(p => p.id === id);

      if (!record) {
        return { success: false, error: 'Pending record not found' };
      }

      if (record.status !== 'pending') {
        return { success: false, error: 'This record has already been resolved' };
      }

      const now = new Date();
      const signInDate = new Date(record.signInTimestamp);

      record.status = 'resolved';
      record.resolvedAt = now.toISOString();
      record.resolvedBy = 'admin';

      if (presentOnly) {
        record.submittedSignOutTime = record.signInTimestamp;
        record.presentOnly = true;

        // Try to update existing temporary record, fallback to adding new
        const updateResult = this.dataManager.updateAttendanceByPendingId(record.id, {
          timestamp: record.signInTimestamp,
          synthetic: true,
          presentOnly: true,
          fromPendingResolution: true,
          resolvedBy: 'admin'
        });

        if (!updateResult.success) {
          this.dataManager.addAttendanceRecord({
            id: Date.now(),
            ufid: record.ufid,
            name: record.name,
            action: 'signout',
            timestamp: record.signInTimestamp,
            synthetic: true,
            presentOnly: true,
            fromPendingResolution: true,
            pendingRecordId: record.id
          });
        }
      } else {
        let signOutDate;
        if (/^\d{2}:\d{2}$/.test(signOutTime)) {
          const [hours, minutes] = signOutTime.split(':').map(Number);
          signOutDate = new Date(signInDate);
          signOutDate.setHours(hours, minutes, 0, 0);
        } else {
          signOutDate = new Date(signOutTime);
        }

        record.submittedSignOutTime = signOutDate.toISOString();

        // Try to update existing temporary record, fallback to adding new
        const updateResult = this.dataManager.updateAttendanceByPendingId(record.id, {
          timestamp: signOutDate.toISOString(),
          synthetic: false,
          fromPendingResolution: true,
          adminResolved: true,
          resolvedBy: 'admin'
        });

        if (!updateResult.success) {
          this.dataManager.addAttendanceRecord({
            id: Date.now(),
            ufid: record.ufid,
            name: record.name,
            action: 'signout',
            timestamp: signOutDate.toISOString(),
            synthetic: false,
            fromPendingResolution: true,
            adminResolved: true,
            pendingRecordId: record.id
          });
        }
      }

      // Update in cloud
      await this.updateInCloud(id, {
        status: record.status,
        resolvedAt: record.resolvedAt,
        resolvedBy: record.resolvedBy,
        submittedSignOutTime: record.submittedSignOutTime,
        presentOnly: record.presentOnly
      });

      // Save locally
      this.saveLocalPendingSignouts(pending);

      this.dataManager.logger?.info('pending',
        `Admin resolved pending sign-out for ${record.name}`, 'admin');

      return { success: true, record };
    } catch (err) {
      console.error('Error in admin resolve:', err);
      return { success: false, error: err.message };
    }
  }

  /**
   * Process all expired pending records (called at 5 PM deadline)
   * @returns {Object} - { expiredCount, affectedDates }
   */
  async processExpiredPending() {
    try {
      // First sync from cloud to get any student-resolved records
      await this.syncResolvedFromCloud();

      const pending = await this.getPendingSignouts();
      const now = new Date();
      const expired = [];
      const affectedDates = new Set();

      for (const record of pending) {
        if (record.status === 'pending' && new Date(record.deadline) < now) {
          // Mark as expired (0 hours, present only)
          record.status = 'expired';
          record.resolvedAt = now.toISOString();
          record.resolvedBy = 'system';
          record.submittedSignOutTime = record.signInTimestamp;
          record.presentOnly = true;

          // Update existing temporary record to mark as expired (0 hours, present only)
          const updateResult = this.dataManager.updateAttendanceByPendingId(record.id, {
            timestamp: record.signInTimestamp,
            synthetic: true,
            presentOnly: true,
            pendingExpired: true,
            resolvedBy: 'system'
          });

          if (!updateResult.success) {
            // Fallback: add new record if no temporary exists
            this.dataManager.addAttendanceRecord({
              id: Date.now() + Math.floor(Math.random() * 1000),
              ufid: record.ufid,
              name: record.name,
              action: 'signout',
              timestamp: record.signInTimestamp,
              synthetic: true,
              presentOnly: true,
              pendingExpired: true,
              pendingRecordId: record.id
            });
          }

          // Update in cloud
          await this.updateInCloud(record.id, {
            status: record.status,
            resolvedAt: record.resolvedAt,
            resolvedBy: record.resolvedBy,
            submittedSignOutTime: record.submittedSignOutTime,
            presentOnly: record.presentOnly
          });

          expired.push(record);

          const dateStr = record.signInTimestamp.split('T')[0];
          affectedDates.add(dateStr);

          this.dataManager.logger?.warning('pending',
            `Expired pending sign-out for ${record.name} - marked as present only`, 'system');
        }
      }

      if (expired.length > 0) {
        this.saveLocalPendingSignouts(pending);
      }

      return {
        success: true,
        expiredCount: expired.length,
        affectedDates: Array.from(affectedDates)
      };
    } catch (err) {
      console.error('Error processing expired pending:', err);
      return { success: false, error: err.message, expiredCount: 0, affectedDates: [] };
    }
  }

  /**
   * Get pending record by token (from local cache)
   */
  getPendingByToken(token) {
    const pending = this.getLocalPendingSignouts();
    return pending.find(p => p.token === token);
  }

  /**
   * Get statistics about pending records
   */
  async getPendingStats() {
    const pending = await this.getPendingSignouts();
    const now = new Date();
    const todayEnd = new Date(now);
    todayEnd.setHours(23, 59, 59, 999);

    const stats = {
      total: pending.filter(p => p.status === 'pending').length,
      expiringToday: pending.filter(p =>
        p.status === 'pending' &&
        new Date(p.deadline) <= todayEnd
      ).length,
      resolved: pending.filter(p => p.status === 'resolved').length,
      expired: pending.filter(p => p.status === 'expired').length
    };

    return stats;
  }

  // ─────────────────────────────────────────────────────────────
  // Email Integration
  // ─────────────────────────────────────────────────────────────

  /**
   * Send pending sign-out email to student
   */
  async sendPendingSignoutEmail(record) {
    try {
      const config = this.dataManager.getConfig();
      if (!config.emailSettings?.enabled || !config.emailSettings?.email) {
        this.dataManager.logger?.warning('email',
          `Email not configured - skipping email to ${record.email}`, 'system');
        return { success: false, error: 'Email not configured' };
      }

      const signInTime = new Date(record.signInTimestamp);
      const deadline = new Date(record.deadline);
      // Use cloud URL for the link
      const link = `${this.apiBaseUrl}/signout/${record.token}`;

      const html = this.generatePendingSignoutEmailHTML({
        name: record.name,
        signInDate: signInTime.toLocaleDateString('en-US', {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
          timeZone: 'America/New_York'
        }),
        signInTime: signInTime.toLocaleTimeString('en-US', {
          hour: 'numeric', minute: '2-digit', hour12: true,
          timeZone: 'America/New_York'
        }),
        deadline: deadline.toLocaleString('en-US', {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
          hour: 'numeric', minute: '2-digit', hour12: true,
          timeZone: 'America/New_York'
        }),
        link
      });

      const transporter = this.emailService.createTransporter(config.emailSettings);

      // Plain text version improves deliverability
      const plainText = `Hello ${record.name},

Our records show that you signed into the lab on ${signInTime.toLocaleDateString('en-US', { timeZone: 'America/New_York' })} at ${signInTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York' })} but did not sign out.

DEADLINE: ${deadline.toLocaleString('en-US', { timeZone: 'America/New_York' })} ET

Please submit your sign-out time here:
${link}

IMPORTANT: If you do not respond by the deadline, your attendance will be marked as "present only" with 0 hours credit.

---
University of Florida Lab Attendance System
This is an automated message. Please do not reply to this email.`;

      const mailOptions = {
        from: {
          name: 'SMILE Lab Attendance',
          address: config.emailSettings.email
        },
        replyTo: config.emailSettings.email,
        to: record.email,
        subject: `Sign-Out Time Needed - ${signInTime.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })}`,
        text: plainText,
        html,
        headers: {
          'X-Priority': '3',
          'X-Mailer': 'SMILE Lab Attendance System'
        }
      };

      const info = await transporter.sendMail(mailOptions);

      this.dataManager.logger?.info('email',
        `Pending sign-out email sent to ${record.email}`, 'system');

      return { success: true, messageId: info.messageId };
    } catch (err) {
      console.error('Error sending pending signout email:', err);
      this.dataManager.logger?.error('email',
        `Failed to send pending sign-out email to ${record.email}: ${err.message}`, 'system');
      return { success: false, error: err.message };
    }
  }

  generatePendingSignoutEmailHTML({ name, signInDate, signInTime, deadline, link }) {
    return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; margin: 0; padding: 20px; background-color: #f5f5f5;">
  <div style="max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px;">
    <div style="text-align: center; margin-bottom: 25px; padding-bottom: 20px; border-bottom: 2px solid #0021A5;">
      <h1 style="color: #0021A5; margin: 0; font-size: 22px;">SMILE Lab - Sign-Out Required</h1>
    </div>

    <p style="color: #333; font-size: 15px; line-height: 1.6;">Hello ${name},</p>

    <p style="color: #333; font-size: 15px; line-height: 1.6;">
      Our records show you signed in on <strong>${signInDate}</strong> at <strong>${signInTime}</strong> but did not sign out.
    </p>

    <div style="background: #f0f4f8; padding: 15px; border-radius: 6px; margin: 20px 0;">
      <p style="margin: 0; color: #333; font-size: 14px;">
        <strong>Deadline:</strong> ${deadline} ET
      </p>
    </div>

    <p style="color: #333; font-size: 15px; line-height: 1.6;">
      Please submit your sign-out time using the link below:
    </p>

    <div style="text-align: center; margin: 25px 0;">
      <a href="${link}" style="display: inline-block; background: #0021A5; color: white; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 15px;">
        Submit Sign-Out Time
      </a>
    </div>

    <p style="color: #666; font-size: 13px; line-height: 1.5;">
      If you cannot click the button, copy this link into your browser:<br>
      <a href="${link}" style="color: #0021A5; word-break: break-all;">${link}</a>
    </p>

    <div style="background: #fff8e6; padding: 12px; border-radius: 6px; margin: 20px 0;">
      <p style="margin: 0; color: #856404; font-size: 13px;">
        <strong>Note:</strong> If you do not respond by the deadline, this session will be recorded as 0 hours.
      </p>
    </div>

    <hr style="margin: 25px 0; border: none; border-top: 1px solid #ddd;">

    <p style="color: #888; font-size: 11px; text-align: center; margin: 0;">
      SMILE Lab Attendance System - University of Florida<br>
      This is an automated message.
    </p>
  </div>
</body>
</html>
    `;
  }

  // ─────────────────────────────────────────────────────────────
  // Server Status (for compatibility - now uses cloud)
  // ─────────────────────────────────────────────────────────────

  startServer() {
    // No local server needed - using cloud API
    console.log(`Pending signout using cloud API: ${this.apiBaseUrl}`);
    return { success: true, url: this.apiBaseUrl };
  }

  stopServer() {
    // No local server to stop
    return { success: true };
  }

  isServerRunning() {
    // Cloud API is always "running"
    return true;
  }

  get port() {
    return this.apiBaseUrl;
  }
}

module.exports = PendingSignoutService;
