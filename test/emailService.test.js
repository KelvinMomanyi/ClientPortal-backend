const test = require('node:test');
const assert = require('node:assert/strict');

const { isEmailConfigured, sendEmail } = require('../src/services/emailService');

test('email service no-ops safely when provider credentials are missing', async () => {
  const oldKey = process.env.RESEND_API_KEY;
  const oldFrom = process.env.EMAIL_FROM;

  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;

  assert.equal(isEmailConfigured(), false);
  assert.deepEqual(
    await sendEmail({ to: 'client@example.com', subject: 'Test', text: 'Hello' }),
    { sent: false, reason: 'not-configured' }
  );

  if (oldKey === undefined) {
    delete process.env.RESEND_API_KEY;
  } else {
    process.env.RESEND_API_KEY = oldKey;
  }

  if (oldFrom === undefined) {
    delete process.env.EMAIL_FROM;
  } else {
    process.env.EMAIL_FROM = oldFrom;
  }
});
