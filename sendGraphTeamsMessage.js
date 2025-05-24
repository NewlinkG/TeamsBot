const msal = require('@azure/msal-node');
const { Client } = require('@microsoft/microsoft-graph-client');
require('isomorphic-fetch');

async function getAccessToken() {
  const cca = new msal.ConfidentialClientApplication({
    auth: {
      clientId: process.env.MicrosoftAppId,
      authority: `https://login.microsoftonline.com/${process.env.TenantId}`,
      clientSecret: process.env.MicrosoftAppPassword,
    }
  });

  const result = await cca.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default']
  });

  return result.accessToken;
}

async function sendGraphTeamsMessage(userEmail, messageText) {
  const token = await getAccessToken();

  const graphClient = Client.init({
    authProvider: done => done(null, token)
  });

  // Step 1: Get the user’s AAD ID
  const userResult = await graphClient
    .api(`/users?$filter=mail eq '${userEmail}'`)
    .select('id')
    .get();

  if (!userResult.value?.[0]?.id) {
    throw new Error(`AAD user not found for email: ${userEmail}`);
  }

  const aadId = userResult.value[0].id;

  // Step 2: Create a 1:1 chat (or get if it exists)
  const chat = await graphClient.api('/chats').post({
    chatType: 'oneOnOne',
    members: [
      {
        '@odata.type': '#microsoft.graph.aadUserConversationMember',
        roles: ['owner'],
        'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${aadId}')`
      }
    ]
  });

  // Step 3: Send the message
  await graphClient
    .api(`/chats/${chat.id}/messages`)
    .post({
      body: {
        contentType: 'html',
        content: messageText
      }
    });

  console.log(`✅ Message sent to ${userEmail}`);
}

module.exports = { sendGraphTeamsMessage };