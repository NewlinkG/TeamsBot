// bot.js
const { ActivityHandler, CardFactory } = require('botbuilder');
const {
  callAzureOpenAI,
  callAzureOpenAIStream,
  classifySupportRequest
} = require('./openaiClient');
const { createTicket, listTickets, addCommentToTicket } = require('./ticketClient');
const { MicrosoftAppCredentials } = require('botframework-connector'); // at the top


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
    confirmPrompt: 'Please confirm the ticket details:',
    confirm:       'Confirm',
    cancel:        'Cancel',
    ticketLabel:   'Ticket',
    createdSuffix: 'created successfully.',
    cancelled:     '👍 Ticket creation cancelled',
    parseError:    'Sorry, I couldn’t parse that. Can you rephrase?'
  },
  pt: {
    confirmPrompt: 'Por favor confirme os detalhes do chamado:',
    confirm:       'Confirmar',
    cancel:        'Cancelar',
    ticketLabel:   'Chamado',
    createdSuffix: 'criado com sucesso.',
    cancelled:     '👍 Criação de chamado cancelada',
    parseError:    'Desculpe, não consegui entender. Pode reformular?'
  },
  es: {
    confirmPrompt: 'Confirma los detalles del ticket:',
    confirm:       'Confirmar',
    cancel:        'Cancelar',
    ticketLabel:   'Ticket',
    createdSuffix: 'creado correctamente.',
    cancelled:     '👍 Creación de ticket cancelada',
    parseError:    'Lo siento, no entendí. ¿Puedes aclarar?'
  }
};

class TeamsBot extends ActivityHandler {
  constructor(conversationState) {
    super();
    this.conversationState = conversationState;
    this.draftAccessor    = conversationState.createProperty('ticketDraft');
    this.onMessage(this.handleMessage.bind(this));
  }

