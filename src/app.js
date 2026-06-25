const dotenv = require('dotenv');
const express = require('express');
const cors = require('cors');
const authRoutes = require('./routes/authRoutes');
const mondayRoutes = require('./routes/mondayRoutes');
const { apiLimiter } = require('./middleware/rateLimiter');
const { initDb } = require('./services/dbService');

dotenv.config({ quiet: true });

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'https://client-portal-seven-alpha.vercel.app',
];

function normalizeOrigin(origin) {
  return origin.trim().replace(/\/+$/, '');
}

function parseAllowedOrigins(value) {
  return (value || '')
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean);
}

function getAllowedOrigins() {
  return new Set([
    ...DEFAULT_ALLOWED_ORIGINS,
    ...parseAllowedOrigins(process.env.ALLOWED_ORIGINS),
  ]);
}

let serverlessApp;

function applyCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;

  const allowedOrigins = getAllowedOrigins();
  if (!allowedOrigins.has(normalizeOrigin(origin))) return;

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    req.headers['access-control-request-headers'] || 'Content-Type,Authorization'
  );
}

function getServerlessApp() {
  if (!serverlessApp) {
    serverlessApp = createApp({ ensureDatabase: true });
  }
  return serverlessApp;
}

function applySecurityHeaders(req, res, next) {
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  return next();
}

async function handler(req, res) {
  applyCorsHeaders(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const app = getServerlessApp();
  return app(req, res);
}

function createApp({ ensureDatabase = false } = {}) {
  const app = express();

  app.use(applySecurityHeaders);

  const allowedOrigins = getAllowedOrigins();

  app.use(cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.has(normalizeOrigin(origin))) return callback(null, true);
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  }));

  app.use(express.json({ limit: '1mb' }));

  if (ensureDatabase) {
    app.use(async (req, res, next) => {
      if (
        req.method === 'OPTIONS' ||
        req.path === '/health' ||
        req.path === '/api/health' ||
        req.path === '/monday-app-association.json' ||
        req.path === '/api/monday-app-association.json'
      ) {
        return next();
      }

      try {
        await initDb();
        return next();
      } catch (err) {
        return next(err);
      }
    });
  }

  app.use('/api', apiLimiter);

  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
    });
    next();
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/monday', mondayRoutes);

  app.get(['/monday-app-association.json', '/api/monday-app-association.json'], (req, res) => {
    if (!process.env.MONDAY_CLIENT_ID) {
      return res.status(500).json({ error: 'MONDAY_CLIENT_ID is not configured' });
    }

    return res.status(200).json({
      apps: [{ clientID: String(process.env.MONDAY_CLIENT_ID) }],
    });
  });

  app.get(['/health', '/api/health'], (req, res) => {
    res.status(200).json({ status: 'ok', uptime: process.uptime() });
  });

  app.use((err, req, res, next) => {
    void next;
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = handler;
module.exports.createApp = createApp;
module.exports.getAllowedOrigins = getAllowedOrigins;
module.exports.parseAllowedOrigins = parseAllowedOrigins;
module.exports.applyCorsHeaders = applyCorsHeaders;
module.exports.applySecurityHeaders = applySecurityHeaders;
