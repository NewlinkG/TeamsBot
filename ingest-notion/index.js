// ingest-notion/index.js
console.log('🔧 ingest-notion module loaded');

const { Client: NotionClient }      = require('@notionhq/client');
const { BlobServiceClient }         = require('@azure/storage-blob');
const { ComputerVisionClient }      = require('@azure/cognitiveservices-computervision');
const { ApiKeyCredentials }         = require('@azure/ms-rest-js');
const { Pinecone }                  = require('@pinecone-database/pinecone');
const { AzureOpenAI }               = require('openai');
const path                          = require('path');
const os                            = require('os');
const fs                            = require('fs/promises');
const fetch                         = require('node-fetch');

module.exports = async function (context, req) {
  context.log('⏱️ ingest-notion (HTTP) triggered at', new Date().toISOString());

  // ———— env vars ————
  const NOTION_TOKEN                   = process.env.NOTION_TOKEN;
  const NOTION_SITE_ROOT               = process.env.NOTION_SITE_ROOT;
  const AZURE_STORAGE_CONN             = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const BLOB_CONTAINER                 = process.env.BLOB_CONTAINER_NAME || 'raw-files';
  const CV_ENDPOINT                    = process.env.COMPUTER_VISION_ENDPOINT;
  const CV_KEY                         = process.env.COMPUTER_VISION_KEY;
  const OPENAI_ENDPOINT                = process.env.AZURE_OPENAI_ENDPOINT;
  const OPENAI_API_KEY                 = process.env.AZURE_OPENAI_KEY;
  const OPENAI_API_VERSION             = process.env.AZURE_OPENAI_API_VERSION;
  const OPENAI_EMBEDDING_DEPLOYMENT_ID = process.env.OPENAI_EMBEDDING_DEPLOYMENT_ID;
  const PINECONE_API_KEY               = process.env.PINECONE_API_KEY;
  const PINECONE_INDEX_NAME            = process.env.PINECONE_INDEX_NAME;

  // ———— Validate env vars ————
  for (const [name, val] of Object.entries({
    NOTION_TOKEN,
    NOTION_SITE_ROOT,
    AZURE_STORAGE_CONN,
    CV_ENDPOINT,
    CV_KEY,
    OPENAI_ENDPOINT,
    OPENAI_API_KEY,
    OPENAI_API_VERSION,
    OPENAI_EMBEDDING_DEPLOYMENT_ID,
    PINECONE_API_KEY,
    PINECONE_INDEX_NAME
  })) {
    if (!val) throw new Error(`Missing env var: ${name}`);
  }

  try {
    // 1) Initialize Notion client
    const notion = new NotionClient({ auth: NOTION_TOKEN });

    // 2) Blob storage
    const blobSvc = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONN);
    const container = blobSvc.getContainerClient(BLOB_CONTAINER);
    await container.createIfNotExists();
    context.log('✅ Blob container ready:', BLOB_CONTAINER);

    // 3) Computer Vision client
    const cvCreds = new ApiKeyCredentials({ inHeader: { 'Ocp-Apim-Subscription-Key': CV_KEY }});
    const cvClient = new ComputerVisionClient(cvCreds, CV_ENDPOINT);
    context.log('✅ Computer Vision client ready');

    // 4) Azure OpenAI client for embeddings
    const openai = new AzureOpenAI({
      endpoint:   OPENAI_ENDPOINT,
      apiKey:     OPENAI_API_KEY,
      apiVersion: OPENAI_API_VERSION,
      deployment: OPENAI_EMBEDDING_DEPLOYMENT_ID
    });
    context.log('✅ AzureOpenAI client ready for embeddings:', OPENAI_EMBEDDING_DEPLOYMENT_ID);

    // 5) Pinecone client
    const pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });
    const pineIndex = pinecone.Index(PINECONE_INDEX_NAME);
    context.log('✅ Pinecone index ready:', PINECONE_INDEX_NAME);

    // 6) Crawl Notion recursively
    const seen = new Set();
    const toProcess = [];
    async function walk(nodeId) {
      if (seen.has(nodeId)) return;
      seen.add(nodeId);
      toProcess.push(nodeId);
      let cursor;
      do {
        const resp = await notion.blocks.children.list({ block_id: nodeId, start_cursor: cursor, page_size: 100 });
        for (const block of resp.results) {
          if (block.type === 'child_page') {
            await walk(block.id);
          } else if (block.type === 'child_database') {
            let dbCursor;
            do {
              const qr = await notion.databases.query({ database_id: block.id, start_cursor: dbCursor, page_size: 100 });
              for (const entry of qr.results) {
                await walk(entry.id);
              }
              dbCursor = qr.has_more ? qr.next_cursor : undefined;
            } while (dbCursor);
          }
        }
        cursor = resp.has_more ? resp.next_cursor : undefined;
      } while (cursor);
    }
    await walk(NOTION_SITE_ROOT);
    context.log(`🔍 Pages to process: ${toProcess.length}`);

    // 7) Process pages
    for (const id of toProcess) {
      // a) Change detection
      const metaBlob = container.getBlobClient(`page-${id}.json`);
      const existing = await metaBlob.getProperties().catch(() => undefined);
      const page = await notion.pages.retrieve({ page_id: id });
      const lastEdited = page.last_edited_time;
      if (existing?.metadata?.lastEdited === lastEdited) {
        context.log(`↩️ skipping unchanged ${id}`);
        continue;
      }

      // b) Fetch blocks
      async function fetchBlocks(bid, acc = []) {
        let cur;
        do {
          const lst = await notion.blocks.children.list({ block_id: bid, start_cursor: cur, page_size: 100 });
          for (const b of lst.results) {
            if (['paragraph','heading_1','heading_2'].includes(b.type)) {
              acc.push(b[b.type].rich_text.map(t => t.plain_text).join(''));
            } else if (['image','file'].includes(b.type)) {
              acc.push({ file: b[b.type].file.url });
            }
            if (b.has_children) await fetchBlocks(b.id, acc);
          }
          cur = lst.has_more ? lst.next_cursor : undefined;
        } while (cur);
        return acc;
      }
      const blocks = await fetchBlocks(id);
      let fullText = '';

      // c) Download + OCR
      for (const frag of blocks) {
        if (typeof frag === 'string') {
          fullText += frag + '\n';
        } else {
          const tmp = path.join(os.tmpdir(), path.basename(frag.file));
          const res = await fetch(frag.file);
          const data = Buffer.from(await res.arrayBuffer());
          await fs.writeFile(tmp, data);
          const name = `attachment-${id}-${path.basename(tmp)}`;
          await container.getBlockBlobClient(name).uploadFile(tmp);
          const readOp = await cvClient.readInStream(data);
          const ocrRes = await cvClient.getReadResult(readOp.jobId);
          for (const p of ocrRes.analyzeResult.readResults || []) {
            for (const line of p.lines) fullText += line.text + '\n';
          }
          await fs.unlink(tmp);
        }
      }

      // d) Chunk + embed
      const CHUNK_SIZE = 1000;
      const vectors = [];
      for (let i = 0; i < fullText.length; i += CHUNK_SIZE) {
        const chunk = fullText.slice(i, i + CHUNK_SIZE);
        const embed = await openai.embeddings.create({ model: OPENAI_EMBEDDING_DEPLOYMENT_ID, input: chunk });
        vectors.push({ id: `${id}-${i/CHUNK_SIZE}`, values: embed.data[0].embedding, metadata: { pageId: id } });
      }

      // e) Upsert vectors
      if (vectors.length) {
        await pineIndex.upsert({ vectors });
        context.log(`✅ upserted ${vectors.length} vectors for page ${id}`);
      }

      // f) Save metadata
      const payload = JSON.stringify({ id, lastEdited, text: fullText });
      await container.uploadBlockBlob(`page-${id}.json`, payload, { metadata: { lastEdited } });
    }

    context.log('🏁 ingest-notion complete');
    context.res = { status: 200, body: 'Ingestion kicked off.' };
    return;
  } catch (err) {
    context.log.error('❌ ingest-notion failed:', err.message);
    context.log.error(err.stack);
    context.res = { status: 500, body: err.message };
    return;
  }
};
