// ticketClient.js
const axios = require('axios');
require('dotenv').config();

const HELP_DESK_URL      = process.env.HELPDESK_API_URL;       // e.g. https://helpdesk.newlink-group.com/api/v1
const HELP_DESK_TOKEN    = process.env.HELP_DESK_TOKEN;        // Your personal access token
const HELP_DESK_GROUP_ID = process.env.HELP_DESK_DEFAULT_GROUP || '1';

if (!HELP_DESK_URL || !HELP_DESK_TOKEN) {
  throw new Error('Missing HELP_DESK_API_URL or HELP_DESK_TOKEN in env vars');
}

/**
 * Crea un ticket en Zammad usando HTTP Token Auth
 * y el formato de payload que ya te funcionaba.
 */
async function createTicket({ title, description, userName, userEmail }) {
  // Divide el nombre completo en nombre + apellidos
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
