/**
 * Admin Data Routes
 *
 * Handles:
 * - Students CRUD
 * - Attendance records
 * - Dashboard statistics
 * - Pending sign-outs management
 *
 * All routes require authentication (except sync endpoints which use API key)
 */

const express = require('express');
const router = express.Router();
const { Redis } = require('@upstash/redis');
const { requireAuth } = require('../middleware/auth');

// Redis keys
const STUDENTS_KEY = 'students';
const ATTENDANCE_KEY = 'attendance';
const PENDING_KEY = 'pending_signouts';

// Initialize Redis
let redis = null;

function getRedis() {
  if (redis) return redis;
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  return redis;
}

// ─────────────────────────────────────────────────────────────
// Data Sync API (API key auth - MUST be before requireAuth middleware)
// ─────────────────────────────────────────────────────────────

/**
 * Middleware to verify API key for sync endpoints
 */
function verifyApiKey(req, res, next) {
  const apiKey = (req.headers['x-api-key'] || '').trim();
  const expectedKey = (process.env.SYNC_API_KEY || '').trim();

  // Debug: check if env var is set
  if (!expectedKey) {
    return res.status(403).json({ success: false, error: 'SYNC_API_KEY not configured on server' });
  }

  if (apiKey === expectedKey) {
    return next();
  }

  return res.status(403).json({ success: false, error: 'Invalid API key' });
}

/**
 * GET /api/admin/data/sync/health
 * Health check endpoint for testing connection (requires API key)
 */
router.get('/sync/health', verifyApiKey, async (req, res) => {
  res.json({ success: true, message: 'Connection successful', timestamp: new Date().toISOString() });
});

/**
 * POST /api/admin/data/sync/students
 * Sync students from Electron app (requires API key)
 */
router.post('/sync/students', verifyApiKey, async (req, res) => {
  try {
    const r = getRedis();
    const { students } = req.body;

    if (!Array.isArray(students)) {
      return res.status(400).json({ success: false, error: 'Students array required' });
    }

    await r.set(STUDENTS_KEY, students);

    res.json({ success: true, count: students.length });
  } catch (error) {
    console.error('Sync students error:', error);
    res.status(500).json({ success: false, error: 'Failed to sync students' });
  }
});

/**
 * POST /api/admin/data/sync/attendance
 * Sync attendance from Electron app (requires API key)
 */
router.post('/sync/attendance', verifyApiKey, async (req, res) => {
  try {
    const r = getRedis();
    const { attendance } = req.body;

    if (!Array.isArray(attendance)) {
      return res.status(400).json({ success: false, error: 'Attendance array required' });
    }

    await r.set(ATTENDANCE_KEY, attendance);

    res.json({ success: true, count: attendance.length });
  } catch (error) {
    console.error('Sync attendance error:', error);
    res.status(500).json({ success: false, error: 'Failed to sync attendance' });
  }
});

// ─────────────────────────────────────────────────────────────
// Apply auth to all remaining routes
// ─────────────────────────────────────────────────────────────
router.use(requireAuth);

// ─────────────────────────────────────────────────────────────
// Students API
// ─────────────────────────────────────────────────────────────

/**
 * GET /api/admin/data/students
 * Get all students with optional pagination and filtering
 */
router.get('/students', async (req, res) => {
  try {
    const r = getRedis();
    const students = await r.get(STUDENTS_KEY) || [];

    const { page = 1, pageSize = 50, search = '' } = req.query;
    const pageNum = parseInt(page);
    const size = parseInt(pageSize);

    // Filter by search
    let filtered = students;
    if (search) {
      const searchLower = search.toLowerCase();
      filtered = students.filter(s =>
        s.name?.toLowerCase().includes(searchLower) ||
        s.ufid?.includes(search) ||
        s.email?.toLowerCase().includes(searchLower)
      );
    }

    // Paginate
    const totalCount = filtered.length;
    const startIndex = (pageNum - 1) * size;
    const paginated = filtered.slice(startIndex, startIndex + size);

    res.json({
      success: true,
      students: paginated,
      totalCount,
      page: pageNum,
      pageSize: size,
      totalPages: Math.ceil(totalCount / size)
    });
  } catch (error) {
    console.error('Get students error:', error);
    res.status(500).json({ success: false, error: 'Failed to get students' });
  }
});

/**
 * POST /api/admin/data/students
 * Add or update a student
 */
