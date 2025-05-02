// ticketClient.js
const axios = require('axios');
require('dotenv').config();

const HELP_DESK_URL      = process.env.HELPDESK_API_URL;      // e.g. https://helpdesk.newlink-group.com/api/v1
const HELP_DESK_TOKEN    = process.env.HELPDESK_TOKEN;        // Your personal access token
const HELP_DESK_GROUP_ID = process.env.HELPDESK_DEFAULT_GROUP || '1';

if (!HELP_DESK_URL || !HELP_DESK_TOKEN) {
  throw new Error('Missing HELP_DESK_API_URL or HELP_DESK_TOKEN in env vars');
}

/**
 * Crea un ticket en Zammad.
 * Solo añadimos console.log para debug, no cambiamos la lógica de reintentos ni
 * transformaciones de error.
 */
async function createTicket({ title, description, userName, userEmail }) {
  console.log('[ticketClient] ⚙️ createTicket()', { title, userName, userEmail });

  // Desglosar nombre
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
      subject: title,
      body:    description
    }
  };

  console.log('[ticketClient] 📤 Payload →', JSON.stringify(payload));

  try {
    const url = `${HELP_DESK_URL.replace(/\/+$/, '')}/tickets`;
    console.log('[ticketClient] POST', url);
    const resp = await axios.post(
      url,
      payload,
      {
        headers: {
          Authorization: `Token token=${HELP_DESK_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('[ticketClient] ✅ Response', resp.status, resp.data);
    return resp.data;
  } catch (err) {
    console.error(
      '[ticketClient] ❌ Error creating ticket:',
      err.response?.status,
      err.response?.data || err.message
    );
    // Rethrow the original error so your bot can handle it as before
    throw err;
  }
}

module.exports = { createTicket };