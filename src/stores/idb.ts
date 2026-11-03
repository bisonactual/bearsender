// IndexedDB: what BearSender keeps in this browser.
//
// The queue, the loaded program, the runtimes from real runs and the modes each job started from.
// Files are too big for localStorage, and each browser keeps its own: other people using the hosted
// page never see them. Every call settles, never throws: in a private window or with storage blocked,
// BearSender works on without keeping anything, and says so once. A write settles when its transaction
// has committed (or failed), not when its request has been accepted.

import { push } from './messages';

export type Store = 'queue' | 'current' | 'runtimes' | 'starts';

const NAME = 'bearsender';
const VERSION = 2;   // 2 added 'starts'

let db: Promise<IDBDatabase | null> | null = null;
let warned = false;

function failed(why: unknown): null {
  if (!warned) {
    warned = true;
    // A DOMException from a request (ConstraintError, QuotaExceededError) can come with no message: its name says it.
    const e = why as { message?: string; name?: string } | null;
    const text = (typeof e === 'object' && e && (e.message || e.name)) || String(why);
    push('error', `This browser won't keep the queue or the runtimes (${text}). They work until the page is reloaded.`);
  }
  return null;
}

function open(): Promise<IDBDatabase | null> {
  db ??= new Promise<IDBDatabase | null>(resolve => {
    try {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        for (const store of ['queue', 'current', 'runtimes', 'starts']) {
          if (!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store);
        }
      };
      // A newer BearSender in another tab upgrading the database: let it, this tab stops keeping things.
      req.onsuccess = () => { req.result.onversionchange = () => req.result.close(); resolve(req.result); };
      req.onerror = () => resolve(failed(req.error));
      req.onblocked = () => resolve(failed('the database is open in an older tab'));
    } catch (e) { resolve(failed(e)); }
  });
  return db;
}

function request<T>(store: Store, mode: IDBTransactionMode, make: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return open().then(d => new Promise<T | undefined>(resolve => {
    if (!d) { resolve(undefined); return; }
    try {
      const req = make(d.transaction(store, mode).objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { failed(req.error); resolve(undefined); };
    } catch (e) { failed(e); resolve(undefined); }
  }));
}

export interface Write { store: Store; key: string; value?: unknown; delete?: boolean; }

/** Writes in one transaction: all of them or none. True once the browser has committed them; false if
 *  the transaction was aborted (a request failed, quota, storage blocked), with the one warning. A failed
 *  request's error event is left alone, so the browser aborts the transaction and undoes the writes
 *  before it: cancelling it (preventDefault) would let the rest commit. A write that throws as it is
 *  asked for (a value that can't be stored) aborts the transaction too. */
export function write(writes: Write[]): Promise<boolean> {
  if (!writes.length) return Promise.resolve(true);
  return open().then(d => new Promise<boolean>(resolve => {
    if (!d) { resolve(false); return; }
    let tx: IDBTransaction | null = null;
    try {
      tx = d.transaction([...new Set(writes.map(w => w.store))], 'readwrite');
      const t = tx;
      t.oncomplete = () => resolve(true);
      t.onabort = () => { failed(t.error ?? 'the write was aborted'); resolve(false); };
      for (const w of writes) {
        const s = t.objectStore(w.store);
        if (w.delete) s.delete(w.key); else s.put(w.value, w.key);
      }
    } catch (e) {
      failed(e);
      try { tx?.abort(); } catch (_) { /* already finished */ }
      resolve(false);
    }
  }));
}

export function get<T>(store: Store, key: string): Promise<T | undefined> {
  return request<T>(store, 'readonly', s => s.get(key));
}

export function put(store: Store, key: string, value: unknown): Promise<boolean> {
  return write([{ store, key, value }]);
}

export function remove(store: Store, key: string): Promise<boolean> {
  return write([{ store, key, delete: true }]);
}

/** Every value in a store. */
export function all<T>(store: Store): Promise<T[]> {
  return request<T[]>(store, 'readonly', s => s.getAll()).then(v => v ?? []);
}

/** Every key and value in a store, for checking what was kept (a value can be anything, whatever its type says). */
export function entries(store: Store): Promise<[string, unknown][]> {
  return open().then(d => new Promise<[string, unknown][]>(resolve => {
    if (!d) { resolve([]); return; }
    try {
      const s = d.transaction(store, 'readonly').objectStore(store);
      const keys = s.getAllKeys(), values = s.getAll();
      values.onsuccess = () => resolve((keys.result ?? []).map((k, i) => [String(k), values.result[i]]));
      values.onerror = () => { failed(values.error); resolve([]); };
    } catch (e) { failed(e); resolve([]); }
  }));
}

/** Drops the kept values that aren't what `valid` expects, says how many went, and returns the rest. */
export async function validEntries<T>(store: Store, valid: (v: unknown) => v is T, what: string): Promise<T[]> {
  const list = await entries(store);
  const bad = list.filter(([, v]) => !valid(v));
  if (bad.length) {
    push('error', `${bad.length} saved ${what} couldn't be read and ${bad.length === 1 ? 'was' : 'were'} dropped; the rest are kept.`);
    write(bad.map(([key]) => ({ store, key, delete: true })));
  }
  return list.filter(([, v]) => valid(v)).map(([, v]) => v as T);
}
