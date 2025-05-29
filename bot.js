const { ActivityHandler, CardFactory, TurnContext, TeamsInfo } = require('botbuilder');
const { callAzureOpenAI, callAzureOpenAIStream, classifySupportRequest } = require('./openaiClient');
const { createTicket, listTickets, addCommentToTicket, uploadAttachment, closeTicket, getTicketById } = require('./ticketClient');
const { MicrosoftAppCredentials } = require('botframework-connector');
const { getReference, saveFullReference } = require('./teamsIdStore');
const axios = require('axios');
const { i18n, firstPromptTemplates, newChatGreetings, getSystemPrompt } = require('./prompts');
const { getTicketListCardBody, getConfirmTicketCard, getCancelTicketCard, getFinalTicketCard, getSingleTicketCard } = require('./cardTemplates');
const helpdeskWebUrl = process.env.HELPDESK_WEB_URL;
if (!helpdeskWebUrl) throw new Error('Missing HELPDESK_WEB_URL env var');

function detectLanguageFromLocale(locale) {
  if (locale.startsWith('en')) return 'en';
  if (locale.startsWith('pt')) return 'pt';
  return 'es';
}

class TeamsBot extends ActivityHandler {
  constructor(conversationState) {
    super();
    this.onConversationUpdate(async (context, next) => {
      const locale = context.activity.locale || 'es-LA';
      const fallbackLang = detectLanguageFromLocale(locale);
      const lang = context.activity.value?.lang || fallbackLang;
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
        await context.sendActivity(newChatGreetings[lang]);
      }
      await next();
    });
    this.conversationState = conversationState;
    this.draftAccessor    = conversationState.createProperty('ticketDraft');
    this.onMessage(this.handleMessage.bind(this));
  }

  async processAttachments(context, token, userEmail, lang) {
    let L = i18n[lang];
    const attachmentTokens = [];
    let commentNote = '';
    const teamsFiles = context.activity.attachments || [];
    for (const file of teamsFiles) {
      if (!file.contentUrl) {
        console.warn("📎 Attachment has no contentUrl:", file);
        continue;
      }
      if (file.contentUrl.includes('sharepoint.com') || file.contentUrl.includes('my.sharepoint.com')) {
        const linkNote = `${L.attachedFile}: ${file.contentUrl}`;
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
        const linkNote = links.map(url => `${L.attachedFile}: ${url}`).join('\n');
        commentNote += `\n\n${linkNote}`;
      }
    }
    return { attachmentTokens, commentNote: commentNote.trim() };
  }

  async handleMessage(context, next) {
    const text   = (context.activity.text || '').trim();
    const locale = context.activity.locale || 'es-LA';
    const fallbackLang = detectLanguageFromLocale(locale);
    let lang = context.activity.value?.lang || fallbackLang;
    let L = i18n[lang];
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
      const { title, summary } = value;
      const userName  = context.activity.from.name;
      const userEmail = context.activity.from.email
        || `${userName.replace(/\s+/g,'.').toLowerCase()}@newlink-group.com`;
      const ticket = await createTicket({ title, description: summary, userName, userEmail });
      const successLine =
        `✅ [${L.ticketLabel} #${ticket.id}]` +
        `(${helpdeskWebUrl}/${ticket.id}) ${L.createdSuffix}`;
      const finalCard = getFinalTicketCard(title, summary, ticket.id, helpdeskWebUrl, L);
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
      const { title, summary } = value;
      const cancelCard = getCancelTicketCard(value.title, value.summary, lang, L);
      await context.updateActivity({ id: context.activity.replyToId, type: 'message', attachments: [ CardFactory.adaptiveCard(cancelCard) ] });
      draft = { state: 'idle', history: [] };
      await this.draftAccessor.set(context, draft);
      return;
    }

    if (value && value.action === 'startEditTicket') {
      draft = { state: 'editing', ticketId: value.ticketId, lang: value.lang, history: [] };
      await this.draftAccessor.set(context, draft);
      return await context.sendActivity(L.editPrompt.replace('{number}', value.ticketId));
    }

    if (value && value.action === 'closeTicket') {
      const ticketId = value.ticketId;
      const userName = context.activity.from.name;
      const userEmail = context.activity.from.email
        || `${userName.replace(/\s+/g, '.').toLowerCase()}@newlink-group.com`;
      await closeTicket(ticketId, userEmail, lang);
      const message = L.ticketClosed.replace('{number}', value.ticketId);
      return await context.sendActivity(message);
    }

    // 2) IN-FLIGHT DRAFT (JSON loop)
    if (draft.state === 'awaiting') {
      draft.history.push({ role: 'user', content: text });
      const userName  = context.activity.from.name;
      const userEmail = context.activity.from.email
        || `${userName.replace(/\s+/g,'.').toLowerCase()}@newlink-group.com`;
      const conversationLog = draft.history.map(m => `[${m.role}] ${m.content}`).join('\n');
      const systemPrompt = getSystemPrompt(userName, userEmail);
      const userPrompt = { role: 'user', content: `Historial:\n${conversationLog}` };
      const raw = await callAzureOpenAI([systemPrompt, userPrompt], lang, { withRetrieval: true, topK: 5 });
      let obj;
      try { obj = JSON.parse(raw.trim()); } catch { return await context.sendActivity(L.parseError); }
      if (!obj.done) {
        draft.history.push({ role: 'assistant', content: obj.question });
        await this.draftAccessor.set(context, draft);
        return await context.sendActivity(obj.question);
      }
      draft = { state: 'idle', history: [] };
      await this.draftAccessor.set(context, draft);
      const confirmCard = getConfirmTicketCard(obj.title, obj.summary, lang, L);
      return await context.sendActivity({ attachments: [CardFactory.adaptiveCard(confirmCard)] });
    }

    if (draft.state === 'editing') {
      let lang = draft.lang || fallbackLang;
      let L    = i18n[lang];
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
      const { attachmentTokens, commentNote } = await this.processAttachments(context, token, userEmail, lang);
      comment = `${comment}\n\n${commentNote}`.trim();
      if (!comment && attachmentTokens.length === 0) {
        return await context.sendActivity(L.writeComment);
      }
      await addCommentToTicket(ticketId, comment || `${L.attachedFile}: `, userEmail, attachmentTokens);
      await this.draftAccessor.set(context, { state: 'idle', history: [] });
      return await context.sendActivity(`${L.commentAdded.replace('{number}', ticketId)}`);
    }

    // 3) INTENT CLASSIFICATION
    let info;
    try {
      info = (value && value.action === 'listTksPage')
        ? { intent: 'listTksPage', lang: value?.lang } // 👈 agregá esto
        : await classifySupportRequest(text, lang);
      if (info.lang) {
        lang = info.lang;
        L = i18n[lang];
      }
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
          const singleCard = getSingleTicketCard(ticket, L, lang, helpdeskWebUrl);
          return await context.sendActivity({ attachments: [CardFactory.adaptiveCard(singleCard)] });
        }
        return await context.sendActivity(L.askForTicketId);   // e.g. “Por favor dime el número de ticket”
      case 'listTks':
        return await this.renderTicketListCard(context, 0, false, lang);
      case 'listTksPage':
        const page = value.page || 0;
        const showClosed = !!value.showClosed;
        return await this.renderTicketListCard(context, page, showClosed, lang);
      case 'editTk':
        if (info.ticketId) {
          const creds2 = new MicrosoftAppCredentials(process.env.MicrosoftAppId, process.env.MicrosoftAppPassword);
          const token2 = await creds2.getToken();
          const { attachmentTokens, commentNote } = await this.processAttachments(context, token2, userEmail, lang);
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
        return await context.sendActivity(L.askForTicketId);
      default:
        await context.sendActivity({ type: 'typing' });
        let reply2 = '';
        await callAzureOpenAIStream(text, lang, chunk => reply2 += chunk, { withRetrieval: true, topK: 5 });
        return await context.sendActivity(reply2);
    }
  }

  async renderTicketListCard(context, page = 0, showClosed = false, lang) {
    let L = i18n[lang];
    const userName = context.activity.from.name;
    const userEmail = context.activity.from.email
      || `${userName.replace(/\s+/g, '.').toLowerCase()}@newlink-group.com`;
    const pageSize = 5;
    const tickets = await listTickets(userEmail, { openOnly: !showClosed });
    if (!tickets || tickets.length === 0) {
      return await context.sendActivity(L.noTickets);
    }
    tickets.sort((a, b) => b.id - a.id);
    const filtered = showClosed
      ? tickets
      : tickets.filter(t => t.state?.toLowerCase() !== 'closed');
    const totalPages = Math.ceil(filtered.length / pageSize);
    const paginated = filtered.slice(page * pageSize, (page + 1) * pageSize);
    const cardBody = getTicketListCardBody(paginated, L, lang);
    const actions = [];
    if (page > 0) {
      actions.push({
        type: 'Action.Submit',
        title: L.prev,
        data: { action: 'listTksPage', page: page - 1, showClosed, lang }
      });
    }
    if (page < totalPages - 1) {
      actions.push({
        type: 'Action.Submit',
        title: L.next,
        data: { action: 'listTksPage', page: page + 1, showClosed, lang }
      });
    }
    actions.push({
      type: 'Action.Submit',
      title: showClosed ? L.hideClosed : L.showClosed,
      data: {
        action: 'listTksPage',
        page: 0,
        showClosed: !showClosed,
        lang
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