const test = require('node:test');
const assert = require('node:assert/strict');

const {
  initDb,
  closeDb,
  normalizeDbInitError,
  requiresAuthToken,
} = require('../src/services/dbService');

function restoreEnv(env) {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

test('remote Turso database URLs require an auth token', async (t) => {
  const originalEnv = {
    TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL,
    LIBSQL_URL: process.env.LIBSQL_URL,
    TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN,
    LIBSQL_AUTH_TOKEN: process.env.LIBSQL_AUTH_TOKEN,
    TURSO_DATABASE_AUTH_TOKEN: process.env.TURSO_DATABASE_AUTH_TOKEN,
    DATABASE_FILE: process.env.DATABASE_FILE,
  };

  process.env.TURSO_DATABASE_URL = 'libsql://example.turso.io';
  delete process.env.LIBSQL_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  delete process.env.LIBSQL_AUTH_TOKEN;
  delete process.env.TURSO_DATABASE_AUTH_TOKEN;
  delete process.env.DATABASE_FILE;

  t.after(async () => {
    await closeDb();
    restoreEnv(originalEnv);
  });

  await assert.rejects(
    () => initDb(),
    /Set TURSO_AUTH_TOKEN in Vercel/
  );
});

test('local libSQL URLs do not require auth tokens', () => {
  assert.equal(requiresAuthToken('file:local.db'), false);
  assert.equal(requiresAuthToken(':memory:'), false);
  assert.equal(requiresAuthToken('libsql://example.turso.io'), true);
});

test('Turso HTTP 401 errors are normalized to deployment config errors', () => {
  const rawError = new Error('SERVER_ERROR: Server returned HTTP status 401');
  rawError.cause = { status: 401 };

  const normalized = normalizeDbInitError(rawError, 'turso');

  assert.equal(normalized.code, 'TURSO_AUTH_FAILED');
  assert.match(normalized.message, /TURSO_AUTH_TOKEN/);
  assert.equal(normalized.cause, rawError);
});
