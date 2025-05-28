const { ActivityHandler, CardFactory, TurnContext, TeamsInfo } = require('botbuilder');
const {
  callAzureOpenAI,
  callAzureOpenAIStream,
  classifySupportRequest
} = require('./openaiClient');
const { createTicket, listTickets, addCommentToTicket, uploadAttachment, closeTicket, getTicketById } = require('./ticketClient');
const { MicrosoftAppCredentials } = require('botframework-connector');
const { getReference, saveFullReference } = require('./teamsIdStore');
const axios = require('axios');

const helpdeskWebUrl = process.env.HELPDESK_WEB_URL;
if (!helpdeskWebUrl) throw new Error('Missing HELPDESK_WEB_URL env var');

function detectLanguageFromLocale(locale) {
  if (locale.startsWith('en')) return 'en';
  if (locale.startsWith('pt')) return 'pt';
  return 'es';
}

// Localized strings
const i18n = {
  en: {
    greeting:      'Hi!',
    confirmPrompt: 'Please confirm the ticket details:',
    confirm:       'Confirm',
    cancel:        'Cancel',
    ticketLabel:   'Ticket',
    statusLabel:   'Status',
    createdLabel:  '🕓 Created',
    updatedLabel:  '🕑 Last Update',
    createdSuffix: 'created successfully.',
    cancelled:     '👍 Ticket creation cancelled',
    parseError:    'Sorry, I couldn’t parse that. Can you rephrase?',
    ticketClosed:  '✅ Ticket #{number} has been closed.',
    commentAdded:  '✅ Your comment has been added to ticket',
    noAttachments: '⚠️ No attachments found in your message.',
    writeComment:  '✏️ Write a comment.',
    noTickets:     '🔍 You have no tickets.',
    viewInBrowser: '🔗 View in browser',
    edit:          '✏️ Edit',
    close:         '✅ Close',
    prev:          '⬅️ Previous',
    next:          'Next ➡️',
    hideClosed:    '🙈 Hide Closed',
    showClosed:    '👁 Show Closed',
    editPrompt:    '✏️ What would you like to add to ticket #{number}?',
    commentFinal:  '📝 Comment added to ticket #{number}{files}.',
    filesClause:   ' with file(s)',
    assignedTo:    '🧑 Assigned to: {owner}',
    notAssigned:   '—',
    listTitle:     '📋 My Tickets',
    unassigned:    'Unassigned'
  },
  pt: {
    greeting:      'Olá!',
    confirmPrompt: 'Por favor confirme os detalhes do chamado:',
    confirm:       'Confirmar',
    cancel:        'Cancelar',
    ticketLabel:   'Chamado',
    statusLabel:   'Estado',
    createdLabel:  '🕓 Creado',
    updatedLabel:  '🕑 Última atualização',
    createdSuffix: 'criado com sucesso.',
    cancelled:     '👍 Criação de chamado cancelada',
    parseError:    'Desculpe, não consegui entender. Pode reformular?',
    ticketClosed:  '✅ Chamado #{number} foi encerrado.',
    commentAdded:  '✅ Seu comentário foi adicionado ao chamado',
    noAttachments: '⚠️ Nenhum anexo encontrado na sua mensagem.',
    writeComment:  '✏️ Escreva um comentário.',
    noTickets:     '🔍 Você não tem chamados.',
    viewInBrowser: '🔗 Ver no navegador',
    edit:          '✏️ Editar',
    close:         '✅ Fechar',
    prev:          '⬅️ Anterior',
    next:          'Próxima ➡️',
    hideClosed:    '🙈 Ocultar Fechados',
    showClosed:    '👁 Mostrar Fechados',
    editPrompt:    '✏️ O que você gostaria de adicionar ao chamado #{number}?',
    commentFinal:  '📝 Comentário adicionado ao chamado #{number}{files}.',
    filesClause:   ' com arquivo(s)',
    assignedTo:    '🧑 Atribuído a: {owner}',
    notAssigned:   '—',
    listTitle:     '📋 Meus chamados',
    unassigned:    'Não atribuído',
  },
  es: {
    greeting:      'Hola!',
    confirmPrompt: 'Confirma los detalles del ticket:',
    confirm:       'Confirmar',
    cancel:        'Cancelar',
    ticketLabel:   'Ticket',
    statusLabel:   'Estado',
    createdLabel:  '🕓 Creado',
    updatedLabel:  '🕑 Ultima atualización',
    createdSuffix: 'creado correctamente.',
    cancelled:     '👍 Creación de ticket cancelada',
    parseError:    'Lo siento, no entendí. ¿Puedes aclarar?',
    ticketClosed:  '✅ Ticket #{number} ha sido cerrado.',
    commentAdded:  '✅ Tu comentario fue agregado al ticket',
    noAttachments: '⚠️ No se encontraron archivos adjuntos en tu mensaje.',
    writeComment:  '✏️ Escribe un comentario.',
    noTickets:     '🔍 No tienes tickets.',
    viewInBrowser: '🔗 Ver en navegador',
    edit:          '✏️ Editar',
    close:         '✅ Cerrar',
    prev:          '⬅️ Anterior',
    next:          'Siguiente ➡️',
    hideClosed:    '🙈 Ocultar cerrados',
    showClosed:    '👁 Mostrar cerrados',
    editPrompt:    '✏️ ¿Qué te gustaría agregar al ticket #{number}?',
    commentFinal:  '📝 Comentario agregado al ticket #{number}{files}.',
    filesClause:   ' con archivo(s)',
    assignedTo:    '🧑 Asignado a: {owner}',
    notAssigned:   '—',
    listTitle:     '📋 Mis Tickets',
    unassigned:    'No asignado'
  }
};


