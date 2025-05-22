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

module.exports = async function (context, req) {
  context.log('⏱️ ingest-notion triggered at', new Date().toISOString());
  try {
    const E = key => { const v = process.env[key]; if (!v) throw new Error(`Missing env var: ${key}`); return v; };

    // Env vars
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
      { retryOptions: { maxRetries: 5, retryDelayInMs: 2000, maxRetryDelayInMs: 5000, mode: "exponential" } }
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

    function extractTitle(properties = {}) {
      const titleProp = Object.values(properties)
        .find(p => p.type === 'title' && Array.isArray(p.title) && p.title[0]);
      return titleProp ? titleProp.title[0].plain_text : '';
    }

    // 1) Discover all pages
    const seen = new Set();
    const toProcess = [];
    async function fetchBlocks(id, acc = []) {
      let cursor;
      do {
        const resp = await notion.blocks.children.list({ block_id: id, start_cursor: cursor, page_size: 100 });
        for (const b of resp.results) {
          const block = { id: b.id, notionType: b.type };
          // Text-like
          if (['paragraph','heading_1','heading_2','heading_3','quote','callout','code','bulleted_list_item','numbered_list_item','to_do','toggle'].includes(b.type)) {
            block.type = 'text';
            block.text = b[b.type]?.rich_text?.map(t => t.plain_text).join('') || '';
            acc.push(block);
            if (b.has_children) await fetchBlocks(b.id, acc);
            continue;
          }
          // Images & files
          if (b.type === 'image' || b.type === 'file' || b.type === 'pdf') {
            const url = b[b.type]?.file?.url || b[b.type]?.external?.url;
            if (url) {
              block.type = b.type === 'image' ? 'image' : 'file';
              block.url = url;
              acc.push(block);
            }
            continue;
          }
          // Media embeds
          if (['video','embed','bookmark','link_preview'].includes(b.type)) {
            const url = b[b.type]?.url || b[b.type]?.external?.url;
            if (url) {
              block.type = 'media';
              block.url = url;
              acc.push(block);
            }
            continue;
          }
          // Layout wrappers
          if (['synced_block','column','column_list'].includes(b.type) && b.has_children) {
            await fetchBlocks(b.id, acc);
          }
        }
        cursor = resp.has_more ? resp.next_cursor : undefined;
      } while (cursor);
      return acc;
    }
    async function walk(id) {
      if (seen.has(id)) return;
      seen.add(id); toProcess.push(id);
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

    // ——— Purge pages deleted in Notion ———
    const existingPages = [];
    for await (const blob of rawContainer.listBlobsFlat({ prefix: 'page-' })) {
      existingPages.push(blob.name.slice(5, -5));
    }
    const removed = existingPages.filter(id => !toProcess.includes(id));
    if (removed.length) {
      context.log(`🗑️ Removing pages no longer in Notion:`, removed);
      for (const id of removed) {
        await rawContainer.deleteBlob(`page-${id}.json`);
        await extractedContainer.deleteBlob(`txt-${id}-*.txt`);
        await pineIndex.delete({ filter: { pageId: id } });
        context.log(`✅ Purged data for deleted page ${id}`);
      }
    }

    // 3) Attachment GC (always after fetchBlocks below)
    context.log('Starting attachment cleanup');
    async function garbageCollectAttachments(pid, pageMeta) {
      const blocks = await fetchBlocks(pid);
      // include file‐property attachments
      for (const [key, prop] of Object.entries(pageMeta.properties || {})) {
        if (prop.type === 'files' && Array.isArray(prop.files)) {
          for (const f of prop.files) {
            const url = f.file?.url || f.external?.url;
            if (url) {
              const ext = path.extname(f.name).toLowerCase();
              blocks.push({
                id: `${pid}-${key}`,
                type: ['.png','.jpg','.jpeg','.bmp','.tif','.tiff'].includes(ext) ? 'image' : 'file',
                notionType: 'property',
                url
              });
            }
          }
        }
      }

      // list existing blobs
      const existing = [];
      for await (const b of rawContainer.listBlobsFlat({ prefix: `image-${pid}-` })) existing.push(b.name);
      for await (const b of rawContainer.listBlobsFlat({ prefix: `file-${pid}-`  })) existing.push(b.name);

      // build live set
      const liveSet = new Set(
        blocks
          .filter(b => b.type === 'image' || b.type === 'file')
          .map(b => {
            const fn = path.basename(new URL(b.url).pathname);
            return `${b.type}-${pid}-${b.id}-${fn}`;
          })
      );

      // delete orphans
      for (const name of existing) {
        if (!liveSet.has(name)) {
          context.log(`🗑️ Deleting orphaned blob ${name}`);
          await rawContainer.deleteBlob(name);
          // also clean up extracted text
          if (name.startsWith('file-')) {
            const [, , blockId, ...rest] = name.split('-');
            const fn = rest.join('-');
            await extractedContainer.deleteBlob(`txt-${pid}-${blockId}-${fn}.txt`).catch(()=>{});
          } else {
            const [, , blockId, ...rest] = name.split('-');
            const fn = rest.join('-');
            await extractedContainer.deleteBlob(`ocr-${pid}-${blockId}-${fn}.txt`).catch(()=>{});
          }
        }
      }
    }

    // 2) Process each page
    for (const pid of toProcess) {
      let pageMeta;
      try {
        pageMeta = await notion.pages.retrieve({ page_id: pid });
      } catch (err) {
        if (err.code === 'object_not_found') {
          context.log.warn(`⚠️ Skipping inaccessible page ${pid}`);
          continue;
        }
        throw err;
      }

      // compare Notion’s last_edited_time to our stored metadata
      const client = rawContainer.getBlockBlobClient(`page-${pid}.json`);
      const props = await client.getProperties().catch(() => undefined);
      const lastKey = 'lastedited';
      
      const unchanged = props?.metadata?.[lastKey] === pageMeta.last_edited_time;
      if (unchanged) {
        context.log(`↩️ ${pid} unchanged since ${pageMeta.last_edited_time}; skipping full sync.`);
      } else {
        // full sync
        const blocks = await fetchBlocks(pid);

        // ─── re-add any “Files & media” property attachments ───
        for (const [key, prop] of Object.entries(pageMeta.properties || {})) {
          if (prop.type === 'files' && Array.isArray(prop.files)) {
            for (const f of prop.files) {
              const url = f.file?.url || f.external?.url;
              if (!url) continue;
              const ext = path.extname(f.name).toLowerCase();
              blocks.push({
                id:    `${pid}-${key}`,                              // unique per-property
                type:  ['.png','.jpg','.jpeg','.bmp','.tif','.tiff']
                      .includes(ext) ? 'image' : 'file',
                notionType: 'property',
                url
              });
            }
          }
        }

        // upload text & attachments
        const records = [];
        const CHUNK   = 300;
        for (const blk of blocks) {
          context.log('Processing: ', blk.id, '-', blk.url);
          const filename = blk.url ? path.basename(new URL(blk.url).pathname) : null;
          let blockText = '';

          if (blk.type === 'text') {
            blockText = blk.text + '\n';
            const blobName = `txt-${pid}-${blk.id}.txt`;
            const textClient = extractedContainer.getBlockBlobClient(blobName);
            if (!(await textClient.exists())) {
              await textClient.upload(blockText, Buffer.byteLength(blockText));
            }
          } else {
            // upload raw blob
            const tmpPath = path.join(os.tmpdir(), filename);
            const buf = Buffer.from(await (await fetch(blk.url)).arrayBuffer());
            if (buf.length > 4 * 1024 * 1024) blk.type = 'file';
            await fs.writeFile(tmpPath, buf);
            await rawContainer.getBlockBlobClient(`${blk.type}-${pid}-${blk.id}-${filename}`)
              .uploadFile(tmpPath);

            // OCR or DI
            if (blk.type === 'image') {
              // Computer Vision OCR...
              let readResp;
              for (let i=0; i<5; i++) {
                try { readResp = await cvClient.readInStream(() => fsSync.createReadStream(tmpPath)); break; }
                catch (e) { if (e instanceof RestError && e.message.includes('rate limit')) await sleep(3000*(i+1)); else throw e; }
              }
              const opId = readResp.operationLocation.split('/').pop();
              let ocrRes;
              while (true) {
                try { ocrRes = await cvClient.getReadResult(opId); }
                catch (e) { if (e instanceof RestError && e.response.headers.get('retry-after')) { await sleep(parseInt(e.response.headers.get('retry-after'),10)*1000); continue; } throw e; }
                if (['succeeded','failed'].includes(ocrRes.status.toLowerCase())) break;
                await sleep(3000);
              }
              if (ocrRes.status.toLowerCase()==='succeeded') {
                for (const pg of ocrRes.analyzeResult.readResults||[])
                  for (const ln of pg.lines) blockText += ln.text + '\n';
              }
            } else {
              // Document Intelligence...
              const blobCli = rawContainer.getBlockBlobClient(`${blk.type}-${pid}-${blk.id}-${filename}`);
              const sasUrl = await blobCli.generateSasUrl({ expiresOn: new Date(Date.now()+3600e3), permissions: "r" });
              const analyzeResponse = await diClient.path('/documentModels/{modelId}:analyze','prebuilt-read').post({ contentType:'application/json', body:{ urlSource: sasUrl }});
              if (isUnexpected(analyzeResponse)) throw new Error(analyzeResponse.body.error?.message);
              const poller = getLongRunningPoller(diClient, analyzeResponse);
              const diResult = (await poller.pollUntilDone()).body.analyzeResult;
              if (diResult.content) blockText += diResult.content + '\n';
              else for (const pg of diResult.pages||[]) for (const ln of pg.lines||[]) blockText += ln.content + '\n';
            }
            await fs.unlink(tmpPath);

            const outName = blk.type==='image'
              ? `ocr-${pid}-${blk.id}-${filename}.txt`
              : `txt-${pid}-${blk.id}-${filename}.txt`;
            await extractedContainer.getBlockBlobClient(outName)
              .upload(blockText, Buffer.byteLength(blockText));
          }

          // embeddings
          const embText = blockText.trim() || (blk.url ? `Media URL: ${blk.url}` : null);
          if (embText) {
            for (let offset=0; offset<embText.length; offset+=CHUNK) {
              const slice = embText.slice(offset, offset+CHUNK);
              const emb = await openai.embeddings.create({ model: OPENAI_EMBED_MODEL, input: slice });
              records.push({
                id: `${pid}-${blk.id}-${offset}`,
                values: emb.data[0].embedding,
                metadata: {
                  pageId: pid,
                  blockId: blk.id,
                  blockType: blk.type,
                  originalUrl: blk.url || '',
                  sourceTitle: extractTitle(pageMeta.properties),
                  sourceUrl: `https://www.notion.so/${pid.replace(/-/g,'')}`
                }
              });
            }
          }
        }

        const recordIds = records.map(r => r.id);

        const metaClient = rawContainer.getBlockBlobClient(`page-${pid}.json`);
        let oldIds = [];
        try {
          const props = await metaClient.downloadToBuffer();
          const md = JSON.parse(props.toString());
          oldIds = md.recordIds || [];
        } catch {
          context.log('No previous metadata or no recordIds field → nothing to delete');
        }

        if (oldIds.length) {
          await pineIndex.deleteMany(
          oldIds,                   // <-- array of expired IDs
          { namespace: 'notion' }      // <-- namespace option
        );
        }
        
        if (records.length) await pineIndex.namespace('notion').upsert(records);

        // record last sync time (metadata only needs lastedited; recordIds live in content)
        const newMeta = { [lastKey]: pageMeta.last_edited_time, recordIds };
        const buf = Buffer.from(JSON.stringify(newMeta), 'utf8');
        await rawContainer
          .getBlockBlobClient(`page-${pid}.json`)
          .uploadData(buf, { metadata: { lastedited: pageMeta.last_edited_time } });
      }
      // always clean up attachments afterwards
      await garbageCollectAttachments(pid, pageMeta);
    }

    context.log('🏁 ingest-notion complete');
    context.res = { status: 200, body: 'Ingestion complete.' };
  } catch(err) {
    context.log.error('❌ ingest-notion failed:', err.message);
    context.log.error(err.stack);
    context.res = { status: 500, body: err.message };
  }
};
