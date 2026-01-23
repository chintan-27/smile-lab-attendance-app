/**
 * Admin Data Routes
 *
 * Handles:
 * - Students CRUD
 * - Attendance records
 * - Dashboard statistics
 * - Pending sign-outs management
 *
 * All routes require authentication
 */

const express = require('express');
const router = express.Router();
const { Redis } = require('@upstash/redis');
const { requireAuth } = require('../middleware/auth');

// Apply auth to all routes
router.use(requireAuth);

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

// ─────────────────────────────────────────────────────────────
// Data Sync API (accepts API key or JWT auth)
// ─────────────────────────────────────────────────────────────

/**
 * Middleware to verify API key for sync endpoints
 */
function verifyApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  const expectedKey = process.env.SYNC_API_KEY;

  if (expectedKey && apiKey === expectedKey) {
    return next();
  }

  // Fall through to requireAuth if no valid API key
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

module.exports = router;
