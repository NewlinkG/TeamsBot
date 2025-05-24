const { MicrosoftAppCredentials, ConnectorClient } = require('botframework-connector');
const { Client } = require('@microsoft/microsoft-graph-client');
require('isomorphic-fetch');

async function getAadObjectId(userEmail, credentials) {
    const graphClient = Client.init({
        authProvider: done => done(null, credentials.appPassword)
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