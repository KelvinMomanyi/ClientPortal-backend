const { initDb, getDb } = require('./src/services/dbService');

async function mapBoard(boardId) {
  if (!boardId) {
    console.error('Usage: node map_board.js <your_monday_board_id> [client_email]');
    process.exit(1);
  }

  await initDb();
  const db = getDb();

  try {
    const clientEmail = (process.argv[3] || 'client@example.com').trim().toLowerCase();
    const client = await db.get('SELECT id, monday_account_id FROM clients WHERE email = ?', [clientEmail]);
    if (!client) {
      console.error(`No client found for ${clientEmail}. Run node seed.js first or create the client in the admin view.`);
      process.exit(1);
    }
    
    // Check if mapping already exists
    const exists = await db.get(
      'SELECT * FROM portals WHERE monday_account_id = ? AND client_id = ? AND board_id = ?',
      [client.monday_account_id, client.id, boardId]
    );
    if (exists) {
      console.log(`Board ${boardId} is already mapped to ${clientEmail}.`);
      return;
    }

    await db.run(
      'INSERT INTO portals (monday_account_id, client_id, board_id) VALUES (?, ?, ?)',
      [client.monday_account_id, client.id, boardId]
    );
    console.log(`Successfully mapped Board ID: ${boardId} to ${clientEmail}.`);
  } catch (err) {
    console.error('Mapping failed:', err);
  }
}

const boardId = process.argv[2];
mapBoard(boardId);
