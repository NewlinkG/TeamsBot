// api-messages/index.js
const {
  BotFrameworkAdapter,
  ConversationState,
  MemoryStorage
} = require('botbuilder');
const { TeamsBot } = require('../bot');

// 1) Adapter con credenciales y manejo de errores
const adapter = new BotFrameworkAdapter({
  appId: process.env.MicrosoftAppId,
  appPassword: process.env.MicrosoftAppPassword
});
adapter.onTurnError = async (context, error) => {
  console.error('Error en Bot Adapter:', error);
  await context.sendActivity('Lo siento, algo falló.');
};

// 2) Configura MemoryStorage + ConversationState
const memoryStorage = new MemoryStorage();
const conversationState = new ConversationState(memoryStorage);

// 3) Instancia tu bot enviándole conversationState
const bot = new TeamsBot(conversationState);

// 4) Exporta **no** async, sino una función que **retorne** el promise
module.exports = function (context, req) {
  // Regresa aquí la promesa de processActivity en lugar de usar async/await
  return adapter.processActivity(req, context.res, async (turnContext) => {
    await bot.run(turnContext);
    // Guardamos cambios en state justo después de que bot.run termine
    await conversationState.saveChanges(turnContext);
  });
};