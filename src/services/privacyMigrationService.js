const {
  encryptString,
  hasConfiguredEncryptionKey,
  isEncrypted,
} = require('./cryptoService');
const { backfillClientPrivacyFields } = require('./clientDataService');

async function migrateSensitiveData(db) {
  if (!hasConfiguredEncryptionKey()) return;

  const accounts = await db.all('SELECT monday_account_id, access_token FROM accounts');
  for (const account of accounts) {
    if (!account.access_token || isEncrypted(account.access_token)) continue;

    await db.run(
      'UPDATE accounts SET access_token = ?, token_encrypted_at = ? WHERE monday_account_id = ?',
      [encryptString(account.access_token), Date.now(), account.monday_account_id]
    );
  }

  await backfillClientPrivacyFields(db);
}

module.exports = {
  migrateSensitiveData,
};
