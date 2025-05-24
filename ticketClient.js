// ticketClient.js
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const axiosRaw = require('axios'); // raw axios for form upload (if needed)
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

async function listTickets(email, { openOnly = true } = {}) {
  const headers = {
    Authorization: `Token token=${HELP_DESK_TOKEN}`,
    'Content-Type': 'application/json',
    From: email
  };

  // Step 1: Lookup user ID by email
  let customerId = null;
  try {
    const userUrl = `${HELPDESK_URL.replace(/\/+$/, '')}/users/search?query=email:${encodeURIComponent(email)}`;
    const userRes = await axios.get(userUrl, { headers });
    if (Array.isArray(userRes.data) && userRes.data.length > 0) {
      customerId = userRes.data[0].id;
    } else {
      console.warn(`⚠️ No user found for email: ${email}`);
      return [];
    }
  } catch (err) {
    console.warn(`⚠️ Failed to fetch user ID for ${email}:`, err.message);
    return [];
  }

  // Step 2: Build query using customer_id
  const baseUrl = `${HELPDESK_URL.replace(/\/+$/, '')}/tickets/search`;
  const query = openOnly
    ? `customer_id:${customerId} AND (state.name:new OR state.name:open)`
    : `customer_id:${customerId}`;

  // Step 3: Fetch tickets (with pagination)
  let page = 1;
  let allTickets = [];
  let hasMore = true;

  while (hasMore) {
    const url = `${baseUrl}?query=${encodeURIComponent(query)}&expand=true&page=${page}`;
    const res = await axios.get(url, { headers });
    const batch = Array.isArray(res.data) ? res.data : [];
    allTickets = allTickets.concat(batch);
    hasMore = batch.length > 0;
    page++;
  }

  // Step 4: Fetch owner names (optional)
  const ownerIds = [...new Set(allTickets.map(t => t.owner_id).filter(Boolean))];
  let owners = {};

  for (const ownerId of ownerIds) {
    try {
      const userUrl = `${HELPDESK_URL.replace(/\/+$/, '')}/users/${ownerId}`;
      const userResp = await axios.get(userUrl, { headers });
      const u = userResp.data;
      if (u && u.firstname) {
        owners[ownerId] = {
          firstname: u.firstname,
          lastname: u.lastname
        };
      }
    } catch (err) {
      console.warn(`⚠️ Failed to fetch user ${ownerId}:`, err.message);
    }
  }

  // Step 5: Attach owner data
  for (const t of allTickets) {
    t.owner = owners[t.owner_id] || null;
  }

  // Sort by newest first (optional)
  allTickets.sort((a, b) => b.number - a.number);

  return allTickets;
}


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

async function closeTicket(ticketId, userEmail) {
  const headers = {
    Authorization: `Token token=${HELP_DESK_TOKEN}`,
    'Content-Type': 'application/json',
    From: userEmail
  };

  const payload = {
    state_id: 4 // Adjust depending on your Zammad state mapping
  };

  const url = `${HELP_DESK_URL.replace(/\/+$/, '')}/tickets/${ticketId}`;
  const resp = await axios.put(url, payload, { headers });
  return resp.data;
}


module.exports = {
  createTicket,
  listTickets,
  addCommentToTicket,
  uploadAttachment,
  closeTicket
};
