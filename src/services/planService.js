const { getDb } = require('./dbService');

const PLAN_LIMITS = {
  free: {
    label: 'Free',
    clients: 2,
    boards: 1,
    itemPermissions: 50,
    clientUpdatesMonthly: 25,
  },
  starter: {
    label: 'Starter',
    clients: 10,
    boards: 5,
    itemPermissions: 500,
    clientUpdatesMonthly: 250,
  },
  pro: {
    label: 'Pro',
    clients: 50,
    boards: 25,
    itemPermissions: 5000,
    clientUpdatesMonthly: 2500,
  },
  enterprise: {
    label: 'Enterprise',
    clients: null,
    boards: null,
    itemPermissions: null,
    clientUpdatesMonthly: null,
  },
};

const BILLING_ACTIVE_STATUSES = new Set(['active', 'trialing']);
const BILLING_SOFT_ACTIVE_STATUSES = new Set(['past_due', 'canceled']);

function getDefaultPlanCode() {
  return normalizePlanCode(process.env.DEFAULT_PLAN_CODE || 'starter');
}

function normalizePlanCode(planCode) {
  const normalized = String(planCode || '').toLowerCase().trim();
  return PLAN_LIMITS[normalized] ? normalized : 'starter';
}

function getPlan(planCode) {
  const code = normalizePlanCode(planCode || getDefaultPlanCode());
  return { code, ...PLAN_LIMITS[code] };
}

function getBillingGraceMs() {
  const graceDays = Number(process.env.BILLING_GRACE_DAYS || 0);
  if (!Number.isFinite(graceDays) || graceDays <= 0) return 0;
  return Math.min(Math.floor(graceDays), 30) * 24 * 60 * 60 * 1000;
}

function isUnlimited(limit) {
  return limit === null || limit === undefined || limit < 0;
}

function isBillingActive(account, now = Date.now()) {
  if (!account) return false;
  const status = String(account.subscription_status || 'active').toLowerCase();
  if (status === 'active') return true;

  const trialEndsAt = Number(account.trial_ends_at || 0);
  if (status === 'trialing' && (!trialEndsAt || trialEndsAt > now)) return true;

  const periodEnd = Number(account.subscription_current_period_end || 0);
  if (BILLING_SOFT_ACTIVE_STATUSES.has(status) && periodEnd + getBillingGraceMs() > now) {
    return true;
  }

  return false;
}

function billingInactiveError(account) {
  const error = new Error('Billing subscription is inactive. Please update billing to continue using the portal.');
  error.statusCode = 402;
  error.code = 'SUBSCRIPTION_INACTIVE';
  error.billing = buildBillingSummary(account, null);
  return error;
}

function limitExceededError(metric, plan, usage, limit, attempted) {
  const error = new Error(`Your ${plan.label} plan limit for ${formatMetric(metric)} has been reached.`);
  error.statusCode = 402;
  error.code = 'PLAN_LIMIT_EXCEEDED';
  error.metric = metric;
  error.plan = plan;
  error.usage = usage;
  error.limit = limit;
  error.attempted = attempted;
  return error;
}

function formatMetric(metric) {
  return {
    clients: 'clients',
    boards: 'assigned boards',
    itemPermissions: 'item permissions',
    clientUpdatesMonthly: 'monthly client comments',
  }[metric] || metric;
}

function getCurrentPeriodStart(now = Date.now()) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0);
}

function getCurrentPeriodEnd(now = Date.now()) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 0, 0, 0, 0) - 1;
}

async function getAccount(accountId) {
  const db = getDb();
  return db.get('SELECT * FROM accounts WHERE monday_account_id = ?', [String(accountId)]);
}

