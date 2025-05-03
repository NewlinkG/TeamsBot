// api-messages/index.js
const {
  BotFrameworkAdapter,
  ConversationState,
  MemoryStorage
} = require('botbuilder');
const { TeamsBot } = require('../bot');

// 1) Adapter with credentials & error handler
const adapter = new BotFrameworkAdapter({
  appId: process.env.MicrosoftAppId,
  appPassword: process.env.MicrosoftAppPassword
});
adapter.onTurnError = async (context, error) => {
  console.error('💥 onTurnError:', error);
  await context.sendActivity('Lo siento, algo falló.');
};

// 2) State storage setup
const memoryStorage    = new MemoryStorage();
const conversationState = new ConversationState(memoryStorage);

// 3) Bot instance
const bot = new TeamsBot(conversationState);

// 4) Export an async function that awaits processActivity
module.exports = async function (context, req) {
  console.log('🔔 api-messages invoked');
  console.log('📝 HTTP body:', req.body);

  // Await the turn processing
  await adapter.processActivity(req, context.res, async (turnContext) => {
    console.log('▶️ invoking bot.run');
    await bot.run(turnContext);
    console.log('✔️ bot.run completed');

    // Save any state changes
    await conversationState.saveChanges(turnContext);
    console.log('💾 state saved');
  });

  // No return, no context.done() — the function exits once awaited work is done.
};