  async handleMessage(context, next) {
    const text   = (context.activity.text || '').trim();
    const locale = context.activity.locale || 'es-LA';
    const lang   = detectLanguageFromLocale(locale);
    const L      = i18n[lang];

    // Load or initialize draft
    let draft = await this.draftAccessor.get(context, {
      state: 'idle',
      history: []
    });

    // 1) CONFIRM / CANCEL flows
    const value = context.activity.value;
    if (value && value.action === 'listTksPage') {
      context.activity.value = { ...value }; // reattach value for pagination
      info = { intent: 'listTks' }; // manually override intent
    }

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
          { type:'TextBlock', text: title,   weight:'Bolder', wrap:true },
          { type:'TextBlock', text: summary, wrap:true },
          { type:'TextBlock', text: successLine, wrap:true }
        ],
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        version:'1.4'
      };

      await context.updateActivity({
        id:          context.activity.replyToId,
        type:        'message',
        attachments: [ CardFactory.adaptiveCard(finalCard) ]
      });

      draft = { state:'idle', history:[] };
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
          { type:'TextBlock', text: title,   weight:'Bolder', wrap:true },
          { type:'TextBlock', text: summary, wrap:true },
          { type:'TextBlock', text: LC.cancelled, wrap:true }
        ],
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        version:'1.4'
      };

      await context.updateActivity({
        id:          context.activity.replyToId,
        type:        'message',
        attachments: [ CardFactory.adaptiveCard(cancelCard) ]
      });

      draft = { state:'idle', history:[] };
      await this.draftAccessor.set(context, draft);
      return;
    }

    // 2) IN-FLIGHT DRAFT (JSON loop)
    if (draft.state === 'awaiting') {
      draft.history.push({ role:'user', content:text });

      const userName  = context.activity.from.name;
      const userEmail = context.activity.from.email
        || `${userName.replace(/\s+/g,'.').toLowerCase()}@newlink-group.com`;

      const conversationLog = draft.history
        .map(m => `[${m.role}] ${m.content}`)
        .join('\n');

      // ask the LLM to include "lang" in its JSON
      const systemPrompt = {
        role:'system',
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
      const userPrompt = { role:'user', content:`Historial:\n${conversationLog}` };

      const raw = await callAzureOpenAI([ systemPrompt, userPrompt ], lang, { withRetrieval: true, topK: 5 });
      let obj;
      try {
        obj = JSON.parse(raw.trim());
      } catch {
        return await context.sendActivity(L.parseError);
      }

      // still gathering
      if (!obj.done) {
        draft.history.push({ role:'assistant', content:obj.question });
        await this.draftAccessor.set(context, draft);
        return await context.sendActivity(obj.question);
      }

      // done → **use obj.lang** here, not the original `lang`
      const cardLang = obj.lang || lang;
      const LC = i18n[cardLang];

      draft = { state:'idle', history:[] };
      await this.draftAccessor.set(context, draft);

      const confirmCard = {
        type: 'AdaptiveCard',
        body: [
          { type:'TextBlock', text: LC.confirmPrompt, wrap:true },
          { type:'TextBlock', text:`**${obj.title}**`, wrap:true },
          { type:'TextBlock', text: obj.summary, wrap:true }
        ],
        actions: [
          {
            type:'Action.Submit',
            title: LC.confirm,
            data:  {
              action: 'confirmTicket',
              title:  obj.title,
              summary:obj.summary,
              lang:    cardLang     // carry forward the lang
            }
          },
          {
            type:'Action.Submit',
            title: LC.cancel,
            data:  {
              action: 'cancelTicket',
              title:  obj.title,
              summary:obj.summary,
              lang:    cardLang
            }
          }
        ],
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        version:'1.4'
      };

      return await context.sendActivity({
        attachments: [ CardFactory.adaptiveCard(confirmCard) ]
      });
    }

    // 3) INTENT CLASSIFICATION
    let info;
    try {
      info = await classifySupportRequest(text, lang);
    } catch {
      // fallback to streaming chat
      await context.sendActivity({ type:'typing' });
      let reply = '';
      await callAzureOpenAIStream(text, lang, chunk => reply += chunk, { withRetrieval: true, topK: 5 });
      return await context.sendActivity(reply);
    }

    // 4) KICK-OFF SUPPORT FLOW
    switch (info.intent) {
      case 'createTk': {
        draft = { state: 'awaiting', history: [] };
        draft.history.push({ role: 'assistant', content: `Resumen inicial: ${info.summary}` });
        await this.draftAccessor.set(context, draft);

        const firstPrompt =
          `Eres OrbIT, recopila info para un ticket de soporte: "${info.summary}". ` +
          `Respondes siempre en el mismo idioma en que te habla el usuario.` +
          `Ofreces sugerencias de autoayuda pero generas el ticket de forma directa si te lo piden.` +
          `Generas el summary hablando en primera persona.` +
          `Pregunta solo detalles del problema (no pidas nombre/correo).`;

        await context.sendActivity({ type: 'typing' });
        let firstQ = '';
        await callAzureOpenAIStream(firstPrompt, lang, delta => firstQ += delta, { withRetrieval: true, topK: 5 });

        draft.history.push({ role: 'assistant', content: firstQ });
        await this.draftAccessor.set(context, draft);
        return await context.sendActivity(firstQ);
      }

      case 'listTks': {
        const userName  = context.activity.from.name;
        const userEmail = `${userName.replace(/\s+/g,'.').toLowerCase()}@newlink-group.com`;
        console.log('Querying Zammad for:', userEmail);
        console.log('Returned tickets:', tickets.length);

        const pageSize = 5;
        const page = (context.activity.value && context.activity.value.page) || 0;

        const tickets = await listTickets(userEmail);
        if (!tickets || tickets.length === 0) {
          return await context.sendActivity("🔍 You have no tickets.");
        }

        const totalPages = Math.ceil(tickets.length / pageSize);
        const paginated = tickets.slice(page * pageSize, (page + 1) * pageSize);

        const cardBody = [
          { type: 'TextBlock', text: '📋 Your Tickets', weight: 'Bolder', size: 'Medium', wrap: true },
          ...paginated.map(t => ({
            type: 'Container',
            items: [
              {
                type: 'TextBlock',
                text: `[${t.title}]((${helpdeskWebUrl}/${t.id}))`,
                weight: 'Bolder',
                wrap: true
              },
              {
                type: 'TextBlock',
                text: `#${t.id} — ${t.state || 'Open'}`,
                spacing: 'None',
                isSubtle: true,
                wrap: true
              }
            ]
          }))
        ];

        const actions = [];
        if (page > 0) {
          actions.push({
            type: 'Action.Submit',
            title: '⬅️ Previous',
            data: { action: 'listTksPage', page: page - 1 }
          });
        }
        if (page < totalPages - 1) {
          actions.push({
            type: 'Action.Submit',
            title: 'Next ➡️',
            data: { action: 'listTksPage', page: page + 1 }
          });
        }

        const card = {
          type: 'AdaptiveCard',
          body: cardBody,
          actions,
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          version: '1.4'
        };

        return await context.sendActivity({
          attachments: [CardFactory.adaptiveCard(card)]
        });
      }


      case 'editTk': {
        if (info.ticketId) {
          const userName  = context.activity.from.name;
          const userEmail = `${userName.replace(/\s+/g,'.').toLowerCase()}@newlink-group.com`;
          const comment = info.comment || text;

          let attachmentTokens = [];
          const teamsFiles = context.activity.attachments || [];

          // 🔐 Get bot token to download Teams file from contentUrl
          const token = await MicrosoftAppCredentials.getToken();

          for (const file of teamsFiles) {
            try {
              const tokenId = await uploadAttachment(file.contentUrl, file.name, userEmail, token);
              attachmentTokens.push(tokenId);
            } catch (err) {
              console.warn(`Attachment upload failed: ${file.name}`, err.message);
            }
          }

          await addCommentToTicket(info.ticketId, comment, userEmail, attachmentTokens);
          return await context.sendActivity(`📝 Comment added to ticket #${info.ticketId}${attachmentTokens.length ? ' with attachments.' : '.'}`);
        }
        break;
      }


      default:
        // fallback to streaming chat if no known intent matched
        await context.sendActivity({ type: 'typing' })
        const prompt = text;
        let reply = '';
        await callAzureOpenAIStream(text, lang, chunk => reply += chunk, { withRetrieval: true, topK: 5 });
        return await context.sendActivity(reply);
    }

    await this.draftAccessor.set(context, draft);
    await next();
  }
}

module.exports.TeamsBot = TeamsBot;
