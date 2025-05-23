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

async function listTickets(userEmail) {
  const headers = {
    Authorization: `Token token=${HELP_DESK_TOKEN}`,
    'Content-Type': 'application/json',
    From: userEmail
  };

  const url = `${HELP_DESK_URL.replace(/\/+$/, '')}/tickets/search?query=${encodeURIComponent(userEmail)}`;
  const resp = await axios.get(url, { headers });
  return resp.data;
}

const FormData = require('form-data');
const fs = require('fs');
const axiosRaw = require('axios'); // raw axios for form upload (if needed)


async function uploadAttachment(fileUrl, fileName, userEmail, bearerToken = null) {
  const headers = bearerToken
    ? { Authorization: `Bearer ${bearerToken}` }
    : {};

  const fileResp = await axios.get(fileUrl, {
    responseType: 'arraybuffer',
    headers
  });

  const form = new FormData();
  form.append('file', fileResp.data, { filename: fileName });

  const uploadHeaders = {
    Authorization: `Token token=${HELP_DESK_TOKEN}`,
    ...form.getHeaders(),
    From: userEmail
  };

  const resp = await axiosRaw.post(
    `${HELP_DESK_URL.replace(/\/+$/, '')}/upload`,
    form,
    { headers: uploadHeaders }
  );

  return resp.data.token;
}


async function addCommentToTicket(ticketId, comment, userEmail, attachments = []) {
  const headers = {
    Authorization: `Token token=${HELP_DESK_TOKEN}`,
    'Content-Type': 'application/json',
    From: userEmail
  };

  const payload = {
    article: {
      body: comment,
      type: 'note',
      attachments  // array of upload tokens
    }
  };

  const url = `${HELP_DESK_URL.replace(/\/+$/, '')}/tickets/${ticketId}/articles`;
  const resp = await axios.post(url, payload, { headers });
  return resp.data;
}



module.exports = {
  createTicket,
  listTickets,
  addCommentToTicket,
  uploadAttachment
};
