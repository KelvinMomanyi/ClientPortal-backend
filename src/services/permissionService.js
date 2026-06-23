const { getDb } = require('./dbService');

async function getClientPortal(clientId, accountId, boardId) {
  const db = getDb();
  return db.get(
    'SELECT * FROM portals WHERE client_id = ? AND monday_account_id = ? AND board_id = ?',
    [clientId, accountId, boardId]
  );
}

async function getAllowedItemIds(clientId, accountId, boardId) {
  const db = getDb();
  const rows = await db.all(
    'SELECT item_id FROM permissions WHERE client_id = ? AND monday_account_id = ? AND board_id = ?',
    [clientId, accountId, boardId]
  );
  return new Set(rows.map((row) => String(row.item_id)));
}

function filterBoardByAllowedItems(board, allowedItemIds) {
  if (!allowedItemIds || allowedItemIds.size === 0) return board;

  return {
    ...board,
    items_page: {
      ...(board.items_page || {}),
      items: (board.items_page?.items || []).filter((item) => allowedItemIds.has(String(item.id))),
    },
  };
}

async function assertClientCanAccessItem(clientId, accountId, boardId, itemId) {
  const portal = await getClientPortal(clientId, accountId, boardId);
  if (!portal) {
    const error = new Error('Board is not assigned to this client.');
    error.statusCode = 403;
    throw error;
  }

  const allowedItemIds = await getAllowedItemIds(clientId, accountId, boardId);
  if (allowedItemIds.size > 0 && !allowedItemIds.has(String(itemId))) {
    const error = new Error('Item is not shared with this client.');
    error.statusCode = 403;
    throw error;
  }
}

async function replaceClientItemPermissions(clientId, accountId, boardId, itemIds) {
  const db = getDb();
  await db.run(
    'DELETE FROM permissions WHERE client_id = ? AND monday_account_id = ? AND board_id = ?',
    [clientId, accountId, boardId]
  );

  const uniqueItemIds = [...new Set(itemIds.map((itemId) => String(itemId).trim()).filter(Boolean))];
  for (const itemId of uniqueItemIds) {
    await db.run(
      'INSERT INTO permissions (monday_account_id, client_id, board_id, item_id) VALUES (?, ?, ?, ?)',
      [accountId, clientId, boardId, itemId]
    );
  }

  return uniqueItemIds;
}

module.exports = {
  getClientPortal,
  getAllowedItemIds,
  filterBoardByAllowedItems,
  assertClientCanAccessItem,
  replaceClientItemPermissions,
};
