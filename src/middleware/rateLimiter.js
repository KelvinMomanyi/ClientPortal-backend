const { getDb } = require('../services/dbService');

function createDbRateLimiter({ keyPrefix, windowMs, max, message }) {
  return async function rateLimiter(req, res, next) {
    const now = Date.now();
    const resetAt = now + windowMs;
    const key = `${keyPrefix}:${getClientIp(req)}`;

    try {
      const db = getDb();
      const row = await db.get('SELECT count, reset_at FROM rate_limits WHERE key = ?', [key]);

      if (!row || Number(row.reset_at) <= now) {
        await db.run(
          `INSERT INTO rate_limits (key, count, reset_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET count = excluded.count, reset_at = excluded.reset_at`,
          [key, 1, resetAt]
        );
        setRateLimitHeaders(res, max, max - 1, resetAt);
        return next();
      }

      const count = Number(row.count);
      if (count >= max) {
        setRateLimitHeaders(res, max, 0, Number(row.reset_at));
        return res.status(429).json(message);
      }

      await db.run('UPDATE rate_limits SET count = ? WHERE key = ?', [count + 1, key]);
      setRateLimitHeaders(res, max, Math.max(max - count - 1, 0), Number(row.reset_at));
      return next();
    } catch (err) {
      console.error('Rate limiter failed:', err);
      return next();
    }
  };
}

function getClientIp(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.length > 0) {
    return forwardedFor.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function setRateLimitHeaders(res, limit, remaining, resetAt) {
  res.setHeader('RateLimit-Limit', String(limit));
  res.setHeader('RateLimit-Remaining', String(remaining));
  res.setHeader('RateLimit-Reset', String(Math.ceil(resetAt / 1000)));
}

const authLimiter = createDbRateLimiter({
  keyPrefix: 'auth',
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts, please try again after 15 minutes.' },
});

const apiLimiter = createDbRateLimiter({
  keyPrefix: 'api',
  windowMs: 1 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please slow down.' },
});

module.exports = { authLimiter, apiLimiter };
