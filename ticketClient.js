// ticketClient.js
const axios = require('axios');
require('dotenv').config();

const HELP_DESK_URL      = process.env.HELPDESK_API_URL;      // e.g. https://helpdesk.newlink-group.com/api/v1
const HELP_DESK_TOKEN    = process.env.HELPDESK_TOKEN;        // tu Personal Access Token
const HELP_DESK_GROUP_ID = process.env.HELPDESK_DEFAULT_GROUP || '1';

if (!HELP_DESK_URL || !HELP_DESK_TOKEN) {
  throw new Error(
    'Falta configurar HELPESK_API_URL y HELPESK_TOKEN en las env vars'
  );
}

/**
 * Crea un ticket en Zammad usando HTTP Token Auth, 
 * e incluye el nombre completo del usuario como contacto.
 */
async function createTicket({ title, description, userName, userEmail }) {
  // Desglosar el nombre completo en first/last
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

  const resp = await axios.post(
    `${HELP_DESK_URL.replace(/\/+$/, '')}/tickets`,
    payload,
    {
      headers: {
        Authorization: `Token token=${HELP_DESK_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );

  return resp.data;
}

module.exports = { createTicket };
