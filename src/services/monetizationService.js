const jwt = require('jsonwebtoken');

const ACTIVE_STATUSES = new Set(['active', 'trialing']);
const INACTIVE_EVENT_KEYWORDS = ['cancel', 'deactivate', 'uninstall', 'expire', 'delete'];

function cleanText(value, maxLength = 200) {
  return String(value || '').trim().slice(0, maxLength);
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function parseBoolean(value) {
  if (value === true || value === 1 || value === '1') return true;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
}

function parseInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : null;
}

function parseTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric > 9999999999 ? Math.floor(numeric) : Math.floor(numeric * 1000);
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

function getConfiguredPlanMapping() {
  const raw = process.env.MONDAY_PLAN_ID_MAP || process.env.MONDAY_PLAN_MAPPING || '';
  if (!raw.trim()) return {};

  try {
    const parsed = JSON.parse(raw);
    return Object.fromEntries(
      Object.entries(parsed).map(([planId, planCode]) => [cleanText(planId).toLowerCase(), cleanText(planCode).toLowerCase()])
    );
  } catch {
    return Object.fromEntries(
      raw
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
          const [planId, planCode] = entry.split(':').map((value) => cleanText(value).toLowerCase());
          return [planId, planCode || planId];
        })
    );
  }
}

function mapMondayPlanIdToPlanCode(planId) {
  const normalized = cleanText(planId).toLowerCase();
  const mapping = getConfiguredPlanMapping();
  if (mapping[normalized]) return mapping[normalized];
  if (['free', 'starter', 'pro', 'enterprise'].includes(normalized)) return normalized;
  if (normalized.includes('enterprise')) return 'enterprise';
  if (normalized.includes('pro')) return 'pro';
  if (normalized.includes('free')) return 'free';
  if (normalized.includes('starter') || normalized.includes('basic')) return 'starter';
  return process.env.DEFAULT_PLAN_CODE || 'starter';
}

