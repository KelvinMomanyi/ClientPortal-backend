const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
process.env.MONDAY_API_TOKEN = 'test-token';
process.env.ALLOWED_ORIGINS = 'http://localhost:5173';
process.env.DATABASE_FILE = path.join(os.tmpdir(), `monday-auth-${process.pid}.sqlite`);

const { createApp } = require('../src/app');
const { initDb, getDb, closeDb } = require('../src/services/dbService');

async function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function resetDb() {
  await closeDb();
  fs.rmSync(process.env.DATABASE_FILE, { force: true });
  await initDb();
}

test('client login issues a token for valid seeded credentials', async (t) => {
  await resetDb();
  const db = getDb();
  const passwordHash = await bcrypt.hash('password123', 4);
  await db.run(
    'INSERT INTO accounts (monday_account_id, access_token, subscription_status) VALUES (?, ?, ?)',
    [1001, 'token', 'active']
  );
  await db.run(
    'INSERT INTO clients (monday_account_id, name, email, password_hash) VALUES (?, ?, ?, ?)',
    [1001, 'Test Client', 'client@example.com', passwordHash]
  );

  const server = await listen(createApp());
  t.after(() => server.close());
  t.after(() => closeDb());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'CLIENT@example.com', password: 'password123' }),
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.client.email, 'client@example.com');
  assert.equal(typeof body.token, 'string');
});

test('client login rejects invalid credentials', async (t) => {
  await resetDb();
  const db = getDb();
  const passwordHash = await bcrypt.hash('password123', 4);
  await db.run(
    'INSERT INTO accounts (monday_account_id, access_token, subscription_status) VALUES (?, ?, ?)',
    [1001, 'token', 'active']
  );
  await db.run(
    'INSERT INTO clients (monday_account_id, name, email, password_hash) VALUES (?, ?, ?, ?)',
    [1001, 'Test Client', 'client@example.com', passwordHash]
  );

  const server = await listen(createApp());
  t.after(() => server.close());
  t.after(() => closeDb());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'client@example.com', password: 'wrong-password' }),
  });

  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error, 'Invalid credentials');
});
