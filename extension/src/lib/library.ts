/** IndexedDB store for finished video clips — chrome.storage.local isn't meant for binary blobs. Usable from both the service worker and the side panel document. */

const DB_NAME = "ai-affiliate-library";
const DB_VERSION = 1;
const STORE = "clips";

/** Library slot for the file made by joining a video's clips; real clips use 0..n-1. */
export const MERGED_CLIP_INDEX = -1;

export interface StoredClip {
  videoId: string;
  index: number;
  blob: Blob;
  mimeType: string;
  createdAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: ["videoId", "index"] });
        store.createIndex("videoId", "videoId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function putClip(videoId: string, index: number, blob: Blob, mimeType: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ videoId, index, blob, mimeType, createdAt: Date.now() } satisfies StoredClip);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function getClipsForVideo(videoId: string): Promise<StoredClip[]> {
  const db = await openDb();
  const clips = await new Promise<StoredClip[]>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const index = tx.objectStore(STORE).index("videoId");
    const request = index.getAll(IDBKeyRange.only(videoId));
    request.onsuccess = () => resolve(request.result as StoredClip[]);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return clips.sort((a, b) => a.index - b.index);
}

export async function listVideoIdsWithClips(): Promise<string[]> {
  const db = await openDb();
  const ids = await new Promise<string[]>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).getAll();
    request.onsuccess = () => {
      const clips = request.result as StoredClip[];
      resolve([...new Set(clips.map((c) => c.videoId))]);
    };
    request.onerror = () => reject(request.error);
  });
  db.close();
  return ids;
}

export async function deleteClipsForVideo(videoId: string): Promise<void> {
  const db = await openDb();
  const clips = await getClipsForVideo(videoId);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const clip of clips) store.delete([clip.videoId, clip.index]);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
