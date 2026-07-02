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
const { decryptString } = require('../services/cryptoService');
const {
  buildClientStorage,
  getClientById,
  isValidEmail,
  normalizeEmail,
  normalizeName,
  toPublicClient,
} = require('../services/clientDataService');
const {
  assertBillingActive,
  assertWithinPlanLimit,
  getAccountPlanSummary,
  recordUsageEvent,
  serializePlanError,
} = require('../services/planService');
const {
  getAccountNotificationEmail,
  sendApprovalDecisionNotification,
  sendClientInviteEmail,
  sendClientUpdateNotification,
  sendFileRequestEmail,
  sendFileSubmissionNotification,
  sendPlanLimitNotification,
} = require('../services/emailService');
const {
  createFileRequest,
  decorateBoardsForClientRoom,
  getFileRequestById,
  getPortalSettings,
  getSetupStatus,
  listActivity,
  listAdminFileRequests,
  recordActivity,
  submitFileRequest,
  updatePortalSettings,
  upsertApproval,
} = require('../services/clientRoomService');
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

function formatApprovalUpdateBody(client, decision, reason) {
  const author = `${client.name || 'Client'}${client.email ? ` (${client.email})` : ''}`;
  const label = decision === 'approved' ? 'Approved' : 'Requested changes';
  const safeAuthor = escapeHtml(author);
  const safeReason = reason ? escapeHtml(reason.trim()).replace(/\r?\n/g, '<br>') : '';
  return [
    `<p><strong>Client portal decision from ${safeAuthor}: ${label}</strong></p>`,
    safeReason ? `<p>${safeReason}</p>` : '',
  ].join('');
}

function formatFileSubmissionUpdateBody(client, request) {
  const author = `${client.name || 'Client'}${client.email ? ` (${client.email})` : ''}`;
  const links = (request.responseLinks || [])
    .map((link) => `<li><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></li>`)
    .join('');
  const note = request.responseNote ? `<p>${escapeHtml(request.responseNote).replace(/\r?\n/g, '<br>')}</p>` : '';
  return [
    `<p><strong>Client file submission from ${escapeHtml(author)}: ${escapeHtml(request.title)}</strong></p>`,
    note,
    links ? `<ul>${links}</ul>` : '',
  ].join('');
}

function getDecisionLabel(decision) {
  return decision === 'approved' ? 'Approved' : 'Changes requested';
}

function isPlanError(err) {
  return err?.code === 'SUBSCRIPTION_INACTIVE' || err?.code === 'PLAN_LIMIT_EXCEEDED';
}

async function notifyPlanLimit(accountId, err) {
  if (err?.code !== 'PLAN_LIMIT_EXCEEDED') return;

  try {
    const db = getDb();
    const account = await db.get('SELECT notification_email, billing_email FROM accounts WHERE monday_account_id = ?', [accountId]);
    await sendPlanLimitNotification({
      to: getAccountNotificationEmail(account),
      accountId,
      metric: err.metric,
      planLabel: err.plan?.label || 'current',
      usage: err.attempted,
      limit: err.limit,
    });
  } catch (emailErr) {
    console.error('Failed to send plan limit notification:', emailErr.message);
  }
}

async function respondWithPlanError(res, accountId, err) {
  await notifyPlanLimit(accountId, err);
  return res.status(err.statusCode || 402).json(serializePlanError(err));
}

async function sendInviteNotification(client, invite) {
  try {
    await sendClientInviteEmail({
      to: client.email,
      clientName: client.name,
      inviteUrl: invite.inviteUrl,
      expiresAt: invite.expiresAt,
    });
  } catch (emailErr) {
    console.error('Failed to send client invite email:', emailErr.message);
  }
}

