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

async function ensureCustomerExists(userEmail, firstName, lastName) {
  const headers = {
    Authorization: `Token token=${HELP_DESK_TOKEN}`,
    'Content-Type': 'application/json'
  };

  const searchUrl = `${HELP_DESK_URL.replace(/\/+$/, '')}/users/search?query=email:${encodeURIComponent(userEmail)}`;
  try {
    const res = await axios.get(searchUrl, { headers });
    if (Array.isArray(res.data) && res.data.length > 0) {
      return res.data[0]; // already exists
    }
  } catch (err) {
    console.warn(`🔍 User lookup failed for ${userEmail}:`, err.message);
  }

  // Auto-create user
  const payload = {
    firstname: firstName,
    lastname: lastName || '—',
    email: userEmail,
    login: userEmail,
    role_ids: [3] // Customer role ID
  };

  try {
    const createRes = await axios.post(`${HELP_DESK_URL.replace(/\/+$/, '')}/users`, payload, { headers });
    console.log(`👤 Created Zammad customer: ${userEmail}`);
    return createRes.data;
  } catch (err) {
    console.error(`❌ User creation failed for ${userEmail}:`, err.response?.data || err.message);
    throw err;
  }
}

async function createTicket({ title, description, userName, userEmail }) {
  const parts = userName.trim().split(/\s+/);
  const firstName = parts.shift();
  const lastName = parts.join(' ');

  // Ensure customer exists
  await ensureCustomerExists(userEmail, firstName, lastName);

  const payload = {
    title,
    group_id: Number(HELP_DESK_GROUP_ID),
    customer: {
      firstname: firstName,
      lastname: lastName,
      login: userEmail,
      email: userEmail
    },
    article: {
      subject: title,
      body: description
    }
  };

  const headers = {
    Authorization: `Token token=${HELP_DESK_TOKEN}`,
    'Content-Type': 'application/json',
    From: userEmail // now safe to impersonate
  };

  const resp = await axios.post(`${HELP_DESK_URL.replace(/\/+$/, '')}/tickets`, payload, { headers });
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
    const userUrl = `${HELP_DESK_URL.replace(/\/+$/, '')}/users/search?query=email:${encodeURIComponent(email)}`;
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
  const baseUrl = `${HELP_DESK_URL.replace(/\/+$/, '')}/tickets/search`;
  const query = openOnly
    ? `customer_id:${customerId} AND (state.name:new OR state.name:open OR state.name:"pending close" OR state.name:"pending reminder")`
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
      const userUrl = `${HELP_DESK_URL.replace(/\/+$/, '')}/users/${ownerId}`;
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


async function getTicketById(ticketId, userEmail) {
  const headers = {
    Authorization: `Token token=${HELP_DESK_TOKEN}`,
    'Content-Type': 'application/json',
    From: userEmail
  };

  const url = `${HELP_DESK_URL.replace(/\/+$/, '')}/tickets/${ticketId}?expand=true`;

  const res = await axios.get(url, { headers });
  return res.data;
}


async function uploadAttachment(file, userEmail) {
  const form = new FormData();
  form.append('file', file.buffer, file.originalname);

  const headers = {
    Authorization: `Token token=${HELP_DESK_TOKEN}`,
    ...form.getHeaders(),
    From: userEmail
  };

  const res = await axios.post(`${HELP_DESK_URL}/uploads`, form, { headers });
  console.log("✅ Upload result:", res.data);
  return res.data[0]?.token;
}


async function addCommentToTicket(ticketId, comment, userEmail, attachmentTokens = []) {
  const headers = {
    Authorization: `Token token=${HELP_DESK_TOKEN}`,
    'Content-Type': 'application/json',
    From: userEmail
  };

  const payload = {
    state: "open",
    article: {
      subject: "Comment from Teams",
      body: comment,
      internal: false,
    }
  };

  if (attachmentTokens.length > 0) {
    payload.article.attachments = attachmentTokens;
  }

  const url = `${HELP_DESK_URL.replace(/\/+$/, '')}/tickets/${ticketId}`;
  //console.log('📎 Tokens:', attachmentTokens);
  //console.log('Posting comment to Zammad:', ticketId, JSON.stringify(payload, null, 2));
  const resp = await axios.put(url, payload, { headers });
  return resp.data;
}


async function closeTicket(ticketId, userEmail, lang = 'es') {
  const headers = {
    Authorization: `Token token=${HELP_DESK_TOKEN}`,
    'Content-Type': 'application/json',
    From: userEmail
  };

  const closeMessages = {
  es: "Este ticket ha sido cerrado por el usuario desde Teams.",
  en: "This ticket has been closed by the user from Teams.",
  pt: "Este chamado foi encerrado pelo usuário via Teams."
};

const localizedBody = closeMessages[lang] || closeMessages['es'];

  const payload = {
  state: "closed",
  article: {
    subject: "Closed from Teams",
    body: localizedBody,
    type: "note",
    internal: false
  }
};


  const url = `${HELP_DESK_URL.replace(/\/+$/, '')}/tickets/${ticketId}`;
  const resp = await axios.put(url, payload, { headers });
  return resp.data;
}



module.exports = {
  createTicket,
  listTickets,
  getTicketById,
  addCommentToTicket,
  uploadAttachment,
  closeTicket
};