const firstPromptTemplates = {
  en: `You are OrbIT, gathering info for a support ticket: "{summary}". 
You always respond in the same language the user uses.
Suggest self-help if possible but proceed to create the ticket when asked.
Speak in first person in the summary.
Only ask about the issue (no name/email prompts).`,
  es: `Eres OrbIT, recopila info para un ticket de soporte: "{summary}". 
Respondes siempre en el mismo idioma en que te habla el usuario.
Ofreces sugerencias de autoayuda pero generas el ticket si te lo piden.
Generas el resumen hablando en primera persona.
Pregunta solo detalles del problema (no pidas nombre/correo).`,
  pt: `Você é o OrbIT, reunindo informações para um chamado de suporte: "{summary}".
Sempre responda no mesmo idioma usado pelo usuário.
Sugira soluções se possível, mas crie o chamado se solicitado.
Fale na primeira pessoa no resumo.
Pergunte apenas sobre o problema (sem nome/email).`
};


const newChatGreetings = {
  en:   `👋 Hi there! I’m **OrbIT**, your helpdesk assistant.\n\n

🔔 I’ll keep you updated on:\n\n

• Ticket assignments  
• Status changes  
• Internal notes\n\n

No need to check email — I’ve got you covered here in Teams.`,

  pt:   `👋 Olá! Sou o **OrbIT**, seu assistente de helpdesk.\n\n

🔔 Vou te manter informado sobre:\n\n

• Atribuições de chamados  
• Mudanças de status  
• Notas internas\n\n

Não precisa checar o e-mail — aqui no Teams eu cuido disso para você.`,
  
  es:   `👋 ¡Hola! Soy **OrbIT**, tu asistente de mesa de ayuda.\n\n

🔔 Te mantendré al tanto de:\n\n

• Asignaciones de tickets  
• Cambios de estado  
• Notas internas\n\n

No necesitas revisar el correo — aquí en Teams te tengo cubierto.`
}


class TeamsBot extends ActivityHandler {
  constructor(conversationState) {
    super();
    this.onConversationUpdate(async (context, next) => {
      const { activity } = context;
      const botId = activity.recipient.id;
      for (const member of activity.membersAdded || []) {
        if (member.id === botId) continue;
        // ─── Resolve true UPN, email & displayName from Graph ─────────────
        let upn, email, userName;
        try {
          const details = await TeamsInfo.getMember(context, member.id);
          upn      = details.userPrincipalName;
          email    = details.email || details.mail;
          userName = details.name   || details.displayName;
        } catch (err) {
          console.warn('⚠️ TeamsInfo.getMember failed:', err.message);
        }

        // Skip if absolutely nothing useful returned
        if (!upn && !email) {
          console.warn('⚠️ No UPN or email for member.id=', member.id, '; skipping registration.');
          continue;
        }

        // Build and enrich the conversation reference
        const fullRef = TurnContext.getConversationReference(context.activity);
        fullRef.user.name = userName;   // store the real display name

        // Persist under **email** key (so you can look up by customer email)
        if (email) {
          await saveFullReference(
            email, // key: the user’s SMTP address
            upn,   // saved value: still the AAD UPN
            fullRef
          );
        }
        await context.sendActivity(newChatGreetings[greetLang] || newChatGreetings.es);
      }
      await next();
    });

    this.conversationState = conversationState;
    this.draftAccessor    = conversationState.createProperty('ticketDraft');
    this.onMessage(this.handleMessage.bind(this));
  }

