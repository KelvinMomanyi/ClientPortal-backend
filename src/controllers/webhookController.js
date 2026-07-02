const { getDb } = require('../services/dbService');
const {
  decodeWebhookJwt,
  extractAccountId,
  isSubscriptionUpdate,
  syncAccountSubscription,
  verifyWebhookJwt,
} = require('../services/monetizationService');

async function handleMondayWebhook(req, res) {
  if (req.body?.challenge) {
    return res.json({ challenge: req.body.challenge });
  }

  const decodedPreview = decodeWebhookJwt(req);
  const hasSubscriptionUpdate = isSubscriptionUpdate(req.body || {}) || isSubscriptionUpdate(decodedPreview || {});

  if (hasSubscriptionUpdate) {
    let decoded;
    try {
      decoded = verifyWebhookJwt(req);
    } catch (err) {
      console.error('Monday subscription webhook authorization failed:', err.message);
      return res.status(err.statusCode || 401).json({ error: err.message });
    }

    try {
      const accountId = extractAccountId(req.body) || extractAccountId(decoded);
      const syncPayload = isSubscriptionUpdate(req.body || {}) ? req.body : decoded;
      const sync = await syncAccountSubscription(getDb(), accountId, syncPayload);
      return res.status(200).json({ ok: true, sync });
    } catch (err) {
      console.error('Failed to process Monday subscription webhook:', err);
      return res.status(err.statusCode || 500).json({ error: err.message || 'Failed to process webhook.' });
    }
  }

  const event = req.body?.event;
  if (event) {
    console.log('Received Monday webhook event:', {
      type: event.type,
      boardId: event.boardId,
      pulseId: event.pulseId,
    });
  }

  return res.status(200).json({ ok: true });
}

module.exports = { handleMondayWebhook };
