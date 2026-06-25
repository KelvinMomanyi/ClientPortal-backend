const jwt = require('jsonwebtoken');

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function getAdminIdentity(decoded) {
  const accountId = firstDefined(
    decoded.accountId,
    decoded.account_id,
    decoded.account?.id,
    decoded.account?.accountId,
    decoded.account?.account_id,
    decoded.data?.accountId,
    decoded.data?.account_id,
    decoded.dat?.accountId,
    decoded.dat?.account_id,
    decoded.context?.accountId,
    decoded.context?.account_id
  );

  const userId = firstDefined(
    decoded.userId,
    decoded.user_id,
    decoded.user?.id,
    decoded.user?.userId,
    decoded.user?.user_id,
    decoded.data?.userId,
    decoded.data?.user_id,
    decoded.dat?.userId,
    decoded.dat?.user_id,
    decoded.context?.userId,
    decoded.context?.user_id
  );

  if (!accountId) {
    return null;
  }

  return { accountId, userId };
}

function describePayloadShape(decoded) {
  return Object.keys(decoded || {}).sort().join(', ');
}

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

    const identity = getAdminIdentity(decoded);
    if (!identity) {
      console.error('Monday session token missing account id. Payload keys:', describePayloadShape(decoded));
      return res.status(401).json({ error: 'Invalid token payload' });
    }

    req.mondayAccountId = identity.accountId;
    req.mondayUserId = identity.userId;

    return next();
  } catch (err) {
    console.error('Monday seamless auth verification failed:', err.message);
    return res.status(403).json({ error: 'Invalid or expired Monday token' });
  }
}

module.exports = { authenticateAdmin, getAdminIdentity };
