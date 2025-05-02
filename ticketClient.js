// ticketClient.js
const axios = require('axios');
require('dotenv').config();

const HELP_DESK_URL      = process.env.HELPDESK_API_URL;      // e.g. https://helpdesk.newlink-group.com/api/v1
const HELP_DESK_TOKEN    = process.env.HELPDESK_TOKEN;        // Personal Access Token
const HELP_DESK_GROUP_ID = process.env.HELPDESK_DEFAULT_GROUP || '1';

if (!HELP_DESK_URL || !HELP_DESK_TOKEN) {
  throw new Error(
    'MISSING_CONFIG'
  );
}

const http = axios.create({
  baseURL: HELP_DESK_URL.replace(/\/+$/, ''),
  timeout: 5000,
  headers: {
    Authorization: `Token token=${HELP_DESK_TOKEN}`,
    'Content-Type': 'application/json'
  }
});

/**
 * Crea un ticket en Zammad con retries y logs detallados.
 * Lanza "CREATE_TICKET_FAILED" si tras todos los retries no funciona.
 */
async function createTicket({ title, description, userName, userEmail }) {
  // Validaciones básicas
  if (!title || !description) {
    throw new Error('VALIDATION_ERROR');
  }

  // Nombre
  const parts     = userName.trim().split(/\s+/);
  const firstName = parts.shift();
  const lastName  = parts.join(' ');

  const payload = {
    title,
    group_id: Number(HELP_DESK_GROUP_ID),
    customer: {
      firstname: firstName,
      lastname:  lastName,
      login:     userEmail,
      email:     userEmail
    },
    article: {
      subject:      title,
      body:         description,
      type:         'email',
      sender:       'Customer',
      internal:     false,
      content_type: 'text/plain'
    }
  };

  const maxRetries = 2;
  const baseDelay  = 500; // ms

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      console.log(`📬 [Attempt ${attempt+1}] POST /tickets`, { payload });
      const resp = await http.post('/tickets', payload);
      console.log(`✅ Ticket created on attempt ${attempt+1}:`, resp.data.id);
      return resp.data;
    } catch (err) {
      const status = err.response?.status;
      const isServerError = status >= 500 && status < 600;
      const isNetworkError = !err.response;
      console.warn(`⚠️ [Attempt ${attempt+1}] failed:`, status || err.message);

      // Only retry on network failures or 5xx
      if (!(isNetworkError || isServerError) || attempt === maxRetries) {
        console.error('❌ All retries exhausted.');
        // Lanzamos un código genérico que bot.js intercepta
        throw new Error('CREATE_TICKET_FAILED');
      }

      // Exponential backoff
      const delay = baseDelay * 2 ** attempt;
      console.log(`⏳ Waiting ${delay}ms before next attempt`);
      await new Promise(res => setTimeout(res, delay));
    }
  }
}

module.exports = { createTicket };
