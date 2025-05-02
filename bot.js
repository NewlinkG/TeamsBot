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
    parseError:    'Sorry, I couldn’t parse that. Can you rephrase?',
    createError:   'Something went wrong creating the ticket. Please try again later.'
  },
  pt: {
    confirmPrompt: 'Por favor confirme os detalhes do chamado:',
    confirm:       'Confirmar',
    cancel:        'Cancelar',
    ticketLabel:   'Chamado',
    createdSuffix: 'criado com sucesso.',
    cancelled:     '👍 Criação de chamado cancelada',
    parseError:    'Desculpe, não consegui entender. Pode reformular?',
    createError:   'Ocorreu um erro ao criar o chamado. Por favor, tente mais tarde.'
  },
  es: {
    confirmPrompt: 'Confirma los detalles del ticket:',
    confirm:       'Confirmar',
    cancel:        'Cancelar',
    ticketLabel:   'Ticket',
    createdSuffix: 'creado correctamente.',
    cancelled:     '👍 Creación de ticket cancelada',
    parseError:    'Lo siento, no entendí. ¿Puedes aclarar?',
    createError:   'Hubo un error al crear el ticket. Por favor, inténtalo más tarde.'
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
    // --- DEBUG: log incoming activity ---
    console.log('--- handleMessage ---', {
      text:    context.activity.text,
      value:   context.activity.value,
      locale:  context.activity.locale
    });

    const text   = (context.activity.text || '').trim();
    const locale = context.activity.locale || 'es-LA';
    const lang   = detectLanguageFromLocale(locale);
    const L      = i18n[lang];
    console.log('Determined lang:', lang);

    // 0) Load or init draft
    let draft = await this.draftAccessor.get(context, { state: 'idle', history: [] });
    console.log('Current draft:', draft);

    // 1) Confirm / Cancel actions
    const value = context.activity.value;
    if (value && value.action === 'confirmTicket') {
      console.log('▶️ confirmTicket branch:', value);
      const { title, summary } = value;
      const userName  = context.activity.from.name;
      const userEmail = context.activity.from.email
        || `${userName.replace(/\s+/g, '.').toLowerCase()}@newlink-group.com`;

      try {
        // Attempt ticket creation
        const ticket = await createTicket({ title, description: summary, userName, userEmail });
        console.log('Ticket created:', ticket.id);

        // Build success card
        const successLine =
          `✅ [${L.ticketLabel} #${ticket.id}](${helpdeskWebUrl}/${ticket.id}) ${L.createdSuffix}`;

        const finalCard = {
          type: 'AdaptiveCard',
          body: [
            { type: 'TextBlock', text: title,   weight: 'Bolder', wrap: true },
            { type: 'TextBlock', text: summary, wrap: true },
            { type: 'TextBlock', text: successLine, wrap: true }
          ],
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          version: '1.4'
        };

        await context.updateActivity({
          id:          context.activity.replyToId,
          type:        'message',
          attachments: [CardFactory.adaptiveCard(finalCard)]
        });

      } catch (err) {
        console.error('❌ createTicket error:', err);

        // Build error card
        const errorCard = {
          type: 'AdaptiveCard',
          body: [
            { type: 'TextBlock', text: title,   weight: 'Bolder', wrap: true },
            { type: 'TextBlock', text: summary, wrap: true },
            { type: 'TextBlock', text: L.createError, wrap: true, color: 'Attention' }
          ],
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          version: '1.4'
        };

        await context.updateActivity({
          id:          context.activity.replyToId,
          type:        'message',
          attachments: [CardFactory.adaptiveCard(errorCard)]
        });
      }

      // Reset draft
      draft = { state: 'idle', history: [] };
      await this.draftAccessor.set(context, draft);
      return;
    }

    if (value && value.action === 'cancelTicket') {
      console.log('▶️ cancelTicket branch:', value);
      const { title, summary } = value;

      const cancelCard = {
        type: 'AdaptiveCard',
        body: [
          { type: 'TextBlock', text: title,   weight: 'Bolder', wrap: true },
          { type: 'TextBlock', text: summary, wrap: true },
          { type: 'TextBlock', text: L.cancelled, wrap: true }
        ],
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        version: '1.4'
      };

      await context.updateActivity({
        id:          context.activity.replyToId,
        type:        'message',
        attachments: [CardFactory.adaptiveCard(cancelCard)]
      });

      draft = { state: 'idle', history: [] };
      await this.draftAccessor.set(context, draft);
      return;
    }

    // 2) In-flight draft: follow-up LLM questions
    if (draft.state === 'awaiting') {
      console.log('▶️ awaiting branch, history:', draft.history);
      draft.history.push({ role: 'user', content: text });
      await this.draftAccessor.set(context, draft);

      const userName  = context.activity.from.name;
      const userEmail = context.activity.from.email
        || `${userName.replace(/\s+/g, '.').toLowerCase()}@newlink-group.com`;

      const conversationLog = draft.history.map(m => `[${m.role}] ${m.content}`).join('\n');
      console.log('Sending conversation log to LLM:', conversationLog);

      const systemPrompt = {
        role: 'system',
        content:
          `Eres Newlinker, asistente de IA que recopila información para un ticket de soporte. ` +
          `Respondes siempre en el idioma que te hablan. ` +
          `Ofreces sugerencias de autoayuda pero generas el ticket de forma directa si lo pide el usuario.` +
          `Generas el summary hablando en primera persona.` +
          `Usuario: ${userName}, correo: ${userEmail}. ` +
          `Solo recopila detalles del problema y equipo. ` +
          `Responde en JSON: ` +
          `{"done":false,"question":"…"} o ` +
          `{"done":true,"title":"…","summary":"…"}.`
      };
      const userPrompt = { role: 'user', content: `Historial:\n${conversationLog}` };

      const raw = await callAzureOpenAI([systemPrompt, userPrompt], lang);
      console.log('LLM raw response:', raw);
      let obj;
      try {
        obj = JSON.parse(raw.trim());
      } catch (parseErr) {
        console.error('❌ JSON parse error:', parseErr);
        return await context.sendActivity(L.parseError);
      }

      if (!obj.done) {
        draft.history.push({ role: 'assistant', content: obj.question });
        await this.draftAccessor.set(context, draft);
        console.log('→ Asking follow-up:', obj.question);
        return await context.sendActivity(obj.question);
      }

      // Done → prompt confirmation
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
            data:  { action: 'confirmTicket', title: obj.title, summary: obj.summary }
          },
          {
            type: 'Action.Submit',
            title: L.cancel,
            data:  { action: 'cancelTicket', title: obj.title, summary: obj.summary }
          }
        ],
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        version: '1.4'
      };

      console.log('→ Sending confirm card');
      return await context.sendActivity({ attachments: [CardFactory.adaptiveCard(confirmCard)] });
    }

    // 3) Classify intent
    console.log('▶️ classifying intent for:', text);
    let info;
    try {
      info = await classifySupportRequest(text, lang);
      console.log('Classifier output:', info);
    } catch (err) {
      console.error('Classifier error, falling back to LLM:', err);
      const reply = await callAzureOpenAI(text, lang);
      return await context.sendActivity(reply);
    }

    // 4) Kick off support flow if intent says so
    if (info.isSupport) {
      console.log('▶️ support intent detected, starting draft');
      draft = { state: 'awaiting', history: [] };
      draft.history.push({ role: 'assistant', content: `Resumen inicial: ${info.summary}` });
      await this.draftAccessor.set(context, draft);

      const firstPrompt =
        `Eres Newlinker, recopila info para un ticket de soporte: "${info.summary}". ` +
        `Pregunta solo detalles del problema (no pidas nombre/correo).`;
      const firstQ = await callAzureOpenAI(firstPrompt, lang);
      draft.history.push({ role: 'assistant', content: firstQ });
      await this.draftAccessor.set(context, draft);

      console.log('→ Sending first follow-up:', firstQ);
      return await context.sendActivity(firstQ);
    }

    // 5) Fallback: normal chat
    console.log('▶️ fallback normal chat to LLM');
    const reply = await callAzureOpenAI(text, lang);
    console.log('LLM reply:', reply);
    await context.sendActivity(reply);
    await this.draftAccessor.set(context, draft);

    await next();
    console.log('--- handleMessage end ---');
  }
}

module.exports.TeamsBot = TeamsBot;