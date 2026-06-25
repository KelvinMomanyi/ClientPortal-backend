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
process.env.LOCAL_ADMIN_TOKEN = 'test-admin-token';
process.env.LOCAL_ADMIN_ACCOUNT_ID = '1001';

const { createApp } = require('../src/app');
const { initDb, getDb, closeDb } = require('../src/services/dbService');
const { createClientInvite } = require('../src/services/inviteService');

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

test('client invite activation sets password and issues a token', async (t) => {
  await resetDb();
  const db = getDb();
  const placeholderHash = await bcrypt.hash('unusable-placeholder', 4);
  await db.run(
    'INSERT INTO accounts (monday_account_id, access_token, subscription_status) VALUES (?, ?, ?)',
    [1001, 'token', 'active']
  );
  const clientResult = await db.run(
    'INSERT INTO clients (monday_account_id, name, email, password_hash) VALUES (?, ?, ?, ?)',
    [1001, 'Invited Client', 'invited@example.com', placeholderHash]
  );
  const invite = await createClientInvite(clientResult.lastID, { get: () => 'https://portal.example.com' });

  const server = await listen(createApp());
  t.after(() => server.close());
  t.after(() => closeDb());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const inviteResponse = await fetch(`${baseUrl}/api/auth/invites/${invite.token}`);
  assert.equal(inviteResponse.status, 200);
  const inviteBody = await inviteResponse.json();
  assert.equal(inviteBody.client.email, 'invited@example.com');

  const activateResponse = await fetch(`${baseUrl}/api/auth/invites/${invite.token}/activate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'new-password-123' }),
  });

  assert.equal(activateResponse.status, 200);
  const activateBody = await activateResponse.json();
  assert.equal(activateBody.client.email, 'invited@example.com');
  assert.equal(typeof activateBody.token, 'string');

  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'invited@example.com', password: 'new-password-123' }),
  });
  assert.equal(loginResponse.status, 200);

  const reusedResponse = await fetch(`${baseUrl}/api/auth/invites/${invite.token}/activate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'another-password-123' }),
  });
  assert.equal(reusedResponse.status, 404);
});

test('admin can create a client invite without setting a password', async (t) => {
  await resetDb();
  const db = getDb();
  await db.run(
    'INSERT INTO accounts (monday_account_id, access_token, subscription_status) VALUES (?, ?, ?)',
    [1001, 'token', 'active']
  );

  const server = await listen(createApp());
  t.after(() => server.close());
  t.after(() => closeDb());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${baseUrl}/api/monday/clients`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-admin-token',
      'content-type': 'application/json',
      origin: 'https://client-portal-seven-alpha.vercel.app',
    },
    body: JSON.stringify({ name: 'Portal Client', email: 'portal@example.com' }),
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(typeof body.invite.inviteUrl, 'string');
  assert.match(body.invite.inviteUrl, /^https:\/\/client-portal-seven-alpha\.vercel\.app\/activate\?token=/);

  const client = await db.get('SELECT * FROM clients WHERE email = ?', ['portal@example.com']);
  assert.equal(client.name, 'Portal Client');
  const pendingInvite = await db.get('SELECT * FROM client_invites WHERE client_id = ? AND used_at IS NULL', [client.id]);
  assert.equal(typeof pendingInvite.token_hash, 'string');
});
