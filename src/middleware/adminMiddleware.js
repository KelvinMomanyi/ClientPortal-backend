const jwt = require('jsonwebtoken');

/**
 * Admin authentication middleware.
 * Validates the requests coming from the Admin Dashboard running inside Monday.com.
 * Uses Monday.com's Seamless Authentication by verifying the sessionToken
 * with the MONDAY_CLIENT_SECRET.
 */
function authenticateAdmin(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Monday session token required' });
  }

  const token = authHeader.split(' ')[1];
  const clientSecret = process.env.MONDAY_CLIENT_SECRET;
  const localAdminToken = process.env.LOCAL_ADMIN_TOKEN;

  if (process.env.NODE_ENV !== 'production' && localAdminToken && token === localAdminToken) {
    req.mondayAccountId = Number(process.env.LOCAL_ADMIN_ACCOUNT_ID || process.env.MONDAY_TEST_ACCOUNT_ID || 123456789);
    req.mondayUserId = 'local-dev';
    return next();
  }

  if (!clientSecret) {
    console.error('Missing MONDAY_CLIENT_SECRET in environment.');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  try {
    const decoded = jwt.verify(token, clientSecret);
    
    // The seamless auth token contains accountId, userId, dataviewId, etc.
    if (!decoded.accountId) {
       return res.status(401).json({ error: 'Invalid token payload' });
    }

    req.mondayAccountId = decoded.accountId;
    req.mondayUserId = decoded.userId;

    return next();
  } catch (err) {
    console.error('Monday seamless auth verification failed:', err.message);
    return res.status(403).json({ error: 'Invalid or expired Monday token' });
  }
}

module.exports = { authenticateAdmin };
