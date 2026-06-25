const express = require('express');
const router = express.Router();
const { loginClient, getInvite, activateClientInvite } = require('../controllers/authController');
const { authLimiter } = require('../middleware/rateLimiter');

// Rate-limited login
router.post('/login', authLimiter, loginClient);
router.get('/invites/:token', getInvite);
router.post('/invites/:token/activate', authLimiter, activateClientInvite);

// Monday OAuth Installation Flow
const { install, callback } = require('../controllers/oauthController');
router.get('/monday/install', install);
router.get('/monday/callback', callback);

// Registration endpoint removed for security.
// Use the admin dashboard or seed script to create clients.

module.exports = router;
