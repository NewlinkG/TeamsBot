// bot.js
const { ActivityHandler, CardFactory } = require('botbuilder');
const { callAzureOpenAI, classifySupportRequest } = require('./openaiClient');
const { createTicket } = require('./ticketClient');

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

    // Retrieve or initialize the draft
    let draft = await this.draftAccessor.get(context, {
      state: 'idle',
      history: []
    });

    // 1) Handle Confirm / Cancel actions
    const value = context.activity.value;
    if (value && value.action === 'confirmTicket') {
      // Use the lang that was saved in the card
      const cardLang = value.lang || lang;
      const LC = i18n[cardLang];

      const { title, summary } = value;
      const userName  = context.activity.from.name;
      const userEmail = context.activity.from.email ||
                        `${userName.replace(/\s+/g, '.').toLowerCase()}@newlink-group.com`;

      // Create the ticket
      const ticket = await createTicket({
        title,
        description: summary,
        userName,
        userEmail
      });

      // Build and replace with final success card
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
        id:         context.activity.replyToId,
        type:       'message',
        attachments:[ CardFactory.adaptiveCard(finalCard) ]
      });

      draft = { state: 'idle', history: [] };
      await this.draftAccessor.set(context, draft);
      return;
    }

    if (value && value.action === 'cancelTicket') {
      // Use the lang that was saved in the card
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

      await context.updateActivity({
        id:         context.activity.replyToId,
        type:       'message',
        attachments:[ CardFactory.adaptiveCard(cancelCard) ]
      });

      draft = { state: 'idle', history: [] };
      await this.draftAccessor.set(context, draft);
      return;
    }

    // 2) In-flight draft: gather details until done
    if (draft.state === 'awaiting') {
      draft.history.push({ role: 'user', content: text });

      const userName  = context.activity.from.name;
      const userEmail = context.activity.from.email ||
                        `${userName.replace(/\s+/g, '.').toLowerCase()}@newlink-group.com`;

      const conversationLog = draft.history
        .map(m => `[${m.role}] ${m.content}`)
        .join('\n');

      // **Only this prompt changed** to ask for a `"lang"` field in the JSON
      const systemPrompt = {
        role: 'system',
        content:
          `Eres Newlinker, asistente de IA que recopila información para un ticket de soporte. ` +
          `Respondes siempre en el idioma que te hablan. ` +
          `Ofreces sugerencias de autoayuda pero generas el ticket de forma directa si lo pide el usuario.` +
          `Generas el summary hablando en primera persona.` +
          `Usuario: ${userName}, correo: ${userEmail}. ` +
          `Solo recopila detalles del problema y equipo. ` +
          `Responde en JSON que incluya tu idioma ISO, usando uno de estos formatos exactos:\n` +
          `  {"done":false,"question":"…","lang":"<iso>"}\n` +
          `  {"done":true,"title":"…","summary":"…","lang":"<iso>"}`
      };
      const userPrompt = { role: 'user', content: `Historial:\n${conversationLog}` };

      const raw = await callAzureOpenAI([ systemPrompt, userPrompt ], lang);
      let obj;
      try {
        obj = JSON.parse(raw.trim());
      } catch {
        return await context.sendActivity(L.parseError);
      }

      if (!obj.done) {
        draft.history.push({ role: 'assistant', content: obj.question });
        await this.draftAccessor.set(context, draft);
        return await context.sendActivity(obj.question);
      }

      // Ready to confirm: reset draft and send confirm card
      draft = { state: 'idle', history: [] };
      await this.draftAccessor.set(context, draft);

      const confirmCard = {
        type: 'AdaptiveCard',
        body: [
          { type: 'TextBlock', text: L.confirmPrompt, wrap: true },
          { type: 'TextBlock', text: `**${obj.title}**`, wrap: true },
          { type: 'TextBlock', text: obj.summary, wrap: true }
        ],
        actions: [
          {
            type: 'Action.Submit',
            title: L.confirm,
            data:  {
              action:  'confirmTicket',
              title:   obj.title,
              summary: obj.summary,
              lang     // ← preserve language
            }
          },
          {
            type: 'Action.Submit',
            title: L.cancel,
            data:  {
              action:  'cancelTicket',
              title:   obj.title,
              summary: obj.summary,
              lang     // ← preserve language
            }
          }
        ],
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        version: '1.4'
      };

      return await context.sendActivity({ attachments: [ CardFactory.adaptiveCard(confirmCard) ] });
    }

    // 3) Initial intent classification
    let info;
    try {
      info = await classifySupportRequest(text, lang);
    } catch {
      const reply = await callAzureOpenAI(text, lang);
      return await context.sendActivity(reply);
    }

    // 4) Kick off support flow if needed
    if (info.isSupport) {
      draft = { state: 'awaiting', history: [] };
      draft.history.push({ role: 'assistant', content: `Resumen inicial: ${info.summary}` });
      await this.draftAccessor.set(context, draft);

      const firstPrompt =
        `Eres Newlinker, recopila info para un ticket de soporte: "${info.summary}". ` +
        `Respondes siempre en el idioma que te hablan. ` +
        `Ofreces sugerencias de autoayuda pero generas el ticket de forma directa si lo pide el usuario.` +
        `Generas el summary hablando en primera persona.` +
        `Pregunta solo detalles del problema (no pidas nombre/correo).`;
      const firstQ = await callAzureOpenAI(firstPrompt, lang);
      draft.history.push({ role: 'assistant', content: firstQ });
      await this.draftAccessor.set(context, draft);

      return await context.sendActivity(firstQ);
    }

    // 5) Fallback: normal chat
    const reply = await callAzureOpenAI(text, lang);
    await context.sendActivity(reply);
    await this.draftAccessor.set(context, draft);
    await next();
  }
}

module.exports.TeamsBot = TeamsBot;
