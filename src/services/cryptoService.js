const crypto = require('crypto');

const ENCRYPTION_PREFIX = 'enc:v1:';

function hasConfiguredEncryptionKey() {
  return Boolean(process.env.DATA_ENCRYPTION_KEY || process.env.APP_ENCRYPTION_KEY);
}

function getEncryptionKey() {
  const configured = process.env.DATA_ENCRYPTION_KEY || process.env.APP_ENCRYPTION_KEY;
  if (!configured) {
    throw new Error('DATA_ENCRYPTION_KEY is required to decrypt encrypted data.');
  }

  const trimmed = configured.trim();
  const hex = /^[a-f0-9]{64}$/i.test(trimmed) ? Buffer.from(trimmed, 'hex') : null;
  if (hex?.length === 32) return hex;

  try {
    const base64 = Buffer.from(trimmed, 'base64');
    if (base64.length === 32) return base64;
  } catch {
    // Fall through to deterministic key derivation for legacy/manual values.
  }

  return crypto.createHash('sha256').update(trimmed).digest();
}

function getHashKey() {
  const configured = process.env.DATA_ENCRYPTION_KEY || process.env.APP_ENCRYPTION_KEY || process.env.JWT_SECRET;
  return configured || 'local-development-hash-key';
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(ENCRYPTION_PREFIX);
}

function encryptString(value) {
  if (value === null || value === undefined) return value;
  const text = String(value);
  if (!hasConfiguredEncryptionKey() || isEncrypted(text)) return text;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    ENCRYPTION_PREFIX.slice(0, -1),
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

function decryptString(value) {
  if (value === null || value === undefined || !isEncrypted(value)) return value;

  const [, version, ivValue, tagValue, ciphertextValue] = value.split(':');
  if (version !== 'v1' || !ivValue || !tagValue || !ciphertextValue) {
    throw new Error('Invalid encrypted payload format.');
  }

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getEncryptionKey(),
    Buffer.from(ivValue, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function hashValue(value, scope = 'default') {
  return crypto
    .createHmac('sha256', getHashKey())
    .update(String(scope))
    .update('\0')
    .update(String(value))
    .digest('hex');
}

function redact(value) {
  if (!value) return 'MISSING';
  const text = String(value);
  if (text.length <= 8) return '****';
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

module.exports = {
  ENCRYPTION_PREFIX,
  decryptString,
  encryptString,
  hashValue,
  hasConfiguredEncryptionKey,
  isEncrypted,
  redact,
};