  async processAttachments(context, token, userEmail) {
    const attachmentTokens = [];
    let commentNote = '';
    const teamsFiles = context.activity.attachments || [];
    for (const file of teamsFiles) {
      if (!file.contentUrl) {
        console.warn("📎 Attachment has no contentUrl:", file);
        continue;
      }
      if (file.contentUrl.includes('sharepoint.com') || file.contentUrl.includes('my.sharepoint.com')) {
        const linkNote = `🔗 Archivo compartido: ${file.contentUrl}`;
        commentNote += `\n\n${linkNote}`;
        continue;
      }
      try {
        const fileRes = await axios.get(file.contentUrl, {
          responseType: 'arraybuffer',
          headers: { Authorization: `Bearer ${token}` }
        });
        const buffer = Buffer.from(fileRes.data);
        const tokenId = await uploadAttachment(
          { buffer, originalname: file.name || 'attachment' },
          userEmail
        );
        attachmentTokens.push(tokenId);
      } catch (err) {
        console.warn(`Attachment upload failed: ${file.name || 'undefined'}`, err.message);
      }
    }
    if (attachmentTokens.length === 0 && context.activity.textFormat === 'html') {
      const html = context.activity.text || '';
      const extracted = await this.extractInlineImagesFromHtml(html, token, userEmail);
      if (extracted.length > 0) {
        attachmentTokens.push(...extracted);
      } else {
        console.warn("⚠️ No se encontraron imágenes embebidas o fallaron todas.");
      }
    }
    if (context.activity.textFormat === 'html') {
      const html = context.activity.text || '';
      const linkMatches = [...html.matchAll(/<a[^>]+href="([^"]+sharepoint\.com[^"]+)"/g)];
      if (linkMatches.length > 0) {
        const links = linkMatches.map(m => m[1]);
        const linkNote = links.map(url => `🔗 Archivo compartido: ${url}`).join('\n');
        commentNote += `\n\n${linkNote}`;
      }
    }
    return { attachmentTokens, commentNote: commentNote.trim() };
  }

