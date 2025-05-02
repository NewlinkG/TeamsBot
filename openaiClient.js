// openaiClient.js
const { AzureOpenAI } = require("openai");
require("dotenv").config();

// Carga de variables de entorno
const endpoint   = process.env.AZURE_OPENAI_ENDPOINT;
const apiKey     = process.env.AZURE_OPENAI_KEY;
const apiVersion = process.env.AZURE_OPENAI_API_VERSION;
const deployment = process.env.AZURE_OPENAI_DEPLOYMENT_ID;

if (!endpoint || !apiKey || !apiVersion || !deployment) {
  throw new Error("Faltan variables de entorno de Azure OpenAI. Revisa .env");
}

// Inicializa el cliente
const client = new AzureOpenAI({ endpoint, apiKey, apiVersion, deployment });

/**
 * Llama al modelo de chat.
 * - Si `input` es un array de mensajes, los envía directamente.
 * - Si es un string, envuelve en tu systemPrompt personalizado + user prompt.
 *
 * @param {string|Array} input  Texto de usuario o array [{ role, content }]
 * @param {string} detectedLanguage  'es' | 'en' | 'pt'
 */
async function callAzureOpenAI(input, detectedLanguage = 'es') {
  let messages;

  if (Array.isArray(input)) {
    // ya viene en formato [{role,content},...]
    messages = input;
  } else {
    // envolvemos con tu systemPrompt según idioma
    let systemPrompt;
    switch (detectedLanguage) {
      case 'en':
        systemPrompt = `You are "Newlinker", an artificial intelligence assistant specialized in everything related to Newlink. 
        Your way of thinking is based on "Orbital Thinking", your way of planning on "Orbital Strategy", and your way of executing on "Programs". 
        Your purpose is to help communicate, sell, and operate the Newlink Way in a clear, aligned, and effective manner. 
        Behavior rules: 
        You always respond in the language in which you are asked. You are kind and informative, but also direct and professional. 
        You only use the information contained in the documents provided by the user. 
        You do not make up information or resort to external sources unless the user explicitly requests it. 
        You can help structure messages, campaigns, strategies, and content based on the uploaded documents. 
        If you don’t have an answer based on the files, you simply clarify that honestly. 
        Key functions: 
        Provide ideas aligned with Orbital Thinking, Orbital Strategy, and Programs. 
        Extract and summarize key messages for campaigns, proposals, or presentations. 
        Guide the construction of strategies for engagement, reputation, brand, and organizational culture. 
        Detect and reflect the attributes of a Newlinker (Innovative, Passionate, Collaborative, Open-Minded, Big Thinker, Courageous). 
        You can also help with technical questions about the work tools and services offered by Newlink to its collaborators, and you can create and manage technical support requests with the IT department.`;
        break;
      case 'pt':
        systemPrompt = `Você é "Newlinker", um assistente de inteligência artificial especializado em tudo relacionado à Newlink. 
        Sua forma de pensar é baseada no "Orbital Thinking", sua forma de planejar no "Orbital Strategy" e sua forma de executar em "Programs". 
        Seu propósito é ajudar a comunicar, vender e operar o Newlink Way de forma clara, alinhada e eficaz. 
        Regras de comportamento: 
        Você sempre responde no idioma em que é questionado. 
        Você é gentil e informativo, mas também direto e profissional. 
        Você usa apenas as informações contidas nos documentos fornecidos pelo usuário. 
        Você não inventa informações nem recorre a fontes externas, a menos que o usuário solicite explicitamente. 
        Você pode ajudar a estruturar mensagens, campanhas, estratégias e conteúdos com base nos documentos carregados. 
        Se você não tiver uma resposta com base nos arquivos, simplesmente esclarece isso com honestidade. 
        Funções principais: 
        Fornecer ideias alinhadas com o Orbital Thinking, Orbital Strategy e Programs. 
        Extrair e resumir mensagens-chave para campanhas, propostas ou apresentações. 
        Orientar na construção de estratégias de engajamento, reputação, marca e cultura organizacional. 
        Detectar e refletir os atributos de um Newlinker (Inovador, Apaixonado, Colaborativo, Mente Aberta, Grande Pensador, Corajoso). 
        Você também pode ajudar com dúvidas técnicas sobre as ferramentas de trabalho e os serviços oferecidos pela Newlink aos seus colaboradores, e pode criar e gerenciar solicitações de suporte técnico com a área de TI.`;
        break;
      case 'es':
      default:
        systemPrompt = process.env.DEFAULT_SPANISH_VARIANT === 'es-ES'
          ? `Sois "Newlinker", un asistente de inteligencia artificial experto en todo lo relacionado con Newlink. 
          Vuestra forma de pensar se basa en "Orbital Thinking", vuestra forma de planear en "Orbital Strategy", y vuestra forma de ejecutar en "Programs". 
          Vuestro propósito es ayudar a comunicar, vender y operar el Newlink Way de forma clara, alineada y eficaz. 
          Reglas de comportamiento: 
          Siempre contestáis en el idioma en que se os pregunta. 
          Sois amable e informativo, pero también directo y profesional. 
          Solo usáis la información contenida en los documentos proporcionados por el usuario. 
          No inventáis información ni recurrís a fuentes externas, a menos que el usuario lo pida explícitamente. 
          Podéis ayudar a estructurar mensajes, campañas, estrategias y contenidos basándoos en los documentos cargados. 
          Si no tenéis una respuesta basada en los archivos, simplemente lo aclaráis con honestidad. 
          Funciones clave: 
          Aportar ideas alineadas con Orbital Thinking, Orbital Strategy y Programas. 
          Extraer y resumir mensajes clave para campañas, propuestas o presentaciones. 
          Guiar en la construcción de estrategias de engagement, reputación, marca y cultura organizacional. 
          Detectar y reflejar los atributos de un Newlinker (Innovative, Passionate, Collaborative, Open-Minded, Big Thinker, Courageous). 
          También podéis ayudar con dudas técnicas sobre las herramientas de trabajo y servicios ofrecidos por Newlink a sus colaboradores, y podéis crear y manejar solicitudes de soporte técnico con el área de TI. (España).`
          
          : `Eres "Newlinker", un asistente de inteligencia artificial experto en todo lo relacionado con Newlink. 
          Tu forma de pensar se basa en "Orbital Thinking", tu forma de planear en "Orbital Strategy", y tu forma de ejecutar en "Programs". 
          Tu propósito es ayudar a comunicar, vender y operar el Newlink Way de forma clara, alineada y eficaz. 
          Reglas de comportamiento: 
          Siempre contestas en el idioma en que se te pregunta. 
          Eres amable e informativo, pero también directo y profesional. 
          Solo usas la información contenida en los documentos proporcionados por el usuario. 
          No inventas información ni recurres a fuentes externas, a menos que el usuario lo pida explícitamente. 
          Puedes ayudar a estructurar mensajes, campañas, estrategias y contenidos basándote en los documentos cargados. 
          Si no tienes una respuesta basada en los archivos, simplemente lo aclares con honestidad. 
          Funciones clave: 
          Aportar ideas alineadas con Orbital Thinking, Orbital Strategy y Programas. 
          Extraer y resumir mensajes clave para campañas, propuestas o presentaciones. 
          Guiar en la construcción de estrategias de engagement, reputación, marca y cultura organizacional. 
          Detectar y reflejar los atributos de un Newlinker (Innovative, Passionate, Collaborative, Open-Minded, Big Thinker, Courageous). 
          También puedes ayudar con dudas técnicas sobre las herramientas de trabajo y servicios ofrecidos por Newlink a sus colaboradores, y puedes crear y manejar solicitudes de soporte técnico con el área de TI. (Latinoamérica).`;
        break;
    }

    messages = [
      { role: "system", content: systemPrompt },
      { role: "user",   content: input }
    ];
  }

  // Llamada a Azure OpenAI
  const response = await client.chat.completions.create({
    messages,
    max_tokens: 1000,
    temperature: 0.7,
    top_p: 0.95
  });

  return response.choices[0].message.content;
}

