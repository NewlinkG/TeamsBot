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

async function getTeamsId(email) {
  await loadCache();
  return inMemoryCache[email]?.teamsId || null;
}

// Public: Save only if changed
async function saveIfChanged(email, teamsId, upn = null) {
  await loadCache();
  const existing = inMemoryCache[email];
  const updated = { teamsId, upn };

  if (!existing || existing.teamsId !== teamsId || existing.upn !== upn) {
    inMemoryCache[email] = updated;
    isDirty = true;
    console.log(`💾 Updated Teams ID record for ${email}`);
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
  await loadCache();
  return { ...inMemoryCache };
}

module.exports = {
  getTeamsId,
  saveIfChanged,
  getAllUsers
};
