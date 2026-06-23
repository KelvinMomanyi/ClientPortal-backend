const dotenv = require('dotenv');
const { createApp } = require('../src/app');
const { initDb } = require('../src/services/dbService');

dotenv.config();

let appPromise;

function getApp() {
  if (!appPromise) {
    appPromise = initDb().then(() => createApp());
  }
  return appPromise;
}

module.exports = async (req, res) => {
  const app = await getApp();
  return app(req, res);
};
