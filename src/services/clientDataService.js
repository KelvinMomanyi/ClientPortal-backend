const {
  decryptString,
  encryptString,
  hashValue,
  hasConfiguredEncryptionKey,
  isEncrypted,
} = require('./cryptoService');

const INTERNAL_EMAIL_PATTERN = /^[^:\s]+:[a-f0-9]{64}$/i;

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function normalizeName(name) {
  return typeof name === 'string' ? name.trim() : '';
}

function isValidEmail(email) {
  const normalized = normalizeEmail(email);
  return normalized.length > 3 && normalized.length <= 255 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
}

function isInternalEmailStorage(value) {
  return typeof value === 'string' && INTERNAL_EMAIL_PATTERN.test(value);
}

function getEmailHash(email) {
  return hashValue(normalizeEmail(email), 'client-email');
}

function getScopedEmailStorage(accountId, emailHash) {
  return `${String(accountId)}:${emailHash}`;
}

function buildClientStorage(accountId, name, email) {
  const cleanName = normalizeName(name);
  const cleanEmail = normalizeEmail(email);
  const emailHash = getEmailHash(cleanEmail);
  const encrypted = hasConfiguredEncryptionKey();

  return {
    name: encrypted ? 'Encrypted client' : cleanName,
    email: encrypted ? getScopedEmailStorage(accountId, emailHash) : cleanEmail,
    name_encrypted: encrypted ? encryptString(cleanName) : null,
    email_encrypted: encrypted ? encryptString(cleanEmail) : null,
    email_hash: emailHash,
    pii_encrypted_at: encrypted ? Date.now() : null,
  };
}

function toPublicClient(row) {
  if (!row) return null;

  const decryptedName = row.name_encrypted ? decryptString(row.name_encrypted) : null;
  const decryptedEmail = row.email_encrypted ? decryptString(row.email_encrypted) : null;
  const legacyEmail = isInternalEmailStorage(row.email) ? '' : row.email;

  const {
    name_encrypted,
    email_encrypted,
    password_hash,
    email_hash,
    pii_encrypted_at,
    ...safe
  } = row;
  void name_encrypted;
  void email_encrypted;
  void password_hash;
  void email_hash;
  void pii_encrypted_at;

  return {
    ...safe,
    name: decryptedName || row.name || 'Client',
    email: decryptedEmail || legacyEmail || '',
    accountId: row.monday_account_id ? String(row.monday_account_id) : undefined,
  };
}

async function findClientsByEmail(db, email, accountId) {
  const normalized = normalizeEmail(email);
  const emailHash = getEmailHash(normalized);
  const params = [emailHash, normalized];
  let sql = 'SELECT * FROM clients WHERE email_hash = ? OR lower(email) = ?';

  if (accountId) {
    sql = 'SELECT * FROM clients WHERE (email_hash = ? OR lower(email) = ?) AND monday_account_id = ?';
    params.push(String(accountId));
  }

  const rows = await db.all(sql, params);
  return rows.map((row) => ({
    ...toPublicClient(row),
    password_hash: row.password_hash,
  }));
}

async function getClientById(db, id, accountId) {
  const params = [id];
  let sql = 'SELECT * FROM clients WHERE id = ?';
  if (accountId !== undefined && accountId !== null) {
    sql += ' AND monday_account_id = ?';
    params.push(String(accountId));
  }

  return toPublicClient(await db.get(sql, params));
}

async function backfillClientPrivacyFields(db) {
  const rows = await db.all('SELECT * FROM clients');

  for (const row of rows) {
    const publicClient = toPublicClient(row);
    if (!isValidEmail(publicClient.email)) continue;

    const emailHash = row.email_hash || getEmailHash(publicClient.email);
    const encrypted = hasConfiguredEncryptionKey();
    const nameEncrypted = row.name_encrypted && isEncrypted(row.name_encrypted)
      ? row.name_encrypted
      : encrypted
      ? encryptString(publicClient.name || 'Client')
      : row.name_encrypted || null;
    const emailEncrypted = row.email_encrypted && isEncrypted(row.email_encrypted)
      ? row.email_encrypted
      : encrypted
      ? encryptString(publicClient.email)
      : row.email_encrypted || null;

    await db.run(
      `UPDATE clients
       SET name = ?, email = ?, name_encrypted = ?, email_encrypted = ?, email_hash = ?, pii_encrypted_at = ?
       WHERE id = ?`,
      [
        encrypted ? 'Encrypted client' : publicClient.name,
        encrypted ? getScopedEmailStorage(row.monday_account_id, emailHash) : publicClient.email,
        nameEncrypted,
        emailEncrypted,
        emailHash,
        encrypted ? Number(row.pii_encrypted_at) || Date.now() : row.pii_encrypted_at || null,
        row.id,
      ]
    );
  }
}

module.exports = {
  backfillClientPrivacyFields,
  buildClientStorage,
  findClientsByEmail,
  getClientById,
  getEmailHash,
  getScopedEmailStorage,
  isInternalEmailStorage,
  isValidEmail,
  normalizeEmail,
  normalizeName,
  toPublicClient,
};