  async handleMessage(context, next) {
    const text   = (context.activity.text || '').trim();
    const locale = context.activity.locale || 'es-LA';
    const lang   = detectLanguageFromLocale(locale);
    const L      = i18n[lang];
    const userId = context.activity.from.id;
    let upn = context.activity.from.userPrincipalName;
    if (!upn) {
      upn = context.activity.from.email
        || `${context.activity.from.name.replace(/\s+/g, '.').toLowerCase()}@newlinkcorp.com`;
    }
    const fallbackEmail = context.activity.from.email
      || `${context.activity.from.name.replace(/\s+/g, '.').toLowerCase()}@newlink-group.com`;
    const zammadEmail = upn
      ? upn.replace(/@newlinkcorp\.com$/i, '@newlink-group.com')
      : fallbackEmail;

    if (zammadEmail && userId) {
      const existingRef = await getReference(zammadEmail);
      if (!existingRef) {
        const fullRef = TurnContext.getConversationReference(context.activity);
        await saveFullReference(zammadEmail, upn, fullRef);
      }
    }

    let draft = await this.draftAccessor.get(context, { state: 'idle', history: [] });
    const value = context.activity.value;

    // 1) CONFIRM / CANCEL flows
    if (value && value.action === 'confirmTicket') {
      const cardLang = value.lang || lang;
      const LC = i18n[cardLang];
      const { title, summary } = value;
      const userName  = context.activity.from.name;
      const userEmail = context.activity.from.email
        || `${userName.replace(/\s+/g,'.').toLowerCase()}@newlink-group.com`;
      const ticket = await createTicket({ title, description: summary, userName, userEmail });
      const successLine =
        `✅ [${LC.ticketLabel} #${ticket.id}]` +
        `(${helpdeskWebUrl}/${ticket.id}) ${LC.createdSuffix}`;
      const finalCard = {
        type: 'AdaptiveCard',
        body: [
          { type: 'TextBlock', text: title, weight: 'Bolder', wrap: true },
          { type: 'TextBlock', text: summary, wrap: true },
          { type: 'TextBlock', text: successLine, wrap: true }
        ],
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        version: '1.4'
      };
      await context.updateActivity({
        id: context.activity.replyToId,
        type: 'message',
        attachments: [ CardFactory.adaptiveCard(finalCard) ]
      });
      draft = { state: 'idle', history: [] };
      await this.draftAccessor.set(context, draft);
      return;
    }

    if (value && value.action === 'cancelTicket') {
      const cardLang = value.lang || lang;
      const LC = i18n[cardLang];
      const { title, summary } = value;
      const cancelCard = {
        type: 'AdaptiveCard',
        body: [
          { type: 'TextBlock', text: title, weight: 'Bolder', wrap: true },
          { type: 'TextBlock', text: summary, wrap: true },
          { type: 'TextBlock', text: LC.cancelled, wrap: true }
        ],
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        version: '1.4'
      };
      await context.updateActivity({ id: context.activity.replyToId, type: 'message', attachments: [ CardFactory.adaptiveCard(cancelCard) ] });
      draft = { state: 'idle', history: [] };
      await this.draftAccessor.set(context, draft);
      return;
    }

    if (value && value.action === 'startEditTicket') {
      draft = { state: 'editing', ticketId: value.ticketId, history: [] };
      await this.draftAccessor.set(context, draft);
      return await context.sendActivity(L.editPrompt.replace('{number}', value.ticketId));
    }

    if (value && value.action === 'closeTicket') {
      const cardLang = value.lang || lang;
      const ticketId = value.ticketId;
      const userName = context.activity.from.name;
      const userEmail = context.activity.from.email
        || `${userName.replace(/\s+/g, '.').toLowerCase()}@newlink-group.com`;
      await closeTicket(ticketId, userEmail, cardLang);
      const LC = i18n[cardLang] || i18n['es'];
      const message = LC.ticketClosed.replace('{number}', value.ticketId);
      return await context.sendActivity(message);
    }

    // 2) IN-FLIGHT DRAFT (JSON loop)
    if (draft.state === 'awaiting') {
      draft.history.push({ role: 'user', content: text });
      const userName  = context.activity.from.name;
      const userEmail = context.activity.from.email
        || `${userName.replace(/\s+/g,'.').toLowerCase()}@newlink-group.com`;
      const conversationLog = draft.history.map(m => `[${m.role}] ${m.content}`).join('\n');
      const systemPrompt = {
        role: 'system',
        content:
          `Eres OrbIT, asistente de IA que recopila información para un ticket de soporte. ` +
          `Respondes siempre en el mismo idioma en el que habla el usuario en cada mensaje. ` +
          `Ofreces sugerencias de autoayuda pero generas el ticket de forma directa si lo pide el usuario.` +
          `Generas el summary hablando en primera persona.` +
          `Usuario: ${userName}, correo: ${userEmail}. ` +
          `Solo recopila detalles del problema y equipo. ` +
          `Responde en JSON e incluye el código ISO de tu idioma actual en un campo "lang": ` +
          `{"done":false,"question":"…","lang":"<iso>"} ` +
          `o {"done":true,"title":"…","summary":"…","lang":"<iso>"}.`
      };
      const userPrompt = { role: 'user', content: `Historial:\n${conversationLog}` };
      const raw = await callAzureOpenAI([systemPrompt, userPrompt], lang, { withRetrieval: true, topK: 5 });
      let obj;
      try { obj = JSON.parse(raw.trim()); } catch { return await context.sendActivity(L.parseError); }
      if (!obj.done) {
        draft.history.push({ role: 'assistant', content: obj.question });
        await this.draftAccessor.set(context, draft);
        return await context.sendActivity(obj.question);
      }
      const cardLang = obj.lang || lang;
      const LC2 = i18n[cardLang];
      draft = { state: 'idle', history: [] };
      await this.draftAccessor.set(context, draft);
      const confirmCard = {
        type: 'AdaptiveCard',
        body: [
          { type: 'TextBlock', text: LC2.confirmPrompt, wrap: true },
          { type: 'TextBlock', text: `**${obj.title}**`, wrap: true },
          { type: 'TextBlock', text: obj.summary, wrap: true }
        ],
        actions: [
          { type: 'Action.Submit', title: LC2.confirm, data: { action: 'confirmTicket', title: obj.title, summary: obj.summary, lang: cardLang } },
          { type: 'Action.Submit', title: LC2.cancel, data: { action: 'cancelTicket', title: obj.title, summary: obj.summary, lang: cardLang } }
        ],
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        version: '1.4'
      };
      return await context.sendActivity({ attachments: [CardFactory.adaptiveCard(confirmCard)] });
    }

    if (draft.state === 'editing') {
      const userName  = context.activity.from.name;
      const userEmail = context.activity.from.email
        || `${userName.replace(/\s+/g,'.').toLowerCase()}@newlink-group.com`;
      let comment = text.trim();
      const ticketId = draft.ticketId;
      const teamsFiles = context.activity.attachments || [];
      if (teamsFiles.length === 0) {
        await context.sendActivity(L.noAttachments);
        return;
      }
      const creds = new MicrosoftAppCredentials(process.env.MicrosoftAppId, process.env.MicrosoftAppPassword);
      const token = await creds.getToken();
      const { attachmentTokens, commentNote } = await this.processAttachments(context, token, userEmail);
      comment = `${comment}\n\n${commentNote}`.trim();
      if (!comment && attachmentTokens.length === 0) {
        return await context.sendActivity(L.writeComment);
      }
      await addCommentToTicket(ticketId, comment || "Archivo adjunto desde Teams.", userEmail, attachmentTokens);
      await this.draftAccessor.set(context, { state: 'idle', history: [] });
      return await context.sendActivity(`${L2?.commentAdded} #${ticketId}.`);
    }

    // 3) INTENT CLASSIFICATION
    let info;
    try {
      info = (value && value.action === 'listTksPage') ? { intent: 'listTksPage' } : await classifySupportRequest(text, lang);
    } catch {
      await context.sendActivity({ type: 'typing' });
      let reply = '';
      await callAzureOpenAIStream(text, lang, chunk => reply += chunk, { withRetrieval: true, topK: 5 });
      return await context.sendActivity(reply);
    }

    // 4) KICK-OFF SUPPORT FLOW

    const userName  = context.activity.from.name;
    const userEmail = context.activity.from.email
      || `${userName.replace(/\s+/g,'.').toLowerCase()}@newlink-group.com`;
    switch (info.intent) {
      case 'createTk':
        draft = { state: 'awaiting', history: [] };
        draft.history.push({ role: 'assistant', content: `Resumen inicial: ${info.summary}` });
        await this.draftAccessor.set(context, draft);
        await context.sendActivity({ type: 'typing' });
        let firstQ = '';
        const firstPrompt = firstPromptTemplates[lang]?.replace('{summary}', info.summary)
          || firstPromptTemplates.es.replace('{summary}', info.summary);
        await callAzureOpenAIStream(firstPrompt, lang, chunk => firstQ += chunk, { withRetrieval: true, topK: 5 });
        draft.history.push({ role: 'assistant', content: firstQ });
        await this.draftAccessor.set(context, draft);
        return await context.sendActivity(firstQ);
      case 'singleTk':
        if (info.ticketId) {
          const ticket = await getTicketById(info.ticketId, userEmail);

          const card = {
            type: 'AdaptiveCard',
            body: [
              { type: 'TextBlock', text: `🔎 ${L.ticketLabel} #${ticket.id}`, weight: 'Bolder', size: 'Medium' },
              { type: 'TextBlock', text: `📌 *${ticket.title}*`, wrap: true },
              { type: 'TextBlock', text: `🗂 ${L.statusLabel}: **${ticket.state}**`, wrap: true },
              { 
                type: 'TextBlock', 
                text: L.assignedTo.replace(
                  '{owner}',
                  ticket.owner
                    ? `${ticket.owner.firstname} ${ticket.owner.lastname}`
                    : L.notAssigned
                ),
                wrap: true 
              },
              { type: 'TextBlock', text: `🕓 ${L.createdLabel}: ${new Date(ticket.created_at).toLocaleString()}`, wrap: true },
              { type: 'TextBlock', text: `🕑 ${L.updatedLabel}: ${new Date(ticket.updated_at).toLocaleString()}`, wrap: true },
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
                data: {
                  action: 'closeTicket',
                  ticketId: ticket.id
                }
              }] : [])
            ],
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            version: '1.4'
          };