router.post('/students', async (req, res) => {
  try {
    const r = getRedis();
    const student = req.body;

    if (!student.ufid || !student.name) {
      return res.status(400).json({ success: false, error: 'UFID and name are required' });
    }

    const students = await r.get(STUDENTS_KEY) || [];
    const existingIndex = students.findIndex(s => s.ufid === student.ufid);

    const newStudent = {
      ufid: student.ufid,
      name: student.name,
      email: student.email || '',
      role: student.role || 'volunteer',
      expectedHoursPerWeek: student.expectedHoursPerWeek || 0,
      expectedDaysPerWeek: student.expectedDaysPerWeek || 0,
      active: student.active !== false,
      addedDate: existingIndex >= 0 ? students[existingIndex].addedDate : new Date().toISOString()
    };

    if (existingIndex >= 0) {
      students[existingIndex] = newStudent;
    } else {
      students.push(newStudent);
    }

    await r.set(STUDENTS_KEY, students);

    res.json({
      success: true,
      student: newStudent,
      message: existingIndex >= 0 ? 'Student updated' : 'Student added'
    });
  } catch (error) {
    console.error('Add/update student error:', error);
    res.status(500).json({ success: false, error: 'Failed to save student' });
  }
});

/**
 * DELETE /api/admin/data/students/:ufid
 * Remove a student
 */
router.delete('/students/:ufid', async (req, res) => {
  try {
    const r = getRedis();
    const { ufid } = req.params;

    const students = await r.get(STUDENTS_KEY) || [];
    const newStudents = students.filter(s => s.ufid !== ufid);

    if (newStudents.length === students.length) {
      return res.status(404).json({ success: false, error: 'Student not found' });
    }

    await r.set(STUDENTS_KEY, newStudents);

    res.json({ success: true, message: 'Student removed' });
  } catch (error) {
    console.error('Remove student error:', error);
    res.status(500).json({ success: false, error: 'Failed to remove student' });
  }
});

// ─────────────────────────────────────────────────────────────
// Attendance API
// ─────────────────────────────────────────────────────────────

/**
 * GET /api/admin/data/attendance
 * Get attendance records with pagination and filtering
 */
router.get('/attendance', async (req, res) => {
  try {
    const r = getRedis();
    const attendance = await r.get(ATTENDANCE_KEY) || [];

    const {
      page = 1,
      pageSize = 50,
      search = '',
      startDate = '',
      endDate = '',
      action = ''
    } = req.query;

    const pageNum = parseInt(page);
    const size = parseInt(pageSize);

    // Filter
    let filtered = attendance;

    if (search) {
      const searchLower = search.toLowerCase();
      filtered = filtered.filter(r =>
        r.name?.toLowerCase().includes(searchLower) ||
        r.ufid?.includes(search)
      );
    }

    if (startDate) {
      const start = new Date(startDate);
      filtered = filtered.filter(r => new Date(r.timestamp) >= start);
    }

    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      filtered = filtered.filter(r => new Date(r.timestamp) <= end);
    }

    if (action) {
      filtered = filtered.filter(r => r.action === action);
    }

    // Sort by timestamp descending
    filtered.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Paginate
    const totalCount = filtered.length;
    const startIndex = (pageNum - 1) * size;
    const paginated = filtered.slice(startIndex, startIndex + size);

    res.json({
      success: true,
      records: paginated,
      totalCount,
      page: pageNum,
      pageSize: size,
      totalPages: Math.ceil(totalCount / size)
    });
  } catch (error) {
    console.error('Get attendance error:', error);
    res.status(500).json({ success: false, error: 'Failed to get attendance' });
  }
});

/**
 * DELETE /api/admin/data/attendance/:id
 * Delete an attendance record
 */
router.delete('/attendance/:id', async (req, res) => {
  try {
    const r = getRedis();
    const { id } = req.params;
    const recordId = parseInt(id) || id;

    const attendance = await r.get(ATTENDANCE_KEY) || [];
    const newAttendance = attendance.filter(r => r.id !== recordId && String(r.id) !== String(id));

    if (newAttendance.length === attendance.length) {
      return res.status(404).json({ success: false, error: 'Record not found' });
    }

    await r.set(ATTENDANCE_KEY, newAttendance);

    res.json({ success: true, message: 'Record deleted' });
  } catch (error) {
    console.error('Delete attendance error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete record' });
  }
});

// ─────────────────────────────────────────────────────────────
// Statistics API
// ─────────────────────────────────────────────────────────────

