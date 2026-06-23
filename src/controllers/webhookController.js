async function handleMondayWebhook(req, res) {
  if (req.body?.challenge) {
    return res.json({ challenge: req.body.challenge });
  }

  const event = req.body?.event;
  if (event) {
    console.log('Received Monday webhook event:', {
      type: event.type,
      boardId: event.boardId,
      pulseId: event.pulseId,
    });
  }

  return res.status(200).json({ ok: true });
}

module.exports = { handleMondayWebhook };
