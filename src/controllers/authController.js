const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDb } = require('../services/dbService');
const { getValidInvite, activateInvite } = require('../services/inviteService');

function validatePassword(password) {
  return typeof password === 'string' && password.length >= 8 && password.length <= 128;
}

function signClientToken(client) {
  return jwt.sign(
    { clientId: client.id, email: client.email, accountId: client.monday_account_id },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  );
}

async function loginClient(req, res) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  // Basic input validation
  if (typeof email !== 'string' || email.length > 255) {
    return res.status(400).json({ error: 'Invalid email format' });
  }
  if (typeof password !== 'string' || password.length > 128) {
    return res.status(400).json({ error: 'Invalid password format' });
  }

  try {
    const db = getDb();
    const client = await db.get('SELECT * FROM clients WHERE email = ?', [email.trim().toLowerCase()]);
    if (!client) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isValid = await bcrypt.compare(password, client.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = signClientToken(client);

    res.json({ token, client: { id: client.id, name: client.name, email: client.email } });
  } catch (err) {
    console.error('Login error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function getInvite(req, res) {
  const invite = await getValidInvite(req.params.token);
  if (!invite) {
    return res.status(404).json({ error: 'Invite link is invalid or expired' });
  }

  return res.json({
    client: {
      name: invite.name,
      email: invite.email,
    },
    expiresAt: Number(invite.expires_at),
  });
}

async function activateClientInvite(req, res) {
  const { password } = req.body;

  if (!validatePassword(password)) {
    return res.status(400).json({ error: 'Password must be between 8 and 128 characters' });
  }

  try {
    const client = await activateInvite(req.params.token, password);
    if (!client) {
      return res.status(404).json({ error: 'Invite link is invalid or expired' });
    }

    const token = signClientToken(client);
    return res.json({ token, client: { id: client.id, name: client.name, email: client.email } });
  } catch (err) {
    console.error('Invite activation error', err);
    return res.status(500).json({ error: 'Failed to activate invite' });
  }
}

module.exports = {
  loginClient,
  getInvite,
  activateClientInvite,
  signClientToken,
  validatePassword,
};
