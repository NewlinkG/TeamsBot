// retrievalClient.js
const { Pinecone } = require('@pinecone-database/pinecone');
const { AzureOpenAI } = require('openai');
require('dotenv').config();

// ———————— Pinecone setup ————————
const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY
});
const pineIndex = pinecone.Index(process.env.PINECONE_INDEX_NAME);

// ———————— OpenAI (for embeddings) ————————
const embeddingClient = new AzureOpenAI({
  endpoint:   process.env.AZURE_OPENAI_ENDPOINT,
  apiKey:     process.env.AZURE_OPENAI_KEY,
  apiVersion: process.env.AZURE_OPENAI_API_VERSION,
  deployment: process.env.AZURE_EMBEDDING_DEPLOYMENT_ID
});

/**
 * Retrieve the top-K relevant documents for a given question.
 * Each record’s metadata.sourceTitle & sourceUrl point back to Notion.
 */
async function retrieveContext(question, topK = 5) {
  // 1) embed the question
  const embRes = await embeddingClient.embeddings.create({
    model: process.env.AZURE_EMBEDDING_DEPLOYMENT_ID,
    input: question
  });
  const qVector = embRes.data[0].embedding;

  // 2) query Pinecone namespace 'notion'
  const queryRes = await pineIndex
    .namespace('notion')
    .query({
      vector:      qVector,
      topK,
      includeMetadata: true
    });

  // 3) return array of { text, sourceTitle, sourceUrl }
  return queryRes.matches.map(m => ({
    text:        m.metadata.text || m.metadata.pageId,    // your ingestion uses block text
    sourceTitle: m.metadata.sourceTitle,
    sourceUrl:   m.metadata.sourceUrl,
    mediaUrl:    m.metadata.mediaUrl,
    score:       m.score
  }));
}

module.exports = { retrieveContext };