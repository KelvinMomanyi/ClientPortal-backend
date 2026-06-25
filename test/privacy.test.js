const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = 'privacy-test-secret-test-secret-test-secret-123456';
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.ALLOWED_ORIGINS = 'http://localhost:5173';
process.env.DATABASE_FILE = path.join(os.tmpdir(), `monday-privacy-${process.pid}.sqlite`);

const { createApp } = require('../src/app');
const { initDb, getDb, closeDb } = require('../src/services/dbService');
const { decryptString, encryptString, isEncrypted } = require('../src/services/cryptoService');
const { buildClientStorage } = require('../src/services/clientDataService');

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

test('crypto service encrypts and decrypts sensitive values with AES-GCM envelopes', () => {
  const encrypted = encryptString('secret-token');

  assert.equal(isEncrypted(encrypted), true);
  assert.notEqual(encrypted, 'secret-token');
  assert.equal(decryptString(encrypted), 'secret-token');
});

test('encrypted clients support the same email in different monday accounts', async (t) => {
  await resetDb();
  const db = getDb();
  const passwordHash = await bcrypt.hash('password123', 4);

  for (const accountId of ['1001', '1002']) {
    const storage = buildClientStorage(accountId, `Client ${accountId}`, 'shared@example.com');
    await db.run(
      `INSERT INTO clients
        (monday_account_id, name, email, password_hash, name_encrypted, email_encrypted, email_hash, pii_encrypted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        accountId,
        storage.name,
        storage.email,
        passwordHash,
        storage.name_encrypted,
        storage.email_encrypted,
        storage.email_hash,
        storage.pii_encrypted_at,
      ]
    );
  }

  const rawRows = await db.all('SELECT email, email_encrypted FROM clients ORDER BY monday_account_id');
  assert.equal(rawRows.length, 2);
  assert.notEqual(rawRows[0].email, 'shared@example.com');
  assert.equal(isEncrypted(rawRows[0].email_encrypted), true);

  const server = await listen(createApp());
  t.after(() => server.close());
  t.after(() => closeDb());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const ambiguousResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'shared@example.com', password: 'password123' }),
  });
  assert.equal(ambiguousResponse.status, 409);
  const ambiguousBody = await ambiguousResponse.json();
  assert.equal(ambiguousBody.code, 'ACCOUNT_SELECTION_REQUIRED');
  assert.deepEqual(
    ambiguousBody.accounts.map((account) => account.accountId).sort(),
    ['1001', '1002']
  );

  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'shared@example.com', password: 'password123', accountId: '1002' }),
  });
  assert.equal(loginResponse.status, 200);
  const loginBody = await loginResponse.json();
  assert.equal(loginBody.client.email, 'shared@example.com');
  assert.equal(loginBody.client.accountId, '1002');
  assert.equal(typeof loginBody.token, 'string');
});
