const { listTickets, addCommentToTicket, closeTicket, uploadAttachment } = require('../ticketClient');
const { MicrosoftAppCredentials } = require('botframework-connector');

module.exports = async function (context, req) {
  const method = req.method.toLowerCase();
  const creds = new MicrosoftAppCredentials(process.env.MicrosoftAppId, process.env.MicrosoftAppPassword);
  const token = await creds.getToken();
  const openOnly = req.query.openOnly !== 'false';

  console.log("🚀 Function triggered");
  console.log("🔗 Method:", req.method);
  console.log("📦 Path params:", req.params);
  console.log("📬 Body:", req.body);

  if (method === 'get') {
    const email = req.query.email;
    if (!email) {
      context.res = { status: 400, body: 'Missing email' };
      return;
    }

    try {
      const tickets = await listTickets(email, { openOnly });
      context.res = { status: 200, body: tickets };
    } catch (err) {
      context.log.error('Error listing tickets:', err);
      context.res = { status: 500, body: 'Error fetching tickets' };
    }

  } else if (method === 'post' && req.params.action === 'comment') {
    const { email, comment, attachments = [] } = req.body;
    const ticketId = req.params.id;

    try {
    const attachmentTokens = [];

    for (const file of attachments) {
        try {
        const tokenId = await uploadAttachment(file.contentUrl, file.name, email, token);
        attachmentTokens.push(tokenId);
        } catch (err) {
        context.log.warn(`Failed to upload file: ${file.name}`, err.message);
        }
    }

    await addCommentToTicket(ticketId, comment, email, attachmentTokens);
    context.res = { status: 200, body: 'Comment and attachments added' };
    } catch (err) {
    context.log.error('Comment failed:', err);
    context.res = { status: 500, body: 'Failed to add comment' };
    }
  } else if (method === 'post' && req.params.action === 'close') {
    const { email } = req.body;
    const ticketId = '10' + req.params.id;

    try {
      await closeTicket(ticketId, email);
      context.res = { status: 200, body: 'Ticket closed' };
    } catch (err) {
      context.log.error('Close failed:', err);
      context.res = { status: 500, body: 'Failed to close ticket' };
    }

  } else {
    context.res = { status: 400, body: 'Invalid request' };
  }
};