function getSafeUpstreamError(err, fallback) {
  if (err?.code === 'MONDAY_PERMISSION_ERROR' || err?.isMondayPermissionError) {
    return 'Monday permissions are missing for item comments. Add the updates:read and updates:write scopes in the monday Developer Center, then reinstall or reauthorize the app.';
  }
  if (err?.isMondayApiError && err.message) {
    return `Monday API error: ${err.message}`;
  }
  return fallback;
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
    await assertBillingActive(accountId);

    // Find boards assigned to this client
    const portals = await db.all('SELECT * FROM portals WHERE client_id = ? AND monday_account_id = ?', [clientId, accountId]);
    console.log(`Portals found for client ${clientId}:`, portals.length);
    
    const token = decryptString(account.access_token);
    const boardsData = [];
    if (portals && portals.length > 0) {
      for (const portal of portals) {
        console.log(`Fetching data for Board ID: ${portal.board_id}`);
        const data = await getBoardData(token, portal.board_id);
        if (data && data.boards) {
          console.log(`Successfully fetched board: ${data.boards[0]?.name}`);
          const allowedItemIds = await getAllowedItemIds(clientId, accountId, portal.board_id);
          boardsData.push(...data.boards.map((board) => filterBoardByAllowedItems(board, allowedItemIds)));
        }
      }
    }

    const portalSettings = await getPortalSettings(db, accountId);
    const clientRoom = await decorateBoardsForClientRoom(db, boardsData, accountId, clientId);

    res.json({
      boards: clientRoom.boards,
      portalSettings,
      clientRoom: {
        summary: clientRoom.summary,
        fileRequests: clientRoom.fileRequests,
        recentActivity: clientRoom.recentActivity,
      },
    });
  } catch (error) {
    if (isPlanError(error)) {
      return respondWithPlanError(res, req.user?.accountId, error);
    }
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
    const client = await getClientById(db, clientId, accountId);
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

    const boardAlreadyAssigned = await db.get(
      'SELECT id FROM portals WHERE monday_account_id = ? AND board_id = ? LIMIT 1',
      [accountId, boardId]
    );
    if (!boardAlreadyAssigned) {
      await assertWithinPlanLimit(accountId, 'boards', 1);
    }

    const result = await db.run(
      'INSERT INTO portals (monday_account_id, client_id, board_id) VALUES (?, ?, ?)',
      [accountId, clientId, boardId]
    );
    await recordActivity(db, {
      accountId,
      clientId,
      boardId,
      eventType: 'board_assigned',
      actorType: 'admin',
      actorName: req.mondayUserId || 'monday admin',
      summary: `Board ${boardId} assigned to ${client.name || 'client'}`,
    });
    res.json({ success: true, portalId: result.lastID });
  } catch (err) {
    if (isPlanError(err)) {
      return respondWithPlanError(res, accountId, err);
    }
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

    await assertBillingActive(accountId);
    await assertClientCanAccessItem(clientId, accountId, boardId, itemId);
    await updateItemStatus(decryptString(account.access_token), boardId, itemId, resolvedColumnId, status);
    res.json({ success: true, columnUpdated: resolvedColumnId });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    if (isPlanError(err)) {
      return respondWithPlanError(res, accountId, err);
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

    await assertBillingActive(accountId);
    await assertClientCanAccessItem(clientId, accountId, boardId, itemId);
    const updates = await getMondayItemUpdates(decryptString(account.access_token), itemId);
    return res.json({ updates });
  } catch (err) {
    if (isPlanError(err)) {
      return respondWithPlanError(res, accountId, err);
    }
    if (err.statusCode && !err.isMondayApiError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error('Error fetching item updates:', err);
    return res.status(err.statusCode || 500).json({
      error: getSafeUpstreamError(err, 'Failed to fetch item updates.'),
    });
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
      getClientById(db, clientId, accountId),
    ]);

    if (!account || !account.access_token) {
      return res.status(500).json({ error: 'Internal setup error.' });
    }

    if (!client) {
      return res.status(404).json({ error: 'Client not found.' });
    }

    await assertWithinPlanLimit(accountId, 'clientUpdatesMonthly', 1);
    await assertClientCanAccessItem(clientId, accountId, boardId, itemId);
    const update = await createItemUpdate(decryptString(account.access_token), itemId, formatClientUpdateBody(client, body));
    await recordUsageEvent(accountId, 'client_update', 1, { boardId, itemId, clientId });
    await recordActivity(db, {
      accountId,
      clientId,
      boardId,
      itemId,
      eventType: 'comment_posted',
      actorType: 'client',
      actorName: client.name,
      summary: `${client.name || 'Client'} posted a comment`,
      metadata: { comment: body.trim().slice(0, 500) },
    });

    const notificationAccount = await db.get(
      'SELECT notification_email, billing_email FROM accounts WHERE monday_account_id = ?',
      [accountId]
    );
    await sendClientUpdateNotification({
      to: getAccountNotificationEmail(notificationAccount),
      clientName: client.name,
      clientEmail: client.email,
      boardId,
      itemId,
      comment: body.trim(),
    }).catch((emailErr) => console.error('Failed to send client update notification:', emailErr.message));

    return res.json({ success: true, update });
  } catch (err) {
    if (isPlanError(err)) {
      return respondWithPlanError(res, accountId, err);
    }
    if (err.statusCode && !err.isMondayApiError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error('Error creating item update:', err);
    return res.status(err.statusCode || 500).json({
      error: getSafeUpstreamError(err, 'Failed to post item update.'),
    });
  }
}

