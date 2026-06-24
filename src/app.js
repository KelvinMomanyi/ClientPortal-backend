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

function getServerlessApp() {
  if (!serverlessApp) {
    serverlessApp = createApp({ ensureDatabase: true });
  }
  return serverlessApp;
}

async function handler(req, res) {
  const app = getServerlessApp();
  return app(req, res);
}

function createApp({ ensureDatabase = false } = {}) {
  const app = express();

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
      if (req.method === 'OPTIONS' || req.path === '/health' || req.path === '/api/health') {
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
