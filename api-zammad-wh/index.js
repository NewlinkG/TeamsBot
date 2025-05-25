const crypto = require('crypto');
const { formatTicketUpdate } = require('../formatTicketUpdate');
const { BotFrameworkAdapter } = require('botbuilder');
const { MicrosoftAppId, MicrosoftAppPassword } = process.env; 
const { getAllUsers } = require('../teamsIdStore');


const adapter = new BotFrameworkAdapter({
  appId: MicrosoftAppId,
  appPassword: MicrosoftAppPassword
});

/**
 * Azure Function entry point
 */
module.exports = async function (context, req) {
  const SHARED_SECRET = process.env.HELPDESK_WEBHOOK_SECRET; // define en App Settings
  const users = await getAllUsers();
  // Determine notification targets based on ticket state
  const { article, ticket } = req.body;
  const recipientEmail = ticket.customer?.email;
  // 🧾 Raw body as string
  const rawBody = req.rawBody;
  const signatureHeader = req.headers['x-hub-signature'];

  if (!article || !ticket || !recipientEmail) {
    context.log.warn('⚠️ Incomplete payload:', req.body);
    context.res = { status: 200 };
    return;
  }

  const ticketState = (ticket.state || '').toLowerCase();
  context.log(`📌 Ticket state: ${ticketState}, channel: ${article.channel}`);
  let agentsToNotify = [];

  if (ticketState === 'new' && ['Email', 'Web'].includes(article.channel)) {
    agentsToNotify = (ticket.organization?.members || []).filter(email =>
      email.toLowerCase() !== recipientEmail.toLowerCase()
    );
  } else if (ticket.owner?.email) {
    // Notify only the owner
    agentsToNotify = [ticket.owner.email];
  }

  // Loop over selected recipients and send notification
  for (const email of agentsToNotify) {
    const normalized = email.toLowerCase();
    const record = users[normalized];

    if (!record?.reference?.user?.id || !record.reference?.conversation?.id) {
      context.log(`ℹ️ Skipping ${email} — no Teams reference`);
      continue;
    }

    try {
      await adapter.continueConversation(record.reference, async (ctx) => {
        const card = {
          type: 'AdaptiveCard',
          body: [
            {
              type: 'TextBlock',
              text: ticketState === 'new'
                ? `📥 New Ticket Created`
                : `🔔 Ticket Updated`,
              weight: 'Bolder',
              size: 'Medium',
              wrap: true
            },
            {
              type: 'TextBlock',
              text: `**${ticket.title}**`,
              wrap: true
            },
            {
              type: 'TextBlock',
              text: `#${ticket.id} — ${ticket.state}`,
              spacing: 'None',
              isSubtle: true,
              wrap: true
            },
            {
              type: 'TextBlock',
              text: ticket.owner
                ? `👨‍🔧 Assigned to ${ticket.owner.firstname} ${ticket.owner.lastname || ''}`
                : '👨‍🔧 Unassigned',
              spacing: 'None',
              isSubtle: true,
              wrap: true
            }
          ],
          actions: [
            {
              type: 'Action.OpenUrl',
              title: '🔗 View in browser',
              url: `${process.env.HELPDESK_WEB_URL}/${ticket.id}`
            },
            ...(ticketState === 'new' ? [{
              type: 'Action.Submit',
              title: '✋ Claim',
              data: {
                action: 'claimTicket',
                ticketId: ticket.id
              }
            }] : [{
              type: 'Action.Submit',
              title: '✏️ Edit',
              data: { action: 'startEditTicket', ticketId: ticket.id }
            }]),
            {
              type: 'Action.Submit',
              title: '✅ Close',
              data: {
                action: 'closeTicket',
                ticketId: ticket.id
              }
            }
          ],
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          version: '1.4'
        };

        await ctx.sendActivity({
          type: 'message',
          attachments: [
            {
              contentType: 'application/vnd.microsoft.card.adaptive',
              content: card
            }
          ]
        });
      });

      context.log(`📤 Notified ${email}`);
    } catch (err) {
      context.log.warn(`⚠️ Failed to notify ${email}:`, err.message);
    }
  }

  

  // ✅ Signature verification
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

  //context.log('🔍 Signature header:', signatureValue);
  //context.log('🔍 Computed HMAC:', expectedHmac);

  if (!crypto.timingSafeEqual(Buffer.from(signatureValue), Buffer.from(expectedHmac))) {
    context.log.warn('⛔ Signature mismatch.');
    context.res = { status: 403, body: 'Invalid signature' };
    return;
  }

  const updated_by = ticket.updated_by;

  if (!updated_by) {
    context.log.warn('⚠️ Missing updated_by in payload.');
    context.res = { status: 200 };
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
  const record = users[recipientEmail];

  if (recipientEmail) {
    if (!record?.reference?.user?.id || !record.reference?.conversation?.id) {
      context.log.warn(`⚠️ No Teams reference found for ${recipientEmail}`);
      context.res = { status: 202, body: `User ${recipientEmail} not registered.` };
      return;
    }

    const reference = record.reference;

    try {
      await adapter.createConversation(reference, async (ctx) => {
        const card = {
          type: 'AdaptiveCard',
          body: [
            {
              type: 'TextBlock',
              text: ticketState === 'new'
                ? `📥 Ticket Created`
                : `🔔 Ticket Updated`,
              weight: 'Bolder',
              size: 'Medium',
              wrap: true
            },
            {
              type: 'TextBlock',
              text: `**${ticket.title}**`,
              wrap: true
            },
            {
              type: 'TextBlock',
              text: `#${ticket.id} — ${ticket.state || 'Open'}`,
              spacing: 'None',
              isSubtle: true,
              wrap: true
            },
            {
              type: 'TextBlock',
              text: ticket.owner
                ? `👨‍🔧 ${ticket.owner.firstname} ${ticket.owner.lastname || ''}`
                : '👨‍🔧 Unassigned',
              spacing: 'None',
              isSubtle: true,
              wrap: true
            }
          ],
          actions: [
            {
              type: 'Action.OpenUrl',
              title: '🔗 View in browser',
              url: `${process.env.HELPDESK_WEB_URL}/${ticket.id}`
            },
            {
              type: 'Action.Submit',
              title: '✏️ Edit',
              data: {
                action: 'startEditTicket',
                ticketId: ticket.id
              }
            },
            {
              type: 'Action.Submit',
              title: '✅ Close',
              data: {
                action: 'closeTicket',
                ticketId: ticket.id
              }
            }
          ],
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          version: '1.4'
        };

        await ctx.sendActivity({
          type: 'message',
          attachments: [
            {
              contentType: 'application/vnd.microsoft.card.adaptive',
              content: card
            }
          ]
        });
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

  context.res = {
    status: 200,
    body: 'Webhook procesado correctamente.'
  };
};
