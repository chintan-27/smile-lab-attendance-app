/**
 * UF Lab Attendance Cloud API
 *
 * Deployed on Vercel, uses Upstash Redis for storage
 * Handles:
 * - Student sign-out form submissions
 * - Secure web admin dashboard
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { Redis } = require('@upstash/redis');

// Routes
const adminRoutes = require('./routes/admin');
const adminDataRoutes = require('./routes/adminData');

// Auth middleware
const { checkAuth, requireAuth } = require('./middleware/auth');

const app = express();

// Security headers (relaxed CSP for admin dashboard)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"]
    }
  }
}));

app.use(cors());
app.use(cookieParser());
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.json({ limit: '50mb' }));

// Serve static files from public directory
app.use('/static', express.static(path.join(__dirname, 'public')));

// Mount admin authentication routes
app.use('/api/admin', adminRoutes);

// Mount admin data routes (requires auth, handled in router)
app.use('/api/admin/data', adminDataRoutes);

// Initialize Upstash Redis (set these in Vercel environment variables)
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const PENDING_KEY = 'pending_signouts';

// ─────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────

async function getPendingSignouts() {
  try {
    const data = await redis.get(PENDING_KEY);
    return data || [];
  } catch (err) {
    console.error('Error reading pending signouts:', err);
    return [];
  }
}

async function savePendingSignouts(data) {
  try {
    await redis.set(PENDING_KEY, data);
    return true;
  } catch (err) {
    console.error('Error saving pending signouts:', err);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// API Routes
// ─────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'pending-signout-api' });
});

// Get all pending records (for Electron app to sync)
app.get('/api/pending', async (req, res) => {
  try {
    const pending = await getPendingSignouts();
    res.json({ success: true, pending });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create a new pending record (called by Electron app)
app.post('/api/pending', async (req, res) => {
  try {
    const record = req.body;

    if (!record.id || !record.ufid || !record.token) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const pending = await getPendingSignouts();

    // Check if already exists
    const existing = pending.find(p => p.id === record.id);
    if (existing) {
      return res.json({ success: true, message: 'Record already exists', record: existing });
    }

    pending.push(record);
    await savePendingSignouts(pending);

    res.json({ success: true, record });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update a pending record (for resolution sync)
app.put('/api/pending/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const pending = await getPendingSignouts();
    const index = pending.findIndex(p => p.id === id);

    if (index === -1) {
      return res.status(404).json({ success: false, error: 'Record not found' });
    }

    pending[index] = { ...pending[index], ...updates };
    await savePendingSignouts(pending);

    res.json({ success: true, record: pending[index] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete resolved/expired records older than 7 days (cleanup)
app.delete('/api/pending/cleanup', async (req, res) => {
  try {
    const pending = await getPendingSignouts();
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    const filtered = pending.filter(p => {
      if (p.status === 'pending') return true;
      const resolvedAt = new Date(p.resolvedAt).getTime();
      return resolvedAt > sevenDaysAgo;
    });

    await savePendingSignouts(filtered);
    res.json({ success: true, removed: pending.length - filtered.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Sign-Out Form Routes (Student-facing)
// ─────────────────────────────────────────────────────────────

// GET: Display sign-out form
app.get('/signout/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const pending = await getPendingSignouts();
    const record = pending.find(p => p.token === token);

    if (!record) {
      return res.status(404).send(generateErrorHTML('Invalid or expired link. This sign-out request was not found.'));
    }

    if (record.status !== 'pending') {
      return res.status(400).send(generateErrorHTML('This sign-out has already been submitted.'));
    }

    const now = new Date();
    if (now > new Date(record.deadline)) {
      return res.status(400).send(generateErrorHTML('The deadline has passed. Your attendance has been marked as "present only" with 0 hours. Please contact the lab administrator if you believe this is an error.'));
    }

    res.send(generateFormHTML(record));
  } catch (err) {
    console.error('Error serving form:', err);
    res.status(500).send(generateErrorHTML('An error occurred. Please try again.'));
  }
});

// POST: Submit sign-out time
app.post('/signout/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const { signOutTime } = req.body;

    const pending = await getPendingSignouts();
    const record = pending.find(p => p.token === token);

    if (!record) {
      return res.status(404).send(generateErrorHTML('Invalid or expired link.'));
    }

    if (!signOutTime) {
      return res.send(generateFormHTML(record, 'Please enter a valid sign-out time.'));
    }

    if (record.status !== 'pending') {
      return res.status(400).send(generateErrorHTML('This sign-out has already been submitted.'));
    }

    const now = new Date();
    const deadline = new Date(record.deadline);
    if (now > deadline) {
      return res.status(400).send(generateErrorHTML('The deadline has passed. Please contact the lab administrator.'));
    }

    // Parse and validate the sign-out time
    // The signInTimestamp is stored in UTC, but we need to work in ET timezone
    const signInDate = new Date(record.signInTimestamp);
    let signOutDate;

    if (/^\d{2}:\d{2}$/.test(signOutTime)) {
      const [hours, minutes] = signOutTime.split(':').map(Number);

      // Get the sign-in date components in ET timezone
      const signInET = new Date(signInDate.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const signInYear = signInET.getFullYear();
      const signInMonth = signInET.getMonth();
      const signInDay = signInET.getDate();

      // Create the sign-out date in UTC by constructing it properly
      // User input is in ET timezone, so we need to convert to UTC
      // Use toLocaleString trick to get the ET offset for that specific date
      const tempDate = new Date(Date.UTC(signInYear, signInMonth, signInDay, hours, minutes, 0));
      const etString = tempDate.toLocaleString('en-US', { timeZone: 'America/New_York' });
      const utcString = tempDate.toLocaleString('en-US', { timeZone: 'UTC' });
      const etOffset = (new Date(utcString) - new Date(etString)) / 60000; // minutes difference

      // The user entered time in ET, so create UTC by adding the offset
      signOutDate = new Date(Date.UTC(signInYear, signInMonth, signInDay, hours, minutes, 0));
      signOutDate.setMinutes(signOutDate.getMinutes() + etOffset);
    } else {
      signOutDate = new Date(signOutTime);
    }

    // Validation - compare in ET timezone to ensure same calendar day
    const signInETStr = signInDate.toLocaleDateString('en-US', { timeZone: 'America/New_York' });
    const signOutETStr = signOutDate.toLocaleDateString('en-US', { timeZone: 'America/New_York' });

    if (signOutDate <= signInDate) {
      return res.send(generateFormHTML(record, 'Sign-out time must be after your sign-in time.'));
    }

    if (signInETStr !== signOutETStr) {
      return res.send(generateFormHTML(record, 'Sign-out time must be on the same day as sign-in.'));
    }

    // Update the record
    record.status = 'resolved';
    record.resolvedAt = now.toISOString();
    record.submittedSignOutTime = signOutDate.toISOString();
    record.resolvedBy = 'student';

    await savePendingSignouts(pending);

    // Calculate hours worked
    const hoursWorked = (signOutDate - signInDate) / (1000 * 60 * 60);

    res.send(generateSuccessHTML(record, hoursWorked));
  } catch (err) {
    console.error('Error processing submission:', err);
    res.status(500).send(generateErrorHTML('An error occurred while processing your submission. Please try again.'));
  }
});

// ─────────────────────────────────────────────────────────────
// HTML Templates
// ─────────────────────────────────────────────────────────────

function generateFormHTML(record, error = null) {
  const signInTime = new Date(record.signInTimestamp);
  const deadline = new Date(record.deadline);

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
      flex-wrap: wrap;
      gap: 5px;
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
    <div class="logo">🎓</div>
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

function generateSuccessHTML(record, hoursWorked) {
  const signInTime = new Date(record.signInTimestamp);
  const signOutTime = new Date(record.submittedSignOutTime);

  const signInDisplay = signInTime.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'America/New_York'
  });

  const signOutDisplay = signOutTime.toLocaleTimeString('en-US', {
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
    <div class="success-icon">✓</div>
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

function generateErrorHTML(message) {
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
    <div class="error-icon">✕</div>
    <h1>Error</h1>
    <p class="message">${message}</p>
    <p class="help">Please contact the lab administrator if you need assistance.</p>
  </div>
</body>
</html>
  `;
}

// ─────────────────────────────────────────────────────────────
// Admin Dashboard Routes
// ─────────────────────────────────────────────────────────────

// Login page
app.get('/login', checkAuth, (req, res) => {
  // If already authenticated, redirect to dashboard
  if (req.isAuthenticated) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Root route - Admin Dashboard (requires auth)
app.get('/', checkAuth, (req, res) => {
  // If not authenticated, redirect to login
  if (!req.isAuthenticated) {
    return res.redirect('/login');
  }
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ─────────────────────────────────────────────────────────────
// Server Start
// ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

// For local development
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Pending signout API running on port ${PORT}`);
  });
}

// For Vercel serverless
module.exports = app;
