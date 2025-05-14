// ingest-notion/index.js
console.log('🔧 ingest-notion module loaded');

const { Client: NotionClient }      = require('@notionhq/client');
const { BlobServiceClient }         = require('@azure/storage-blob');
const { ComputerVisionClient }      = require('@azure/cognitiveservices-computervision');
const { ApiKeyCredentials }         = require('@azure/ms-rest-js');
const { PineconeClient }            = require('@pinecone-database/pinecone');
const { OpenAI }                    = require('openai');
const path                          = require('path');
const os                            = require('os');
const fs                            = require('fs/promises');
const fetch                         = require('node-fetch');

module.exports = async function (context, req) {
  context.log('⏱️ ingest-notion (HTTP) triggered at', new Date().toISOString());

  // ———— env vars ————
  const NOTION_TOKEN        = process.env.NOTION_TOKEN;
  const NOTION_SITE_ROOT    = process.env.NOTION_SITE_ROOT;
  const AZURE_STORAGE_CONN  = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const BLOB_CONTAINER      = process.env.BLOB_CONTAINER_NAME || 'notion-assets';
  const CV_ENDPOINT         = process.env.COMPUTER_VISION_ENDPOINT;
  const CV_KEY              = process.env.COMPUTER_VISION_KEY;

  const AZ_OPENAI_ENDPOINT      = process.env.AZURE_OPENAI_ENDPOINT;
  const AZ_OPENAI_API_VERSION   = process.env.AZURE_OPENAI_API_VERSION;
  const AZ_OPENAI_KEY           = process.env.AZURE_OPENAI_KEY;
  const AZ_OPENAI_DEPLOYMENT_ID = process.env.AZURE_OPENAI_DEPLOYMENT_ID;

  const PINECONE_API_KEY    = process.env.PINECONE_API_KEY;
  const PINECONE_INDEX_NAME = process.env.PINECONE_INDEX_NAME;

  try {
    // 0) Validar env vars
    if (!NOTION_TOKEN)        throw new Error('Missing NOTION_TOKEN');
    if (!NOTION_SITE_ROOT)    throw new Error('Missing NOTION_SITE_ROOT');
    if (!AZURE_STORAGE_CONN)  throw new Error('Missing AZURE_STORAGE_CONNECTION_STRING');
    if (!CV_ENDPOINT || !CV_KEY)  
                              throw new Error('Missing COMPUTER_VISION_ENDPOINT or COMPUTER_VISION_KEY');
    if (!AZ_OPENAI_ENDPOINT || !AZ_OPENAI_KEY || !AZ_OPENAI_DEPLOYMENT_ID)
                              throw new Error('Missing one of AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_KEY, or AZURE_OPENAI_DEPLOYMENT_ID');
    if (!PINECONE_API_KEY)    throw new Error('Missing PINECONE_API_KEY');
    if (!PINECONE_INDEX_NAME) throw new Error('Missing PINECONE_INDEX_NAME');

    // 1) Inicializar clientes
    const notion = new NotionClient({ auth: NOTION_TOKEN });

    const blobSvc   = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONN);
    const container = blobSvc.getContainerClient(BLOB_CONTAINER);
    await container.createIfNotExists();
    context.log('✅ Blob container ready:', BLOB_CONTAINER);

    // ← use ApiKeyCredentials for CV
    const cvCreds = new ApiKeyCredentials({
      inHeader: { 'Ocp-Apim-Subscription-Key': CV_KEY }
    });
    const cvClient = new ComputerVisionClient(cvCreds, CV_ENDPOINT);
    context.log('✅ Computer Vision client ready');

    // Azure OpenAI client
    const openai = new OpenAI({
      apiKey: AZ_OPENAI_KEY,
      azure: {
        endpoint:       AZ_OPENAI_ENDPOINT,
        deploymentName: AZ_OPENAI_DEPLOYMENT_ID,
        apiVersion:     AZ_OPENAI_API_VERSION
      }
    });

    const pinecone = new PineconeClient();
    await pinecone.init({ apiKey: PINECONE_API_KEY });
    const pineIndex = pinecone.Index(PINECONE_INDEX_NAME);
    context.log('✅ Pinecone index ready:', PINECONE_INDEX_NAME);

    // … your ingestion logic (walk, OCR, embeddings, upsert) …

    context.log('🏁 ingest-notion complete');
    context.res = { status: 200, body: "Ingestion kicked off." };
    return;
  }
  catch (err) {
    context.log.error('❌ ingest-notion failed:', err.message);
    context.log.error(err.stack);
    context.res = { status: 500, body: err.message };
    return;
  }
};
