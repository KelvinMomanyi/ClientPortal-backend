const DEFAULT_PORTAL_SETTINGS = {
  portalName: 'Client Approval Portal',
  logoUrl: '',
  primaryColor: '#0073ea',
  welcomeMessage: 'Review approvals, files, decisions, and project updates in one secure client room.',
  supportEmail: '',
};

const APPROVAL_STATUSES = new Set(['pending', 'approved', 'changes_requested']);
const FILE_REQUEST_STATUSES = new Set(['open', 'submitted', 'closed']);

function cleanText(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength);
}

function cleanOptionalText(value, maxLength = 500) {
  const cleaned = cleanText(value, maxLength);
  return cleaned || null;
}

function normalizeColor(value) {
  const color = cleanText(value, 16);
  return /^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULT_PORTAL_SETTINGS.primaryColor;
}

function normalizeUrl(value) {
  const url = cleanText(value, 500);
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function normalizeEmailLike(value) {
  const email = cleanText(value, 254);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function normalizePortalSettings(account = {}) {
  return {
    portalName: cleanText(account.portal_name, 80) || DEFAULT_PORTAL_SETTINGS.portalName,
    logoUrl: normalizeUrl(account.portal_logo_url),
    primaryColor: normalizeColor(account.portal_primary_color),
    welcomeMessage: cleanText(account.portal_welcome_message, 240) || DEFAULT_PORTAL_SETTINGS.welcomeMessage,
    supportEmail: normalizeEmailLike(account.support_email),
  };
}

function normalizePortalSettingsInput(input = {}) {
  return {
    portalName: cleanText(input.portalName, 80) || DEFAULT_PORTAL_SETTINGS.portalName,
    logoUrl: normalizeUrl(input.logoUrl),
    primaryColor: normalizeColor(input.primaryColor),
    welcomeMessage: cleanText(input.welcomeMessage, 240) || DEFAULT_PORTAL_SETTINGS.welcomeMessage,
    supportEmail: normalizeEmailLike(input.supportEmail),
  };
}

async function getPortalSettings(db, accountId) {
  const account = await db.get('SELECT * FROM accounts WHERE monday_account_id = ?', [String(accountId)]);
  return normalizePortalSettings(account || {});
}

async function updatePortalSettings(db, accountId, input = {}) {
  const settings = normalizePortalSettingsInput(input);
  await db.run(
    `UPDATE accounts
     SET portal_name = ?, portal_logo_url = ?, portal_primary_color = ?, portal_welcome_message = ?, support_email = ?
     WHERE monday_account_id = ?`,
    [
      settings.portalName,
      settings.logoUrl || null,
      settings.primaryColor,
      settings.welcomeMessage,
      settings.supportEmail || null,
      String(accountId),
    ]
  );
  return settings;
}

async function getSetupStatus(db, accountId, settings) {
  const [clientsRow, portalsRow, permissionsRow] = await Promise.all([
    db.get('SELECT COUNT(*) as count FROM clients WHERE monday_account_id = ?', [String(accountId)]),
    db.get('SELECT COUNT(*) as count FROM portals WHERE monday_account_id = ?', [String(accountId)]),
    db.get('SELECT COUNT(*) as count FROM permissions WHERE monday_account_id = ?', [String(accountId)]),
  ]);

  const hasBranding = Boolean(
    settings?.portalName &&
    settings.portalName !== DEFAULT_PORTAL_SETTINGS.portalName &&
    settings?.welcomeMessage
  );

  const steps = [
    { key: 'brand_portal', label: 'Brand the portal', complete: hasBranding },
    { key: 'create_client', label: 'Create or invite a client', complete: Number(clientsRow?.count || 0) > 0 },
    { key: 'assign_board', label: 'Assign a board', complete: Number(portalsRow?.count || 0) > 0 },
    { key: 'set_visibility', label: 'Set item visibility', complete: Number(permissionsRow?.count || 0) > 0 },
  ];

  return {
    complete: steps.every((step) => step.complete),
    steps,
    counts: {
      clients: Number(clientsRow?.count || 0),
      portals: Number(portalsRow?.count || 0),
      itemPermissions: Number(permissionsRow?.count || 0),
    },
  };
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function serializeApproval(row) {
  if (!row) {
    return {
      status: 'pending',
      reason: '',
      decidedAt: null,
      updatedAt: null,
    };
  }

  return {
    id: row.id,
    status: APPROVAL_STATUSES.has(row.status) ? row.status : 'pending',
    reason: row.reason || '',
    decidedAt: row.decided_at ? Number(row.decided_at) : null,
    updatedAt: row.updated_at ? Number(row.updated_at) : null,
  };
}

function serializeActivity(row) {
  return {
    id: row.id,
    clientId: row.client_id ? Number(row.client_id) : null,
    boardId: row.board_id ? String(row.board_id) : null,
    itemId: row.item_id ? String(row.item_id) : null,
    eventType: row.event_type,
    actorType: row.actor_type,
    actorName: row.actor_name || '',
    summary: row.summary,
    metadata: parseJson(row.metadata, {}),
    createdAt: Number(row.created_at || 0),
  };
}

function serializeFileRequest(row) {
  return {
    id: row.id,
    clientId: Number(row.client_id),
    boardId: String(row.board_id),
    itemId: row.item_id ? String(row.item_id) : '',
    title: row.title,
    instructions: row.instructions || '',
    dueAt: row.due_at ? Number(row.due_at) : null,
    status: FILE_REQUEST_STATUSES.has(row.status) ? row.status : 'open',
    requestedBy: row.requested_by || '',
    responseNote: row.response_note || '',
    responseLinks: parseJson(row.response_links, []),
    respondedAt: row.responded_at ? Number(row.responded_at) : null,
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
  };
}

async function recordActivity(
  db,
  { accountId, clientId = null, boardId = null, itemId = null, eventType, actorType, actorName = '', summary, metadata = {} }
) {
  const result = await db.run(
    `INSERT INTO client_activity_events
      (monday_account_id, client_id, board_id, item_id, event_type, actor_type, actor_name, summary, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(accountId),
      clientId,
      boardId ? String(boardId) : null,
      itemId ? String(itemId) : null,
      eventType,
      actorType,
      cleanOptionalText(actorName, 120),
      cleanText(summary, 500),
      JSON.stringify(metadata || {}),
      Date.now(),
    ]
  );
  return result.lastID;
}

async function listActivity(db, accountId, { clientId, boardId, itemId, limit = 20 } = {}) {
  const clauses = ['monday_account_id = ?'];
  const params = [String(accountId)];

  if (clientId) {
    clauses.push('client_id = ?');
    params.push(Number(clientId));
  }
  if (boardId) {
    clauses.push('board_id = ?');
    params.push(String(boardId));
  }
  if (itemId) {
    clauses.push('item_id = ?');
    params.push(String(itemId));
  }

  params.push(Math.min(Math.max(Number(limit) || 20, 1), 100));
  const rows = await db.all(
    `SELECT * FROM client_activity_events
     WHERE ${clauses.join(' AND ')}
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    params
  );
  return rows.map(serializeActivity);
}

async function getApproval(db, accountId, clientId, boardId, itemId) {
  const row = await db.get(
    `SELECT * FROM item_approvals
     WHERE monday_account_id = ? AND client_id = ? AND board_id = ? AND item_id = ?`,
    [String(accountId), Number(clientId), String(boardId), String(itemId)]
  );
  return serializeApproval(row);
}

async function upsertApproval(db, { accountId, clientId, boardId, itemId, status, reason = '' }) {
  const normalizedStatus = APPROVAL_STATUSES.has(status) ? status : 'pending';
  const now = Date.now();
  const existing = await db.get(
    `SELECT id FROM item_approvals
     WHERE monday_account_id = ? AND client_id = ? AND board_id = ? AND item_id = ?`,
    [String(accountId), Number(clientId), String(boardId), String(itemId)]
  );

  if (existing) {
    await db.run(
      `UPDATE item_approvals
       SET status = ?, reason = ?, decided_at = ?, updated_at = ?
       WHERE id = ?`,
      [normalizedStatus, cleanOptionalText(reason, 2000), now, now, existing.id]
    );
  } else {
    await db.run(
      `INSERT INTO item_approvals
        (monday_account_id, client_id, board_id, item_id, status, reason, decided_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(accountId),
        Number(clientId),
        String(boardId),
        String(itemId),
        normalizedStatus,
        cleanOptionalText(reason, 2000),
        now,
        now,
        now,
      ]
    );
  }

  return getApproval(db, accountId, clientId, boardId, itemId);
}

function getBoardItemKeys(boards = []) {
  return boards.flatMap((board) =>
    (board.items_page?.items || []).map((item) => ({
      boardId: String(board.id),
      itemId: String(item.id),
    }))
  );
}

async function getApprovalsForClient(db, accountId, clientId) {
  const rows = await db.all(
    `SELECT * FROM item_approvals
     WHERE monday_account_id = ? AND client_id = ?`,
    [String(accountId), Number(clientId)]
  );
  return new Map(rows.map((row) => [`${row.board_id}:${row.item_id}`, serializeApproval(row)]));
}

async function getFileRequestsForClient(db, accountId, clientId) {
  const rows = await db.all(
    `SELECT * FROM client_file_requests
     WHERE monday_account_id = ? AND client_id = ?
     ORDER BY status ASC, COALESCE(due_at, 9999999999999) ASC, created_at DESC`,
    [String(accountId), Number(clientId)]
  );
  return rows.map(serializeFileRequest);
}

async function decorateBoardsForClientRoom(db, boards, accountId, clientId) {
  const [approvalMap, fileRequests, activity] = await Promise.all([
    getApprovalsForClient(db, accountId, clientId),
    getFileRequestsForClient(db, accountId, clientId),
    listActivity(db, accountId, { clientId, limit: 100 }),
  ]);

  const requestMap = new Map();
  fileRequests.forEach((request) => {
    if (!request.itemId) return;
    const key = `${request.boardId}:${request.itemId}`;
    requestMap.set(key, [...(requestMap.get(key) || []), request]);
  });

  const activityMap = new Map();
  activity.forEach((event) => {
    if (!event.boardId || !event.itemId) return;
    const key = `${event.boardId}:${event.itemId}`;
    activityMap.set(key, [...(activityMap.get(key) || []), event].slice(0, 5));
  });

  const decoratedBoards = boards.map((board) => ({
    ...board,
    items_page: {
      ...(board.items_page || {}),
      items: (board.items_page?.items || []).map((item) => {
        const key = `${String(board.id)}:${String(item.id)}`;
        return {
          ...item,
          client_portal: {
            approval: approvalMap.get(key) || serializeApproval(null),
            fileRequests: requestMap.get(key) || [],
            activity: activityMap.get(key) || [],
          },
        };
      }),
    },
  }));

  const itemKeys = new Set(getBoardItemKeys(decoratedBoards).map((key) => `${key.boardId}:${key.itemId}`));
  const visibleFileRequests = fileRequests.filter(
    (request) => !request.itemId || itemKeys.has(`${request.boardId}:${request.itemId}`)
  );
  const visibleApprovals = [...approvalMap.entries()].filter(([key]) => itemKeys.has(key)).map(([, approval]) => approval);

  return {
    boards: decoratedBoards,
    summary: {
      pendingApprovals: visibleApprovals.filter((approval) => approval.status === 'pending').length,
      approved: visibleApprovals.filter((approval) => approval.status === 'approved').length,
      changesRequested: visibleApprovals.filter((approval) => approval.status === 'changes_requested').length,
      openFileRequests: visibleFileRequests.filter((request) => request.status === 'open').length,
    },
    fileRequests: visibleFileRequests,
    recentActivity: activity.slice(0, 12),
  };
}

function normalizeLinks(links) {
  const values = Array.isArray(links)
    ? links
    : String(links || '')
        .split(/\r?\n|,/)
        .map((entry) => entry.trim());

  return values
    .map(normalizeUrl)
    .filter(Boolean)
    .slice(0, 10);
}

function normalizeDueAt(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

async function createFileRequest(db, { accountId, clientId, boardId, itemId = '', title, instructions = '', dueAt, requestedBy = '' }) {
  const cleanTitle = cleanText(title, 160);
  if (!cleanTitle) {
    const error = new Error('File request title is required.');
    error.statusCode = 400;
    throw error;
  }

  const now = Date.now();
  const result = await db.run(
    `INSERT INTO client_file_requests
      (monday_account_id, client_id, board_id, item_id, title, instructions, due_at, status, requested_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
    [
      String(accountId),
      Number(clientId),
      String(boardId),
      itemId ? String(itemId) : null,
      cleanTitle,
      cleanOptionalText(instructions, 2000),
      normalizeDueAt(dueAt),
      cleanOptionalText(requestedBy, 120),
      now,
      now,
    ]
  );

  const request = await getFileRequestById(db, accountId, result.lastID);
  await recordActivity(db, {
    accountId,
    clientId,
    boardId,
    itemId,
    eventType: 'file_request_created',
    actorType: 'admin',
    actorName: requestedBy || 'monday admin',
    summary: `Requested files: ${cleanTitle}`,
    metadata: { fileRequestId: request.id },
  });
  return request;
}

async function getFileRequestById(db, accountId, id) {
  const row = await db.get(
    'SELECT * FROM client_file_requests WHERE monday_account_id = ? AND id = ?',
    [String(accountId), Number(id)]
  );
  return row ? serializeFileRequest(row) : null;
}

async function listAdminFileRequests(db, accountId, { clientId, boardId, limit = 50 } = {}) {
  const clauses = ['monday_account_id = ?'];
  const params = [String(accountId)];
  if (clientId) {
    clauses.push('client_id = ?');
    params.push(Number(clientId));
  }
  if (boardId) {
    clauses.push('board_id = ?');
    params.push(String(boardId));
  }
  params.push(Math.min(Math.max(Number(limit) || 50, 1), 100));

  const rows = await db.all(
    `SELECT * FROM client_file_requests
     WHERE ${clauses.join(' AND ')}
     ORDER BY status ASC, COALESCE(due_at, 9999999999999) ASC, created_at DESC
     LIMIT ?`,
    params
  );
  return rows.map(serializeFileRequest);
}

async function submitFileRequest(db, { accountId, clientId, requestId, note = '', links = [] }) {
  const request = await getFileRequestById(db, accountId, requestId);
  if (!request || Number(request.clientId) !== Number(clientId)) {
    const error = new Error('File request not found.');
    error.statusCode = 404;
    throw error;
  }

  const cleanLinks = normalizeLinks(links);
  const cleanNote = cleanOptionalText(note, 2000);
  if (cleanLinks.length === 0 && !cleanNote) {
    const error = new Error('Add at least one file link or a note.');
    error.statusCode = 400;
    throw error;
  }

  const now = Date.now();
  await db.run(
    `UPDATE client_file_requests
     SET status = 'submitted', response_note = ?, response_links = ?, responded_at = ?, updated_at = ?
     WHERE monday_account_id = ? AND id = ? AND client_id = ?`,
    [cleanNote, JSON.stringify(cleanLinks), now, now, String(accountId), Number(requestId), Number(clientId)]
  );

  const updatedRequest = await getFileRequestById(db, accountId, requestId);
  await recordActivity(db, {
    accountId,
    clientId,
    boardId: request.boardId,
    itemId: request.itemId || null,
    eventType: 'file_request_submitted',
    actorType: 'client',
    summary: `Submitted files for: ${request.title}`,
    metadata: { fileRequestId: request.id, links: cleanLinks },
  });
  return updatedRequest;
}

module.exports = {
  DEFAULT_PORTAL_SETTINGS,
  APPROVAL_STATUSES,
  FILE_REQUEST_STATUSES,
  cleanText,
  createFileRequest,
  decorateBoardsForClientRoom,
  getFileRequestById,
  getPortalSettings,
  getSetupStatus,
  listActivity,
  listAdminFileRequests,
  normalizePortalSettings,
  normalizePortalSettingsInput,
  recordActivity,
  serializeActivity,
  serializeFileRequest,
  submitFileRequest,
  updatePortalSettings,
  upsertApproval,
};