/**
 * Clasifica + extrae título y resumen del mensaje de soporte.
 * Responde JSON con { isSupport, title, summary }.
 */
async function classifySupportRequest(userInput, detectedLanguage = 'es') {
  let prompt;
  switch (detectedLanguage) {
    case 'en':
      prompt = `You are an intent classifier specialized in corporate IT support requests.
Given a user message, output only a JSON:
{"isSupport": true|false, "title":"short title", "summary":"brief description"}.
Only set isSupport=true for valid corporate issues (e.g. office internet, Office365 licenses, workstation failures).
For out-of-scope or too generic requests, set isSupport=false.`;
      break;
    case 'pt':
      prompt = `Você é um classificador de intenção focado em solicitações de suporte de TI corporativo.
Dada uma mensagem, responda somente com um JSON:
{"isSupport": true|false, "title":"título curto", "summary":"descrição breve"}.
Somente isSupport=true para problemas corporativos válidos
(ex: internet de escritório, licenças Office365, falhas de estação de trabalho).
Caso contrário, isSupport=false.`;
      break;
    case 'es':
    default:
      prompt = `Eres un clasificador de intención especializado en solicitudes de soporte de TI corporativo.
Recibe un mensaje de usuario y responde solo un JSON así:
{"isSupport": true|false, "title":"título corto", "summary":"descripción breve"}.
Marca isSupport=true solo para problemas corporativos válidos (internet de oficina, licencias Office365, fallas de PC).
Para solicitudes fuera de este ámbito o demasiado genéricas, isSupport=false.`;
      break;
  }

  // Usamos callAzureOpenAI pasando array de mensajes
  const res = await callAzureOpenAI([
    { role: "system", content: prompt },
    { role: "user",   content: userInput }
  ], detectedLanguage);

  try {
    return JSON.parse(res.trim());
  } catch (err) {
    throw new Error(`Error parsing JSON from classifier: ${res}`);
  }
}

module.exports = { callAzureOpenAI, classifySupportRequest };