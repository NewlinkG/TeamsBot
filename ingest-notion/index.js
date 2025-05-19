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
const crypto                        = require('crypto');

// Hash helper
function hashText(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16); // 16 chars should suffice
}

module.exports = async function (context, req) {
  context.log('⏱️ ingest-notion triggered at', new Date().toISOString());
  try {
    const E = key => { const v = process.env[key]; if (!v) throw new Error(`Missing env var: ${key}`); return v; };
    // Environment
    const NOTION_TOKEN        = E('NOTION_TOKEN');
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
      CV_ENDPOINT,
      {
        // Retry up to 5 times, exponential back-off between 200ms and 5s
        retryOptions: {
          maxRetries: 5,
          retryDelayInMs: 2000,
          maxRetryDelayInMs: 5000,
          mode: "exponential"
        }
      }
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

    async function discoverAllAccessibleRoots() {
      let cursor;
      do {
        const resp = await notion.search({ start_cursor: cursor, page_size: 100 });
        for (const result of resp.results) {
          if ((result.object === 'page' || result.object === 'database') && result.id) {
            await walk(result.id);
          }
        }
        cursor = resp.has_more ? resp.next_cursor : undefined;
      } while (cursor);
    }

    await discoverAllAccessibleRoots();

    // fetch blocks
    async function fetchBlocks(id, acc = []) {
      let cursor;
      do {
        const resp = await notion.blocks.children.list({ block_id: id, start_cursor: cursor, page_size: 100 });
        for (const b of resp.results) {
          context.log('Notion block type', b.type);
          const block = { id: b.id, notionType: b.type };

          // Text-like blocks
          if (['paragraph','heading_1','heading_2','quote','callout','code','bulleted_list_item','numbered_list_item','to_do','toggle'].includes(b.type)) {
            block.type = 'text';
            block.text = b[b.type]?.rich_text?.map(t => t.plain_text).join('') || '';
            acc.push(block);
            if (b.has_children) await fetchBlocks(b.id, acc);
            continue;
          }

          // Images and files
          else if (b.type === 'image') {
            const url = b.image?.file?.url || b.image?.external?.url;
            if (url) {
              block.type = 'image';
              block.url = url;
              acc.push(block);
            }
          }
          else if (b.type === 'file' || b.type === 'pdf') {
            const url = b.file?.file?.url || b.file?.external?.url;
            if (url) {
              block.type = 'file';
              block.url = url;
              acc.push(block);
            }
          }

          // Embeds and videos
          else if (['video', 'embed', 'bookmark', 'link_preview'].includes(b.type)) {
            const url = b[b.type]?.url || b[b.type]?.external?.url;
            if (url) {
              block.type = 'media';
              block.url = url;
              acc.push(block);
            }
          }

          // Layout wrappers — recurse only
          else if (['synced_block', 'column', 'column_list'].includes(b.type)) {
            if (b.has_children) await fetchBlocks(b.id, acc);
            continue;
          }

          // Unknown — recurse if possible
          else {
            context.log.warn(`⚠️ Unrecognized block type: ${b.type}`);
            if (b.has_children) await fetchBlocks(b.id, acc);
            continue;
          }
        }

        cursor = resp.has_more ? resp.next_cursor : undefined;
      } while (cursor);

      return acc;
    }


      const blocks = await fetchBlocks(pid);
      const records = [];
      const CHUNK   = 1000;

      for (const blk of blocks) {
        context.log('RUNNING', blk.type.toUpperCase(), 'for block', blk.id, 'URL:', blk.url);
        const filename = blk.url ? path.basename(new URL(blk.url).pathname) : null;
        let blockText = '';

        if (blk.type === 'text') {
          context.log('RUNNING TEXT');
          blockText = blk.text + '\n';

          const hash = hashText(blockText);
          const blobName = `txt-${pid}-${blk.id}-${hash}.txt`;
          const client = extractedContainer.getBlockBlobClient(blobName);
          const exists = await client.exists();
          if (exists) {
            context.log('Skipping unchanged text block', blk.id);
            continue;
          }

          await client.upload(blockText, blockText.length);
        } else {
          context.log('RUNNING', blk.type.toUpperCase());
          const tmpPath = path.join(os.tmpdir(), filename);
          const buf     = Buffer.from(await (await fetch(blk.url)).arrayBuffer());

          if (buf.length > 4 * 1024 * 1024) {
            context.log.warn(`📤 Treating oversized image as file (${(buf.length/1024/1024).toFixed(2)}MB): ${filename}`);
            blk.type = 'file';
          }

          await fs.writeFile(tmpPath, buf);
          await rawContainer.getBlockBlobClient(`${blk.type}-${pid}-${blk.id}-${filename}`).uploadFile(tmpPath);

          if (blk.type === 'image') {
            context.log('RUNNING IMAGE');
            let readResp;
            for (let attempt = 0; attempt < 5; attempt++) {
              try {
                readResp = await cvClient.readInStream(() => fsSync.createReadStream(tmpPath));
                break; // success
              } catch (err) {
                if (err instanceof RestError && err.message.includes('call rate limit')) {
                  const wait = 3000 * (attempt + 1); // exponential-ish backoff
                  context.log.warn(`📉 Computer Vision rate limited on initial call; retrying in ${wait}ms`);
                  await sleep(wait);
                } else {
                  throw err;
                }
              }
            }
            if (!readResp) throw new Error('❌ Failed to initiate Computer Vision read after retries.');

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
            context.log('RUNNING OTHER DOCUMENTS');

            // Construct blob name and client
            const blobName = `${blk.type}-${pid}-${blk.id}-${filename}`;
            const blobClient = rawContainer.getBlockBlobClient(blobName);

            // Generate a SAS URL valid for 1 hour
            const sasUrl = await blobClient.generateSasUrl({
              expiresOn: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
              permissions: "r",
            });

            // Document Intelligence via REST SDK using the signed blob URL
            const analyzeResponse = await diClient
              .path('/documentModels/{modelId}:analyze', 'prebuilt-read')
              .post({
                contentType: 'application/json',
                body: { urlSource: sasUrl },
              });

            if (isUnexpected(analyzeResponse)) {
              context.log.error('📄 DI analyzeResponse:', JSON.stringify(analyzeResponse.body, null, 2));
              throw new Error(analyzeResponse.body?.error?.message || 'Unexpected Document Intelligence error');
            }

            const poller = getLongRunningPoller(diClient, analyzeResponse);
            const diResult = (await poller.pollUntilDone()).body.analyzeResult;

            if (diResult.content) {
              blockText += diResult.content + '\n';
            } else if (diResult.pages) {
              for (const pg of diResult.pages) {
                if (Array.isArray(pg.lines)) {
                  for (const ln of pg.lines) blockText += ln.content + '\n';
                }
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
