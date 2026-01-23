/**
 * Admin Authentication Routes
 *
 * Handles:
 * - Login/Logout
 * - Auth status check
 * - Password changes
 */

const express = require('express');
const router = express.Router();

const {
  generateToken,
  loginRateLimit,
  setAuthCookie,
  clearAuthCookie,
  requireAuth
} = require('../middleware/auth');

const adminService = require('../services/adminService');

/**
 * POST /api/admin/init
 * Initialize/reset credentials from environment (temporary setup endpoint)
 * Remove after initial setup!
 */
router.post('/init', async (req, res) => {
  try {
    const result = await adminService.resetCredentialsFromEnv();
    res.json(result);
  } catch (error) {
    console.error('Init error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/login
 * Authenticate admin and set session cookie
 */
router.post('/login', loginRateLimit, async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        error: 'Username and password are required'
      });
    }

    const result = await adminService.verifyAdminPassword(username, password);

    if (!result.success) {
      return res.status(401).json({
        success: false,
        error: result.error || 'Invalid credentials'
      });
    }

    // Generate JWT token
    const token = generateToken({ username: result.username });

    // Set httpOnly cookie
    setAuthCookie(res, token);

    res.json({
      success: true,
      message: 'Login successful',
      username: result.username
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      error: 'Authentication service error'
    });
  }
});

/**
 * POST /api/admin/logout
 * Clear session cookie
 */
router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({
    success: true,
    message: 'Logged out successfully'
  });
});

/**
 * GET /api/admin/me
 * Check authentication status
 */
router.get('/me', requireAuth, async (req, res) => {
  try {
    const info = await adminService.getAdminInfo();

    res.json({
      success: true,
      authenticated: true,
      username: req.admin.username,
      info: info.success ? {
        createdAt: info.createdAt,
        updatedAt: info.updatedAt
      } : null
    });
  } catch (error) {
    console.error('Get me error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get user info'
    });
  }
});

/**
 * POST /api/admin/change-password
 * Change admin password (requires current password)
 */
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        error: 'Current password and new password are required'
      });
    }

    const result = await adminService.changeAdminPassword(currentPassword, newPassword);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error
      });
    }

    res.json({
      success: true,
      message: 'Password changed successfully'
    });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to change password'
    });
  }
});

/**
 * POST /api/admin/reset-credentials
 * Force reset credentials from environment variables (requires API key)
 */
router.post('/reset-credentials', async (req, res) => {
  try {
    // Verify API key for this sensitive operation
    const apiKey = req.headers['x-api-key'];
    const expectedKey = process.env.SYNC_API_KEY;

    if (!expectedKey || apiKey !== expectedKey) {
      return res.status(403).json({
        success: false,
        error: 'Invalid API key'
      });
    }

    const result = await adminService.resetCredentialsFromEnv();

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error
      });
    }

    res.json({
      success: true,
      message: result.message
    });
  } catch (error) {
    console.error('Reset credentials error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to reset credentials'
    });
  }
});

/**
 * POST /api/admin/sync-credentials
 * Sync credentials from Electron app (requires API key)
 * Used when admin changes password in Electron, sync to web
 */
router.post('/sync-credentials', async (req, res) => {
  try {
    // Verify API key for this sensitive operation
    const apiKey = req.headers['x-api-key'];
    const expectedKey = process.env.SYNC_API_KEY;

    if (!expectedKey || apiKey !== expectedKey) {
      return res.status(403).json({
        success: false,
        error: 'Invalid API key'
      });
    }

    const { username, passwordHash } = req.body;

    if (!username || !passwordHash) {
      return res.status(400).json({
        success: false,
        error: 'Username and passwordHash are required'
      });
    }

    const result = await adminService.syncCredentials(username, passwordHash);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error
      });
    }

    res.json({
      success: true,
      message: 'Credentials synced successfully'
    });
  } catch (error) {
    console.error('Sync credentials error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to sync credentials'
    });
  }
});

module.exports = router;