function getNestedValue(source, paths) {
  for (const path of paths) {
    const value = path.split('.').reduce((current, key) => current?.[key], source);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function findSubscriptionObject(payload = {}) {
  return firstDefined(
    payload.app_subscription,
    payload.subscription,
    payload.appSubscription,
    payload.data?.app_subscription,
    payload.data?.subscription,
    payload.data?.appSubscription,
    payload.event?.app_subscription,
    payload.event?.subscription,
    payload.event?.appSubscription,
    payload.event?.data?.app_subscription,
    payload.event?.data?.subscription,
    payload.event?.data?.appSubscription,
    payload.dat?.app_subscription,
    payload.dat?.subscription,
    payload.dat?.appSubscription,
    payload.context?.app_subscription,
    payload.context?.subscription,
    payload.context?.appSubscription
  );
}

function extractAccountId(payload = {}) {
  return cleanText(
    getNestedValue(payload, [
      'account_id',
      'accountId',
      'account.id',
      'data.account_id',
      'data.accountId',
      'data.account.id',
      'event.account_id',
      'event.accountId',
      'event.account.id',
      'event.data.account_id',
      'event.data.accountId',
      'event.data.account.id',
      'dat.account_id',
      'dat.accountId',
      'dat.account.id',
      'context.account_id',
      'context.accountId',
      'context.account.id',
    ])
  );
}

function extractEventType(payload = {}) {
  return cleanText(
    firstDefined(
      payload.type,
      payload.event_type,
      payload.eventType,
      payload.event?.type,
      payload.event?.event_type,
      payload.event?.eventType,
      payload.data?.type,
      payload.data?.event_type,
      payload.data?.eventType
    ),
    120
  ).toLowerCase();
}

function inferStatus(payload = {}, subscription = {}) {
  const eventType = extractEventType(payload);
  const explicit = cleanText(
    firstDefined(
      subscription.status,
      subscription.subscription_status,
      subscription.subscriptionStatus,
      payload.status,
      payload.subscription_status,
      payload.subscriptionStatus,
      payload.data?.status,
      payload.event?.status,
      payload.event?.data?.status
    ),
    80
  ).toLowerCase();

  if (explicit) return explicit;
  if (INACTIVE_EVENT_KEYWORDS.some((keyword) => eventType.includes(keyword))) return 'canceled';
  if (parseBoolean(firstDefined(subscription.is_trial, subscription.isTrial, payload.is_trial, payload.isTrial))) {
    return 'trialing';
  }
  return 'active';
}

function normalizeSubscriptionUpdate(payload = {}) {
  const subscription = findSubscriptionObject(payload) || payload;
  const planId = cleanText(
    firstDefined(
      subscription.plan_id,
      subscription.planId,
      subscription.plan?.id,
      subscription.plan?.plan_id,
      payload.plan_id,
      payload.planId,
      payload.data?.plan_id,
      payload.event?.plan_id,
      payload.event?.data?.plan_id
    )
  );

  const isTrial = parseBoolean(
    firstDefined(subscription.is_trial, subscription.isTrial, payload.is_trial, payload.isTrial)
  );
  const daysLeft = parseInteger(
    firstDefined(
      subscription.days_left,
      subscription.daysLeft,
      subscription.subscription_days_left,
      subscription.subscriptionDaysLeft,
      payload.days_left,
      payload.daysLeft
    )
  );
  const status = inferStatus(payload, subscription);
  const currentPeriodEnd = parseTimestamp(
    firstDefined(
      subscription.current_period_end,
      subscription.currentPeriodEnd,
      subscription.renewal_date,
      subscription.renewalDate,
      subscription.period_end,
      subscription.periodEnd,
      payload.current_period_end,
      payload.currentPeriodEnd
    )
  );

  return {
    accountId: extractAccountId(payload),
    eventType: extractEventType(payload),
    planId,
    planCode: planId ? mapMondayPlanIdToPlanCode(planId) : null,
    status,
    billingPeriod: cleanText(
      firstDefined(
        subscription.billing_period,
        subscription.billingPeriod,
        subscription.period,
        payload.billing_period,
        payload.billingPeriod
      ),
      80
    ),
    daysLeft,
    isTrial,
    currentPeriodEnd,
  };
}

function isSubscriptionUpdate(payload = {}) {
  const update = normalizeSubscriptionUpdate(payload);
  const eventType = update.eventType || '';
  return Boolean(
    update.planId ||
      findSubscriptionObject(payload) ||
      eventType.includes('subscription') ||
      eventType.includes('payment') ||
      eventType.includes('billing') ||
      eventType.includes('monetization') ||
      eventType.includes('install') ||
      eventType.includes('uninstall')
  );
}

async function syncAccountSubscription(db, accountId, payload = {}) {
  const update = normalizeSubscriptionUpdate({ ...payload, account_id: accountId || payload.account_id });
  const resolvedAccountId = cleanText(accountId || update.accountId);
  if (!resolvedAccountId) {
    const error = new Error('Monday subscription payload is missing account_id.');
    error.statusCode = 400;
    throw error;
  }

  const account = await db.get('SELECT monday_account_id, plan_code FROM accounts WHERE monday_account_id = ?', [resolvedAccountId]);
  if (!account) {
    return { synced: false, reason: 'account-not-found', update };
  }

  const planCode = update.planCode || account.plan_code || process.env.DEFAULT_PLAN_CODE || 'starter';
  const subscriptionStatus = update.isTrial && ACTIVE_STATUSES.has(update.status) ? 'trialing' : update.status || 'active';
  const now = Date.now();
  const trialEndsAt =
    update.isTrial && update.daysLeft !== null && update.daysLeft >= 0
      ? now + update.daysLeft * 24 * 60 * 60 * 1000
      : null;

  await db.run(
    `UPDATE accounts
     SET plan_code = ?,
         subscription_status = ?,
         subscription_current_period_end = ?,
         trial_ends_at = ?,
         billing_provider = ?,
         monday_app_plan_id = ?,
         monday_app_billing_period = ?,
         monday_app_subscription_days_left = ?,
         monday_app_subscription_is_trial = ?,
         monday_app_subscription_synced_at = ?
     WHERE monday_account_id = ?`,
    [
      planCode,
      subscriptionStatus,
      update.currentPeriodEnd,
      trialEndsAt,
      'monday',
      update.planId || null,
      update.billingPeriod || null,
      update.daysLeft,
      update.isTrial ? 1 : 0,
      now,
      resolvedAccountId,
    ]
  );

  return {
    synced: true,
    update: {
      ...update,
      accountId: resolvedAccountId,
      planCode,
      status: subscriptionStatus,
      trialEndsAt,
      syncedAt: now,
    },
  };
}

function verifyWebhookJwt(req) {
  const clientSecret = process.env.MONDAY_CLIENT_SECRET;
  if (!clientSecret) {
    const error = new Error('Missing MONDAY_CLIENT_SECRET.');
    error.statusCode = 500;
    throw error;
  }

  const header = req.headers.authorization || req.headers.Authorization;
  const token = String(header || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    const error = new Error('Monday webhook authorization token is missing.');
    error.statusCode = 401;
    throw error;
  }

  return jwt.verify(token, clientSecret);
}

function decodeWebhookJwt(req) {
  const header = req.headers.authorization || req.headers.Authorization;
  const token = String(header || '').replace(/^Bearer\s+/i, '').trim();
  return token ? jwt.decode(token) : null;
}

module.exports = {
  decodeWebhookJwt,
  extractAccountId,
  findSubscriptionObject,
  isSubscriptionUpdate,
  mapMondayPlanIdToPlanCode,
  normalizeSubscriptionUpdate,
  syncAccountSubscription,
  verifyWebhookJwt,
};