async function submitItemApproval(req, res) {
  const { itemId } = req.params;
  const { boardId, decision, reason = '', statusColumnId } = req.body;
  const { clientId, accountId } = req.user;

  if (!boardId || !itemId) {
    return res.status(400).json({ error: 'Board ID and Item ID are required.' });
  }

  if (!['approved', 'changes_requested'].includes(decision)) {
    return res.status(400).json({ error: 'Decision must be approved or changes_requested.' });
  }

  if (decision === 'changes_requested' && String(reason || '').trim().length === 0) {
    return res.status(400).json({ error: 'Please include a reason when requesting changes.' });
  }

  try {
    const db = getDb();
    const [account, client] = await Promise.all([
      db.get('SELECT access_token, notification_email, billing_email FROM accounts WHERE monday_account_id = ?', [accountId]),
      getClientById(db, clientId, accountId),
    ]);

    if (!account || !account.access_token) {
      return res.status(500).json({ error: 'Internal setup error.' });
    }
    if (!client) {
      return res.status(404).json({ error: 'Client not found.' });
    }

    await assertBillingActive(accountId);
    await assertClientCanAccessItem(clientId, accountId, boardId, itemId);

    const token = decryptString(account.access_token);
    const cleanReason = String(reason || '').trim().slice(0, 2000);
    const approval = await upsertApproval(db, {
      accountId,
      clientId,
      boardId,
      itemId,
      status: decision,
      reason: cleanReason,
    });

    await createItemUpdate(token, itemId, formatApprovalUpdateBody(client, decision, cleanReason));

    if (statusColumnId) {
      const nextStatus = decision === 'approved' ? 'Done' : 'Stuck';
      await updateItemStatus(token, boardId, itemId, statusColumnId, nextStatus);
    }

    await recordActivity(db, {
      accountId,
      clientId,
      boardId,
      itemId,
      eventType: decision === 'approved' ? 'item_approved' : 'changes_requested',
      actorType: 'client',
      actorName: client.name,
      summary: `${client.name || 'Client'}: ${getDecisionLabel(decision)}`,
      metadata: { reason: cleanReason },
    });

    await sendApprovalDecisionNotification({
      to: getAccountNotificationEmail(account),
      clientName: client.name,
      clientEmail: client.email,
      boardId,
      itemId,
      decision,
      reason: cleanReason,
    }).catch((emailErr) => console.error('Failed to send approval notification:', emailErr.message));

    return res.json({ success: true, approval });
  } catch (err) {
    if (isPlanError(err)) {
      return respondWithPlanError(res, accountId, err);
    }
    if (err.statusCode && !err.isMondayApiError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error('Error submitting item approval:', err);
    return res.status(err.statusCode || 500).json({
      error: getSafeUpstreamError(err, 'Failed to submit approval decision.'),
    });
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

    await assertBillingActive(accountId);
    const data = await getBoardData(decryptString(account.access_token), boardId);
    res.json({ board: data?.boards?.[0] || null });
  } catch (err) {
    if (isPlanError(err)) {
      return respondWithPlanError(res, accountId, err);
    }
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

    const currentItemIds = await getAllowedItemIds(id, accountId, boardId);
    const nextItemIds = new Set(itemIds.map(String));
    const delta = Math.max(nextItemIds.size - currentItemIds.size, 0);
    if (delta > 0) {
      await assertWithinPlanLimit(accountId, 'itemPermissions', delta);
    }

    const savedItemIds = await replaceClientItemPermissions(id, accountId, boardId, itemIds);
    await recordActivity(db, {
      accountId,
      clientId: id,
      boardId,
      eventType: 'item_visibility_updated',
      actorType: 'admin',
      actorName: req.mondayUserId || 'monday admin',
      summary: `Item visibility updated (${savedItemIds.length || 'all'} selected)`,
      metadata: { itemCount: savedItemIds.length },
    });
    res.json({ success: true, itemIds: savedItemIds });
  } catch (err) {
    if (isPlanError(err)) {
      return respondWithPlanError(res, accountId, err);
    }
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
    const safeClients = clients.map(({ latest_invite_expires_at, ...client }) => {
      const inviteExpiresAt = latest_invite_expires_at ? Number(latest_invite_expires_at) : null;
      const inviteStatus = inviteExpiresAt ? (inviteExpiresAt > now ? 'pending' : 'expired') : 'active';
      const publicClient = toPublicClient(client);

      return {
        ...publicClient,
        invite_status: inviteStatus,
        pending_invite_expires_at: inviteExpiresAt,
      };
    });
    const portalSettings = await getPortalSettings(db, accountId);
    const [billing, setup, recentActivity, fileRequests] = await Promise.all([
      getAccountPlanSummary(accountId),
      getSetupStatus(db, accountId, portalSettings),
      listActivity(db, accountId, { limit: 12 }),
      listAdminFileRequests(db, accountId, { limit: 12 }),
    ]);
    res.json({ clients: safeClients, billing, portalSettings, setup, recentActivity, fileRequests });
  } catch (err) {
    console.error('Error fetching clients:', err);
    res.status(500).json({ error: 'Failed to fetch clients.' });
  }
}

async function getAdminPortalSettings(req, res) {
  try {
    const accountId = req.mondayAccountId;
    const db = getDb();
    const portalSettings = await getPortalSettings(db, accountId);
    const setup = await getSetupStatus(db, accountId, portalSettings);
    return res.json({ portalSettings, setup });
  } catch (err) {
    console.error('Error fetching portal settings:', err);
    return res.status(500).json({ error: 'Failed to fetch portal settings.' });
  }
}

async function saveAdminPortalSettings(req, res) {
  try {
    const accountId = req.mondayAccountId;
    const db = getDb();
    await assertBillingActive(accountId);
    const portalSettings = await updatePortalSettings(db, accountId, req.body || {});
    const setup = await getSetupStatus(db, accountId, portalSettings);
    await recordActivity(db, {
      accountId,
      eventType: 'portal_branding_updated',
      actorType: 'admin',
      actorName: req.mondayUserId || 'monday admin',
      summary: 'Portal branding was updated',
      metadata: { portalName: portalSettings.portalName },
    });
    return res.json({ success: true, portalSettings, setup });
  } catch (err) {
    if (isPlanError(err)) {
      return respondWithPlanError(res, req.mondayAccountId, err);
    }
    console.error('Error saving portal settings:', err);
    return res.status(500).json({ error: 'Failed to save portal settings.' });
  }
}

async function getAdminActivity(req, res) {
  try {
    const activity = await listActivity(getDb(), req.mondayAccountId, {
      clientId: req.query.clientId,
      boardId: req.query.boardId,
      itemId: req.query.itemId,
      limit: req.query.limit,
    });
    return res.json({ activity });
  } catch (err) {
    console.error('Error fetching activity:', err);
    return res.status(500).json({ error: 'Failed to fetch activity.' });
  }
}

async function getAdminFileRequests(req, res) {
  try {
    const fileRequests = await listAdminFileRequests(getDb(), req.mondayAccountId, {
      clientId: req.query.clientId,
      boardId: req.query.boardId,
      limit: req.query.limit,
    });
    return res.json({ fileRequests });
  } catch (err) {
    console.error('Error fetching file requests:', err);
    return res.status(500).json({ error: 'Failed to fetch file requests.' });
  }
}

async function createClientFileRequest(req, res) {
  const { id } = req.params;
  const { boardId, itemId, title, instructions, dueAt } = req.body;
  const accountId = req.mondayAccountId;

  if (!boardId) {
    return res.status(400).json({ error: 'Board ID is required.' });
  }

  try {
    const db = getDb();
    const [client, account] = await Promise.all([
      getClientById(db, id, accountId),
      db.get('SELECT notification_email, billing_email FROM accounts WHERE monday_account_id = ?', [accountId]),
    ]);

    if (!client) {
      return res.status(404).json({ error: 'Client not found or unowned' });
    }

    const portal = await db.get(
      'SELECT id FROM portals WHERE client_id = ? AND monday_account_id = ? AND board_id = ?',
      [id, accountId, boardId]
    );
    if (!portal) {
      return res.status(400).json({ error: 'Board must be assigned to this client before requesting files.' });
    }

    await assertBillingActive(accountId);
    const fileRequest = await createFileRequest(db, {
      accountId,
      clientId: client.id,
      boardId,
      itemId,
      title,
      instructions,
      dueAt,
      requestedBy: req.mondayUserId || 'monday admin',
    });

    await sendFileRequestEmail({
      to: client.email,
      clientName: client.name,
      title: fileRequest.title,
      instructions: fileRequest.instructions,
      dueAt: fileRequest.dueAt,
    }).catch((emailErr) => console.error('Failed to send file request email:', emailErr.message));

    await sendClientUpdateNotification({
      to: getAccountNotificationEmail(account),
      clientName: client.name,
      clientEmail: client.email,
      boardId,
      itemId: itemId || 'General',
      comment: `File request created: ${fileRequest.title}`,
    }).catch((emailErr) => console.error('Failed to send internal file request notification:', emailErr.message));

    return res.json({ success: true, fileRequest });
  } catch (err) {
    if (isPlanError(err)) {
      return respondWithPlanError(res, accountId, err);
    }
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error('Error creating file request:', err);
    return res.status(500).json({ error: 'Failed to create file request.' });
  }
}

async function submitClientFileRequest(req, res) {
  const { id } = req.params;
  const { note, links } = req.body;
  const { clientId, accountId } = req.user;

  try {
    const db = getDb();
    const [account, client] = await Promise.all([
      db.get('SELECT access_token, notification_email, billing_email FROM accounts WHERE monday_account_id = ?', [accountId]),
      getClientById(db, clientId, accountId),
    ]);

    if (!account || !account.access_token) {
      return res.status(500).json({ error: 'Internal setup error.' });
    }
    if (!client) {
      return res.status(404).json({ error: 'Client not found.' });
    }

    await assertBillingActive(accountId);
    const existingRequest = await getFileRequestById(db, accountId, id);
    if (!existingRequest || Number(existingRequest.clientId) !== Number(clientId)) {
      return res.status(404).json({ error: 'File request not found.' });
    }

    if (existingRequest.itemId) {
      await assertClientCanAccessItem(clientId, accountId, existingRequest.boardId, existingRequest.itemId);
    }

    const fileRequest = await submitFileRequest(db, {
      accountId,
      clientId,
      requestId: id,
      note,
      links,
    });

    if (fileRequest.itemId) {
      await createItemUpdate(
        decryptString(account.access_token),
        fileRequest.itemId,
        formatFileSubmissionUpdateBody(client, fileRequest)
      );
    }

    await sendFileSubmissionNotification({
      to: getAccountNotificationEmail(account),
      clientName: client.name,
      clientEmail: client.email,
      boardId: fileRequest.boardId,
      itemId: fileRequest.itemId,
      title: fileRequest.title,
      links: fileRequest.responseLinks,
      note: fileRequest.responseNote,
    }).catch((emailErr) => console.error('Failed to send file submission notification:', emailErr.message));

    return res.json({ success: true, fileRequest });
  } catch (err) {
    if (isPlanError(err)) {
      return respondWithPlanError(res, accountId, err);
    }
    if (err.statusCode && !err.isMondayApiError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error('Error submitting file request:', err);
    return res.status(err.statusCode || 500).json({
      error: getSafeUpstreamError(err, 'Failed to submit file request.'),
    });
  }
}

async function createClient(req, res) {
  const { name, email, password } = req.body;
  const accountId = req.mondayAccountId;

  const cleanName = normalizeName(name);
  const cleanEmail = normalizeEmail(email);

  if (!cleanName || !cleanEmail) {
    return res.status(400).json({ error: 'Name and email are required' });
  }

  if (!isValidEmail(cleanEmail)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  if (password && !isValidPassword(password)) {
    return res.status(400).json({ error: 'Password must be between 8 and 128 characters' });
  }

  try {
    const db = getDb();
    await assertWithinPlanLimit(accountId, 'clients', 1);
    const initialPassword = password || crypto.randomBytes(32).toString('hex');
    const hash = await bcrypt.hash(initialPassword, 10);
    const storage = buildClientStorage(accountId, cleanName, cleanEmail);
    const result = await db.run(
      `INSERT INTO clients
        (monday_account_id, name, email, password_hash, name_encrypted, email_encrypted, email_hash, pii_encrypted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        accountId,
        storage.name,
        storage.email,
        hash,
        storage.name_encrypted,
        storage.email_encrypted,
        storage.email_hash,
        storage.pii_encrypted_at,
      ]
    );
    await recordActivity(db, {
      accountId,
      clientId: result.lastID,
      eventType: 'client_created',
      actorType: 'admin',
      actorName: req.mondayUserId || 'monday admin',
      summary: `Client created: ${cleanName}`,
    });

    if (!password) {
      const invite = await createClientInvite(result.lastID, req);
      await sendInviteNotification({ id: result.lastID, name: cleanName, email: cleanEmail }, invite);
      return res.json({ success: true, clientId: result.lastID, invite });
    }

    return res.json({ success: true, clientId: result.lastID });
  } catch (err) {
    if (isPlanError(err)) {
      return respondWithPlanError(res, accountId, err);
    }
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
  
  const cleanName = normalizeName(name);
  const cleanEmail = normalizeEmail(email);

  if (!cleanName || !cleanEmail) {
    return res.status(400).json({ error: 'Name and email are required' });
  }

  if (!isValidEmail(cleanEmail)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  if (password && !isValidPassword(password)) {
    return res.status(400).json({ error: 'Password must be between 8 and 128 characters' });
  }

  try {
    const db = getDb();
    const storage = buildClientStorage(accountId, cleanName, cleanEmail);
    
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await db.run(
        `UPDATE clients
         SET name = ?, email = ?, password_hash = ?, name_encrypted = ?, email_encrypted = ?, email_hash = ?, pii_encrypted_at = ?
         WHERE id = ? AND monday_account_id = ?`,
        [
          storage.name,
          storage.email,
          hash,
          storage.name_encrypted,
          storage.email_encrypted,
          storage.email_hash,
          storage.pii_encrypted_at,
          id,
          accountId,
        ]
      );
    } else {
      await db.run(
        `UPDATE clients
         SET name = ?, email = ?, name_encrypted = ?, email_encrypted = ?, email_hash = ?, pii_encrypted_at = ?
         WHERE id = ? AND monday_account_id = ?`,
        [
          storage.name,
          storage.email,
          storage.name_encrypted,
          storage.email_encrypted,
          storage.email_hash,
          storage.pii_encrypted_at,
          id,
          accountId,
        ]
      );
    }
    await recordActivity(db, {
      accountId,
      clientId: id,
      eventType: 'client_updated',
      actorType: 'admin',
      actorName: req.mondayUserId || 'monday admin',
      summary: `Client updated: ${cleanName}`,
    });
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
    const client = await getClientById(db, id, accountId);
    if (!client) {
      return res.status(404).json({ error: 'Client not found or unowned' });
    }

    const invite = await createClientInvite(client.id, req);
    await sendInviteNotification(client, invite);
    return res.json({ success: true, client, invite });
  } catch (err) {
    if (isPlanError(err)) {
      return respondWithPlanError(res, accountId, err);
    }
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
    await db.run('DELETE FROM item_approvals WHERE client_id = ? AND monday_account_id = ?', [id, accountId]);
    await db.run('DELETE FROM client_file_requests WHERE client_id = ? AND monday_account_id = ?', [id, accountId]);
    await db.run('DELETE FROM client_activity_events WHERE client_id = ? AND monday_account_id = ?', [id, accountId]);
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
  submitItemApproval,
  getAdminBoard,
  getClientPermissions,
  updateClientPermissions,
  getClients,
  getAdminPortalSettings,
  saveAdminPortalSettings,
  getAdminActivity,
  getAdminFileRequests,
  createClientFileRequest,
  submitClientFileRequest,
  createClient,
  updateClient,
  createInviteForClient,
  deleteClient,
  formatClientUpdateBody
};
