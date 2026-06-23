const { initDb, getDb } = require('./src/services/dbService');
const bcrypt = require('bcryptjs');
require('dotenv').config();

async function seed() {
  await initDb();
  const db = getDb();

  const name = 'Test Client';
  const email = 'client@example.com';
  const password = 'password123';
  const hash = await bcrypt.hash(password, 10);
  const accountId = Number(process.env.MONDAY_TEST_ACCOUNT_ID || 123456789);
  const testBoardId = Number(process.env.MONDAY_TEST_BOARD_ID || process.env.VITE_MONDAY_TEST_BOARD_ID || 123456);

  try {
    // 1. Create a Mock Account
    await db.run(
      'INSERT OR REPLACE INTO accounts (monday_account_id, access_token, subscription_status) VALUES (?, ?, ?)',
      [accountId, process.env.MONDAY_API_TOKEN || 'DUMMY_TOKEN', 'active']
    );

    // 2. Insert or update Client
    let client = await db.get('SELECT id FROM clients WHERE email = ?', [email]);
    if (client) {
      await db.run(
        'UPDATE clients SET monday_account_id = ?, name = ?, password_hash = ? WHERE id = ?',
        [accountId, name, hash, client.id]
      );
    } else {
      const clientResult = await db.run(
        'INSERT INTO clients (monday_account_id, name, email, password_hash) VALUES (?, ?, ?, ?)',
        [accountId, name, email, hash]
      );
      client = { id: clientResult.lastID };
    }

    // 3. Assign a Sample Board
    await db.run(
      `INSERT OR IGNORE INTO portals (monday_account_id, client_id, board_id)
       VALUES (?, ?, ?)`,
      [accountId, client.id, testBoardId]
    );

    console.log('Seed successful!');
    console.log('Email:', email);
    console.log('Password:', password);
    console.log('Mock Account linked to test board:', testBoardId);
  } catch (err) {
    console.error('Seed failed:', err);
  }
}

seed();
