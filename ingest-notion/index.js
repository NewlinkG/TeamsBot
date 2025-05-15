// ingest-notion/index.js
console.log('🔧 ingest-notion module loaded');

const { Client: NotionClient }      = require('@notionhq/client');
const { BlobServiceClient }         = require('@azure/storage-blob');
const { ComputerVisionClient }      = require('@azure/cognitiveservices-computervision');
const { ApiKeyCredentials }         = require('@azure/ms-rest-js');
const { PineconeClient }            = require('@pinecone-database/pinecone');
const { AzureOpenAI }               = require('openai');
const path                          = require('path');
const os                            = require('os');
const fs                            = require('fs/promises');
const fetch                         = require('node-fetch');

module.exports = async function (context, req) {
  context.log('⏱️ ingest-notion triggered at', new Date().toISOString());

  try {
    // ———— Validate env vars ————
    const env = {
      NOTION_TOKEN:                   process.env.NOTION_TOKEN,
      NOTION_SITE_ROOT:               process.env.NOTION_SITE_ROOT,
      AZURE_STORAGE_CONN:             process.env.AZURE_STORAGE_CONNECTION_STRING,
      CV_ENDPOINT:                    process.env.COMPUTER_VISION_ENDPOINT,
      CV_KEY:                         process.env.COMPUTER_VISION_KEY,
      OPENAI_ENDPOINT:                process.env.AZURE_OPENAI_ENDPOINT,
      OPENAI_API_KEY:                 process.env.AZURE_OPENAI_KEY,
      OPENAI_API_VERSION:             process.env.AZURE_OPENAI_API_VERSION,
      OPENAI_EMBEDDING_DEPLOYMENT_ID: process.env.OPENAI_EMBEDDING_DEPLOYMENT_ID,
      PINECONE_API_KEY:               process.env.PINECONE_API_KEY,
      PINECONE_INDEX_NAME:            process.env.PINECONE_INDEX_NAME,
    };
    for (const [key, val] of Object.entries(env)) {
      if (!val) throw new Error(`Missing env var: ${key}`);
    }

    // 1) Notion client
    const notion = new NotionClient({ auth: env.NOTION_TOKEN });

    // 2) Blob storage
    const blobSvc   = BlobServiceClient.fromConnectionString(env.AZURE_STORAGE_CONN);
    const container = blobSvc.getContainerClient(process.env.BLOB_CONTAINER_NAME || 'raw-files');
    await container.createIfNotExists();
    context.log('✅ Blob container ready');

    // 3) Computer Vision client
    const cvCreds  = new ApiKeyCredentials({ inHeader: { 'Ocp-Apim-Subscription-Key': env.CV_KEY } });
    const cvClient = new ComputerVisionClient(cvCreds, env.CV_ENDPOINT);
    context.log('✅ Computer Vision client ready');

    // 4) Azure OpenAI client for embeddings
    const openai = new AzureOpenAI({
      endpoint:   env.OPENAI_ENDPOINT,
      apiKey:     env.OPENAI_API_KEY,
      apiVersion: env.OPENAI_API_VERSION,
      deployment: env.OPENAI_EMBEDDING_DEPLOYMENT_ID
    });
    context.log('✅ AzureOpenAI (embeddings) ready');

    // 5) Pinecone client (no environment needed)
    const pinecone = new PineconeClient();
    await pinecone.init({ apiKey: env.PINECONE_API_KEY });
    const pineIndex = pinecone.Index(env.PINECONE_INDEX_NAME);
    context.log('✅ Pinecone index ready');

    // 6) Collect Notion pages
    const seen = new Set();
    const toProcess = [];
    async function walk(id) {
      if (seen.has(id)) return;
      seen.add(id);
      toProcess.push(id);
      let cursor;
      do {
        const resp = await notion.blocks.children.list({ block_id: id, start_cursor: cursor, page_size: 100 });
        for (const b of resp.results) {
          if (b.type === 'child_page') await walk(b.id);
          else if (b.type === 'child_database') {
            let dbCur;
            do {
              const qr = await notion.databases.query({ database_id: b.id, start_cursor: dbCur, page_size: 100 });
              for (const e of qr.results) await walk(e.id);
              dbCur = qr.has_more ? qr.next_cursor : undefined;
            } while (dbCur);
          }
        }
        cursor = resp.has_more ? resp.next_cursor : undefined;
      } while (cursor);
    }
    await walk(env.NOTION_SITE_ROOT);
    context.log(`🔍 Will process ${toProcess.length} pages`);

    // 7) Process pages
    for (const pageId of toProcess) {
      // change detection
      const meta = container.getBlobClient(`page-${pageId}.json`);
      const props = await meta.getProperties().catch(() => undefined);
      const page = await notion.pages.retrieve({ page_id: pageId });
      if (props?.metadata?.lastEdited === page.last_edited_time) continue;

      // fetch content
      async function fetchBlocks(id, acc = []) {
        let cur;
        do {
          const res = await notion.blocks.children.list({ block_id: id, start_cursor: cur, page_size: 100 });
          for (const b of res.results) {
            if (['paragraph','heading_1','heading_2'].includes(b.type)) acc.push(b[b.type].rich_text.map(t => t.plain_text).join(''));
            else if (['image','file'].includes(b.type)) acc.push({ url: b[b.type].file.url });
            if (b.has_children) await fetchBlocks(b.id, acc);
          }
          cur = res.has_more ? res.next_cursor : undefined;
        } while (cur);
        return acc;
      }
      const blocks = await fetchBlocks(pageId);
      let text = '';
      for (const blk of blocks) {
        if (typeof blk === 'string') text += blk + '\n';
        else {
          const tmp = path.join(os.tmpdir(), path.basename(blk.url));
          const r = await fetch(blk.url);
          const data = Buffer.from(await r.arrayBuffer());
          await fs.writeFile(tmp, data);
          await container.getBlockBlobClient(`att-${pageId}-${path.basename(tmp)}`).uploadFile(tmp);
          const read = await cvClient.readInStream(data);
          const ocr = await cvClient.getReadResult(read.jobId);
          for (const pr of ocr.analyzeResult.readResults || []) for (const ln of pr.lines) text += ln.text + '\n';
          await fs.unlink(tmp);
        }
      }

      // chunk & embed
      const CHUNK = 1000;
      const vectors = [];
      for (let i = 0; i < text.length; i += CHUNK) {
        const chunk = text.slice(i, i + CHUNK);
        const resp = await openai.embeddings.create({ model: env.OPENAI_EMBEDDING_DEPLOYMENT_ID, input: chunk });
        vectors.push({ id: `${pageId}-${i}`, values: resp.data[0].embedding, metadata: { pageId }});
      }

      // upsert
      if (vectors.length) {
        await pineIndex.upsert({ vectors });
        context.log(`✅ upserted ${vectors.length} for ${pageId}`);
      }

      // save metadata
      const body = JSON.stringify({ lastEdited: page.last_edited_time });
      await container.uploadBlockBlob(`page-${pageId}.json`, body, { metadata: { lastEdited: page.last_edited_time }});
    }

    context.log('🏁 ingest-notion complete');
    context.res = { status: 200, body: 'Ingestion kicked off.' };
  } catch (err) {
    context.log.error('❌ ingest-notion failed:', err.message);
    context.log.error(err.stack);
    context.res = { status: 500, body: err.message };
  }
};
