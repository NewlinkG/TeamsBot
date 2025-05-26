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
 * Azure Function entry point for Zammad webhook
 */
module.exports = async function (context, req) {
  const SHARED_SECRET = process.env.HELPDESK_WEBHOOK_SECRET;
  context.log('🔔 Webhook received:', JSON.stringify(req.body, null, 2));

  // validate signature (unchanged)
  const rawBody = req.rawBody;
  const signatureHeader = req.headers['x-hub-signature'];
  const hmac = crypto.createHmac('sha1', SHARED_SECRET).update(rawBody).digest('hex');
  if (`sha1=${hmac}` !== signatureHeader) {
    context.log.warn('⚠️ Invalid webhook signature');
    context.res = { status: 401 };
    return;
  }

  const users = await getAllUsers();

  // Extract core fields
  const { article, ticket } = req.body;
  const recipientEmail = ticket.customer?.email;
  // ─── Ticket detail extraction ──────────────────────────────────────
  const content = (article.body || '(no content)').replace(/<[^>]+>/g, '').trim();
  const attachmentsList = (article.attachments || [])
    .map(att => `- [${att.filename}](${att.url || att.content_url})`)
    .join('\n') || '(none)';

  if (!article || !ticket || !recipientEmail) {
    context.log.warn('⚠️ Incomplete payload:', req.body);
    context.res = { status: 200 };
    return;
  }

  // Determine context
  const ticketState = (ticket.state || '').toLowerCase();
  const channel     = (article.type || '').toLowerCase();
  const isEmailWeb  = ['email', 'web'].includes(channel);

  context.log(`📌 Ticket ${ticket.id}: state=${ticketState}, channel=${channel}`);

  // Determine agents to notify
  let agentsToNotify;
  if (ticket.owner?.email) {
    agentsToNotify = [ticket.owner.email];
  } else {
    agentsToNotify = ticket.group?.users || [];
  }
  context.log(`👥 agentsToNotify: ${agentsToNotify.join(', ')}`);

  // Determine if customer should be notified
  const lowerAgents = agentsToNotify.map(e => e.toLowerCase());
  let notifyCustomer = false;
  if (isEmailWeb) {
    notifyCustomer = recipientEmail && !lowerAgents.includes(recipientEmail.toLowerCase());
  } else {
    // Teams-origin: only notify customer on updates/closings
    notifyCustomer = ticketState !== 'new';
  }
  context.log(`📣 notifyCustomer? ${notifyCustomer}`);

  // Send notifications to agents
  for (const email of agentsToNotify) {
    const rec = users[email.toLowerCase()];
    if (!rec?.reference?.user?.id) {
      context.log(`ℹ️ Skipping agent ${email} — no Teams reference`);
      continue;
    }
    await adapter.continueConversation(rec.reference, async (ctx) => {
      // Build header
      const header =
        ticketState === 'new'    ? '📥 New Ticket Created' :
        ticketState === 'closed' ? '🚫 Ticket Closed'       :
                                    '✏️ Ticket Updated';

      // Build actions
      const actions = [
        { type: 'Action.OpenUrl', title: '🔗 View in browser', url: `${process.env.HELPDESK_WEB_URL}/${ticket.id}` },
        ...(ticketState === 'new' && !ticket.owner?.email
          ? [{ type: 'Action.Submit', title: '✋ Claim', data: { action: 'claimTicket', ticketId: ticket.id } }]
          : [{ type: 'Action.Submit', title: '✏️ Edit', data: { action: 'startEditTicket', ticketId: ticket.id } }]
        ),
        ...(ticketState !== 'closed'
          ? [{ type: 'Action.Submit', title: '✅ Close', data: { action: 'closeTicket', ticketId: ticket.id } }]
          : [])
      ];

      const card = {
        type: 'AdaptiveCard',
        body: [
          { type: 'TextBlock', text: header, weight: 'Bolder', size: 'Medium', wrap: true },
          { type: 'TextBlock', text: `**${ticket.title}**`, wrap: true },
          { type: 'TextBlock', text: `#${ticket.id} — ${ticket.state}`, isSubtle: true, wrap: true },
          { type: 'TextBlock', text: ticket.owner
              ? `👨‍🔧 Assigned to ${ticket.owner.firstname} ${ticket.owner.lastname || ''}`
              : '👨‍🔧 Unassigned', isSubtle: true, wrap: true },
          // ─── Content ─────────────────────────────────────────
          ...(content && content !== '(no content)' ? [
            { type:'TextBlock', text: content, wrap:true },
          ] : []),
          ...(attachmentsList && attachmentsList !== '(none)' ? [
            { type:'TextBlock', text:'**Attachments:**', wrap:true },
            { type:'TextBlock', text: attachmentsList, wrap:true }
          ] : []),
        ],
        actions,
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        version: '1.4'
      };
      await ctx.sendActivity({ attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }] });
      context.log(`📤 Notified agent ${email}`);
    }).catch(err => {
      context.log.warn(`⚠️ Failed to notify agent ${email}:`, err.message);
    });
  }

  // Send notification to customer if applicable
  if (notifyCustomer) {
    const rec = users[recipientEmail.toLowerCase()];
    if (!rec?.reference?.user?.id) {
      context.log(`⚠️ Skipping customer ${recipientEmail} — no Teams reference`);
    } else {
      await adapter.createConversation(rec.reference, async (ctx) => {
        const header =
          ticketState === 'new'    ? '📥 Your ticket was created' :
          ticketState === 'closed' ? '🚫 Your ticket was closed'  :
                                      '🔔 Your ticket was updated';

        const custActions = [
          { type: 'Action.OpenUrl', title: '🔗 View in browser', url: `${process.env.HELPDESK_WEB_URL}/${ticket.id}` },
          { type: 'Action.Submit', title: '✏️ Edit', data: { action: 'startEditTicket', ticketId: ticket.id } },
          ...(ticketState !== 'closed'
            ? [{ type: 'Action.Submit', title: '✅ Close', data: { action: 'closeTicket', ticketId: ticket.id } }]
            : [])
        ];

        const custCard = {
          type: 'AdaptiveCard',
          body: [
            { type: 'TextBlock', text: header, weight: 'Bolder', size: 'Medium', wrap: true },
            { type: 'TextBlock', text: `**${ticket.title}**`, wrap: true },
            { type: 'TextBlock', text: `#${ticket.id} — ${ticket.state}`, isSubtle: true, wrap: true },
            { type: 'TextBlock', text: ticket.owner
                ? `👨‍🔧 ${ticket.owner.firstname} ${ticket.owner.lastname || ''}`
                : '👨‍🔧 Unassigned', isSubtle: true, wrap: true },
            ...(content && content !== '(no content)' ? [
              { type:'TextBlock', text: content, wrap:true },
            ] : []),
            ...(attachmentsList && attachmentsList !== '(none)' ? [
              { type:'TextBlock', text:'**Attachments:**', wrap:true },
              { type:'TextBlock', text: attachmentsList, wrap:true }
            ] : []),
          ],
          actions: custActions,
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          version: '1.4'
        };
        await ctx.sendActivity({ attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: custCard }] });
        context.log(`📣 Customer notified: ${recipientEmail}`);
      }).catch(err => {
        context.log.error(`❌ Failed to notify customer:`, err.message);
      });
    }
  } else {
    context.log(`ℹ️ Customer skipped (sender=${article.sender})`);
  }

  // Respond to the webhook
  context.res = {
    status: 200,
    body: 'Webhook procesado correctamente.'
  };
};
