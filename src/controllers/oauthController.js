const axios = require('axios');
const { getDb } = require('../services/dbService');
const { encryptString } = require('../services/cryptoService');

async function install(req, res) {
  const clientId = process.env.MONDAY_CLIENT_ID;
  if (!clientId) {
    return res.status(500).send('Monday Client ID not configured.');
  }

  // Monday OAuth installation URL
  const authUrl = `https://auth.monday.com/oauth2/authorize?client_id=${clientId}`;
  res.redirect(authUrl);
}

async function callback(req, res) {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send('Authorization code is missing.');
  }

  const clientId = process.env.MONDAY_CLIENT_ID;
  const clientSecret = process.env.MONDAY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res.status(500).send('Monday Client credentials not configured.');
  }

  try {
    // Exchange code for access token
    const tokenResponse = await axios.post('https://auth.monday.com/oauth2/token', {
      client_id: clientId,
      client_secret: clientSecret,
      code: code
    });

    const accessToken = tokenResponse.data.access_token;
    const storedAccessToken = encryptString(accessToken);
    
    // We need to fetch the account_id associated with this token using Monday API
    const meResponse = await axios.post('https://api.monday.com/v2', {
      query: `query { me { account { id } } }`
    }, {
      headers: {
        'Authorization': accessToken,
        'Content-Type': 'application/json'
      }
    });

    if (meResponse.data.errors) {
      console.error('Monday API Errors:', meResponse.data.errors);
      return res.status(400).send('Failed to fetch account details from Monday API.');
    }

    const accountId = meResponse.data.data.me.account.id;

    const db = getDb();
    
    // Store or update account in the database
    const exists = await db.get('SELECT * FROM accounts WHERE monday_account_id = ?', [accountId]);
    if (exists) {
      await db.run(
        'UPDATE accounts SET access_token = ?, subscription_status = ?, token_encrypted_at = ? WHERE monday_account_id = ?',
        [storedAccessToken, 'active', storedAccessToken === accessToken ? null : Date.now(), accountId]
      );
    } else {
      await db.run(
        'INSERT INTO accounts (monday_account_id, access_token, subscription_status, token_encrypted_at) VALUES (?, ?, ?, ?)',
        [accountId, storedAccessToken, 'active', storedAccessToken === accessToken ? null : Date.now()]
      );
    }

    res.send('Installation successful! You can configure the application within Monday.com now.');
  } catch (error) {
    console.error('OAuth Callback Error:', error.response?.data || error.message);
    res.status(500).send('Failed to complete OAuth process.');
  }
}

module.exports = {
  install,
  callback
};
