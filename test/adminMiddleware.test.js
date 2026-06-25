const test = require('node:test');
const assert = require('node:assert/strict');

const { getAdminIdentity } = require('../src/middleware/adminMiddleware');

test('admin identity accepts camelCase Monday session token payloads', () => {
  assert.deepEqual(
    getAdminIdentity({ accountId: 1001, userId: 2002 }),
    { accountId: '1001', userId: '2002' }
  );
});

test('admin identity accepts snake_case Monday session token payloads', () => {
  assert.deepEqual(
    getAdminIdentity({ account_id: 1001, user_id: 2002 }),
    { accountId: '1001', userId: '2002' }
  );
});

test('admin identity accepts nested Monday session token payloads', () => {
  assert.deepEqual(
    getAdminIdentity({ dat: { account_id: 1001, user_id: 2002 } }),
    { accountId: '1001', userId: '2002' }
  );
});

test('admin identity rejects payloads without an account id', () => {
  assert.equal(getAdminIdentity({ userId: 2002 }), null);
});
