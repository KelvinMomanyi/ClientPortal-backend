const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getDb } = require('./dbService');
const { toPublicClient } = require('./clientDataService');

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function generateInviteToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashInviteToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function getInviteBaseUrl(req) {
  const configuredUrl = process.env.CLIENT_PORTAL_URL || process.env.FRONTEND_URL;
  const requestOrigin = req?.get?.('origin');
  return (configuredUrl || requestOrigin || 'http://localhost:5173').replace(/\/+$/, '');
}

function buildInviteUrl(req, token) {
  return `${getInviteBaseUrl(req)}/activate?token=${encodeURIComponent(token)}`;
}

async function createClientInvite(clientId, req) {
  const db = getDb();
  const token = generateInviteToken();
  const tokenHash = hashInviteToken(token);
  const now = Date.now();
  const expiresAt = now + INVITE_TTL_MS;

  await db.run('UPDATE client_invites SET used_at = ? WHERE client_id = ? AND used_at IS NULL', [now, clientId]);
  await db.run(
    'INSERT INTO client_invites (client_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)',
    [clientId, tokenHash, expiresAt, now]
  );

  return {
    token,
    inviteUrl: buildInviteUrl(req, token),
    expiresAt,
  };
}

async function getValidInvite(token) {
  if (!token || typeof token !== 'string') {
    return null;
  }

  const db = getDb();
  const tokenHash = hashInviteToken(token);
  const invite = await db.get(
    `SELECT i.*, c.id as client_row_id, c.name, c.email, c.name_encrypted, c.email_encrypted, c.email_hash, c.pii_encrypted_at, c.monday_account_id
     FROM client_invites i
     JOIN clients c ON c.id = i.client_id
     WHERE i.token_hash = ?`,
    [tokenHash]
  );

  if (!invite || invite.used_at || Number(invite.expires_at) <= Date.now()) {
    return null;
  }

  const client = toPublicClient({
    id: invite.client_row_id,
    name: invite.name,
    email: invite.email,
    name_encrypted: invite.name_encrypted,
    email_encrypted: invite.email_encrypted,
    email_hash: invite.email_hash,
    pii_encrypted_at: invite.pii_encrypted_at,
    monday_account_id: invite.monday_account_id,
  });

  return {
    ...invite,
    name: client.name,
    email: client.email,
  };
}

async function activateInvite(token, password) {
  const invite = await getValidInvite(token);
  if (!invite) {
    return null;
  }

  const db = getDb();
  const passwordHash = await bcrypt.hash(password, 10);
  const now = Date.now();

  await db.run('UPDATE clients SET password_hash = ? WHERE id = ?', [passwordHash, invite.client_id]);
  await db.run('UPDATE client_invites SET used_at = ? WHERE id = ?', [now, invite.id]);

  return {
    id: invite.client_id,
    name: invite.name,
    email: invite.email,
    monday_account_id: invite.monday_account_id,
  };
}

module.exports = {
  INVITE_TTL_MS,
  createClientInvite,
  getValidInvite,
  activateInvite,
  buildInviteUrl,
  hashInviteToken,
};
