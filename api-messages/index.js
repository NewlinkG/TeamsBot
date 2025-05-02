// api-messages/index.js
const {
  BotFrameworkAdapter,
  ConversationState,
  MemoryStorage
} = require('botbuilder');
const { TeamsBot } = require('../bot');

const adapter = new BotFrameworkAdapter({
  appId: process.env.MicrosoftAppId,
  appPassword: process.env.MicrosoftAppPassword
});

adapter.onTurnError = async (context, error) => {
  console.error('💥 onTurnError:', error);
  await context.sendActivity('Lo siento, algo falló.');
};

const memoryStorage     = new MemoryStorage();
const conversationState = new ConversationState(memoryStorage);
const bot               = new TeamsBot(conversationState);

module.exports = function (context, req) {
  console.log('🔔 api-messages invoked');
  console.log('📝 HTTP body:', req.body);

  // Return the adapter promise and let onTurnError handle any errors
  return adapter.processActivity(req, context.res, async (turnContext) => {
    console.log('▶️ invoking bot.run');
    await bot.run(turnContext);
    console.log('✔️ bot.run completed');
    await conversationState.saveChanges(turnContext);
    console.log('💾 state saved');
  });
};
