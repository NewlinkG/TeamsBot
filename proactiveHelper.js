const { MicrosoftAppCredentials, ConnectorClient } = require('botframework-connector');
const { Client } = require('@microsoft/microsoft-graph-client');
const msal = require('@azure/msal-node');
require('isomorphic-fetch');

const msal = require('@azure/msal-node');

async function getAccessToken() {
  const msalConfig = {
    auth: {
      clientId: process.env.MicrosoftAppId,
      authority: `https://login.microsoftonline.com/${process.env.TenantId}`,
      clientSecret: process.env.MicrosoftAppPassword,
    }
  };

  const cca = new msal.ConfidentialClientApplication(msalConfig);

  const result = await cca.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default'],
  });

  return result.accessToken;
}

async function getAadObjectId(userEmail) {
  const token = await getAccessToken();

  const graphClient = Client.init({
    authProvider: done => done(null, token)
  });

  const result = await graphClient
    .api(`/users?$filter=mail eq '${userEmail}'`)
    .select('id')
    .get();

  if (!result.value?.[0]?.id) {
    throw new Error(`AAD ID not found for ${userEmail}`);
  }

  return result.value[0].id;
}

async function sendProactiveTeamsMessage(userEmail, messageText) {
  const appId = process.env.MicrosoftAppId;
  const appPassword = process.env.MicrosoftAppPassword;
  const tenantId = process.env.TenantId;

  const credentials = new MicrosoftAppCredentials(appId, appPassword);
  const connector = new ConnectorClient(credentials, { baseUri: 'https://smba.trafficmanager.net/amer/' });

  const aadId = await getAadObjectId(userEmail, credentials);
  const userId = `8:orgid:${aadId}`;

  const conversation = await connector.conversations.createConversation({
    isGroup: false,
    bot: { id: appId, name: 'OrbIT' },
    members: [{ id: userId }],
    channelData: { tenant: { id: tenantId } }
  });

  const activity = {
    type: 'message',
    from: { id: appId },
    recipient: { id: userId },
    text: messageText,
    channelData: { tenant: { id: tenantId } }
  };

  return await connector.conversations.sendToConversation(conversation.id, activity);
}

module.exports = { sendProactiveTeamsMessage };