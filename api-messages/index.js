// api-messages/index.js
const {
  BotFrameworkAdapter,
  ConversationState,
  MemoryStorage
} = require('botbuilder');
const { TeamsBot } = require('../bot');

// Adapter + error handler
const adapter = new BotFrameworkAdapter({
  appId: process.env.MicrosoftAppId,
  appPassword: process.env.MicrosoftAppPassword
});
adapter.onTurnError = async (context, error) => {
  console.error('💥 onTurnError:', error);
  await context.sendActivity('Lo siento, algo falló.');
};

// State
const memoryStorage    = new MemoryStorage();
const conversationState = new ConversationState(memoryStorage);

// Bot
const bot = new TeamsBot(conversationState);

// **Export a non-async function** 
module.exports = async function (context, req) {
  await adapter.processActivity(context, req, async (turnContext) => {
    await bot.run(turnContext);
    await conversationState.saveChanges(turnContext);
  });
};

