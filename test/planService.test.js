const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_FILE = path.join(os.tmpdir(), `monday-plan-${process.pid}.sqlite`);

const { initDb, getDb, closeDb } = require('../src/services/dbService');
const {
  assertBillingActive,
  assertWithinPlanLimit,
  getAccountPlanSummary,
  recordUsageEvent,
} = require('../src/services/planService');

async function resetDb() {
  await closeDb();
  fs.rmSync(process.env.DATABASE_FILE, { force: true });
  await initDb();
}

test('plan summary reports usage and limits for an account', async (t) => {
  await resetDb();
  t.after(() => closeDb());

  const db = getDb();
  await db.run(
    'INSERT INTO accounts (monday_account_id, access_token, subscription_status, plan_code) VALUES (?, ?, ?, ?)',
    [1001, 'token', 'active', 'free']
  );
  await db.run(
    'INSERT INTO clients (monday_account_id, name, email, password_hash) VALUES (?, ?, ?, ?)',
    [1001, 'One', 'one@example.com', 'hash']
  );
  await db.run(
    'INSERT INTO portals (monday_account_id, client_id, board_id) VALUES (?, ?, ?)',
    [1001, 1, 55]
  );
  await recordUsageEvent(1001, 'client_update', 2);

  const summary = await getAccountPlanSummary(1001);
  assert.equal(summary.plan.code, 'free');
  assert.equal(summary.usage.clients.used, 1);
  assert.equal(summary.usage.clients.limit, 2);
  assert.equal(summary.usage.boards.used, 1);
  assert.equal(summary.usage.clientUpdatesMonthly.used, 2);
});

test('plan limits block usage above the configured plan allowance', async (t) => {
  await resetDb();
  t.after(() => closeDb());

  const db = getDb();
  await db.run(
    'INSERT INTO accounts (monday_account_id, access_token, subscription_status, plan_code) VALUES (?, ?, ?, ?)',
    [1001, 'token', 'active', 'free']
  );
  await db.run(
    'INSERT INTO clients (monday_account_id, name, email, password_hash) VALUES (?, ?, ?, ?)',
    [1001, 'One', 'one@example.com', 'hash']
  );
  await db.run(
    'INSERT INTO clients (monday_account_id, name, email, password_hash) VALUES (?, ?, ?, ?)',
    [1001, 'Two', 'two@example.com', 'hash']
  );

  await assert.rejects(
    () => assertWithinPlanLimit(1001, 'clients', 1),
    (err) => err.code === 'PLAN_LIMIT_EXCEEDED' && err.statusCode === 402
  );
});

test('inactive subscriptions are rejected by billing enforcement', async (t) => {
  await resetDb();
  t.after(() => closeDb());

  const db = getDb();
  await db.run(
    'INSERT INTO accounts (monday_account_id, access_token, subscription_status, plan_code) VALUES (?, ?, ?, ?)',
    [1001, 'token', 'canceled', 'starter']
  );

  await assert.rejects(
    () => assertBillingActive(1001),
    (err) => err.code === 'SUBSCRIPTION_INACTIVE' && err.statusCode === 402
  );
});
