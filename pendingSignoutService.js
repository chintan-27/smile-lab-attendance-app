/**
 * Pending Sign-Out Service
 *
 * Handles the workflow for students who forget to sign out:
 * - Creates pending records with unique tokens
 * - Runs Express server for sign-out submission forms
 * - Sends reminder emails via EmailService
 * - Processes expired records at deadline
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class PendingSignoutService {
  constructor(dataManager, emailService) {
    this.dataManager = dataManager;
    this.emailService = emailService;
    this.server = null;
    this.port = 3847;
    this.pendingFile = path.join(dataManager.dataDir, 'pendingSignouts.json');
    this.initializeData();
  }

  // ─────────────────────────────────────────────────────────────
  // Data Layer
  // ─────────────────────────────────────────────────────────────

  initializeData() {
    if (!fs.existsSync(this.pendingFile)) {
      fs.writeFileSync(this.pendingFile, '[]', 'utf8');
    }
  }

  getPendingSignouts() {
    try {
      const data = fs.readFileSync(this.pendingFile, 'utf8');
      return JSON.parse(data);
    } catch (err) {
      console.error('Error reading pending signouts:', err);
      return [];
    }
  }

  savePendingSignouts(data) {
    try {
      fs.writeFileSync(this.pendingFile, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch (err) {
      console.error('Error saving pending signouts:', err);
      return false;
    }
  }

  generateToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  // ─────────────────────────────────────────────────────────────
  // Pending Record Management
  // ─────────────────────────────────────────────────────────────

  /**
   * Create a pending sign-out record for a student with an open session
   * @param {Object} student - Student object with ufid, name, email
   * @param {Object} signInRecord - The sign-in attendance record
   * @returns {Object} - { success, record?, error? }
   */
  async createPendingSignout(student, signInRecord) {
    try {
      const pending = this.getPendingSignouts();

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

      pending.push(record);
      this.savePendingSignouts(pending);

      // Send email
      if (student.email) {
        await this.sendPendingSignoutEmail(record);
      }

      this.dataManager.logger?.info('pending',
        `Created pending sign-out for ${student.name} (${student.ufid})`, 'system');

      return { success: true, record };
    } catch (err) {
      console.error('Error creating pending signout:', err);
      return { success: false, error: err.message };
    }
  }

  /**
   * Get ET timezone offset in minutes
   */
  getETOffset(date) {
    const etDate = new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
    return (utcDate - etDate) / 60000;
  }

  /**
   * Resolve a pending sign-out when student submits their time
   * @param {string} token - The unique token
   * @param {string} signOutTime - ISO timestamp or time string
   * @returns {Object} - { success, record?, hoursWorked?, error? }
   */
  resolvePendingSignout(token, signOutTime) {
    try {
      const pending = this.getPendingSignouts();
      const record = pending.find(p => p.token === token);

      if (!record) {
        return { success: false, error: 'Invalid or expired link' };
      }

      if (record.status !== 'pending') {
        return { success: false, error: 'This sign-out has already been submitted' };
      }

      const now = new Date();
      const deadline = new Date(record.deadline);
      if (now > deadline) {
        return { success: false, error: 'The deadline has passed. Please contact the lab administrator.' };
      }

      // Parse and validate the sign-out time
      const signInDate = new Date(record.signInTimestamp);
      let signOutDate;

      // If signOutTime is just a time (HH:MM), combine with sign-in date
      if (/^\d{2}:\d{2}$/.test(signOutTime)) {
        const [hours, minutes] = signOutTime.split(':').map(Number);
        signOutDate = new Date(signInDate);
        signOutDate.setHours(hours, minutes, 0, 0);
      } else {
        signOutDate = new Date(signOutTime);
      }

      // Validation: sign-out must be after sign-in
      if (signOutDate <= signInDate) {
        return { success: false, error: 'Sign-out time must be after your sign-in time' };
      }

      // Validation: sign-out should be on same day (allow up to 11:59 PM)
      const signInDay = signInDate.toDateString();
      const signOutDay = signOutDate.toDateString();
      if (signInDay !== signOutDay) {
        return { success: false, error: 'Sign-out time must be on the same day as sign-in' };
      }

      // Update the record
      record.status = 'resolved';
      record.resolvedAt = now.toISOString();
      record.submittedSignOutTime = signOutDate.toISOString();
      record.resolvedBy = 'student';

      this.savePendingSignouts(pending);

      // Add the sign-out record to attendance
      this.dataManager.addAttendanceRecord({
        id: Date.now(),
        ufid: record.ufid,
        name: record.name,
        action: 'signout',
        timestamp: signOutDate.toISOString(),
        synthetic: false,
        fromPendingResolution: true,
        pendingRecordId: record.id
      });

      // Calculate hours worked
      const hoursWorked = (signOutDate - signInDate) / (1000 * 60 * 60);

      this.dataManager.logger?.info('pending',
        `Resolved pending sign-out for ${record.name}: ${hoursWorked.toFixed(2)} hours`, 'system');

      return { success: true, record, hoursWorked };
    } catch (err) {
      console.error('Error resolving pending signout:', err);
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
  adminResolvePending(id, signOutTime, presentOnly = false) {
    try {
      const pending = this.getPendingSignouts();
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
        // Mark as present only (0 hours)
        record.submittedSignOutTime = record.signInTimestamp; // Same time = 0 hours
        record.presentOnly = true;

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
      } else {
        // Parse admin-provided time
        let signOutDate;
        if (/^\d{2}:\d{2}$/.test(signOutTime)) {
          const [hours, minutes] = signOutTime.split(':').map(Number);
          signOutDate = new Date(signInDate);
          signOutDate.setHours(hours, minutes, 0, 0);
        } else {
          signOutDate = new Date(signOutTime);
        }

        record.submittedSignOutTime = signOutDate.toISOString();

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

      this.savePendingSignouts(pending);

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
  processExpiredPending() {
    try {
      const pending = this.getPendingSignouts();
      const now = new Date();
      const expired = [];
      const affectedDates = new Set();

      for (const record of pending) {
        if (record.status === 'pending' && new Date(record.deadline) < now) {
          // Mark as expired (0 hours, present only)
          record.status = 'expired';
          record.resolvedAt = now.toISOString();
          record.resolvedBy = 'system';
          record.submittedSignOutTime = record.signInTimestamp; // 0 hours
          record.presentOnly = true;

          // Add present-only sign-out record
          this.dataManager.addAttendanceRecord({
            id: Date.now() + Math.floor(Math.random() * 1000),
            ufid: record.ufid,
            name: record.name,
            action: 'signout',
            timestamp: record.signInTimestamp, // Same as sign-in = 0 hours
            synthetic: true,
            presentOnly: true,
            pendingExpired: true,
            pendingRecordId: record.id
          });

          expired.push(record);

          // Track affected date for summary regeneration
          const dateStr = record.signInTimestamp.split('T')[0];
          affectedDates.add(dateStr);

          this.dataManager.logger?.warning('pending',
            `Expired pending sign-out for ${record.name} - marked as present only`, 'system');
        }
      }

      if (expired.length > 0) {
        this.savePendingSignouts(pending);
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
   * Get pending record by token
   */
  getPendingByToken(token) {
    const pending = this.getPendingSignouts();
    return pending.find(p => p.token === token);
  }

  /**
   * Get statistics about pending records
   */
  getPendingStats() {
    const pending = this.getPendingSignouts();
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
        return { success: false, error: 'Email not configured' };
      }

      const signInTime = new Date(record.signInTimestamp);
      const deadline = new Date(record.deadline);
      const link = `http://localhost:${this.port}/signout/${record.token}`;

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

      const mailOptions = {
        from: {
          name: 'UF Lab Attendance System',
          address: config.emailSettings.email
        },
        to: record.email,
        subject: `Action Required: Submit Your Sign-Out Time for ${signInTime.toLocaleDateString('en-US', { timeZone: 'America/New_York' })}`,
        html
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
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; margin: 0; padding: 20px; background-color: #f4f4f4;">
  <div style="max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
    <div style="text-align: center; margin-bottom: 30px;">
      <div style="background: linear-gradient(135deg, #0021A5, #001A85); width: 60px; height: 60px; border-radius: 12px; margin: 0 auto 15px; display: flex; align-items: center; justify-content: center;">
        <span style="color: white; font-size: 24px;">&#127891;</span>
      </div>
      <h1 style="color: #0021A5; margin: 0; font-size: 24px;">Sign-Out Time Required</h1>
    </div>

    <p style="color: #333; font-size: 16px; line-height: 1.6;">Hello <strong>${name}</strong>,</p>

    <p style="color: #333; font-size: 16px; line-height: 1.6;">
      Our records show that you signed into the lab on <strong>${signInDate}</strong> at <strong>${signInTime}</strong> but did not sign out.
    </p>

    <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 25px 0; border-left: 4px solid #FA4616;">
      <p style="margin: 0; color: #333; font-size: 15px;">
        <strong style="color: #0021A5;">Deadline to respond:</strong><br>
        ${deadline} ET
      </p>
    </div>

    <p style="color: #333; font-size: 16px; line-height: 1.6;">
      Please click the button below to submit your actual sign-out time:
    </p>

    <div style="text-align: center; margin: 30px 0;">
      <a href="${link}" style="display: inline-block; background: linear-gradient(135deg, #0021A5, #001A85); color: white; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
        Submit Sign-Out Time
      </a>
    </div>

    <div style="background: #FFF4E6; padding: 15px; border-radius: 8px; margin: 25px 0;">
      <p style="margin: 0; color: #92400e; font-size: 14px;">
        <strong>Important:</strong> If you do not respond by the deadline, your attendance will be marked as "present only" with <strong>0 hours</strong> credit for this session.
      </p>
    </div>

    <p style="color: #64748b; font-size: 13px; margin-top: 30px;">
      <strong>Note:</strong> This link will only work when the lab attendance application is running. If you cannot access the form, please contact the lab administrator.
    </p>

    <hr style="margin: 30px 0; border: none; border-top: 1px solid #e2e8f0;">

    <p style="color: #64748b; font-size: 12px; text-align: center; margin: 0;">
      University of Florida Lab Attendance System<br>
      This is an automated message. Please do not reply to this email.
    </p>
  </div>
</body>
</html>
    `;
  }

  // ─────────────────────────────────────────────────────────────
  // Express Web Server
  // ─────────────────────────────────────────────────────────────

  /**
   * Start the Express web server for sign-out forms
   */
  startServer() {
    if (this.server) {
      console.log('Pending signout server already running');
      return { success: true, port: this.port };
    }

    const app = express();
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());

    // Health check
    app.get('/health', (req, res) => {
      res.json({ status: 'ok', service: 'pending-signout' });
    });

    // GET: Display sign-out form
    app.get('/signout/:token', (req, res) => {
      try {
        const { token } = req.params;
        const record = this.getPendingByToken(token);

        if (!record) {
          return res.status(404).send(this.generateErrorHTML('Invalid or expired link. This sign-out request was not found.'));
        }

        if (record.status !== 'pending') {
          return res.status(400).send(this.generateErrorHTML('This sign-out has already been submitted.'));
        }

        const now = new Date();
        if (now > new Date(record.deadline)) {
          return res.status(400).send(this.generateErrorHTML('The deadline has passed. Your attendance has been marked as "present only" with 0 hours. Please contact the lab administrator if you believe this is an error.'));
        }

        res.send(this.generateFormHTML(record));
      } catch (err) {
        console.error('Error serving form:', err);
        res.status(500).send(this.generateErrorHTML('An error occurred. Please try again.'));
      }
    });

    // POST: Submit sign-out time
    app.post('/signout/:token', (req, res) => {
      try {
        const { token } = req.params;
        const { signOutTime } = req.body;

        if (!signOutTime) {
          const record = this.getPendingByToken(token);
          if (record) {
            return res.send(this.generateFormHTML(record, 'Please enter a valid sign-out time.'));
          }
          return res.status(400).send(this.generateErrorHTML('Please enter a valid sign-out time.'));
        }

        const result = this.resolvePendingSignout(token, signOutTime);

        if (!result.success) {
          const record = this.getPendingByToken(token);
          if (record && record.status === 'pending') {
            return res.send(this.generateFormHTML(record, result.error));
          }
          return res.status(400).send(this.generateErrorHTML(result.error));
        }

        res.send(this.generateSuccessHTML(result.record, result.hoursWorked));
      } catch (err) {
        console.error('Error processing submission:', err);
        res.status(500).send(this.generateErrorHTML('An error occurred while processing your submission. Please try again.'));
      }
    });

    // Start server on localhost only
    this.server = app.listen(this.port, '127.0.0.1', () => {
      console.log(`Pending signout server running at http://localhost:${this.port}`);
      this.dataManager.logger?.info('server',
        `Pending sign-out web server started on port ${this.port}`, 'system');
    });

    this.server.on('error', (err) => {
      console.error('Server error:', err);
      this.dataManager.logger?.error('server',
        `Pending sign-out server error: ${err.message}`, 'system');
    });

    return { success: true, port: this.port };
  }

  /**
   * Stop the Express server
   */
  stopServer() {
    if (this.server) {
      this.server.close(() => {
        console.log('Pending signout server stopped');
        this.dataManager.logger?.info('server',
          'Pending sign-out web server stopped', 'system');
      });
      this.server = null;
    }
    return { success: true };
  }

  /**
   * Check if server is running
   */
  isServerRunning() {
    return this.server !== null;
  }

  // ─────────────────────────────────────────────────────────────
  // HTML Templates
  // ─────────────────────────────────────────────────────────────

  generateFormHTML(record, error = null) {
    const signInTime = new Date(record.signInTimestamp);
    const deadline = new Date(record.deadline);

    // Format times for display
    const signInDisplay = signInTime.toLocaleString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
      timeZone: 'America/New_York'
    });

    const deadlineDisplay = deadline.toLocaleString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
      timeZone: 'America/New_York'
    });

    // Get min time (sign-in time in HH:MM format)
    const minTime = signInTime.toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', hour12: false,
      timeZone: 'America/New_York'
    });

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Submit Sign-Out Time - UF Lab Attendance</title>
  <style>
    :root {
      --uf-blue: #0021A5;
      --uf-blue-dark: #001A85;
      --uf-orange: #FA4616;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
      background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%);
      min-height: 100vh;
      padding: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: white;
      border-radius: 16px;
      padding: 40px;
      max-width: 500px;
      width: 100%;
      box-shadow: 0 10px 40px rgba(0,0,0,0.1);
    }
    .logo {
      width: 60px;
      height: 60px;
      background: linear-gradient(135deg, var(--uf-blue), var(--uf-blue-dark));
      border-radius: 12px;
      margin: 0 auto 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 28px;
    }
    h1 {
      color: var(--uf-blue);
      text-align: center;
      margin-bottom: 10px;
      font-size: 24px;
    }
    .subtitle {
      color: #64748b;
      text-align: center;
      margin-bottom: 30px;
    }
    .info-box {
      background: #f8fafc;
      padding: 20px;
      border-radius: 10px;
      margin-bottom: 25px;
    }
    .info-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 10px;
    }
    .info-row:last-child { margin-bottom: 0; }
    .info-label { color: #64748b; font-size: 14px; }
    .info-value { color: #0f172a; font-weight: 600; font-size: 14px; }
    .error {
      background: #fee2e2;
      color: #dc2626;
      padding: 15px;
      border-radius: 8px;
      margin-bottom: 20px;
      font-size: 14px;
    }
    .form-group {
      margin-bottom: 25px;
    }
    label {
      display: block;
      color: #374151;
      font-weight: 600;
      margin-bottom: 8px;
    }
    input[type="time"] {
      width: 100%;
      padding: 14px 16px;
      font-size: 18px;
      border: 2px solid #e2e8f0;
      border-radius: 10px;
      transition: border-color 0.2s;
    }
    input[type="time"]:focus {
      outline: none;
      border-color: var(--uf-blue);
    }
    .btn {
      width: 100%;
      padding: 16px;
      background: linear-gradient(135deg, var(--uf-blue), var(--uf-blue-dark));
      color: white;
      border: none;
      border-radius: 10px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 15px rgba(0,33,165,0.4);
    }
    .warning {
      background: #FFF4E6;
      border-left: 4px solid var(--uf-orange);
      padding: 15px;
      border-radius: 0 8px 8px 0;
      margin-top: 25px;
      font-size: 13px;
      color: #92400e;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">&#127891;</div>
    <h1>Submit Sign-Out Time</h1>
    <p class="subtitle">Hello, <strong>${record.name}</strong></p>

    <div class="info-box">
      <div class="info-row">
        <span class="info-label">Sign-in time</span>
        <span class="info-value">${signInDisplay}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Deadline</span>
        <span class="info-value">${deadlineDisplay} ET</span>
      </div>
    </div>

    ${error ? `<div class="error">${error}</div>` : ''}

    <form method="POST" action="/signout/${record.token}">
      <div class="form-group">
        <label for="signOutTime">What time did you leave?</label>
        <input type="time" id="signOutTime" name="signOutTime" required min="${minTime}" max="23:59">
      </div>
      <button type="submit" class="btn">Submit Sign-Out Time</button>
    </form>

    <div class="warning">
      <strong>Important:</strong> If you don't respond by the deadline, your session will be marked as "present only" with 0 hours credit.
    </div>
  </div>
</body>
</html>
    `;
  }

  generateSuccessHTML(record, hoursWorked) {
    const signInTime = new Date(record.signInTimestamp);
    const signOutTime = new Date(record.submittedSignOutTime);

    const signInDisplay = signInTime.toLocaleString('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true,
      timeZone: 'America/New_York'
    });

    const signOutDisplay = signOutTime.toLocaleString('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true,
      timeZone: 'America/New_York'
    });

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Success - UF Lab Attendance</title>
  <style>
    :root { --uf-blue: #0021A5; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
      background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%);
      min-height: 100vh;
      padding: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: white;
      border-radius: 16px;
      padding: 40px;
      max-width: 500px;
      width: 100%;
      box-shadow: 0 10px 40px rgba(0,0,0,0.1);
      text-align: center;
    }
    .success-icon {
      width: 80px;
      height: 80px;
      background: linear-gradient(135deg, #10b981, #059669);
      border-radius: 50%;
      margin: 0 auto 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 40px;
      color: white;
    }
    h1 {
      color: #10b981;
      margin-bottom: 10px;
    }
    .subtitle {
      color: #64748b;
      margin-bottom: 30px;
    }
    .info-box {
      background: #f8fafc;
      padding: 20px;
      border-radius: 10px;
      text-align: left;
    }
    .info-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 12px;
      padding-bottom: 12px;
      border-bottom: 1px solid #e2e8f0;
    }
    .info-row:last-child { margin-bottom: 0; padding-bottom: 0; border: none; }
    .info-label { color: #64748b; }
    .info-value { color: #0f172a; font-weight: 600; }
    .hours-highlight {
      background: linear-gradient(135deg, var(--uf-blue), #001A85);
      color: white;
      padding: 3px 12px;
      border-radius: 20px;
      font-size: 16px;
    }
    .close-msg {
      color: #64748b;
      margin-top: 25px;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="success-icon">&#10003;</div>
    <h1>Sign-Out Submitted!</h1>
    <p class="subtitle">Thank you, ${record.name}</p>

    <div class="info-box">
      <div class="info-row">
        <span class="info-label">Sign-in</span>
        <span class="info-value">${signInDisplay}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Sign-out</span>
        <span class="info-value">${signOutDisplay}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Hours worked</span>
        <span class="info-value"><span class="hours-highlight">${hoursWorked.toFixed(2)} hours</span></span>
      </div>
    </div>

    <p class="close-msg">You may now close this window.</p>
  </div>
</body>
</html>
    `;
  }

  generateErrorHTML(message) {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Error - UF Lab Attendance</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
      background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%);
      min-height: 100vh;
      padding: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: white;
      border-radius: 16px;
      padding: 40px;
      max-width: 500px;
      width: 100%;
      box-shadow: 0 10px 40px rgba(0,0,0,0.1);
      text-align: center;
    }
    .error-icon {
      width: 80px;
      height: 80px;
      background: linear-gradient(135deg, #ef4444, #dc2626);
      border-radius: 50%;
      margin: 0 auto 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 40px;
      color: white;
    }
    h1 {
      color: #dc2626;
      margin-bottom: 20px;
    }
    .message {
      color: #374151;
      line-height: 1.6;
      margin-bottom: 25px;
    }
    .help {
      color: #64748b;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="error-icon">&#10005;</div>
    <h1>Error</h1>
    <p class="message">${message}</p>
    <p class="help">Please contact the lab administrator if you need assistance.</p>
  </div>
</body>
</html>
    `;
  }
}

module.exports = PendingSignoutService;
