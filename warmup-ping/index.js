const axios = require('axios');

module.exports = async function (context, myTimer) {
  const pingUrl = process.env.PING_URL;
  if (!pingUrl) {
    context.log('No PING_URL configured. Skipping ping.');
    return;
  }

  try {
    // Con GET es suficiente para un endpoint que solo responde 200.
    await axios.get(pingUrl);
    context.log(`✅ Keep-alive OK: ${pingUrl}`);
  } catch (error) {
    context.log(`❌ Keep-alive failed: ${error.message}`);
  }
};