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
  context.log('⏱️ ingest-notion triggered at', new Date().toISOString());

  try {
    // ———— Validate env vars ————
    const E = key => {
      const v = process.env[key];
      if (!v) throw new Error(`Missing env var: ${key}`);
      return v;
    };
    const NOTION_TOKEN        = E('NOTION_TOKEN');
    const NOTION_SITE_ROOT    = E('NOTION_SITE_ROOT');
    const AZURE_STORAGE_CONN  = E('AZURE_STORAGE_CONNECTION_STRING');
    const CV_ENDPOINT         = E('COMPUTER_VISION_ENDPOINT');
    const CV_KEY              = E('COMPUTER_VISION_KEY');
    const OPENAI_ENDPOINT     = E('AZURE_OPENAI_ENDPOINT');
    const OPENAI_API_KEY      = E('AZURE_OPENAI_KEY');
    const OPENAI_API_VERSION  = E('AZURE_OPENAI_API_VERSION');
    const OPENAI_EMBED_MODEL  = E('OPENAI_EMBEDDING_DEPLOYMENT_ID');
    const PINECONE_API_KEY    = E('PINECONE_API_KEY');
    const PINECONE_INDEX_NAME = E('PINECONE_INDEX_NAME');
    const BLOB_CONTAINER      = process.env.BLOB_CONTAINER_NAME || 'raw-files';

    // 1) Notion client
    const notion = new NotionClient({ auth: NOTION_TOKEN });

    // 2) Blob storage
    const blobSvc   = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONN);
    const container = blobSvc.getContainerClient(BLOB_CONTAINER);
    await container.createIfNotExists();
    context.log('✅ Blob container ready');

    // 3) Computer Vision client
    const cvCreds  = new ApiKeyCredentials({ inHeader: { 'Ocp-Apim-Subscription-Key': CV_KEY }});
    const cvClient = new ComputerVisionClient(cvCreds, CV_ENDPOINT);
    context.log('✅ Computer Vision client ready');

    // 4) Azure OpenAI client (embeddings)
    const openai = new AzureOpenAI({
      endpoint:   OPENAI_ENDPOINT,
      apiKey:     OPENAI_API_KEY,
      apiVersion: OPENAI_API_VERSION,
      deployment: OPENAI_EMBED_MODEL
    });
    context.log('✅ AzureOpenAI (embeddings) ready');

    // 5) Pinecone client (v6)
    const pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });
    const pineIndex = pinecone.Index(PINECONE_INDEX_NAME);
    context.log('✅ Pinecone index ready');

    // 6) Gather Notion pages
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
    await walk(NOTION_SITE_ROOT);
    context.log(`🔍 Pages to process: ${toProcess.length}`);
    context.log(`To process: ${toProcess}`);

    // 7) Process pages: fetch, OCR, embed, upsert
    for (const pid of toProcess) {
      // change detection
      const blobClient = container.getBlobClient(`page-${pid}.json`);
      const props      = await blobClient.getProperties().catch(() => undefined);
      const pageMeta   = await notion.pages.retrieve({ page_id: pid });
      if (props?.metadata?.lastEdited === pageMeta.last_edited_time) {
        context.log(`↩️ skipping unchanged ${pid}`);
        continue;
      }

      // fetch content blocks
      async function fetchBlocks(id, acc = []) {
        let cursor;
        do {
          const resp = await notion.blocks.children.list({ block_id: id, start_cursor: cursor, page_size: 100 });
          for (const b of resp.results) {
            if (['paragraph','heading_1','heading_2'].includes(b.type)) {
              acc.push(b[b.type].rich_text.map(t=>t.plain_text).join(''));
            } else if (['image','file'].includes(b.type)) {
              acc.push({ url: b[b.type].file.url });
            }
            if (b.has_children) await fetchBlocks(b.id, acc);
          }
          cursor = resp.has_more ? resp.next_cursor : undefined;
        } while (cursor);
        return acc;
      }
      const blocks = await fetchBlocks(pid);

      // assemble text + OCR, strip query from URL filename
      let fullText = '';
      for (const blk of blocks) {
        if (typeof blk === 'string') {
          fullText += blk + '\n';
        } else {
          const fileUrl  = new URL(blk.url);
          const filename = path.basename(fileUrl.pathname);
          const tmpPath  = path.join(os.tmpdir(), filename);

          const res = await fetch(blk.url);
          const arrayBuf = await res.arrayBuffer();
          const buf = Buffer.from(arrayBuf);
          await fsp.writeFile(tmpPath, buf);

          await container.getBlockBlobClient(`att-${pid}-${filename}`).uploadFile(tmpPath);

          // use a stream for OCR so jobId is set
          const stream = Readable.from(buf);
          const readOp = await cvClient.readInStream(stream);
          const ocrRes = await cvClient.getReadResult(readOp.jobId);
          for (const pr of ocrRes.analyzeResult.readResults||[]) {
            for (const ln of pr.lines) fullText += ln.text + '\n';
          }
          await fsp.unlink(tmpPath);
        }
      }

      context.log(fullText);

      // chunk & embed
      const CHUNK = 1000;
      const records = [];
      for (let i = 0; i < fullText.length; i += CHUNK) {
        const slice  = fullText.slice(i, i + CHUNK);
        const emb    = await openai.embeddings.create({ model: OPENAI_EMBED_MODEL, input: slice });
        records.push({ id: `${pid}-${i}`, values: emb.data[0].embedding, metadata: { pageId: pid } });
      }

      // upsert into Pinecone
      if (records.length) {
        await pineIndex.upsert(records);
        context.log(`✅ upserted ${records.length} vectors for ${pid}`);
      }

      // save metadata blob
      const metaData = JSON.stringify({ lastEdited: pageMeta.last_edited_time });
      const metaBuf  = Buffer.from(metaData, 'utf8');
      await container.getBlockBlobClient(`page-${pid}.json`)
        .uploadData(metaBuf, { metadata: { lastEdited: pageMeta.last_edited_time } });
    }

    context.log('🏁 ingest-notion complete');
    context.res = { status: 200, body: 'Ingestion kicked off.' };
  } catch (err) {
    context.log.error('❌ ingest-notion failed:', err.message);
    context.log.error(err.stack);
    context.res = { status: 500, body: err.message };
  }
};
