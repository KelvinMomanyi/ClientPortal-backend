const test = require('node:test');
const assert = require('node:assert/strict');

const { formatClientUpdateBody } = require('../src/controllers/mondayController');

test('formatClientUpdateBody escapes client-authored HTML and preserves line breaks', () => {
  const body = formatClientUpdateBody(
    { name: '<Client>', email: 'client@example.com' },
    'Please review <script>alert("x")</script>\nThanks & regards'
  );

  assert.equal(
    body,
    '<p><strong>Client portal update from &lt;Client&gt; (client@example.com)</strong></p><p>Please review &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;<br>Thanks &amp; regards</p>'
  );
});
