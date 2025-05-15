// ingest-notion/index.js
console.log('🔧 ingest-notion module loaded');

const { Client: NotionClient }      = require('@notionhq/client');
const { BlobServiceClient }         = require('@azure/storage-blob');
const { ComputerVisionClient }      = require('@azure/cognitiveservices-computervision');
const { ApiKeyCredentials }         = require('@azure/ms-rest-js');
const { Pinecone }                  = require('@pinecone-database/pinecone');
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
    if (!CV_ENDPOINT || !CV_KEY)  throw new Error('Missing COMPUTER_VISION_ENDPOINT or COMPUTERI_VISION_KEY');
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

    const cvCreds = new ApiKeyCredentials({
      inHeader: { 'Ocp-Apim-Subscription-Key': CV_KEY }
    });
    const cvClient = new ComputerVisionClient(cvCreds, CV_ENDPOINT);
    context.log('✅ Computer Vision client ready');

    const openai = new OpenAI({
      apiKey: AZ_OPENAI_KEY,
      azure: {
        endpoint:       AZ_OPENAI_ENDPOINT,
        deploymentName: AZ_OPENAI_DEPLOYMENT_ID,
        apiVersion:     AZ_OPENAI_API_VERSION
      }
    });

    const pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });
    const pineIndex = pinecone.Index(PINECONE_INDEX_NAME);
    context.log('✅ Pinecone index ready:', PINECONE_INDEX_NAME);

    // 2) Crawl Notion recursively
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
          if (block.type === 'child_page') await walk(block.id);
          if (block.type === 'child_database') {
            let dbCursor;
            do {
              const qr = await notion.databases.query({ database_id: block.id, start_cursor: dbCursor, page_size: 100 });
              for (const entry of qr.results) await walk(entry.id);
              dbCursor = qr.has_more ? qr.next_cursor : undefined;
            } while (dbCursor);
          }
        }
        cursor = resp.has_more ? resp.next_cursor : undefined;
      } while (cursor);
    }
    await walk(NOTION_SITE_ROOT);
    context.log(`🔍 Pages to process: ${toProcess.length}`);

    // 3) Process each page: extract text/images, OCR, embed, upsert
    for (const id of toProcess) {
      // 3.a) Change detection
      const metaBlob = container.getBlobClient(`page-${id}.json`);
      const props = await metaBlob.getProperties().catch(()=>undefined);
      const page = await notion.pages.retrieve({ page_id: id });
      const lastEdited = page.last_edited_time;
      if (props?.metadata?.lastEdited === lastEdited) {
        context.log(`↩️ skipping unchanged ${id}`);
        continue;
      }
      // 3.b) Gather blocks
      async function fetchBlocks(bid, acc = []) {
        let cur;
        do {
          const lst = await notion.blocks.children.list({ block_id: bid, start_cursor: cur, page_size: 100 });
          for (const b of lst.results) {
            if (['paragraph','heading_1','heading_2'].includes(b.type)) {
              acc.push(b[b.type].rich_text.map(t => t.plain_text).join(''));
            }
            if (['image','file'].includes(b.type)) acc.push({ file: b[b.type].file.url });
            if (b.has_children) await fetchBlocks(b.id, acc);
          }
          cur = lst.has_more ? lst.next_cursor : undefined;
        } while (cur);
        return acc;
      }
      const blocks = await fetchBlocks(id);
      let fullText = '';
      for (const frag of blocks) {
        if (typeof frag === 'string') { fullText += frag + '\n'; }
        else {
          const tmp = path.join(os.tmpdir(), path.basename(frag.file));
          const res = await fetch(frag.file);
          await fs.writeFile(tmp, Buffer.from(await res.arrayBuffer()));
          const blobName = `attachment-${id}-${path.basename(tmp)}`;
          await container.getBlockBlobClient(blobName).uploadFile(tmp);
          const readOp = await cvClient.readInStream(await fs.readFile(tmp));
          const ocr = await cvClient.getReadResult(readOp.jobId);
          for (const p of ocr.analyzeResult.readResults || []) {
            for (const line of p.lines) fullText += line.text + '\n';
          }
          await fs.unlink(tmp);
        }
      }
      // 3.c) Embed & upsert
      const CHUNK_SIZE = 1000;
      const vectors = [];
      for (let i = 0; i < fullText.length; i += CHUNK_SIZE) {
        const chunk = fullText.slice(i, i + CHUNK_SIZE);
        const embed = await openai.embeddings.create({ model: AZ_OPENAI_DEPLOYMENT_ID, input: chunk });
        vectors.push({ id: `${id}-${i/CHUNK_SIZE}`, values: embed.data[0].embedding, metadata: { pageId: id } });
      }
      await pineIndex.upsert({ vectors });
      // 3.d) Save metadata
      const body = JSON.stringify({ id, lastEdited, text: fullText });
      await container.uploadBlockBlob(`page-${id}.json`, body, { metadata: { lastEdited } });
      context.log(`✅ processed ${id} — chunks: ${vectors.length}`);
    }

    context.log('🏁 ingest-notion complete');
    context.res = { status: 200, body: "Ingestion kicked off." };
    return;
  }
  catch (err) {
    context.log.error('❌ ingest-notion failed:', err.message);
    context.log.error(err.stack);
    context.res = { status: 500, body: err.message };
  }
};