async function getUsageCounts(accountId, now = Date.now()) {
  const db = getDb();
  const [clientsRow, boardsRow, permissionsRow, updatesRow] = await Promise.all([
    db.get('SELECT COUNT(*) as count FROM clients WHERE monday_account_id = ?', [String(accountId)]),
    db.get('SELECT COUNT(DISTINCT board_id) as count FROM portals WHERE monday_account_id = ?', [String(accountId)]),
    db.get('SELECT COUNT(*) as count FROM permissions WHERE monday_account_id = ?', [String(accountId)]),
    db.get(
      `SELECT COALESCE(SUM(quantity), 0) as count
       FROM usage_events
       WHERE monday_account_id = ? AND event_type = ? AND created_at >= ? AND created_at <= ?`,
      [String(accountId), 'client_update', getCurrentPeriodStart(now), getCurrentPeriodEnd(now)]
    ),
  ]);

  return {
    clients: Number(clientsRow?.count || 0),
    boards: Number(boardsRow?.count || 0),
    itemPermissions: Number(permissionsRow?.count || 0),
    clientUpdatesMonthly: Number(updatesRow?.count || 0),
  };
}

function buildUsageLimit(metric, used, limit) {
  return {
    metric,
    label: formatMetric(metric),
    used,
    limit: isUnlimited(limit) ? null : limit,
    remaining: isUnlimited(limit) ? null : Math.max(limit - used, 0),
    unlimited: isUnlimited(limit),
  };
}

function buildBillingSummary(account, usage) {
  const plan = getPlan(account?.plan_code);
  const usageCounts = usage || {
    clients: 0,
    boards: 0,
    itemPermissions: 0,
    clientUpdatesMonthly: 0,
  };

  return {
    status: account?.subscription_status || 'active',
    active: isBillingActive(account || { subscription_status: 'active' }),
    plan,
    currentPeriodEnd: account?.subscription_current_period_end ? Number(account.subscription_current_period_end) : null,
    trialEndsAt: account?.trial_ends_at ? Number(account.trial_ends_at) : null,
    usage: {
      clients: buildUsageLimit('clients', usageCounts.clients, plan.clients),
      boards: buildUsageLimit('boards', usageCounts.boards, plan.boards),
      itemPermissions: buildUsageLimit('itemPermissions', usageCounts.itemPermissions, plan.itemPermissions),
      clientUpdatesMonthly: buildUsageLimit(
        'clientUpdatesMonthly',
        usageCounts.clientUpdatesMonthly,
        plan.clientUpdatesMonthly
      ),
    },
  };
}

async function getAccountPlanSummary(accountId) {
  const account = await getAccount(accountId);
  if (!account) return null;
  const usage = await getUsageCounts(accountId);
  return buildBillingSummary(account, usage);
}

async function assertBillingActive(accountId) {
  const account = await getAccount(accountId);
  if (!isBillingActive(account)) {
    throw billingInactiveError(account);
  }
  return account;
}

async function assertWithinPlanLimit(accountId, metric, increment = 1) {
  const account = await assertBillingActive(accountId);
  const plan = getPlan(account.plan_code);
  const limit = plan[metric];
  if (isUnlimited(limit)) return { account, plan };

  const usage = await getUsageCounts(accountId);
  const attempted = Number(usage[metric] || 0) + Number(increment || 0);
  if (attempted > limit) {
    throw limitExceededError(metric, plan, Number(usage[metric] || 0), limit, attempted);
  }

  return { account, plan, usage };
}

async function recordUsageEvent(accountId, eventType, quantity = 1, metadata = {}) {
  const db = getDb();
  await db.run(
    `INSERT INTO usage_events (monday_account_id, event_type, quantity, metadata, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [String(accountId), eventType, Number(quantity) || 1, JSON.stringify(metadata || {}), Date.now()]
  );
}

function serializePlanError(error) {
  return {
    error: error.message,
    code: error.code || 'PLAN_ENFORCEMENT_ERROR',
    metric: error.metric,
    plan: error.plan,
    usage: error.usage,
    limit: error.limit,
    attempted: error.attempted,
    billing: error.billing,
  };
}

module.exports = {
  PLAN_LIMITS,
  assertBillingActive,
  assertWithinPlanLimit,
  buildBillingSummary,
  getAccount,
  getAccountPlanSummary,
  getCurrentPeriodEnd,
  getCurrentPeriodStart,
  getPlan,
  getUsageCounts,
  isBillingActive,
  recordUsageEvent,
  serializePlanError,
};
