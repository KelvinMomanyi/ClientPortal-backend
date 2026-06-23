const dotenv = require('dotenv');
const { createApp } = require('./app');
const { initDb } = require('./services/dbService');

dotenv.config();

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET must be set and at least 32 characters long.');
  process.exit(1);
}

if (!process.env.MONDAY_API_TOKEN) {
  console.warn('WARNING: MONDAY_API_TOKEN is not set. Monday.com API calls will fail.');
}

const PORT = process.env.PORT || 5000;
const allowedOrigins = process.env.ALLOWED_ORIGINS || 'http://localhost:5173';

initDb()
  .then(() => {
    const app = createApp();
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
      console.log(`CORS allowed origins: ${allowedOrigins}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database', err);
    process.exit(1);
  });
