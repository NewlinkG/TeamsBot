// teamsIdStore.js
const { BlobServiceClient } = require('@azure/storage-blob');

const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const containerName = 'persistent';
const blobName = 'teamsUsers.json';

const blobClient = BlobServiceClient
  .fromConnectionString(AZURE_STORAGE_CONNECTION_STRING)
  .getContainerClient(containerName)
  .getBlockBlobClient(blobName);

let inMemoryCache = null; // lazy loaded
let isDirty = false;

async function ensureCacheLoaded() {
  if (!inMemoryCache) {
    await loadCache();
  }
}

async function getReference(email) {
  await ensureCacheLoaded();
  return inMemoryCache[email]?.reference || null;
}

// Utility: Stream → string
async function streamToString(readableStream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readableStream.on('data', chunk => chunks.push(chunk.toString()));
    readableStream.on('end', () => resolve(chunks.join('')));
    readableStream.on('error', reject);
  });
}

// Load JSON from blob (once)
async function loadCache() {
  if (inMemoryCache) return;
  try {
    const download = await blobClient.download();
    const raw = await streamToString(download.readableStreamBody);
    inMemoryCache = JSON.parse(raw || '{}');
    console.log(`🔁 Teams ID map loaded from blob (${Object.keys(inMemoryCache).length} entries)`);
  } catch (err) {
    if (err.statusCode === 404) {
      inMemoryCache = {};
      console.log('ℹ️ No existing blob found, starting fresh');
    } else {
      console.error('❌ Failed to read blob:', err.message);
      throw err;
    }
  }
}

// Public: Save only if changed
async function saveIfChanged(email, teamsId, upn = null, conversationId = null) {
  await ensureCacheLoaded();
  const existing = inMemoryCache[email];
  const updated = {
    upn,
    reference: {
        user: { id: teamsId },
        conversation: { id: conversationId },
    }
    };

  if (
    !existing ||
    existing.upn !== upn ||
    existing.reference?.user?.id !== teamsId ||
    !existing.reference?.conversation?.id
  )
 {
    inMemoryCache[email] = updated;
    isDirty = true;
    console.log(`💾 Updated Teams ID record for ${email}`);
    await flush();
  }
}

async function saveFullReference(email, upn, reference) {
  await ensureCacheLoaded();
  const existing = inMemoryCache[email];

  const updated = {
    upn,
    reference
  };

  if (
    !existing ||
    existing.upn !== upn ||
    JSON.stringify(existing.reference) !== JSON.stringify(reference)
  ) {
    inMemoryCache[email] = updated;
    isDirty = true;
    console.log(`💾 Updated full reference for ${email}`);
    await flush();
  }
}

// Internal: Flush cache to blob
async function flush() {
  if (!isDirty || !inMemoryCache) return;
  const data = JSON.stringify(inMemoryCache, null, 2);
  await blobClient.upload(data, Buffer.byteLength(data), { overwrite: true });
  isDirty = false;
  console.log(`✅ Blob updated with ${Object.keys(inMemoryCache).length} records`);
}

// Optional: Expose full map (read-only)
async function getAllUsers() {
  await ensureCacheLoaded();
  return { ...inMemoryCache };
}

async function getFullRecord(email) {
  await ensureCacheLoaded();
  return inMemoryCache[email] || null;
}

module.exports = {
  saveIfChanged,
  getAllUsers,
  getReference,
  saveFullReference,
  getFullRecord
};
