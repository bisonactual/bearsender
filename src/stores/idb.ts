// ═══════════════════════════════════════════════
// IndexedDB — what BearSender keeps in this browser
// ═══════════════════════════════════════════════
//
// The queue, the loaded program and the runtimes from real runs. Files are too big for
// localStorage, and each browser keeps its own: other people using the hosted page never see them.
// Every call settles, never throws: in a private window or with storage blocked, BearSender works
// on without keeping anything, and says so once.

import { push } from './messages';

export type Store = 'queue' | 'current' | 'runtimes';

const NAME = 'bearsender';
const VERSION = 1;

let db: Promise<IDBDatabase | null> | null = null;
let warned = false;

function failed(why: unknown): null {
  if (!warned) {
    warned = true;
    push('error', `This browser won't keep the queue or the runtimes (${why instanceof Error ? why.message : String(why)}). They work until the page is reloaded.`);
  }
  return null;
}

function open(): Promise<IDBDatabase | null> {
  db ??= new Promise<IDBDatabase | null>(resolve => {
    try {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        for (const store of ['queue', 'current', 'runtimes']) {
          if (!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store);
        }
      };
      req.onsuccess = () => resolve(req.result);
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

export function get<T>(store: Store, key: string): Promise<T | undefined> {
  return request<T>(store, 'readonly', s => s.get(key));
}

export function put(store: Store, key: string, value: unknown): Promise<unknown> {
  return request(store, 'readwrite', s => s.put(value, key));
}

export function remove(store: Store, key: string): Promise<unknown> {
  return request(store, 'readwrite', s => s.delete(key));
}

/** Every value in a store. */
export function all<T>(store: Store): Promise<T[]> {
  return request<T[]>(store, 'readonly', s => s.getAll()).then(v => v ?? []);
}
