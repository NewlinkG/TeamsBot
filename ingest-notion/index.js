console.log('🔧 ingest-notion module loaded');

const { Client: NotionClient }      = require('@notionhq/client');
const { BlobServiceClient }         = require('@azure/storage-blob');
const { ComputerVisionClient }      = require('@azure/cognitiveservices-computervision');
const { ApiKeyCredentials, RestError } = require('@azure/ms-rest-js');
const { Pinecone }                  = require('@pinecone-database/pinecone');
const { AzureOpenAI }               = require('openai');
const DocumentIntelligenceClient    = require('@azure-rest/ai-document-intelligence').default;
const { getLongRunningPoller, isUnexpected } = require('@azure-rest/ai-document-intelligence');
const { AzureKeyCredential }        = require('@azure/core-auth');
const path                          = require('path');
const os                            = require('os');
const fs                            = require('fs/promises');
const fsSync                        = require('fs');
const fetch                         = require('node-fetch');

// helper to detect content type for Document Analysis (non-image formats)
function getContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case '.pdf': return 'application/pdf';
    case '.doc': return 'application/msword';
    case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.xls': return 'application/vnd.ms-excel';
    case '.xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.ppt': return 'application/vnd.ms-powerpoint';
    case '.pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    default: return 'application/octet-stream';
  }
}

module.exports = async function (context, req) {
  context.log('⏱️ ingest-notion triggered at', new Date().toISOString());
  try {
    const E = key => { const v = process.env[key]; if (!v) throw new Error(`Missing env var: ${key}`); return v; };
    // Environment
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

    const diClient = DocumentIntelligenceClient(DI_ENDPOINT, new AzureKeyCredential(DI_KEY));

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

    // 2) Process each page incrementally
    for (const pid of toProcess) {
      context.log('Processing page', pid);
      context.log('Fetching blocks for page', pid);
      const metaClient = rawContainer.getBlockBlobClient(`page-${pid}.json`);
      const props      = await metaClient.getProperties().catch(() => undefined);
      const pageMeta   = await notion.pages.retrieve({ page_id: pid });
      const lastKey    = 'lastedited';
      if (props?.metadata?.[lastKey] === pageMeta.last_edited_time) {
        context.log('Skipping unchanged page; no blocks processed for page', pid);
        continue;
      }

      // fetch blocks
      async function fetchBlocks(id, acc = []) {
        let cursor;
        do {
          const resp = await notion.blocks.children.list({ block_id: id, start_cursor: cursor, page_size: 100 });
          for (const b of resp.results) {
            context.log('Notion block type', b.type);
            const block = { id: b.id };
            if (['paragraph','heading_1','heading_2'].includes(b.type)) {
              block.type = 'text'; block.text = b[b.type].rich_text.map(t => t.plain_text).join('');
            } else if (b.type === 'image') { block.type = 'image'; block.url = b.image.file.url; }
            else if (b.type === 'file')  { block.type = 'file';  block.url = b.file.file.url; }
            else { if (b.has_children) await fetchBlocks(b.id, acc); continue; }
            acc.push(block);
            if (b.has_children) await fetchBlocks(b.id, acc);
          }
          cursor = resp.has_more ? resp.next_cursor : undefined;
        } while (cursor);
        return acc;
      }

      const blocks = await fetchBlocks(pid);
      context.log(`Fetched ${blocks.length} blocks for page ${pid}`);
      const records = [];
      const CHUNK   = 1000;

      for (const blk of blocks) {
        context.log('RUNNING', blk.type.toUpperCase(), 'for block', blk.id);
        const filename = blk.url ? path.basename(new URL(blk.url).pathname) : null;
        let blockText = '';

        if (blk.type === 'text') {
          context.log('RUNNING TEXT'); blockText = blk.text + '\n';
        } else {
          context.log('RUNNING', blk.type.toUpperCase());
          const tmpPath = path.join(os.tmpdir(), filename);
          const buf     = Buffer.from(await (await fetch(blk.url)).arrayBuffer());
          await fs.writeFile(tmpPath, buf);
          await rawContainer.getBlockBlobClient(`${blk.type}-${pid}-${blk.id}-${filename}`).uploadFile(tmpPath);

          if (blk.type === 'image') {
            context.log('RUNNING IMAGE');
            const readResp = await cvClient.readInStream(() => fsSync.createReadStream(tmpPath));
            const opId     = readResp.operationLocation.split('/').pop();
            let ocrRes;
            while (true) {
              try { ocrRes = await cvClient.getReadResult(opId); }
              catch (err) {
                if (err instanceof RestError && err.response.headers.get('retry-after')) {
                  const wait = parseInt(err.response.headers.get('retry-after'),10)*1000||3000;
                  context.log.warn(`Rate limited; retrying after ${wait}ms`);
                  await sleep(wait); continue;
                }
                throw err;
              }
              const st = ocrRes.status.toLowerCase(); if (st==='succeeded'||st==='failed') break;
              await sleep(3000);
            }
            if (ocrRes.status.toLowerCase()==='succeeded') {
              for (const pg of ocrRes.analyzeResult.readResults||[])
                for (const ln of pg.lines) blockText += ln.text + '\n';
            }
          } else {
            context.log('RUNNING OTHER');
            // Document Intelligence via REST SDK (using local file stream)
            const contentType = getContentType(filename);
            const fileStream = fsSync.createReadStream(tmpPath);
            const initialResponse = await diClient
              .path('/documentModels/{modelId}:analyze', 'prebuilt-read')
              .post({ contentType, body: fileStream });
            if (isUnexpected(initialResponse)) throw initialResponse.body.error;
            const poller = getLongRunningPoller(diClient, initialResponse);
            const diResult = (await poller.pollUntilDone()).body.analyzeResult;
            if (diResult.content) {
              blockText += diResult.content + '
';
            } else if (diResult.pages) {
              for (const pg of diResult.pages) {
                if (Array.isArray(pg.lines)) {
                  for (const ln of pg.lines) blockText += ln.content + '
';
                }
              }
            }
          await fs.unlink(tmpPath);
          // save extraction
          const blobName = blk.type==='image' ?
            `ocr-${pid}-${blk.id}-${filename}.txt` :
            `txt-${pid}-${blk.id}-${filename}.txt`;
          await extractedContainer.getBlockBlobClient(blobName)
            .upload(blockText, blockText.length);
        }

        // embeddings
        for (let offset=0; offset<blockText.length; offset+=CHUNK) {
          const slice = blockText.slice(offset, offset+CHUNK);
          const emb   = await openai.embeddings.create({ model: OPENAI_EMBED_MODEL, input: slice });
          records.push({ id:`${pid}-${blk.id}-${offset}`, values: emb.data[0].embedding, metadata:{ pageId: pid, blockId: blk.id }});
        }
      }

      context.log(`Completed processing ${blocks.length} blocks for page ${pid}`);
      if (records.length) await pineIndex.upsert(records);
      // save metadata
      const md      = { [lastKey]: pageMeta.last_edited_time };
      const metaBuf = Buffer.from(JSON.stringify(md),'utf8');
      await rawContainer.getBlockBlobClient(`page-${pid}.json`)
        .uploadData(metaBuf,{ metadata: md });
    }

    context.log('🏁 ingest-notion complete');
    context.res = { status: 200, body: 'Ingestion complete.' };
  } catch(err) {
    context.log.error('❌ ingest-notion failed:', err.message);
    context.log.error(err.stack);
    context.res = { status: 500, body: err.message };
  }
};