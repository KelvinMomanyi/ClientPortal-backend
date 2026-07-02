const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_FILE = path.join(os.tmpdir(), `monday-monetization-${process.pid}.sqlite`);

const { initDb, getDb, closeDb } = require('../src/services/dbService');
const {
  isSubscriptionUpdate,
  mapMondayPlanIdToPlanCode,
  normalizeSubscriptionUpdate,
  syncAccountSubscription,
} = require('../src/services/monetizationService');
const { getAccountPlanSummary, isBillingActive } = require('../src/services/planService');

async function resetDb() {
  await closeDb();
  fs.rmSync(process.env.DATABASE_FILE, { force: true });
  await initDb();
}

test('monday plan ids map to internal plan codes with defaults and env overrides', () => {
  const oldMapping = process.env.MONDAY_PLAN_ID_MAP;
  process.env.MONDAY_PLAN_ID_MAP = JSON.stringify({
    monday_starter_2026: 'starter',
    monday_scale_2026: 'pro',
  });

  assert.equal(mapMondayPlanIdToPlanCode('monday_starter_2026'), 'starter');
  assert.equal(mapMondayPlanIdToPlanCode('monday_scale_2026'), 'pro');
  assert.equal(mapMondayPlanIdToPlanCode('enterprise-annual'), 'enterprise');

  if (oldMapping === undefined) {
    delete process.env.MONDAY_PLAN_ID_MAP;
  } else {
    process.env.MONDAY_PLAN_ID_MAP = oldMapping;
  }
});

test('subscription payload normalization supports webhook-style event bodies', () => {
  const payload = {
    event: {
      type: 'app_subscription_created',
      account_id: 1001,
      data: {
        app_subscription: {
          plan_id: 'pro',
          billing_period: 'monthly',
          is_trial: true,
          days_left: 14,
        },
      },
    },
  };

  assert.equal(isSubscriptionUpdate(payload), true);
  const update = normalizeSubscriptionUpdate(payload);
  assert.equal(update.accountId, '1001');
  assert.equal(update.planId, 'pro');
  assert.equal(update.planCode, 'pro');
  assert.equal(update.status, 'trialing');
  assert.equal(update.billingPeriod, 'monthly');
  assert.equal(update.daysLeft, 14);
});

test('subscription sync updates account plan and monday billing metadata', async (t) => {
  await resetDb();
  t.after(() => closeDb());

  const db = getDb();
  await db.run(
    'INSERT INTO accounts (monday_account_id, access_token, subscription_status, plan_code) VALUES (?, ?, ?, ?)',
    [1001, 'token', 'active', 'starter']
  );

  const result = await syncAccountSubscription(db, 1001, {
    app_subscription: {
      plan_id: 'enterprise',
      billing_period: 'yearly',
      status: 'active',
    },
  });

  assert.equal(result.synced, true);
  const summary = await getAccountPlanSummary(1001);
  assert.equal(summary.plan.code, 'enterprise');
  assert.equal(summary.billingProvider, 'monday');
  assert.equal(summary.monday.planId, 'enterprise');
  assert.equal(summary.monday.billingPeriod, 'yearly');
  assert.equal(summary.active, true);
});

test('strict monday monetization mode requires a synced monday plan', async () => {
  const oldRequired = process.env.MONDAY_MONETIZATION_REQUIRED;
  process.env.MONDAY_MONETIZATION_REQUIRED = 'true';

  assert.equal(isBillingActive({ subscription_status: 'active' }), false);
  assert.equal(
    isBillingActive({ subscription_status: 'active', monday_app_plan_id: 'starter' }),
    true
  );

  if (oldRequired === undefined) {
    delete process.env.MONDAY_MONETIZATION_REQUIRED;
  } else {
    process.env.MONDAY_MONETIZATION_REQUIRED = oldRequired;
  }
});
