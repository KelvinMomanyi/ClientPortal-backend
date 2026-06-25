const {
  getBoardData,
  updateItemStatus,
  getItemUpdates: getMondayItemUpdates,
  createItemUpdate,
} = require('../services/mondayService');
const { getDb } = require('../services/dbService');
const {
  getAllowedItemIds,
  filterBoardByAllowedItems,
  assertClientCanAccessItem,
  replaceClientItemPermissions,
} = require('../services/permissionService');
const { createClientInvite } = require('../services/inviteService');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

function isValidPassword(password) {
  return typeof password === 'string' && password.length >= 8 && password.length <= 128;
}

function isValidComment(comment) {
  return typeof comment === 'string' && comment.trim().length > 0 && comment.trim().length <= 5000;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatClientUpdateBody(client, comment) {
  const author = `${client.name || 'Client'}${client.email ? ` (${client.email})` : ''}`;
  const safeAuthor = escapeHtml(author);
  const safeComment = escapeHtml(comment.trim()).replace(/\r?\n/g, '<br>');
  return `<p><strong>Client portal update from ${safeAuthor}</strong></p><p>${safeComment}</p>`;
}

async function getClientDashboard(req, res) {
  try {
    const { clientId, accountId } = req.user; // From authMiddleware (which decodes authController token)
    if (!accountId) {
      return res.status(403).json({ error: 'Client not associated with a Monday account' });
    }

    const db = getDb();
    
    // Check account token and subscription
    const account = await db.get('SELECT * FROM accounts WHERE monday_account_id = ?', [accountId]);
    if (!account || !account.access_token) {
      return res.status(500).json({ error: 'Monday account integration not found.' });
    }
    if (account.subscription_status !== 'active') { // For future monetization
      return res.status(403).json({ error: 'Monday account subscription is inactive.' });
    }

    // Find boards assigned to this client
    const portals = await db.all('SELECT * FROM portals WHERE client_id = ? AND monday_account_id = ?', [clientId, accountId]);
    console.log(`Portals found for client ${clientId}:`, portals.length);
    
    if (!portals || portals.length === 0) {
      return res.json({ boards: [] });
    }

    const token = account.access_token;
    const boardsData = [];
    for (const portal of portals) {
      console.log(`Fetching data for Board ID: ${portal.board_id}`);
      const data = await getBoardData(token, portal.board_id);
      if (data && data.boards) {
        console.log(`Successfully fetched board: ${data.boards[0]?.name}`);
        const allowedItemIds = await getAllowedItemIds(clientId, accountId, portal.board_id);
        boardsData.push(...data.boards.map((board) => filterBoardByAllowedItems(board, allowedItemIds)));
      }
    }

    res.json({ boards: boardsData });
  } catch (error) {
    console.error('Error fetching client dashboard:', error);
    res.status(500).json({ error: 'Failed to fetch Monday data' });
  }
}

async function assignBoardToClient(req, res) {
  const { clientId, boardId } = req.body;
  const accountId = req.mondayAccountId;

  if (!clientId || !boardId) {
    return res.status(400).json({ error: 'Client ID and Board ID are required.' });
  }

  try {
    const db = getDb();
    // Check if client exists and belongs to this account
    const client = await db.get('SELECT * FROM clients WHERE id = ? AND monday_account_id = ?', [clientId, accountId]);
    if (!client) {
      return res.status(404).json({ error: 'Client not found or belongs to a different account.' });
    }

    // Check if mapping already exists
    const exists = await db.get(
      'SELECT * FROM portals WHERE monday_account_id = ? AND client_id = ? AND board_id = ?',
      [accountId, clientId, boardId]
    );
    if (exists) {
      return res.status(400).json({ error: 'Board already assigned to this client.' });
    }

    const result = await db.run(
      'INSERT INTO portals (monday_account_id, client_id, board_id) VALUES (?, ?, ?)',
      [accountId, clientId, boardId]
    );
    res.json({ success: true, portalId: result.lastID });
  } catch (err) {
    console.error('Error assigning board:', err);
    res.status(500).json({ error: 'Could not assign board.' });
  }
}

async function updateStatus(req, res) {
  const { boardId, itemId, status, columnId } = req.body;
  const { clientId, accountId } = req.user;

  const resolvedColumnId = columnId || 'status';

  if (!boardId || !itemId || !status) {
    return res.status(400).json({ error: 'Board ID, Item ID, and status are required.' });
  }

  try {
    const db = getDb();
    const account = await db.get('SELECT access_token FROM accounts WHERE monday_account_id = ?', [accountId]);
    if (!account || !account.access_token) {
      return res.status(500).json({ error: 'Internal setup error.' });
    }

    await assertClientCanAccessItem(clientId, accountId, boardId, itemId);
    await updateItemStatus(account.access_token, boardId, itemId, resolvedColumnId, status);
    res.json({ success: true, columnUpdated: resolvedColumnId });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error('Error updating status:', err);
    res.status(500).json({ error: 'Failed to update status on Monday.com' });
  }
}

async function getItemUpdates(req, res) {
  const { itemId } = req.params;
  const { boardId } = req.query;
  const { clientId, accountId } = req.user;

  if (!boardId || !itemId) {
    return res.status(400).json({ error: 'Board ID and Item ID are required.' });
  }

  try {
    const db = getDb();
    const account = await db.get('SELECT access_token FROM accounts WHERE monday_account_id = ?', [accountId]);
    if (!account || !account.access_token) {
      return res.status(500).json({ error: 'Internal setup error.' });
    }

    await assertClientCanAccessItem(clientId, accountId, boardId, itemId);
    const updates = await getMondayItemUpdates(account.access_token, itemId);
    return res.json({ updates });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error('Error fetching item updates:', err);
    return res.status(500).json({ error: 'Failed to fetch item updates.' });
  }
}

async function createClientItemUpdate(req, res) {
  const { itemId } = req.params;
  const { boardId, body } = req.body;
  const { clientId, accountId } = req.user;

  if (!boardId || !itemId) {
    return res.status(400).json({ error: 'Board ID and Item ID are required.' });
  }

  if (!isValidComment(body)) {
    return res.status(400).json({ error: 'Comment must be between 1 and 5000 characters.' });
  }

  try {
    const db = getDb();
    const [account, client] = await Promise.all([
      db.get('SELECT access_token FROM accounts WHERE monday_account_id = ?', [accountId]),
      db.get('SELECT name, email FROM clients WHERE id = ? AND monday_account_id = ?', [clientId, accountId]),
    ]);

    if (!account || !account.access_token) {
      return res.status(500).json({ error: 'Internal setup error.' });
    }

    if (!client) {
      return res.status(404).json({ error: 'Client not found.' });
    }

    await assertClientCanAccessItem(clientId, accountId, boardId, itemId);
    const update = await createItemUpdate(account.access_token, itemId, formatClientUpdateBody(client, body));
    return res.json({ success: true, update });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error('Error creating item update:', err);
    return res.status(500).json({ error: 'Failed to post item update.' });
  }
}

async function getAdminBoard(req, res) {
  const { boardId } = req.params;
  const accountId = req.mondayAccountId;

  if (!boardId) {
    return res.status(400).json({ error: 'Board ID is required.' });
  }

  try {
    const db = getDb();
    const account = await db.get('SELECT access_token FROM accounts WHERE monday_account_id = ?', [accountId]);
    if (!account || !account.access_token) {
      return res.status(500).json({ error: 'Monday account integration not found.' });
    }

    const data = await getBoardData(account.access_token, boardId);
    res.json({ board: data?.boards?.[0] || null });
  } catch (err) {
    console.error('Error fetching admin board:', err);
    res.status(500).json({ error: 'Failed to fetch Monday board.' });
  }
}

async function getClientPermissions(req, res) {
  const { id } = req.params;
  const { boardId } = req.query;
  const accountId = req.mondayAccountId;

  if (!boardId) {
    return res.status(400).json({ error: 'Board ID is required.' });
  }

  try {
    const db = getDb();
    const client = await db.get('SELECT id FROM clients WHERE id = ? AND monday_account_id = ?', [id, accountId]);
    if (!client) {
      return res.status(404).json({ error: 'Client not found or unowned' });
    }

    const allowedItemIds = await getAllowedItemIds(id, accountId, boardId);
    res.json({ itemIds: [...allowedItemIds] });
  } catch (err) {
    console.error('Error fetching permissions:', err);
    res.status(500).json({ error: 'Failed to fetch permissions.' });
  }
}

async function updateClientPermissions(req, res) {
  const { id } = req.params;
  const { boardId, itemIds } = req.body;
  const accountId = req.mondayAccountId;

  if (!boardId || !Array.isArray(itemIds)) {
    return res.status(400).json({ error: 'Board ID and itemIds array are required.' });
  }

  try {
    const db = getDb();
    const client = await db.get('SELECT id FROM clients WHERE id = ? AND monday_account_id = ?', [id, accountId]);
    if (!client) {
      return res.status(404).json({ error: 'Client not found or unowned' });
    }

    const portal = await db.get(
      'SELECT id FROM portals WHERE client_id = ? AND monday_account_id = ? AND board_id = ?',
      [id, accountId, boardId]
    );
    if (!portal) {
      return res.status(400).json({ error: 'Board must be assigned before item permissions can be set.' });
    }

    const savedItemIds = await replaceClientItemPermissions(id, accountId, boardId, itemIds);
    res.json({ success: true, itemIds: savedItemIds });
  } catch (err) {
    console.error('Error updating permissions:', err);
    res.status(500).json({ error: 'Failed to update permissions.' });
  }
}

async function getClients(req, res) {
  try {
    const accountId = req.mondayAccountId;
    const db = getDb();
    
    const clients = await db.all(`
      SELECT
        c.*,
        COUNT(DISTINCT p.id) as portal_count,
        MAX(CASE WHEN i.used_at IS NULL THEN i.expires_at END) as latest_invite_expires_at
      FROM clients c 
      LEFT JOIN portals p ON c.id = p.client_id 
      LEFT JOIN client_invites i ON i.client_id = c.id
      WHERE c.monday_account_id = ?
      GROUP BY c.id
    `, [accountId]);
    
    const now = Date.now();
    const safeClients = clients.map(({ password_hash, latest_invite_expires_at, ...client }) => {
      const inviteExpiresAt = latest_invite_expires_at ? Number(latest_invite_expires_at) : null;
      const inviteStatus = inviteExpiresAt ? (inviteExpiresAt > now ? 'pending' : 'expired') : 'active';

      return {
        ...client,
        invite_status: inviteStatus,
        pending_invite_expires_at: inviteExpiresAt,
      };
    });
    res.json({ clients: safeClients });
  } catch (err) {
    console.error('Error fetching clients:', err);
    res.status(500).json({ error: 'Failed to fetch clients.' });
  }
}

async function createClient(req, res) {
  const { name, email, password } = req.body;
  const accountId = req.mondayAccountId;

  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required' });
  }

  if (password && !isValidPassword(password)) {
    return res.status(400).json({ error: 'Password must be between 8 and 128 characters' });
  }

  try {
    const db = getDb();
    const initialPassword = password || crypto.randomBytes(32).toString('hex');
    const hash = await bcrypt.hash(initialPassword, 10);
    const result = await db.run(
      'INSERT INTO clients (monday_account_id, name, email, password_hash) VALUES (?, ?, ?, ?)',
      [accountId, name.trim(), email.trim().toLowerCase(), hash]
    );

    if (!password) {
      const invite = await createClientInvite(result.lastID, req);
      return res.json({ success: true, clientId: result.lastID, invite });
    }

    return res.json({ success: true, clientId: result.lastID });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'Email already exists' });
    }
    console.error('Error creating client:', err);
    res.status(500).json({ error: 'Failed to create client' });
  }
}