/**
 * GET /api/admin/data/stats
 * Get dashboard statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const r = getRedis();
    const [students, attendance, pending] = await Promise.all([
      r.get(STUDENTS_KEY) || [],
      r.get(ATTENDANCE_KEY) || [],
      r.get(PENDING_KEY) || []
    ]);

    // Get today's date in ET
    const now = new Date();
    const todayET = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const todayStart = new Date(todayET);
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(todayET);
    todayEnd.setHours(23, 59, 59, 999);

    // Today's attendance
    const todaysRecords = attendance.filter(r => {
      const ts = new Date(r.timestamp);
      return ts >= todayStart && ts <= todayEnd;
    });

    // Currently signed in (signin without signout today)
    const signInsByUfid = new Map();
    todaysRecords.forEach(r => {
      if (r.action === 'signin') {
        signInsByUfid.set(r.ufid, true);
      } else if (r.action === 'signout') {
        signInsByUfid.delete(r.ufid);
      }
    });
    const currentlySignedIn = signInsByUfid.size;

    // Weekly stats
    const weekStart = new Date(todayET);
    weekStart.setDate(weekStart.getDate() - 7);
    const weeklyRecords = attendance.filter(r => new Date(r.timestamp) >= weekStart);

    // Pending signouts
    const pendingCount = pending.filter(p => p.status === 'pending').length;

    res.json({
      success: true,
      stats: {
        totalStudents: students.length,
        activeStudents: students.filter(s => s.active !== false).length,
        currentlySignedIn,
        todaysVisits: new Set(todaysRecords.filter(r => r.action === 'signin').map(r => r.ufid)).size,
        weeklyVisits: new Set(weeklyRecords.filter(r => r.action === 'signin').map(r => r.ufid)).size,
        totalRecords: attendance.length,
        pendingSignouts: pendingCount
      }
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ success: false, error: 'Failed to get statistics' });
  }
});

/**
 * GET /api/admin/data/charts
 * Get chart data for dashboard
 */
router.get('/charts', async (req, res) => {
  try {
    const r = getRedis();
    const [students, attendance] = await Promise.all([
      r.get(STUDENTS_KEY) || [],
      r.get(ATTENDANCE_KEY) || []
    ]);

    // Get last 7 days in ET
    const now = new Date();
    const todayET = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));

    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date(todayET);
      date.setDate(date.getDate() - i);
      date.setHours(0, 0, 0, 0);
      last7Days.push(date);
    }

    // Calculate sign-ins and sign-outs per day
    const weeklyData = last7Days.map(day => {
      const dayEnd = new Date(day);
      dayEnd.setHours(23, 59, 59, 999);

      const dayRecords = attendance.filter(r => {
        const ts = new Date(r.timestamp);
        return ts >= day && ts <= dayEnd;
      });

      return {
        date: day.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' }),
        fullDate: day.toISOString().split('T')[0],
        signIns: dayRecords.filter(r => r.action === 'signin').length,
        signOuts: dayRecords.filter(r => r.action === 'signout').length
      };
    });

    // Top students by sign-ins this week
    const weekStart = new Date(todayET);
    weekStart.setDate(weekStart.getDate() - 7);

    const weeklySignIns = attendance.filter(r =>
      r.action === 'signin' && new Date(r.timestamp) >= weekStart
    );

    const studentCounts = {};
    weeklySignIns.forEach(r => {
      const key = r.name || r.ufid;
      studentCounts[key] = (studentCounts[key] || 0) + 1;
    });

    const topStudents = Object.entries(studentCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));

    res.json({
      success: true,
      weeklyData,
      topStudents
    });
  } catch (error) {
    console.error('Get charts error:', error);
    res.status(500).json({ success: false, error: 'Failed to get chart data' });
  }
});

/**
 * GET /api/admin/data/student-hours
 * Get student hours for a specific date
 */
