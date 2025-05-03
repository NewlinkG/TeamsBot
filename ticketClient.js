// ticketClient.js
const axios = require('axios');
require('dotenv').config();

const HELP_DESK_URL      = process.env.HELP_DESK_API_URL;      // e.g. https://helpdesk.newlink-group.com/api/v1
const HELP_DESK_TOKEN    = process.env.HELP_DESK_TOKEN;        // Your personal access token
const HELP_DESK_GROUP_ID = process.env.HELP_DESK_DEFAULT_GROUP || '1';

if (!HELP_DESK_URL || !HELP_DESK_TOKEN) {
  throw new Error('Missing HELP_DESK_API_URL or HELP_DESK_TOKEN in env vars');
}

/**
 * Crea un ticket en Zammad como una nota (type: "note"),
 * manteniendo los console.log para debug.
 */
async function createTicket({ title, description, userName, userEmail }) {
  console.log('[ticketClient] ⚙️ createTicket()', { title, userName, userEmail });

  // Desglosar el nombre completo
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
      type:         "note",       // <— create as a Note, not email
      internal:     false,        // visible to both customer & agents
      content_type: "text/html"   // or "text/plain"
    }
  };

  console.log('[ticketClient] 📤 Payload →', JSON.stringify(payload, null, 2));

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
    console.error('[ticketClient] ❌ Error creating ticket:');
    if (err.response) {
      console.error('  Status :', err.response.status);
      console.error('  Headers:', JSON.stringify(err.response.headers, null, 2));
      console.error('  Body   :', JSON.stringify(err.response.data, null, 2));
    } else {
      console.error('  Message:', err.message);
    }
    throw err;
  }
}

module.exports = { createTicket };