async function updateClient(req, res) {
  const { id } = req.params;
  const { name, email, password } = req.body;
  const accountId = req.mondayAccountId;
  
  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required' });
  }

  if (password && !isValidPassword(password)) {
    return res.status(400).json({ error: 'Password must be between 8 and 128 characters' });
  }

  try {
    const db = getDb();
    
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await db.run(
        'UPDATE clients SET name = ?, email = ?, password_hash = ? WHERE id = ? AND monday_account_id = ?',
        [name.trim(), email.trim().toLowerCase(), hash, id, accountId]
      );
    } else {
      await db.run(
        'UPDATE clients SET name = ?, email = ? WHERE id = ? AND monday_account_id = ?',
        [name.trim(), email.trim().toLowerCase(), id, accountId]
      );
    }
    res.json({ success: true });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'Email already exists' });
    }
    console.error('Error updating client:', err);
    res.status(500).json({ error: 'Failed to update client' });
  }
}

async function createInviteForClient(req, res) {
  const { id } = req.params;
  const accountId = req.mondayAccountId;

  try {
    const db = getDb();
    const client = await db.get('SELECT id, name, email FROM clients WHERE id = ? AND monday_account_id = ?', [id, accountId]);
    if (!client) {
      return res.status(404).json({ error: 'Client not found or unowned' });
    }

    const invite = await createClientInvite(client.id, req);
    return res.json({ success: true, client, invite });
  } catch (err) {
    console.error('Error creating client invite:', err);
    return res.status(500).json({ error: 'Failed to create invite' });
  }
}

async function deleteClient(req, res) {
  const { id } = req.params;
  const accountId = req.mondayAccountId;

  try {
    const db = getDb();
    
    const client = await db.get('SELECT id FROM clients WHERE id = ? AND monday_account_id = ?', [id, accountId]);
    if (!client) {
      return res.status(404).json({ error: 'Client not found or unowned' });
    }

    await db.run('DELETE FROM portals WHERE client_id = ? AND monday_account_id = ?', [id, accountId]);
    await db.run('DELETE FROM permissions WHERE client_id = ? AND monday_account_id = ?', [id, accountId]);
    await db.run('DELETE FROM client_invites WHERE client_id = ?', [id]);
    await db.run('DELETE FROM clients WHERE id = ? AND monday_account_id = ?', [id, accountId]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting client:', err);
    res.status(500).json({ error: 'Failed to delete client' });
  }
}

module.exports = {
  getClientDashboard,
  assignBoardToClient,
  updateStatus,
  getItemUpdates,
  createClientItemUpdate,
  getAdminBoard,
  getClientPermissions,
  updateClientPermissions,
  getClients,
  createClient,
  updateClient,
  createInviteForClient,
  deleteClient,
  formatClientUpdateBody
};
