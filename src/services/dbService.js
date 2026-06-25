const path = require('path');

let db;
let dbKind;

async function initDb() {
  if (db) {
    return db;
  }

  db = await createDb();

  try {
    // Create tables for the Marketplace Hybrid Architecture
    await db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      monday_account_id INTEGER PRIMARY KEY,
      access_token TEXT NOT NULL,
      subscription_status TEXT DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monday_account_id INTEGER,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      FOREIGN KEY (monday_account_id) REFERENCES accounts (monday_account_id)
    );

    CREATE TABLE IF NOT EXISTS portals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monday_account_id INTEGER,
      client_id INTEGER,
      board_id INTEGER NOT NULL,
      FOREIGN KEY (monday_account_id) REFERENCES accounts (monday_account_id),
      FOREIGN KEY (client_id) REFERENCES clients (id)
    );

    CREATE TABLE IF NOT EXISTS permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monday_account_id INTEGER,
      client_id INTEGER,
      board_id INTEGER,
      item_id INTEGER NOT NULL,
      FOREIGN KEY (monday_account_id) REFERENCES accounts (monday_account_id),
      FOREIGN KEY (client_id) REFERENCES clients (id)
    );

    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      reset_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS client_invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      token_hash TEXT UNIQUE NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients (id)
    );
  `);

    await ensureColumn('accounts', 'token_encrypted_at', 'INTEGER');
    await ensureColumn('clients', 'name_encrypted', 'TEXT');
    await ensureColumn('clients', 'email_encrypted', 'TEXT');
    await ensureColumn('clients', 'email_hash', 'TEXT');
    await ensureColumn('clients', 'pii_encrypted_at', 'INTEGER');
    await ensureColumn('permissions', 'board_id', 'INTEGER');

    await db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_portals_unique
      ON portals (monday_account_id, client_id, board_id);

    CREATE INDEX IF NOT EXISTS idx_permissions_lookup
      ON permissions (monday_account_id, client_id, board_id);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_permissions_unique
      ON permissions (monday_account_id, client_id, board_id, item_id);

    CREATE INDEX IF NOT EXISTS idx_rate_limits_reset
      ON rate_limits (reset_at);

    CREATE INDEX IF NOT EXISTS idx_client_invites_client
      ON client_invites (client_id);

    CREATE INDEX IF NOT EXISTS idx_client_invites_token
      ON client_invites (token_hash);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_account_email_hash
      ON clients (monday_account_id, email_hash);
  `);

    const { migrateSensitiveData } = require('./privacyMigrationService');
    await migrateSensitiveData(db);

    console.log(`Database initialized successfully (${dbKind}).`);
    return db;
  } catch (err) {
    const failedDb = db;
    const failedDbKind = dbKind;
    db = null;
    dbKind = null;

    if (failedDb && typeof failedDb.close === 'function') {
      await failedDb.close();
    }

    throw normalizeDbInitError(err, failedDbKind);
  }
}

async function createDb() {
  const tursoUrl = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL;
  const tursoAuthToken =
    process.env.TURSO_AUTH_TOKEN ||
    process.env.LIBSQL_AUTH_TOKEN ||
    process.env.TURSO_DATABASE_AUTH_TOKEN;

  if (tursoUrl) {
    if (requiresAuthToken(tursoUrl) && !tursoAuthToken) {
      throw new Error(
        'Turso database auth token is missing. Set TURSO_AUTH_TOKEN in Vercel for the database in TURSO_DATABASE_URL.'
      );
    }

    dbKind = 'turso';
    const { createClient } = require('@libsql/client');
    const client = createClient({
      url: tursoUrl,
      authToken: tursoAuthToken,
    });
    return createLibsqlAdapter(client);
  }

  dbKind = 'sqlite';
  const sqlite3 = require('sqlite3').verbose();
  const { open } = require('sqlite');
  return open({
    filename: process.env.DATABASE_FILE || path.join(__dirname, '../../database.sqlite'),
    driver: sqlite3.Database
  });
}

function requiresAuthToken(databaseUrl) {
  return !databaseUrl.startsWith('file:') && databaseUrl !== ':memory:';
}

function createLibsqlAdapter(client) {
  const execute = (sql, params = []) => client.execute({ sql, args: params });

  return {
    async exec(sql) {
      const statements = sql
        .split(';')
        .map((statement) => statement.trim())
        .filter(Boolean);

      for (const statement of statements) {
        await execute(statement);
      }
    },
    async run(sql, params = []) {
      const result = await execute(sql, params);
      return {
        lastID: result.lastInsertRowid ? Number(result.lastInsertRowid) : undefined,
        changes: result.rowsAffected,
      };
    },
    async get(sql, params = []) {
      const result = await execute(sql, params);
      return result.rows[0];
    },
    async all(sql, params = []) {
      const result = await execute(sql, params);
      return result.rows;
    },
    async close() {
      if (typeof client.close === 'function') {
        client.close();
      }
    },
  };
}

async function ensureColumn(tableName, columnName, definition) {
  const columns = await db.all(`PRAGMA table_info(${tableName})`);
  const exists = columns.some((column) => column.name === columnName);
  if (!exists) {
    await db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function normalizeDbInitError(err, failedDbKind) {
  if (failedDbKind === 'turso' && isUnauthorizedLibsqlError(err)) {
    const configError = new Error(
      'Turso database authentication failed with HTTP 401. Verify TURSO_DATABASE_URL points to the correct database and TURSO_AUTH_TOKEN is current for that database.'
    );
    configError.code = 'TURSO_AUTH_FAILED';
    configError.cause = err;
    return configError;
  }

  return err;
}

function isUnauthorizedLibsqlError(err) {
  return err?.cause?.status === 401 || /HTTP status 401/i.test(err?.message || '');
}

function getDb() {
  if (!db) {
    throw new Error('Database not initialized');
  }
  return db;
}

async function closeDb() {
  if (db) {
    await db.close();
    db = null;
    dbKind = null;
  }
}

module.exports = {
  initDb,
  getDb,
  closeDb,
  requiresAuthToken,
  normalizeDbInitError
};
