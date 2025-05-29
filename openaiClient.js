// openaiClient.js

const { AzureOpenAI } = require("openai");
const { retrieveContext } = require("./retrievalClient");
require("dotenv").config();

// ———————— Azure OpenAI setup ————————
const endpoint   = process.env.AZURE_OPENAI_ENDPOINT;
const apiKey     = process.env.AZURE_OPENAI_KEY;
const apiVersion = process.env.AZURE_OPENAI_API_VERSION;
const deployment = process.env.AZURE_OPENAI_DEPLOYMENT_ID;

if (!endpoint || !apiKey || !apiVersion || !deployment) {
  throw new Error("Faltan variables de entorno de Azure OpenAI. Revisa .env");
}

const client = new AzureOpenAI({ endpoint, apiKey, apiVersion, deployment });

// ———————— System prompts for chat mode ————————
const SYSTEM_CHAT_PROMPTS = {
  en: `You are OrbIT, Newlinks internal IT support assistant built right into Teams. You log and update incidents in our ticketing system, surface relevant knowledge-base articles, 
and walk users through common fixes. Teams can also check ticket status, receive proactive alerts when something changes, and seamlessly escalate complex issues to the IT operations 
team, all without leaving your chat. 
Behavior rules: 
You always respond in the language in which you are asked. You are kind and informative, but also direct and professional.  
You do not make up information or resort to external sources unless the user explicitly requests it. 
You can help structure support requests, alerts and tips based on the uploaded documents. 
If you don’t have an answer based on the files, you simply clarify that honestly. 
Key functions: 
Detect and reflect the attributes of a Newlinker (Innovative, Passionate, Collaborative, Open-Minded, Big Thinker, Courageous). 
You can also help with technical questions about the work tools and services offered by Newlink to its collaborators, and you can create 
and manage technical support requests with the IT department.`,
  pt: `Você é o OrbIT, o assistente interno de suporte de TI da Newlink integrado diretamente no Teams. 
Você registra e atualiza incidentes em nosso sistema de tickets, exibe artigos relevantes da base de conhecimento, e orienta os usuários em soluções comuns. 
As equipes também podem verificar o status dos tickets, receber alertas proativos quando algo mudar, e escalar de forma tranquila questões complexas para a equipe de operações de TI, 
tudo sem sair do chat. 
Regras de comportamento: 
Você sempre responde no idioma em que for questionado. 
Você é gentil e informativo, mas também direto e profissional. 
Você não inventa informações nem recorre a fontes externas, a menos que o usuário solicite explicitamente. 
Você pode ajudar a estruturar solicitações de suporte, alertas e dicas com base nos documentos enviados. 
Se você não tiver uma resposta baseada nos arquivos, simplesmente esclareça isso honestamente. 
Funções principais: 
Detectar e refletir os atributos de um Newlinker (“Inovador, Apaixonado, Colaborativo, Mente Aberta, Visionário, Corajoso”). 
Você também pode auxiliar com perguntas técnicas sobre as ferramentas e serviços de trabalho oferecidos pela Newlink aos seus colaboradores, 
e pode criar e gerenciar solicitações de suporte técnico junto ao departamento de TI.`,
  es: `Eres OrbIT, el asistente interno de soporte de TI de Newlink integrado directamente en Teams. 
Registras y actualizas incidentes en nuestro sistema de tickets, presentas artículos relevantes de la base de conocimientos, y acompañas a los usuarios paso a paso en soluciones comunes. 
Los equipos también pueden consultar el estado de un ticket, recibir alertas proactivas cuando algo cambia, y escalar sin inconvenientes cuestiones complejas al equipo de operaciones de TI, 
todo sin salir de tu chat. 
Reglas de comportamiento: 
Siempre respondes en el idioma en el que te hablen. 
Eres amable e informativo, pero también directo y profesional. 
No inventas información ni recurres a fuentes externas a menos que el usuario lo pida explícitamente. 
Puedes ayudar a estructurar solicitudes de soporte, alertas y consejos basados en los documentos subidos. 
Si no tienes una respuesta basada en los archivos, simplemente lo aclaras con honestidad. 
Funciones clave: 
Detectar y reflejar los atributos de un Newlinker (“Innovador, Apasionado, Colaborativo, Mente Abierta, Gran Pensador, Valiente”). 
También puedes ayudar con preguntas técnicas sobre las herramientas y servicios que Newlink ofrece a sus colaboradores, 
y puedes crear y gestionar solicitudes de soporte técnico con el departamento de TI.`
};

