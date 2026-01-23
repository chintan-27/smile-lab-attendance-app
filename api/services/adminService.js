/**
 * Admin Service for Web Admin Dashboard
 *
 * Handles admin credentials storage and verification using bcrypt
 * Stores credentials in Redis for persistence across deployments
 */

const bcrypt = require('bcryptjs');
const { Redis } = require('@upstash/redis');

const ADMIN_KEY = 'admin_credentials';
const BCRYPT_ROUNDS = 12;

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

/**
 * Initialize admin credentials from environment variables if not already set
 * Called on first login attempt
 * @param {boolean} force - If true, overwrite existing credentials
 */
async function initializeFromEnv(force = false) {
  const r = getRedis();

  // Check if credentials already exist
  const existing = await r.get(ADMIN_KEY);
  if (existing && !force) {
    return { success: true, message: 'Credentials already exist' };
  }

  // Get from environment (trim to handle accidental whitespace/newlines)
  const username = process.env.ADMIN_USERNAME?.trim();
  const password = process.env.ADMIN_PASSWORD?.trim();

  if (!username || !password) {
    return { success: false, error: 'ADMIN_USERNAME and ADMIN_PASSWORD environment variables required' };
  }

  // Hash password and store
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await r.set(ADMIN_KEY, {
    username,
    passwordHash: hash,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  return { success: true, message: force ? 'Credentials reset from environment' : 'Credentials initialized from environment' };
}

/**
 * Force reset credentials from environment variables
 */
async function resetCredentialsFromEnv() {
  return initializeFromEnv(true);
}

/**
 * Verify admin password
 * @param {string} username - Username to verify
 * @param {string} password - Password to verify
 * @returns {Promise<Object>} { success, error? }
 */
async function verifyAdminPassword(username, password) {
  try {
    // Initialize from env if needed
    await initializeFromEnv();

    const r = getRedis();
    const credentials = await r.get(ADMIN_KEY);

    if (!credentials) {
      return { success: false, error: 'Admin credentials not configured' };
    }

    // Check username
    if (credentials.username !== username) {
      return { success: false, error: 'Invalid username or password' };
    }

    // Check password
    const isValid = await bcrypt.compare(password, credentials.passwordHash);
    if (!isValid) {
      return { success: false, error: 'Invalid username or password' };
    }

    return { success: true, username: credentials.username };
  } catch (error) {
    console.error('Password verification error:', error);
    return { success: false, error: 'Authentication service error' };
  }
}

/**
 * Change admin password
 * @param {string} currentPassword - Current password for verification
 * @param {string} newPassword - New password to set
 * @returns {Promise<Object>} { success, error? }
 */
async function changeAdminPassword(currentPassword, newPassword) {
  try {
    const r = getRedis();
    const credentials = await r.get(ADMIN_KEY);

    if (!credentials) {
      return { success: false, error: 'Admin credentials not configured' };
    }

    // Verify current password
    const isValid = await bcrypt.compare(currentPassword, credentials.passwordHash);
    if (!isValid) {
      return { success: false, error: 'Current password is incorrect' };
    }

    // Validate new password
    if (!newPassword || newPassword.length < 8) {
      return { success: false, error: 'New password must be at least 8 characters' };
    }

    // Hash and save new password
    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    credentials.passwordHash = newHash;
    credentials.updatedAt = new Date().toISOString();

    await r.set(ADMIN_KEY, credentials);

    return { success: true, message: 'Password changed successfully' };
  } catch (error) {
    console.error('Password change error:', error);
    return { success: false, error: 'Failed to change password' };
  }
}

/**
 * Get admin info (without password)
 * @returns {Promise<Object>} { success, username, createdAt, updatedAt }
 */
async function getAdminInfo() {
  try {
    const r = getRedis();
    const credentials = await r.get(ADMIN_KEY);

    if (!credentials) {
      return { success: false, error: 'Admin not configured' };
    }

    return {
      success: true,
      username: credentials.username,
      createdAt: credentials.createdAt,
      updatedAt: credentials.updatedAt
    };
  } catch (error) {
    console.error('Get admin info error:', error);
    return { success: false, error: 'Failed to get admin info' };
  }
}

/**
 * Update admin credentials from Electron app
 * Used for syncing credentials between Electron and web
 * @param {string} username - Admin username
 * @param {string} passwordHash - Already hashed password (bcrypt)
 * @returns {Promise<Object>} { success, error? }
 */
async function syncCredentials(username, passwordHash) {
  try {
    const r = getRedis();

    const existing = await r.get(ADMIN_KEY);
    const credentials = {
      username,
      passwordHash,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      syncedFromElectron: true
    };

    await r.set(ADMIN_KEY, credentials);

    return { success: true, message: 'Credentials synced successfully' };
  } catch (error) {
    console.error('Sync credentials error:', error);
    return { success: false, error: 'Failed to sync credentials' };
  }
}

/**
 * Set admin credentials directly (for initial setup)
 * @param {string} username - Admin username
 * @param {string} password - Plain text password (will be hashed)
 * @returns {Promise<Object>} { success, error? }
 */
async function setAdminCredentials(username, password) {
  try {
    if (!username || !password) {
      return { success: false, error: 'Username and password required' };
    }

    if (password.length < 8) {
      return { success: false, error: 'Password must be at least 8 characters' };
    }

    const r = getRedis();
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const existing = await r.get(ADMIN_KEY);
    await r.set(ADMIN_KEY, {
      username,
      passwordHash: hash,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    return { success: true, message: 'Credentials set successfully' };
  } catch (error) {
    console.error('Set credentials error:', error);
    return { success: false, error: 'Failed to set credentials' };
  }
}

module.exports = {
  verifyAdminPassword,
  changeAdminPassword,
  getAdminInfo,
  syncCredentials,
  setAdminCredentials,
  initializeFromEnv,
  resetCredentialsFromEnv
};
