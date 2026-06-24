const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp, parseAllowedOrigins } = require('../src/app');

async function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

test('CORS preflight allows the deployed frontend origin by default', async (t) => {
  const originalAllowedOrigins = process.env.ALLOWED_ORIGINS;
  delete process.env.ALLOWED_ORIGINS;

  const server = await listen(createApp());
  t.after(() => {
    server.close();
    if (originalAllowedOrigins === undefined) {
      delete process.env.ALLOWED_ORIGINS;
    } else {
      process.env.ALLOWED_ORIGINS = originalAllowedOrigins;
    }
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://client-portal-seven-alpha.vercel.app',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,authorization',
    },
  });

  assert.equal(response.status, 204);
  assert.equal(
    response.headers.get('access-control-allow-origin'),
    'https://client-portal-seven-alpha.vercel.app'
  );
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
});

test('configured CORS origins are trimmed and normalized', () => {
  assert.deepEqual(
    parseAllowedOrigins(' https://example.com/, http://localhost:5173 '),
    ['https://example.com', 'http://localhost:5173']
  );
});