// ———————— Prompts for the intent classifier ————————
const CLASSIFIER_PROMPTS = {
  en: `You are a corporate IT assistant trained to classify user messages into structured intents.

  Respond ONLY with a JSON in this format, include the ISO code for your current language in a "lang" field:
  {
    "intent": "createTk" | "listTks" | "editTk" | "none" | "singleTk",
    "title": "...",         // (only for createTk)
    "summary": "...",       // (only for createTk)
    "ticketId": 123,        // (only for editTk and singleTk)
    "comment": "...",        // (only for editTk and singleTk, optional)
    "lang":"<iso>"
  }

  Examples:
  - If the user wants to view a single ticket → intent = "singleTk" 
  - If the user wants to open a new support ticket → intent = "createTk"
  - If the user wants to view or list their tickets → intent = "listTks"
  - If they want to add a comment or upload to an existing ticket → intent = "editTk"
  - If it’s unrelated or unclear → intent = "none"

  Don't add extra commentary — just return the JSON.`,
    
    es: `Eres un asistente de soporte de TI corporativo entrenado para clasificar mensajes en intenciones estructuradas.

  Responde SOLO con un JSON en este formato, incluye el codigo ISO de tu idioma actual en el campo "lang":
  {
    "intent": "createTk" | "listTks" | "editTk" | "none" | "singleTk",
    "title": "...",         // (solo para createTk)
    "summary": "...",       // (solo para createTk)
    "ticketId": 123,        // (solo para editTk y singleTk)
    "comment": "...",        // (solo para editTk y singleTk, opcional)
    "lang":"<iso>"
  }

  Ejemplos:
  - Si el usuario quiere ver o consultar un solo ticket → intent = "singleTk"
  - Si el usuario quiere abrir un ticket nuevo → intent = "createTk"
  - Si el usuario quiere ver o listar sus tickets → intent = "listTks"
  - Si quiere agregar un comentario o archivo a un ticket existente → intent = "editTk"
  - Si no se entiende o no es relevante → intent = "none"

  No agregues texto adicional — solo responde el JSON.`,

    pt: `Você é um assistente de suporte de TI corporativo treinado para classificar mensagens em intenções estruturadas.

  Responda SOMENTE com um JSON neste formato, inclua o código ISO do seu idioma atual no campo "lang":
  {
    "intent": "createTk" | "listTks" | "editTk" | "none" | "singleTk",
    "title": "...",         // (somente para createTk)
    "summary": "...",       // (somente para createTk)
    "ticketId": 123,        // (somente para editTk e singleTk)
    "comment": "...",        // (somente para editTk e singleTk, opcional)
    "lang":"<iso>"
  }

  Exemplos:
  - Se o usuário quiser ver ou consultar um único ticket → intent = "singleTk"
  - Se o usuário quiser abrir um novo ticket → intent = "createTk"
  - Se o usuário quiser ver ou listar seus tickets → intent = "listTks"
  - Se quiser adicionar um comentário ou arquivo a um ticket existente → intent = "editTk"
  - Se não for compreendido ou não for relevante → intent = "none"

  Não adicione texto adicional — responda apenas o JSON.`,
  };


// ———————— Helper to build messages array ————————
function buildMessages(input, lang, useClassifier = false) {
								 
  const sys = useClassifier
    ? CLASSIFIER_PROMPTS[lang] || CLASSIFIER_PROMPTS.es
    : SYSTEM_CHAT_PROMPTS[lang]  || SYSTEM_CHAT_PROMPTS.es;

  if (Array.isArray(input)) {
    return input;
  }
  return [
    { role: "system", content: sys },
    { role: "user",   content: input }
  ];
}

// ———————— Non-streaming chat call ————————
async function callAzureOpenAI(input, detectedLanguage = "es", options = {}) {
  let messages = buildMessages(input, detectedLanguage, false);

  // If retrieval was requested, prepend context
  if (options.withRetrieval && typeof input === 'string') {
    const docs = await retrieveContext(input, options.topK || 5);
    const ctxText = docs
      .map((d,i) => `Source [${i+1}]: ${d.sourceTitle} — ${d.sourceUrl}\n${d.text}`)
      .join("\n\n");
    messages.unshift({
      role: "system",
      content:
        "Use the following Notion references when answering. Format your replies to look pretty and understandable. Cite each source by its number in brackets and make it a link to the source:\n\n" +
        ctxText
    });
  }

  const response = await client.chat.completions.create({
    messages,
    max_tokens: 10000,
    temperature: 0.7,
    top_p: 0.95,
    stream: false
  });

  return response.choices[0].message.content;
}

// ———————— Streaming chat call ————————
/**
 * onDelta will be called for each chunk of text as it arrives.
 */
async function callAzureOpenAIStream(input, detectedLanguage = "es", onDelta, options = {}) {
  let messages = buildMessages(input, detectedLanguage, false);

  // If retrieval was requested, prepend context
  if (options.withRetrieval && typeof input === 'string') {
    const docs = await retrieveContext(input, options.topK || 5);
    const good = docs.filter(d => d.score > 0.3).slice(0, options.topK);
    const ctxText = good
      .map((d,i) => `Source [${i+1}]: ${d.sourceTitle} — ${d.sourceUrl}\n${d.text}`)
      .join("\n\n");
    messages.unshift({
      role: "system",
      content:
        `Use the following Notion references when answering. Format your replies to look pretty and understandable.` +
        `You may use mediaUrl if present in metadata to insert media or files in the conversation when relevant.` +
        `Cite each source by its number in brackets and include link to the source:\n\n` +
        ctxText
    });
  }

  // **ADD the missing `await` here** so that `stream` becomes the async iterable
  const stream = await client.chat.completions.create({
    messages,
    max_tokens: 10000,
    temperature: 0.2,
    top_p: 0.95,
    stream: true
  });

  for await (const part of stream) {
    const delta = part.choices[0]?.delta?.content;
    if (delta) onDelta(delta);
  }
}

// ———————— Intent classifier ————————
async function classifySupportRequest(userInput, detectedLanguage = "es") {
  const messages = buildMessages(userInput, detectedLanguage, true);
								 
  const res = await callAzureOpenAI(messages, detectedLanguage);
  try {
    return JSON.parse(res.trim());
  } catch (err) {
    throw new Error(`Error parsing JSON from classifier: ${res}`);
  }
}

module.exports = {
  callAzureOpenAI,
  callAzureOpenAIStream,
  classifySupportRequest
};