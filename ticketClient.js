// ticketClient.js
const axios = require('axios');
require('dotenv').config();

const HELP_DESK_URL      = process.env.HELPDESK_API_URL;
const HELP_DESK_TOKEN    = process.env.HELPDESK_TOKEN;
const HELP_DESK_GROUP_ID = process.env.HELPESK_DEFAULT_GROUP || '1';

if (!HELP_DESK_URL || !HELP_DESK_TOKEN) {
  throw new Error(
    'Falta configurar HELP_DESK_API_URL y HELP_DESK_TOKEN en las env vars'
  );
}

async function createTicket({ title, description, userName, userEmail }) {
  // Nombre completo → first/last
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

  // Añade el header From con el email del usuario:
  const headers = {
    Authorization: `Token token=${HELP_DESK_TOKEN}`,
    'Content-Type': 'application/json',
    From:           userEmail            // <— impersona al usuario
  };

  const resp = await axios.post(
    `${HELP_DESK_URL.replace(/\/+$/, '')}/tickets`,
    payload,
    { headers }
  );

  return resp.data;
}

module.exports = { createTicket };