router.get('/student-hours', async (req, res) => {
  try {
    const r = getRedis();
    const [students, attendance] = await Promise.all([
      r.get(STUDENTS_KEY) || [],
      r.get(ATTENDANCE_KEY) || []
    ]);

    // Parse date from query or use today (format: YYYY-MM-DD)
    let targetDateStr;
    if (req.query.date) {
      targetDateStr = req.query.date; // Expected: "2024-01-15"
    } else {
      // Get today in ET timezone
      const now = new Date();
      targetDateStr = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // en-CA gives YYYY-MM-DD
    }

    console.log('Student hours request - targetDateStr:', targetDateStr);
    console.log('Total attendance records:', attendance.length);

    // Filter attendance for the target date by comparing date strings in ET
    const dayRecords = attendance.filter(record => {
      const ts = new Date(record.timestamp);
      const recordDateStr = ts.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      return recordDateStr === targetDateStr;
    }).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    console.log('Filtered day records:', dayRecords.length);
    if (attendance.length > 0) {
      // Log a few sample dates for debugging
      const sampleDates = attendance.slice(0, 5).map(r => {
        const ts = new Date(r.timestamp);
        return ts.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      });
      console.log('Sample record dates in ET:', sampleDates);
    }

    // Group by student and calculate hours
    const studentHours = {};
    const studentSessions = {};

    dayRecords.forEach(record => {
      const ufid = record.ufid;
      if (!studentSessions[ufid]) {
        studentSessions[ufid] = { signIn: null, sessions: [] };
      }

      if (record.action === 'signin') {
        studentSessions[ufid].signIn = new Date(record.timestamp);
      } else if (record.action === 'signout' && studentSessions[ufid].signIn) {
        const signOut = new Date(record.timestamp);
        const hours = (signOut - studentSessions[ufid].signIn) / (1000 * 60 * 60);
        studentSessions[ufid].sessions.push({
          in: studentSessions[ufid].signIn.toISOString(),
          out: signOut.toISOString(),
          hours: Math.round(hours * 100) / 100
        });
        studentSessions[ufid].signIn = null;
      }
    });

    // Calculate total hours per student
    const results = [];
    Object.keys(studentSessions).forEach(ufid => {
      const student = students.find(s => s.ufid === ufid) || {};
      const sessions = studentSessions[ufid].sessions;
      const totalHours = sessions.reduce((sum, s) => sum + s.hours, 0);
      const stillSignedIn = studentSessions[ufid].signIn !== null;

      // If still signed in, calculate running hours
      let runningHours = 0;
      if (stillSignedIn) {
        const now = new Date();
        runningHours = (now - studentSessions[ufid].signIn) / (1000 * 60 * 60);
      }

      results.push({
        ufid,
        name: student.name || ufid,
        role: student.role || 'volunteer',
        totalHours: Math.round((totalHours + runningHours) * 100) / 100,
        sessions,
        stillSignedIn
      });
    });

    // Sort by role priority, then by name
    const rolePriority = { 'postdoc': 0, 'phd': 1, 'lead': 2, 'member': 3, 'volunteer': 4 };
    results.sort((a, b) => {
      const roleA = rolePriority[a.role?.toLowerCase()] ?? 4;
      const roleB = rolePriority[b.role?.toLowerCase()] ?? 4;
      if (roleA !== roleB) return roleA - roleB;
      return (a.name || a.ufid).localeCompare(b.name || b.ufid);
    });

    res.json({
      success: true,
      date: targetDateStr,
      studentHours: results
    });
  } catch (error) {
    console.error('Get student hours error:', error);
    res.status(500).json({ success: false, error: 'Failed to get student hours' });
  }
});

/**
 * GET /api/admin/data/weekly-matrix
 * Get weekly hours matrix (hours per student per day)
 */
