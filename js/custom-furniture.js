/* 助手生成的家具模板，可在当前浏览器的不同项目中复用。 */
(() => {
  'use strict';
  const App = globalThis.App;
  const items = new Map();

  function template(raw){
    if (!raw || typeof raw.name !== 'string' || !raw.name.trim() ||
        typeof raw.type !== 'string' || !Number.isFinite(raw.w) || !Number.isFinite(raw.d) ||
        raw.w < 1 || raw.d < 1 || raw.w > 10000 || raw.d > 10000) return null;
    const normalized = App.geom.normalizeFurn({...raw, id:'template', name:raw.name.trim().slice(0, 120), cx:0, cy:0});
    if (!normalized) return null;
    const {cx, cy, id, ...asset} = normalized;
    return asset;
  }

  const ready = new Promise(resolve => {
    try {
      const request = indexedDB.open('interior-custom-furniture-v1' + App.core.projectScope, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('items', {keyPath:'id'});
        store.createIndex('signature', 'signature', {unique:true});
      };
      request.onerror = request.onblocked = () => resolve(null);
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        const load = db.transaction('items').objectStore('items').getAll();
        load.onsuccess = () => {
          for (const row of load.result){
            const asset = template(row);
            if (asset && typeof row.id === 'string' && typeof row.signature === 'string')
              items.set(row.id, {...asset,id:row.id,createdAt:row.createdAt,signature:row.signature});
          }
          resolve(db);
          if (items.size) App.interact.buildLib?.();
        };
        load.onerror = () => resolve(null);
      };
    } catch { resolve(null); }
  });

  function write(db, candidates){
    return new Promise((resolve, reject) => {
      const tx = db.transaction('items', 'readwrite');
      const store = tx.objectStore('items'), index = store.index('signature'), result = [];
      for (const row of candidates){
        const request = index.get(row.signature);
        request.onsuccess = () => {
          const saved = request.result;
          if (!saved) store.add(row);
          result.push(saved || row);
        };
      }
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }

  async function add(raw){
    const db = await ready;
    const candidates = new Map();
    for (const value of (Array.isArray(raw) ? raw : []).slice(0, 8)){
      const asset = template(value);
      if (!asset) continue;
      const signature = JSON.stringify(asset);
      if (candidates.has(signature)) continue;
      candidates.set(signature, {...asset,id:globalThis.crypto?.randomUUID?.() || App.geom.uid(),createdAt:Date.now(),signature});
    }
    if (!candidates.size) return {items:[], persisted:true};
    const batch = [...candidates.values()];
    let saved = batch, persisted = false;
    if (db){
      try { saved = await write(db, batch); persisted = true; }
      catch { /* 浏览器存储不可用时仍可在本次会话试用素材。 */ }
    }
    if (!persisted){
      const existing = new Map([...items.values()].map(row => [row.signature,row]));
      saved = batch.map(row => existing.get(row.signature) || row);
    }
    for (const row of saved) items.set(row.id, row);
    App.interact.buildLib?.();
    return {items:saved, persisted};
  }

  App.customFurniture = {list:() => [...items.values()].sort((a,b) => b.createdAt-a.createdAt), add};
})();
