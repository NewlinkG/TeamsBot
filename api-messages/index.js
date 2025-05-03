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

// **Export a non-async function** and call context.done() once work is complete
module.exports = function (context, req) {
  // console.log('🔔 api-messages invoked');
  // console.log('📝 HTTP body:', req.body);

  adapter.processActivity(req, context.res, async (turnContext) => {
    // console.log('▶️ invoking bot.run');
    await bot.run(turnContext);
    // console.log('✔️ bot.run completed');

    await conversationState.saveChanges(turnContext);
    // console.log('💾 state saved');

    // Tell Azure Functions we’re done
    context.done();
  });
};
