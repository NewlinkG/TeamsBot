// cardTemplates.js

/**
 * Genera el body para la lista de tickets.
 * @param {Array} paginated – Array de tickets.
 * @param {Object} L – Objeto de localización (i18n[lang]).
 * @returns {Array} Array de elementos para AdaptiveCard body.
 */
function getTicketListCardBody(paginated, L) {
  return [
    { type: 'TextBlock', text: L.listTitle, weight: 'Bolder', size: 'Medium', wrap: true },
    ...paginated.map(t => {
      const isClosed = t.state?.toLowerCase() === 'closed';
      return {
        type: 'Container',
        style: isClosed ? 'attention' : 'default',
        items: [
          {
            type: 'TextBlock',
            text: `${isClosed ? '🚫' : '🔗'} ${t.title}`,
            weight: 'Bolder',
            wrap: true
          },
          {
            type: 'TextBlock',
            text: `#${t.id} — ${t.state || 'Open'}`,
            spacing: 'None',
            isSubtle: true,
            wrap: true
          },
          {
            type: 'TextBlock',
            text: t.owner
              ? `👨‍🔧 ${t.owner.firstname} ${t.owner.lastname || ''}`
              : `👨‍🔧 ${L.unassigned}`,
            spacing: 'None',
            isSubtle: true,
            wrap: true
          },
          {
            type: 'ActionSet',
            actions: [
              { type: 'Action.OpenUrl', title: L.viewInBrowser, url: `${process.env.HELPDESK_WEB_URL}/${t.id}` },
              {
                type: 'Action.Submit',
                title: L.edit,
                data: { action: 'startEditTicket', ticketId: t.id, lang: L.lang }
              },
              ...(!isClosed
                ? [{
                    type: 'Action.Submit',
                    title: L.close,
                    data: { action: 'closeTicket', ticketId: t.id, lang: L.lang }
                  }]
                : [])
            ],
            spacing: 'Medium',
            horizontalAlignment: 'Left'
          }
        ]
      };
    })
  ];
}

// Generate confirmation card
function getConfirmTicketCard(title, summary, lang, L) {
  return {
    type: 'AdaptiveCard',
    body: [
      { type: 'TextBlock', text: L.confirmPrompt, wrap: true },
      { type: 'TextBlock', text: `**${title}**`, wrap: true },
      { type: 'TextBlock', text: summary, wrap: true }
    ],
    actions: [
      { type: 'Action.Submit', title: L.confirm, data: { action: 'confirmTicket', title, summary, lang } },
      { type: 'Action.Submit', title: L.cancel, data: { action: 'cancelTicket', title, summary, lang } }
    ],
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4'
  };
}

// Generate cancellation card
function getCancelTicketCard(title, summary, L) {
  return {
    type: 'AdaptiveCard',
    body: [
      { type: 'TextBlock', text: title, weight: 'Bolder', wrap: true },
      { type: 'TextBlock', text: summary, wrap: true },
      { type: 'TextBlock', text: L.cancelled, wrap: true }
    ],
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4'
  };
}

// Generate final confirmation card after ticket is created
function getFinalTicketCard(title, summary, ticketId, helpdeskWebUrl, L) {
  const successLine = `✅ [${L.ticketLabel} #${ticketId}](${helpdeskWebUrl}/${ticketId}) ${L.createdSuffix}`;
  return {
    type: 'AdaptiveCard',
    body: [
      { type: 'TextBlock', text: title, weight: 'Bolder', wrap: true },
      { type: 'TextBlock', text: summary, wrap: true },
      { type: 'TextBlock', text: successLine, wrap: true }
    ],
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4'
  };
}

// Generate single ticket card
function getSingleTicketCard(ticket, L, helpdeskWebUrl) {
  return {
    type: 'AdaptiveCard',
    body: [
      { type: 'TextBlock', text: `🔎 ${L.ticketLabel} #${ticket.id}`, weight: 'Bolder', size: 'Medium' },
      { type: 'TextBlock', text: `📌 *${ticket.title}*`, wrap: true },
      { type: 'TextBlock', text: `🗂 ${L.statusLabel}: **${ticket.state}**`, wrap: true },
      { 
        type: 'TextBlock', 
        text: L.assignedTo.replace(
          '{owner}',
          ticket.owner ? `${ticket.owner.firstname} ${ticket.owner.lastname}` : L.notAssigned
        ),
        wrap: true 
      },
      { type: 'TextBlock', text: `🕓 ${new Date(ticket.created_at).toLocaleString()}`, wrap: true },
      { type: 'TextBlock', text: `🕑 ${new Date(ticket.updated_at).toLocaleString()}`, wrap: true },
      { type: 'TextBlock', text: `💬 ${ticket.article?.body || L.notAssigned}`, wrap: true }
    ],
    actions: [
      {
        type: 'Action.OpenUrl',
        title: L.viewInBrowser,
        url: `${helpdeskWebUrl}/${ticket.id}`
      },
      ...(ticket.state !== 'closed' ? [{
        type: 'Action.Submit',
        title: L.close,
        data: { action: 'closeTicket', ticketId: ticket.id }
      }] : [])
    ],
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4'
  };
}

module.exports = {
  getTicketListCardBody,
  getConfirmTicketCard,
  getCancelTicketCard,
  getFinalTicketCard,
  getSingleTicketCard
};