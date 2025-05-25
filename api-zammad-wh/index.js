const crypto = require('crypto');
const { sendProactiveTeamsMessage } = require('../proactiveHelper');
const { formatTicketUpdate } = require('../formatTicketUpdate');
const { BotFrameworkAdapter } = require('botbuilder');
const { getTeamsId } = require('../teamsIdStore');
const { MicrosoftAppId, MicrosoftAppPassword } = process.env; 

const adapter = new BotFrameworkAdapter({
  appId: MicrosoftAppId,
  appPassword: MicrosoftAppPassword
});

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

  context.log('🔍 Signature header:', signatureValue);
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
  const recipientEmail = ticket.customer.email; // or `created_by`, depending on your Zammad config

  if (recipientEmail) {
    const teamsId = await getTeamsId(recipientEmail);
    if (!teamsId) {
      context.log.warn(`⚠️ No Teams ID found for ${recipientEmail}`);
      context.res = { status: 202, body: `User ${recipientEmail} not registered.` };
      return;
    }

    const reference = {
      bot: { id: MicrosoftAppId },
      user: { id: teamsId },
      serviceUrl: 'https://smba.trafficmanager.net/emea/',
      channelId: 'msteams',
      conversation: { isGroup: false },
      channelData: {
        tenant: { id: process.env.TenantId }
      }
    };

    try {
      await adapter.createConversation(reference, async (ctx) => {
        await ctx.sendActivity(`🔔 Your ticket "${ticket.title}" has been updated.`);
      });
      context.log(`✅ Teams message sent to ${recipientEmail}`);
    } catch (error) {
      context.log.error(`❌ Failed to send proactive message:`, error.message);
      context.res = { status: 500, body: `Failed to notify user: ${error.message}` };
      return;
    }
  } else {
    context.log.warn("⚠️ No recipient email found");
  }

  // 🔔 Send this message (e.g., to Teams, email, queue, etc.)
  context.log('✅ Notificación preparada:\n', message);

  context.res = {
    status: 200,
    body: 'Webhook procesado correctamente.'
  };
};