          return await context.sendActivity({ attachments: [CardFactory.adaptiveCard(card)] });
        }
        break;
      case 'listTks':
        return await this.renderTicketListCard(context, 0, false);
      case 'listTksPage':
        const page = value.page || 0;
        const showClosed = !!value.showClosed;
        return await this.renderTicketListCard(context, page, showClosed);
      case 'editTk':
        if (info.ticketId) {
          const creds2 = new MicrosoftAppCredentials(process.env.MicrosoftAppId, process.env.MicrosoftAppPassword);
          const token2 = await creds2.getToken();
          const { attachmentTokens, commentNote } = await this.processAttachments(context, token2, userEmail);
          let comment2 = value.comment?.trim() || '';
          comment2 = `${comment2}\n\n${commentNote}`.trim();
          if (!comment2 && attachmentTokens.length === 0) {
            return await context.sendActivity(L.writeComment);
          }
          await addCommentToTicket(info.ticketId, comment2, userEmail, attachmentTokens);
          const msg = L.commentFinal
            .replace('{number}', info.ticketId)
            .replace('{files}', attachmentTokens.length ? L.filesClause : '');
          return await context.sendActivity(msg);
        }
        break;
      default:
        await context.sendActivity({ type: 'typing' });
        let reply2 = '';
        await callAzureOpenAIStream(text, lang, chunk => reply2 += chunk, { withRetrieval: true, topK: 5 });
        return await context.sendActivity(reply2);
    }
  }

  async renderTicketListCard(context, page = 0, showClosed = false) {
    const userName = context.activity.from.name;
    const userEmail = context.activity.from.email
      || `${userName.replace(/\s+/g, '.').toLowerCase()}@newlink-group.com`;

    const pageSize = 5;
    const tickets = await listTickets(userEmail, { openOnly: !showClosed });
    if (!tickets || tickets.length === 0) {
      return await context.sendActivity(L3.noTickets);
    }

    tickets.sort((a, b) => b.id - a.id);
    const filtered = showClosed
      ? tickets
      : tickets.filter(t => t.state?.toLowerCase() !== 'closed');

    const totalPages = Math.ceil(filtered.length / pageSize);
    const paginated = filtered.slice(page * pageSize, (page + 1) * pageSize);

    const cardBody = [
      { type: 'TextBlock', text: L.listTitle, weight: 'Bolder', size: 'Medium', wrap: true },
      ...paginated.map(t => {
        const isClosed = t.state?.toLowerCase() === 'closed';
        const isNew = t.state?.toLowerCase() === 'new';

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
                {
                  type: 'Action.OpenUrl',
                  title: L.viewInBrowser,
                  url: `${helpdeskWebUrl}/${t.id}`
                },
                {
                  type: 'Action.Submit',
                  title: L.edit,
                  data: {
                    action: 'startEditTicket',
                    ticketId: t.id
                  }
                },
                ...(!isClosed ? [{
                  type: 'Action.Submit',
                  title: L.close,
                  data: {
                    action: 'closeTicket',
                    ticketId: t.id
                  }
                }] : [])
              ],
              spacing: 'Medium',
              horizontalAlignment: 'Left'
            }
          ]
        };
      })
    ];

    const actions = [];
    if (page > 0) {
      actions.push({
        type: 'Action.Submit',
        title: L.prev,
        data: { action: 'listTksPage', page: page - 1, showClosed }
      });
    }
    if (page < totalPages - 1) {
      actions.push({
        type: 'Action.Submit',
        title: L.next,
        data: { action: 'listTksPage', page: page + 1, showClosed }
      });
    }
    actions.push({
      type: 'Action.Submit',
      title: showClosed ? L.hideClosed : L.showClosed,
      data: {
        action: 'listTksPage',
        page: 0,
        showClosed: !showClosed
      }
    });

    const card = {
      type: 'AdaptiveCard',
      body: cardBody,
      actions,
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      version: '1.4'
    };

    const cardMessage = {
      type: 'message',
      attachments: [CardFactory.adaptiveCard(card)]
    };

    if (context.activity.replyToId) {
      cardMessage.id = context.activity.replyToId;
      return await context.updateActivity(cardMessage);
    } else {
      return await context.sendActivity(cardMessage);
    }
  }

  async extractInlineImagesFromHtml(html, token, userEmail) {
    const attachmentTokens = [];

    const imgRegex = /<img[^>]+src="([^"]+)"/g;
    const matches = [...html.matchAll(imgRegex)];

    for (const match of matches) {
      const imageUrl = match[1];
      console.log("📎 Found inline image URL:", imageUrl);

      try {
        const imgRes = await axios.get(imageUrl, {
          responseType: 'arraybuffer',
          headers: { Authorization: `Bearer ${token}` }
        });

        const buffer = Buffer.from(imgRes.data);
        const tokenId = await uploadAttachment(
          {
            buffer,
            originalname: 'inline-image.png'
          },
          userEmail
        );

        attachmentTokens.push(tokenId);
      } catch (err) {
        console.warn("❌ Failed to download inline image:", imageUrl, err.message);
      }
    }

    return attachmentTokens;
  }
}

module.exports.TeamsBot = TeamsBot;