const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDb } = require('../services/dbService');

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

    const token = jwt.sign(
      { clientId: client.id, email: client.email, accountId: client.monday_account_id },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({ token, client: { id: client.id, name: client.name, email: client.email } });
  } catch (err) {
    console.error('Login error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  loginClient,
};
