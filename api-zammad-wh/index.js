const crypto = require('crypto');
const { sendProactiveTeamsMessage } = require('../proactiveHelper');
const { formatTicketUpdate } = require('../formatTicketUpdate');

/**
 * Azure Function entry point
 */
module.exports = async function (context, req) {
  const SHARED_SECRET = process.env.HELPDESK_WEBHOOK_SECRET; // define en App Settings

  // 🧾 Raw body as string
  const rawBody = req.rawBody;

  // ✅ Signature verification
  const signatureHeader = req.headers['x-hub-signature'];
  if (!signatureHeader || !signatureHeader.startsWith('sha1=')) {
    context.log.warn('⛔ Missing or invalid signature header.');
    context.res = { status: 401, body: 'Unauthorized' };
    return;
  }

  const signatureValue = signatureHeader.slice(5); // remove "sha1="
  const expectedHmac = crypto
    .createHmac('sha1', SHARED_SECRET)
    .update(rawBody)
    .digest('hex');

  context.log('🔍 Signature header:', signatureHeader);
  context.log('🔍 Computed HMAC:', expectedHmac);

  if (!crypto.timingSafeEqual(Buffer.from(signatureValue), Buffer.from(expectedHmac))) {
    context.log.warn('⛔ Signature mismatch.');
    context.res = { status: 403, body: 'Invalid signature' };
    return;
  }


  // ✅ Valid request
  const { article, ticket } = req.body;
  const updated_by = ticket.updated_by;

  if (!article || !updated_by || !ticket) {
    context.log.warn('⚠️ Incomplete payload:', req.body);
    context.res = { status: 200 }; // Acknowledge but skip
    return;
  }

  // 🧠 Build message
  const actor = `${updated_by.firstname} ${updated_by.lastname}`;
  const subject = article.subject || '(sin asunto)';
  const body = article.body || '(sin contenido)';
  const attachments = (article.attachments || [])
    .map(att => `- [${att.filename}](${att.content_url})`)
    .join('\n') || 'Ninguno';

  const message = formatTicketUpdate({ ticket, article, updated_by });
  const recipientEmail = ticket.customer; // or `created_by`, depending on your Zammad config

  if (recipientEmail) {
    await sendProactiveTeamsMessage(recipientEmail, message);
    context.log(`✅ Message sent to ${recipientEmail}`);
  } else {
    context.log.warn("⚠️ No recipient email found");
  }

  // 🔔 Send this message (e.g., to Teams, email, queue, etc.)
  context.log('✅ Notificación preparada:\n', message);

  // TODO: call your notifier here (e.g., sendToTeams(message))

  context.res = {
    status: 200,
    body: 'Webhook procesado correctamente.'
  };
};
