// ingest-notion/index.js
const { Client: NotionClient } = require('@notionhq/client');
const { BlobServiceClient } = require('@azure/storage-blob');
const { ComputerVisionClient } = require('@azure/cognitiveservices-computervision');
const { DefaultAzureCredential } = require('@azure/identity');
const { PineconeClient } = require('@pinecone-database/pinecone');
const { OpenAI } = require('openai');
const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const fetch = require('node-fetch');

// ———— env vars ————
const NOTION_TOKEN        = process.env.NOTION_TOKEN;
const NOTION_SITE_ROOT    = process.env.NOTION_SITE_ROOT;    // <-- root page ID
const AZURE_STORAGE_CONN  = process.env.AZURE_STORAGE_CONNECTION_STRING;
const BLOB_CONTAINER      = process.env.BLOB_CONTAINER_NAME || 'notion-assets';
const CV_ENDPOINT         = process.env.COMPUTER_VISION_ENDPOINT;
const CV_KEY              = process.env.COMPUTER_VISION_KEY;
const OPENAI_KEY          = process.env.OPENAI_API_KEY;
const PINECONE_API_KEY    = process.env.PINECONE_API_KEY;
const PINECONE_INDEX_NAME = process.env.PINECONE_INDEX_NAME;

if (!NOTION_TOKEN || !NOTION_SITE_ROOT) {
  throw new Error('Missing NOTION_TOKEN or NOTION_SITE_ROOT');
}

module.exports = async function (context, timer) {
  context.log('⏱️ ingest-notion triggered:', new Date().toISOString());

  // 1) init clients
  const notion = new NotionClient({ auth: NOTION_TOKEN });
  const blobSvc = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONN);
  const container = blobSvc.getContainerClient(BLOB_CONTAINER);
  await container.createIfNotExists();

  const cvClient = new ComputerVisionClient(
    CV_ENDPOINT,
    new DefaultAzureCredential()
  );

  const openai = new OpenAI({ apiKey: OPENAI_KEY });

  const pinecone = new PineconeClient();
  await pinecone.init({ apiKey: PINECONE_API_KEY });
  const pineIndex = pinecone.Index(PINECONE_INDEX_NAME);

  // 2) Recursively walk the “site” starting from NOTION_SITE_ROOT
  const seen = new Set();
  async function walk(nodeId) {
    if (seen.has(nodeId)) return;
    seen.add(nodeId);
    // queue this page/database for processing
    toProcess.push(nodeId);

    // list children blocks
    let cursor = undefined;
    do {
      const { results, has_more, next_cursor } = await notion.blocks.children.list({
        block_id: nodeId,
        start_cursor: cursor,
        page_size: 100
      });
      for (const block of results) {
        if (block.type === 'child_page') {
          await walk(block.id);
        }
        if (block.type === 'child_database') {
          // fetch all entries of that database
          let dbCursor = undefined;
          do {
            const { results: entries, has_more: dbMore, next_cursor: dbNext } =
              await notion.databases.query({
                database_id: block.id,
                start_cursor: dbCursor,
                page_size: 100
              });
            for (const entry of entries) {
              // each entry is a “page” too
              await walk(entry.id);
            }
            dbCursor = dbMore ? dbNext : undefined;
          } while (dbCursor);
        }
      }
      cursor = has_more ? next_cursor : undefined;
    } while (cursor);
  }

  const toProcess = [];
  await walk(NOTION_SITE_ROOT);

  // 3) For each page/database page ID, fetch its blocks & attachments, OCR, embed & upsert
  for (const id of toProcess) {
    // (same dedupe logic as before)
    const metaBlob = container.getBlobClient(`page-${id}.json`);
    let props = null;
    try { props = await metaBlob.getProperties(); } catch {}
    const lastEdited = (await notion.pages.retrieve({ page_id: id })).last_edited_time;
    if (props?.metadata?.lastEdited === lastEdited) {
      context.log(`↩️ skipping unchanged ${id}`);
      continue;
    }

    // fetch all text blocks + attachments
    async function fetchBlocks(blockId, acc = []) {
      let cur = undefined;
      do {
        const { results, has_more, next_cursor } = await notion.blocks.children.list({
          block_id: blockId, start_cursor: cur, page_size: 100
        });
        for (const b of results) {
          if (['paragraph','heading_1','heading_2'].includes(b.type)) {
            acc.push(b[b.type].rich_text.map(t => t.plain_text).join(''));
          }
          if (['image','file'].includes(b.type)) {
            acc.push({ file: b[b.type].file.url });
          }
          if (b.has_children) await fetchBlocks(b.id, acc);
        }
        cur = has_more ? next_cursor : undefined;
      } while (cur);
      return acc;
    }
    const blocks = await fetchBlocks(id);

    // assemble text + OCR attachments
    let fullText = '';
    for (const frag of blocks) {
      if (typeof frag === 'string') {
        fullText += frag + '\n';
      } else {
        // download to temp, OCR & upload
        const tmp = path.join(os.tmpdir(), path.basename(frag.file));
        const res = await fetch(frag.file);
        await fs.writeFile(tmp, Buffer.from(await res.arrayBuffer()));

        // upload raw asset
        const blobName = `attachment-${id}-${path.basename(tmp)}`;
        await container.getBlockBlobClient(blobName).uploadFile(tmp);

        // OCR
        const readOp = await cvClient.readInStream(await fs.readFile(tmp));
        const ocr = await cvClient.getReadResult(readOp.jobId);
        for (const p of ocr.analyzeResult.readResults || []) {
          for (const line of p.lines) {
            fullText += line.text + '\n';
          }
        }
        await fs.unlink(tmp);
      }
    }

    // chunk → embed → upsert
    const CHUNK_SIZE = 1000;
    const vectors = [];
    for (let i = 0; i < fullText.length; i += CHUNK_SIZE) {
      const chunk = fullText.slice(i, i + CHUNK_SIZE);
      const embed = await openai.embeddings.create({
        model: 'text-embedding-ada-002',
        input: chunk
      });
      vectors.push({
        id: `${id}-${i/CHUNK_SIZE}`,
        values: embed.data[0].embedding,
        metadata: { pageId: id }
      });
    }
    await pineIndex.upsert({ vectors });

    // save metadata + text
    const body = JSON.stringify({ id, lastEdited, text: fullText });
    await container.uploadBlockBlob(`page-${id}.json`, body, {
      metadata: { lastEdited }
    });

    context.log(`✅ processed ${id} (${vectors.length} chunks)`);
  }

  context.log('🏁 ingest-notion complete');
};
