const DEFAULT_RESEND_ENDPOINT = 'https://api.resend.com/emails';

function emailNotificationsEnabled() {
  return process.env.EMAIL_NOTIFICATIONS_ENABLED !== 'false';
}

function getEmailFromAddress() {
  return process.env.EMAIL_FROM || process.env.RESEND_FROM || '';
}

function getDefaultNotificationEmail() {
  return process.env.NOTIFICATION_EMAIL || process.env.BILLING_EMAIL || '';
}

function getAccountNotificationEmail(account) {
  return account?.notification_email || account?.billing_email || getDefaultNotificationEmail();
}

function isEmailConfigured() {
  return Boolean(emailNotificationsEnabled() && process.env.RESEND_API_KEY && getEmailFromAddress());
}

function escapeText(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function paragraph(value) {
  return `<p>${escapeText(value).replace(/\r?\n/g, '<br>')}</p>`;
}

async function sendEmail({ to, subject, text, html }) {
  const recipients = Array.isArray(to) ? to.filter(Boolean) : [to].filter(Boolean);
  if (!recipients.length) {
    return { sent: false, reason: 'missing-recipient' };
  }

  if (!isEmailConfigured()) {
    console.log(`Email notification skipped (${subject}): provider is not configured.`);
    return { sent: false, reason: 'not-configured' };
  }

  const response = await fetch(process.env.RESEND_API_URL || DEFAULT_RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: getEmailFromAddress(),
      to: recipients,
      subject,
      text,
      html,
    }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.message || `Email provider returned HTTP ${response.status}`);
    error.statusCode = response.status;
    error.providerResponse = body;
    throw error;
  }

  return { sent: true, id: body?.id || null };
}

async function sendClientInviteEmail({ to, clientName, inviteUrl, expiresAt }) {
  const expiryLabel = expiresAt ? new Date(Number(expiresAt)).toLocaleString('en-US') : 'soon';
  const text = [
    `Hi ${clientName || 'there'},`,
    '',
    'You have been invited to access your client portal.',
    inviteUrl,
    '',
    `This invite expires ${expiryLabel}.`,
  ].join('\n');

  const html = [
    paragraph(`Hi ${clientName || 'there'},`),
    paragraph('You have been invited to access your client portal.'),
    `<p><a href="${escapeText(inviteUrl)}">Activate your portal access</a></p>`,
    paragraph(`This invite expires ${expiryLabel}.`),
  ].join('');

  return sendEmail({
    to,
    subject: 'Activate your client portal access',
    text,
    html,
  });
}

async function sendClientUpdateNotification({ to, clientName, clientEmail, boardId, itemId, comment }) {
  const text = [
    `${clientName || 'A client'}${clientEmail ? ` (${clientEmail})` : ''} posted a portal comment.`,
    '',
    `Board: ${boardId}`,
    `Item: ${itemId}`,
    '',
    comment,
  ].join('\n');

  const html = [
    paragraph(`${clientName || 'A client'}${clientEmail ? ` (${clientEmail})` : ''} posted a portal comment.`),
    paragraph(`Board: ${boardId}\nItem: ${itemId}`),
    paragraph(comment),
  ].join('');

  return sendEmail({
    to,
    subject: 'New client portal comment',
    text,
    html,
  });
}

async function sendApprovalDecisionNotification({ to, clientName, clientEmail, boardId, itemId, decision, reason }) {
  const label = decision === 'approved' ? 'approved an item' : 'requested changes on an item';
  const text = [
    `${clientName || 'A client'}${clientEmail ? ` (${clientEmail})` : ''} ${label}.`,
    '',
    `Board: ${boardId}`,
    `Item: ${itemId}`,
    '',
    reason ? `Reason:\n${reason}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const html = [
    paragraph(`${clientName || 'A client'}${clientEmail ? ` (${clientEmail})` : ''} ${label}.`),
    paragraph(`Board: ${boardId}\nItem: ${itemId}`),
    reason ? paragraph(`Reason:\n${reason}`) : '',
  ].join('');

  return sendEmail({
    to,
    subject: decision === 'approved' ? 'Client approved an item' : 'Client requested changes',
    text,
    html,
  });
}

async function sendFileRequestEmail({ to, clientName, title, instructions, dueAt }) {
  const dueLabel = dueAt ? new Date(Number(dueAt)).toLocaleString('en-US') : '';
  const text = [
    `Hi ${clientName || 'there'},`,
    '',
    `A new file request is waiting in your client portal: ${title}`,
    dueLabel ? `Due: ${dueLabel}` : '',
    '',
    instructions || 'Please open the portal to submit the requested file links.',
  ]
    .filter(Boolean)
    .join('\n');

  const html = [
    paragraph(`Hi ${clientName || 'there'},`),
    paragraph(`A new file request is waiting in your client portal: ${title}`),
    dueLabel ? paragraph(`Due: ${dueLabel}`) : '',
    paragraph(instructions || 'Please open the portal to submit the requested file links.'),
  ].join('');

  return sendEmail({
    to,
    subject: `File request: ${title}`,
    text,
    html,
  });
}

async function sendFileSubmissionNotification({ to, clientName, clientEmail, boardId, itemId, title, links, note }) {
  const linkList = (links || []).map((link) => `- ${link}`).join('\n');
  const text = [
    `${clientName || 'A client'}${clientEmail ? ` (${clientEmail})` : ''} submitted files for "${title}".`,
    '',
    `Board: ${boardId}`,
    itemId ? `Item: ${itemId}` : '',
    '',
    note ? `Note:\n${note}` : '',
    linkList ? `Links:\n${linkList}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const html = [
    paragraph(`${clientName || 'A client'}${clientEmail ? ` (${clientEmail})` : ''} submitted files for "${title}".`),
    paragraph(`Board: ${boardId}${itemId ? `\nItem: ${itemId}` : ''}`),
    note ? paragraph(`Note:\n${note}`) : '',
    linkList ? paragraph(`Links:\n${linkList}`) : '',
  ].join('');

  return sendEmail({
    to,
    subject: `Client submitted files: ${title}`,
    text,
    html,
  });
}

async function sendPlanLimitNotification({ to, accountId, metric, planLabel, usage, limit }) {
  return sendEmail({
    to,
    subject: 'Client portal plan limit reached',
    text: `Monday account ${accountId} reached the ${metric} limit on the ${planLabel} plan (${usage}/${limit}).`,
    html: paragraph(`Monday account ${accountId} reached the ${metric} limit on the ${planLabel} plan (${usage}/${limit}).`),
  });
}

module.exports = {
  getAccountNotificationEmail,
  getDefaultNotificationEmail,
  isEmailConfigured,
  sendApprovalDecisionNotification,
  sendClientInviteEmail,
  sendClientUpdateNotification,
  sendEmail,
  sendFileRequestEmail,
  sendFileSubmissionNotification,
  sendPlanLimitNotification,
};
