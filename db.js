// db.js — 計數紀錄的本機資料庫（IndexedDB）：含縮圖、處理後原圖、標記座標、備註
// 所有資料只存在這支手機的瀏覽器裡，不會上傳。

const DB_NAME = 'pill-counter', DB_VER = 1, STORE = 'records';
let dbPromise = null;

function req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error || new Error('IndexedDB 失敗')); }); }

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((res, rej) => {
    if (!('indexedDB' in self)) { rej(new Error('此瀏覽器不支援 IndexedDB')); return; }
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        s.createIndex('t', 't');
      }
    };
    r.onsuccess = () => { const db = r.result; db.onversionchange = () => db.close(); res(db); };
    r.onerror = () => rej(r.error || new Error('無法開啟資料庫'));
    r.onblocked = () => rej(new Error('資料庫被其他分頁佔用'));
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

async function store(mode) { const db = await openDB(); return db.transaction(STORE, mode).objectStore(STORE); }

/** 新增一筆紀錄，回傳 id */
export async function addRecord(rec) { return req((await store('readwrite')).add(rec)); }
/** 讀一筆（含圖片 Blob） */
export async function getRecord(id) { return req((await store('readonly')).get(id)); }
/** 局部更新 */
export async function updateRecord(id, patch) {
  const s = await store('readwrite');
  const cur = await req(s.get(id));
  if (!cur) throw new Error('紀錄不存在');
  const next = { ...cur, ...patch, id };
  await req(s.put(next));
  return next;
}
export async function deleteRecord(id) { return req((await store('readwrite')).delete(id)); }
export async function clearRecords() { return req((await store('readwrite')).clear()); }
export async function countRecords() { return req((await store('readonly')).count()); }

/** 列出紀錄（新→舊），不含原圖 Blob（縮圖保留），避免一次佔太多記憶體 */
export async function listRecords(limit = 500) {
  const s = await store('readonly');
  return new Promise((res, rej) => {
    const out = [];
    const c = s.index('t').openCursor(null, 'prev');
    c.onsuccess = () => {
      const cur = c.result;
      if (!cur || out.length >= limit) { res(out); return; }
      const { image, ...meta } = cur.value;
      meta.hasImage = !!image;
      out.push(meta);
      cur.continue();
    };
    c.onerror = () => rej(c.error);
  });
}

/** 舊版 localStorage 紀錄（無圖）搬進資料庫，只做一次 */
export async function migrateFromLocalStorage(key = 'pc_history_v1', flag = 'pc_migrated_db_v1') {
  try {
    if (localStorage.getItem(flag)) return 0;
    const old = JSON.parse(localStorage.getItem(key) || '[]');
    if (!Array.isArray(old) || !old.length) { localStorage.setItem(flag, '1'); return 0; }
    const s = await store('readwrite');
    for (const r of old.slice().reverse()) {
      await req(s.add({ t: r.t || Date.now(), drug: r.drug || '', memo: '', target: r.target ?? null, count: r.count ?? 0, auto: null, markers: [], thumb: null, image: null, w: 0, h: 0, R: 0, ver: 1 }));
    }
    localStorage.setItem(flag, '1');
    return old.length;
  } catch { return 0; }
}

/** 儲存空間資訊（MB） */
export async function storageInfo() {
  try {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    const { usage, quota } = await navigator.storage.estimate();
    return { usageMB: usage / 1048576, quotaMB: quota / 1048576 };
  } catch { return null; }
}
/** 要求瀏覽器不要在空間不足時自動清掉這個網站的資料 */
export async function requestPersist() {
  try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch {}
  return false;
}
