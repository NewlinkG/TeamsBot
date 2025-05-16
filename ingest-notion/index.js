console.log('🔧 ingest-notion module loaded');

const { Client: NotionClient }      = require('@notionhq/client');
const { BlobServiceClient }         = require('@azure/storage-blob');
const { ComputerVisionClient }      = require('@azure/cognitiveservices-computervision');
const { ApiKeyCredentials, RestError } = require('@azure/ms-rest-js');
const { Pinecone }                  = require('@pinecone-database/pinecone');
const { AzureOpenAI }               = require('openai');
const { DocumentAnalysisClient, AzureKeyCredential } = require('@azure/ai-form-recognizer');
const path                          = require('path');
const os                            = require('os');
const fs                            = require('fs/promises');
const fsSync                        = require('fs');
const fetch                         = require('node-fetch');

module.exports = async function (context, req) {
  context.log('⏱️ ingest-notion triggered at', new Date().toISOString());

  try {
    const E = key => {
      const v = process.env[key]; if (!v) throw new Error(`Missing env var: ${key}`); return v;
    };
    const NOTION_TOKEN        = E('NOTION_TOKEN');
    const NOTION_SITE_ROOT    = E('NOTION_SITE_ROOT');
    const AZURE_STORAGE_CONN  = E('AZURE_STORAGE_CONNECTION_STRING');
    const CV_ENDPOINT         = E('COMPUTER_VISION_ENDPOINT');
    const CV_KEY              = E('COMPUTER_VISION_KEY');
    const OPENAI_ENDPOINT     = E('AZURE_OPENAI_ENDPOINT');
    const OPENAI_API_KEY      = E('AZURE_OPENAI_KEY');
    const OPENAI_API_VERSION  = E('AZURE_OPENAI_API_VERSION');
    const OPENAI_EMBED_MODEL  = E('AZURE_EMBEDDING_DEPLOYMENT_ID');
    const PINECONE_API_KEY    = E('PINECONE_API_KEY');
    const PINECONE_INDEX_NAME = E('PINECONE_INDEX_NAME');
    const DI_ENDPOINT         = E('DI_ENDPOINT');
    const DI_KEY              = E('DI_KEY');
    const RAW_CONTAINER       = E('BLOB_RAW_NAME');
    const EXTRACTED_CONTAINER = E('BLOB_EXTRACTED_NAME');

    // Clients
    const notion = new NotionClient({ auth: NOTION_TOKEN });
    const blobSvc = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONN);
    const rawContainer = blobSvc.getContainerClient(RAW_CONTAINER);
    await rawContainer.createIfNotExists();
    const extractedContainer = blobSvc.getContainerClient(EXTRACTED_CONTAINER);
    await extractedContainer.createIfNotExists();

    const cvClient = new ComputerVisionClient(
      new ApiKeyCredentials({ inHeader: { 'Ocp-Apim-Subscription-Key': CV_KEY }}),
      CV_ENDPOINT
    );

    const openai = new AzureOpenAI({
      endpoint:   OPENAI_ENDPOINT,
      apiKey:     OPENAI_API_KEY,
      apiVersion: OPENAI_API_VERSION,
      deployment: OPENAI_EMBED_MODEL
    });

    const pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });
    const pineIndex = pinecone.Index(PINECONE_INDEX_NAME);

    const frClient = new DocumentAnalysisClient(
      DI_ENDPOINT,
      new AzureKeyCredential(DI_KEY)
    );

    // helper to sleep
    const sleep = ms => new Promise(res => setTimeout(res, ms));

    // 1) Gather pages
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
          context.log('Notion block type', b.type);
          if (b.type === 'child_page') await walk(b.id);
          else if (b.type === 'child_database') {
            let dbCur;
            do {
              const qr = await notion.databases.query({ database_id: b.id, start_cursor: dbCur, page_size: 100 });
              for (const e of qr.results) {
                context.log('Notion block type', e.id);
                await walk(e.id);
              }
              dbCur = qr.has_more ? qr.next_cursor : undefined;
            } while (dbCur);
          }
        }
        cursor = resp.has_more ? resp.next_cursor : undefined;
      } while (cursor);
    }
    await walk(NOTION_SITE_ROOT);

    // 2) Process each page
    for (const pid of toProcess) {
      context.log('Processing page', pid);
      // check page-level metadata for incremental
      const metaClient = rawContainer.getBlockBlobClient(`page-${pid}.json`);
      const props      = await metaClient.getProperties().catch(() => undefined);
      const pageMeta   = await notion.pages.retrieve({ page_id: pid });
      const lastKey    = 'lastedited';
      if (props?.metadata?.[lastKey] === pageMeta.last_edited_time) {
        context.log('Skipping unchanged page', pid);
        continue;
      }

      // fetch blocks
      async function fetchBlocks(id, acc = []) {
        let cursor;
        do {
          const resp = await notion.blocks.children.list({ block_id: id, start_cursor: cursor, page_size: 100 });
          for (const b of resp.results) {
            context.log('Notion block type', b.type);
            if (['paragraph','heading_1','heading_2'].includes(b.type)) {
              acc.push({ type: 'text', text: b[b.type].rich_text.map(t => t.plain_text).join('') });
            } else if (b.type === 'image') {
              acc.push({ type: 'image', url: b.image.file.url });
            } else if (b.type === 'file') {
              acc.push({ type: 'file', url: b.file.file.url });
            }
            if (b.has_children) await fetchBlocks(b.id, acc);
          }
          cursor = resp.has_more ? resp.next_cursor : undefined;
        } while (cursor);
        return acc;
      }

      const blocks = await fetchBlocks(pid);
      let fullText = '';

      for (const blk of blocks) {
        context.log('Internal block type', blk.type);
        if (blk.type === 'text') {
          context.log('RUNNING TEXT');
          fullText += blk.text + '\n';
          continue;
        }

        context.log('RUNNING', blk.type.toUpperCase());
        const filename = path.basename(new URL(blk.url).pathname);
        const tmpPath  = path.join(os.tmpdir(), filename);
        const res      = await fetch(blk.url);
        const buf      = Buffer.from(await res.arrayBuffer());
        await fs.writeFile(tmpPath, buf);
        await rawContainer.getBlockBlobClient(`${blk.type}-${pid}-${filename}`).uploadFile(tmpPath);

        if (blk.type === 'image') {
          // OCR
          context.log('RUNNING IMAGE');
          const readResp = await cvClient.readInStream(() => fsSync.createReadStream(tmpPath));
          const operationId = readResp.operationLocation.split('/').pop();
          let ocrRes;
          while (true) {
            try { ocrRes = await cvClient.getReadResult(operationId); }
            catch (err) {
              if (err instanceof RestError && err.response.headers.get('retry-after')) {
                const wait = parseInt(err.response.headers.get('retry-after'),10)*1000||3000;
                context.log.warn(`Rate limited; retrying after ${wait}ms`);
                await sleep(wait);
                continue;
              }
              throw err;
            }
            const st = ocrRes.status.toLowerCase();
            if (st === 'succeeded' || st === 'failed') break;
            await sleep(3000);
          }
          if (ocrRes.status.toLowerCase() === 'succeeded') {
            let ocrText = '';
            for (const pg of ocrRes.analyzeResult.readResults||[]) for (const ln of pg.lines) ocrText += ln.text + '\n';
            // save OCR output
            await extractedContainer.getBlockBlobClient(`ocr-${pid}-${filename}.txt`)
              .upload(ocrText, ocrText.length);
            fullText += ocrText;
          }
        } else {
          // Document Intelligence
          context.log('RUNNING OTHER');
          const poller = await frClient.beginAnalyzeDocument('prebuilt-read', tmpPath);
          const result = await poller.pollUntilDone();
          let fileText = '';
          for (const pg of result.pages||[]) for (const ln of pg.lines) fileText += ln.content + '\n';
          // save DI output
          await extractedContainer.getBlockBlobClient(`txt-${pid}-${filename}.txt`)
            .upload(fileText, fileText.length);
          fullText += fileText;
        }
        await fs.unlink(tmpPath);
      }

      context.log(fullText);

      // chunk & embed
      const CHUNK = 1000;
      const records = [];
      for (let i = 0; i < fullText.length; i += CHUNK) {
        const slice = fullText.slice(i, i + CHUNK);
        const emb = await openai.embeddings.create({ model: OPENAI_EMBED_MODEL, input: slice });
        records.push({ id: `${pid}-${i}`, values: emb.data[0].embedding, metadata: { pageId: pid } });
      }
      if (records.length) await pineIndex.upsert(records);

      // save page metadata
      const md = { [lastKey]: pageMeta.last_edited_time };
      const metaBuf = Buffer.from(JSON.stringify(md), 'utf8');
      await rawContainer.getBlockBlobClient(`page-${pid}.json`)
        .uploadData(metaBuf, { metadata: md });
    }

    context.log('🏁 ingest-notion complete');
    context.res = { status: 200, body: 'Ingestion complete.' };
  } catch(err) {
    context.log.error('❌ ingest-notion failed:', err.message);
    context.log.error(err.stack);
    context.res = { status: 500, body: err.message };
  }
};