router.get('/weekly-matrix', async (req, res) => {
  try {
    const r = getRedis();
    const [students, attendance] = await Promise.all([
      r.get(STUDENTS_KEY) || [],
      r.get(ATTENDANCE_KEY) || []
    ]);

    // Parse week start from query or use current week
    let weekStart;
    if (req.query.weekStart) {
      weekStart = new Date(req.query.weekStart);
    } else {
      // Get Monday of current week
      const now = new Date();
      const day = now.getDay();
      const diff = now.getDate() - day + (day === 0 ? -6 : 1);
      weekStart = new Date(now.setDate(diff));
    }
    weekStart.setHours(0, 0, 0, 0);

    // Generate 7 days (Mon-Sun)
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + i);
      days.push(d);
    }

    // Calculate hours per student per day
    const studentMap = new Map();

    // Get date strings for each day in ET timezone
    const dayStrings = days.map(d => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }));

    days.forEach((day, dayIdx) => {
      const targetDateStr = dayStrings[dayIdx];

      // Get records for this day by comparing date strings in ET
      const dayRecords = attendance.filter(record => {
        const ts = new Date(record.timestamp);
        const recordDateStr = ts.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        return recordDateStr === targetDateStr;
      }).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

      // Calculate hours per student for this day
      const sessions = {};
      dayRecords.forEach(record => {
        const ufid = record.ufid;
        if (!sessions[ufid]) {
          sessions[ufid] = { signIn: null, totalHours: 0 };
        }

        if (record.action === 'signin') {
          sessions[ufid].signIn = new Date(record.timestamp);
        } else if (record.action === 'signout' && sessions[ufid].signIn) {
          const hours = (new Date(record.timestamp) - sessions[ufid].signIn) / (1000 * 60 * 60);
          sessions[ufid].totalHours += hours;
          sessions[ufid].signIn = null;
        }
      });

      // Add to student map
      Object.keys(sessions).forEach(ufid => {
        const student = students.find(s => s.ufid === ufid) || {};
        const name = student.name || ufid;

        if (!studentMap.has(name)) {
          studentMap.set(name, {
            name,
            ufid,
            role: student.role || 'volunteer',
            days: [0, 0, 0, 0, 0, 0, 0]
          });
        }

        studentMap.get(name).days[dayIdx] = Math.round(sessions[ufid].totalHours * 100) / 100;
      });
    });

    // Convert to array and sort
    const matrix = Array.from(studentMap.values());
    const rolePriority = { 'postdoc': 0, 'phd': 1, 'lead': 2, 'member': 3, 'volunteer': 4 };
    matrix.sort((a, b) => {
      const roleA = rolePriority[a.role?.toLowerCase()] ?? 4;
      const roleB = rolePriority[b.role?.toLowerCase()] ?? 4;
      if (roleA !== roleB) return roleA - roleB;
      return a.name.localeCompare(b.name);
    });

    // Calculate totals
    matrix.forEach(row => {
      row.total = Math.round(row.days.reduce((sum, h) => sum + h, 0) * 100) / 100;
    });

    res.json({
      success: true,
      weekStart: weekStart.toISOString().split('T')[0],
      weekEnd: days[6].toISOString().split('T')[0],
      dayLabels: days.map(d => d.toLocaleDateString('en-US', { weekday: 'short' })),
      matrix
    });
  } catch (error) {
    console.error('Get weekly matrix error:', error);
    res.status(500).json({ success: false, error: 'Failed to get weekly matrix' });
  }
});

// ─────────────────────────────────────────────────────────────
// Pending Sign-Outs API
// ─────────────────────────────────────────────────────────────

/**
 * GET /api/admin/data/pending
 * Get pending sign-outs
 */
router.get('/pending', async (req, res) => {
  try {
    const r = getRedis();
    const pending = await r.get(PENDING_KEY) || [];

    res.json({
      success: true,
      pending,
      stats: {
        total: pending.length,
        pending: pending.filter(p => p.status === 'pending').length,
        resolved: pending.filter(p => p.status === 'resolved').length,
        expired: pending.filter(p => p.status === 'expired').length
      }
    });
  } catch (error) {
    console.error('Get pending error:', error);
    res.status(500).json({ success: false, error: 'Failed to get pending sign-outs' });
  }
});

/**
 * PUT /api/admin/data/pending/:id
 * Resolve a pending sign-out (admin action)
 */
router.put('/pending/:id', async (req, res) => {
  try {
    const r = getRedis();
    const { id } = req.params;
    const { signOutTime, presentOnly } = req.body;

    const pending = await r.get(PENDING_KEY) || [];
    const record = pending.find(p => p.id === id);

    if (!record) {
      return res.status(404).json({ success: false, error: 'Pending record not found' });
    }

    record.status = 'resolved';
    record.resolvedAt = new Date().toISOString();
    record.resolvedBy = 'admin';

    if (presentOnly) {
      record.presentOnly = true;
      record.submittedSignOutTime = record.signInTimestamp; // 0 hours
    } else if (signOutTime) {
      record.submittedSignOutTime = signOutTime;
    }

    await r.set(PENDING_KEY, pending);

    // Also update attendance record
    const attendance = await r.get(ATTENDANCE_KEY) || [];
    const signoutRecord = attendance.find(a =>
      a.pendingRecordId === id ||
      (a.ufid === record.ufid && a.pendingTimestamp === true)
    );

    if (signoutRecord) {
      signoutRecord.timestamp = record.submittedSignOutTime || record.signInTimestamp;
      signoutRecord.pendingTimestamp = false;
      signoutRecord.resolvedAt = record.resolvedAt;
      await r.set(ATTENDANCE_KEY, attendance);
    }

    res.json({ success: true, record });
  } catch (error) {
    console.error('Resolve pending error:', error);
    res.status(500).json({ success: false, error: 'Failed to resolve pending sign-out' });
  }
});

module.exports = router;
