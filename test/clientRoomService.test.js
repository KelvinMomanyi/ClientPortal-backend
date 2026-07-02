const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_FILE = path.join(os.tmpdir(), `monday-client-room-${process.pid}.sqlite`);

const { initDb, getDb, closeDb } = require('../src/services/dbService');
const {
  createFileRequest,
  decorateBoardsForClientRoom,
  getPortalSettings,
  getSetupStatus,
  submitFileRequest,
  updatePortalSettings,
  upsertApproval,
} = require('../src/services/clientRoomService');

async function resetDb() {
  await closeDb();
  fs.rmSync(process.env.DATABASE_FILE, { force: true });
  await initDb();
}

async function seedAccountAndClient() {
  const db = getDb();
  await db.run(
    'INSERT INTO accounts (monday_account_id, access_token, subscription_status, plan_code) VALUES (?, ?, ?, ?)',
    [1001, 'token', 'active', 'starter']
  );
  const client = await db.run(
    'INSERT INTO clients (monday_account_id, name, email, password_hash) VALUES (?, ?, ?, ?)',
    [1001, 'Acme', 'acme@example.com', 'hash']
  );
  await db.run(
    'INSERT INTO portals (monday_account_id, client_id, board_id) VALUES (?, ?, ?)',
    [1001, client.lastID, 55]
  );
  return client.lastID;
}

test('portal settings normalize unsafe values and setup reflects launch progress', async (t) => {
  await resetDb();
  t.after(() => closeDb());
  await seedAccountAndClient();

  const db = getDb();
  assert.equal((await getPortalSettings(db, 1001)).portalName, 'Client Approval Portal');

  const settings = await updatePortalSettings(db, 1001, {
    portalName: 'Acme Review Room',
    logoUrl: 'javascript:alert(1)',
    primaryColor: 'blue',
    welcomeMessage: 'Review work before launch.',
    supportEmail: 'support@example.com',
  });

  assert.equal(settings.portalName, 'Acme Review Room');
  assert.equal(settings.logoUrl, '');
  assert.equal(settings.primaryColor, '#0073ea');
  assert.equal(settings.supportEmail, 'support@example.com');

  const setup = await getSetupStatus(db, 1001, settings);
  assert.equal(setup.steps.find((step) => step.key === 'brand_portal').complete, true);
  assert.equal(setup.steps.find((step) => step.key === 'assign_board').complete, true);
});

test('client room decoration exposes approvals, file requests, and activity per item', async (t) => {
  await resetDb();
  t.after(() => closeDb());
  const clientId = await seedAccountAndClient();
  const db = getDb();

  await upsertApproval(db, {
    accountId: 1001,
    clientId,
    boardId: 55,
    itemId: 700,
    status: 'changes_requested',
    reason: 'Please revise the headline.',
  });

  const request = await createFileRequest(db, {
    accountId: 1001,
    clientId,
    boardId: 55,
    itemId: 700,
    title: 'Upload signed brief',
    instructions: 'Share a link to the signed PDF.',
  });

  const decorated = await decorateBoardsForClientRoom(
    db,
    [{ id: '55', name: 'Launch', items_page: { items: [{ id: '700', name: 'Landing page' }] } }],
    1001,
    clientId
  );

  const itemMeta = decorated.boards[0].items_page.items[0].client_portal;
  assert.equal(itemMeta.approval.status, 'changes_requested');
  assert.equal(itemMeta.fileRequests[0].id, request.id);
  assert.equal(itemMeta.activity[0].eventType, 'file_request_created');
  assert.equal(decorated.summary.openFileRequests, 1);
});

test('file request submission stores sanitized links and response details', async (t) => {
  await resetDb();
  t.after(() => closeDb());
  const clientId = await seedAccountAndClient();
  const db = getDb();

  const request = await createFileRequest(db, {
    accountId: 1001,
    clientId,
    boardId: 55,
    itemId: 700,
    title: 'Upload assets',
  });

  const submitted = await submitFileRequest(db, {
    accountId: 1001,
    clientId,
    requestId: request.id,
    note: 'Here are the files.',
    links: ['https://example.com/asset.pdf', 'javascript:alert(1)'],
  });

  assert.equal(submitted.status, 'submitted');
  assert.deepEqual(submitted.responseLinks, ['https://example.com/asset.pdf']);
  assert.equal(submitted.responseNote, 'Here are the files.');
});
