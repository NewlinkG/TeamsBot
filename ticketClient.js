// ticketClient.js
const axios = require('axios');
require('dotenv').config();

const HELP_DESK_URL      = process.env.HELPDESK_API_URL;      // e.g. https://helpdesk.newlink-group.com/api/v1
const HELP_DESK_TOKEN    = process.env.HELPDESK_TOKEN;        // your Personal Access Token
const HELP_DESK_GROUP_ID = process.env.HELPDESK_DEFAULT_GROUP || '1';

if (!HELP_DESK_URL || !HELP_DESK_TOKEN) {
  throw new Error(
    'Falta configurar HELPDESK_API_URL y HELPDESK_TOKEN en las variables de entorno'
  );
}

// Creamos una instancia de Axios con timeout y headers por defecto
const http = axios.create({
  baseURL: HELP_DESK_URL.replace(/\/+$/, ''),
  timeout: 5000,
  headers: {
    Authorization: `Token token=${HELP_DESK_TOKEN}`,
    'Content-Type': 'application/json'
  }
});

/**
 * Crea un ticket en Zammad simulando un email entrante del cliente,
 * con reintentos automáticos en caso de errores de red o 5xx.
 *
 * @param {object} opts
 * @param {string} opts.title       Asunto del ticket
 * @param {string} opts.description Cuerpo del ticket
 * @param {string} opts.userName    Nombre completo del usuario de Teams
 * @param {string} opts.userEmail   Email del usuario de Teams
 * @returns {Promise<object>}       El objeto ticket creado por Zammad
 */
async function createTicket({ title, description, userName, userEmail }) {
  // Validaciones básicas
  if (!title || !description) {
    throw new Error('Título y descripción son obligatorios para crear el ticket.');
  }
  if (title.length > 200) {
    throw new Error('El título no puede exceder 200 caracteres.');
  }
  if (description.length > 5000) {
    throw new Error('La descripción no puede exceder 5000 caracteres.');
  }

  // Desglosar el nombre completo en firstname/lastname
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
      type:         'email',        // interpretado como email entrante
      //sender:       'Customer',     // origen = cliente
      internal:     false,
      content_type: 'text/plain'
    }
  };

  const maxRetries = 2;
  const baseDelay  = 500; // ms

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await http.post('/tickets', payload);
      return resp.data;
    } catch (err) {
      const status = err.response ? err.response.status : null;
      const retryable =
        // Red de Axios (timeout, DNS, etc.) o errores 5xx
        (!err.response) || (status >= 500 && status < 600);

      if (!retryable || attempt === maxRetries) {
        // No más reintentos, propagamos el error
        throw new Error('No se pudo crear el ticket. Por favor intenta más tarde.');
      }

      // Espera exponencial antes del siguiente intento
      const delay = baseDelay * Math.pow(2, attempt);
      await new Promise(res => setTimeout(res, delay));
    }
  }
}

module.exports = { createTicket };