const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_FILE = path.join(os.tmpdir(), `monday-permissions-${process.pid}.sqlite`);

const { initDb, getDb, closeDb } = require('../src/services/dbService');
const {
  filterBoardByAllowedItems,
  assertClientCanAccessItem,
} = require('../src/services/permissionService');

async function resetDb() {
  await closeDb();
  fs.rmSync(process.env.DATABASE_FILE, { force: true });
  await initDb();
}

test('filterBoardByAllowedItems leaves a board unchanged when no item restrictions exist', () => {
  const board = {
    id: '10',
    name: 'Project',
    items_page: { items: [{ id: '1', name: 'One' }, { id: '2', name: 'Two' }] },
  };

  assert.deepEqual(filterBoardByAllowedItems(board, new Set()), board);
});

test('filterBoardByAllowedItems hides items outside the allowed set', () => {
  const board = {
    id: '10',
    name: 'Project',
    items_page: { items: [{ id: '1', name: 'One' }, { id: '2', name: 'Two' }] },
  };

  const filtered = filterBoardByAllowedItems(board, new Set(['2']));
  assert.deepEqual(filtered.items_page.items, [{ id: '2', name: 'Two' }]);
});

test('assertClientCanAccessItem requires assigned board and allowed item', async (t) => {
  await resetDb();
  t.after(() => closeDb());

  const db = getDb();
  await db.run(
    'INSERT INTO accounts (monday_account_id, access_token, subscription_status) VALUES (?, ?, ?)',
    [1001, 'token', 'active']
  );
  await db.run(
    'INSERT INTO clients (id, monday_account_id, name, email, password_hash) VALUES (?, ?, ?, ?, ?)',
    [7, 1001, 'Test Client', 'client@example.com', 'hash']
  );
  await db.run(
    'INSERT INTO portals (monday_account_id, client_id, board_id) VALUES (?, ?, ?)',
    [1001, 7, 55]
  );
  await db.run(
    'INSERT INTO permissions (monday_account_id, client_id, board_id, item_id) VALUES (?, ?, ?, ?)',
    [1001, 7, 55, 999]
  );

  await assert.doesNotReject(() => assertClientCanAccessItem(7, 1001, 55, 999));
  await assert.rejects(
    () => assertClientCanAccessItem(7, 1001, 55, 111),
    /Item is not shared/
  );
  await assert.rejects(
    () => assertClientCanAccessItem(7, 1001, 66, 999),
    /Board is not assigned/
  );
});
