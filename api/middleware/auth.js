/**
 * Authentication Middleware for Web Admin Dashboard
 *
 * Provides:
 * - JWT token verification from httpOnly cookies
 * - Rate limiting on login attempts
 * - Token generation
 */

const jwt = require('jsonwebtoken');
const { Ratelimit } = require('@upstash/ratelimit');
const { Redis } = require('@upstash/redis');

// JWT configuration
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const JWT_EXPIRY = '8h'; // 8 hours
const COOKIE_NAME = 'admin_token';

// Initialize rate limiter with Upstash Redis
let ratelimit = null;

function initRateLimit() {
  if (ratelimit) return ratelimit;

  try {
    const redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });

    ratelimit = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(5, '15 m'), // 5 attempts per 15 minutes
      analytics: true,
      prefix: 'ratelimit:admin:login',
    });

    return ratelimit;
  } catch (error) {
    console.error('Failed to initialize rate limiter:', error);
    return null;
  }
}

/**
 * Generate a JWT token for an authenticated admin
 * @param {Object} payload - Token payload (e.g., { username })
 * @returns {string} JWT token
 */
function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

/**
 * Verify a JWT token
 * @param {string} token - JWT token to verify
 * @returns {Object|null} Decoded payload or null if invalid
 */
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

/**
 * Middleware: Require authentication
 * Checks for valid JWT in httpOnly cookie
 */
function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];

  if (!token) {
    // For API requests, return 401
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    // For page requests, redirect to login
    return res.redirect('/login');
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    // Clear invalid cookie
    res.clearCookie(COOKIE_NAME, getCookieOptions());

    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }
    return res.redirect('/login');
  }

  // Attach user info to request
  req.admin = decoded;
  next();
}

/**
 * Middleware: Rate limit login attempts
 * Uses IP address as identifier
 */
async function loginRateLimit(req, res, next) {
  const limiter = initRateLimit();

  if (!limiter) {
    // If rate limiter not available, allow the request but log warning
    console.warn('Rate limiter not available, allowing request');
    return next();
  }

  // Get client IP (handle proxies like Vercel)
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.ip
    || req.connection.remoteAddress
    || 'unknown';

  try {
    const { success, limit, reset, remaining } = await limiter.limit(ip);

    // Set rate limit headers
    res.setHeader('X-RateLimit-Limit', limit);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', reset);

    if (!success) {
      const retryAfter = Math.ceil((reset - Date.now()) / 1000);
      res.setHeader('Retry-After', retryAfter);

      return res.status(429).json({
        success: false,
        error: 'Too many login attempts. Please try again later.',
        retryAfter
      });
    }

    next();
  } catch (error) {
    console.error('Rate limit check failed:', error);
    // On error, allow the request but log
    next();
  }
}

/**
 * Set the authentication cookie
 * @param {Object} res - Express response object
 * @param {string} token - JWT token
 */
function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, getCookieOptions());
}

/**
 * Clear the authentication cookie
 * @param {Object} res - Express response object
 */
function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, getCookieOptions());
}

/**
 * Get cookie options for secure httpOnly cookies
 */
function getCookieOptions() {
  const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL;

  return {
    httpOnly: true,
    secure: isProduction, // HTTPS only in production
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000, // 8 hours in milliseconds
    path: '/'
  };
}

/**
 * Middleware: Check if user is authenticated (non-blocking)
 * Useful for conditional rendering
 */
function checkAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];

  if (token) {
    const decoded = verifyToken(token);
    if (decoded) {
      req.admin = decoded;
      req.isAuthenticated = true;
    } else {
      req.isAuthenticated = false;
    }
  } else {
    req.isAuthenticated = false;
  }

  next();
}

module.exports = {
  generateToken,
  verifyToken,
  requireAuth,
  loginRateLimit,
  setAuthCookie,
  clearAuthCookie,
  checkAuth,
  COOKIE_NAME,
  JWT_SECRET
};
