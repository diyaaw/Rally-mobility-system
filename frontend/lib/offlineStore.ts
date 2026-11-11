import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { LocationCreate } from './api/types';

export interface QueuedLocationRecord extends LocationCreate {
  id?: number;
  queued_at?: number;
}

export interface RallyOfflineDB extends DBSchema {
  queued_locations: {
    key: number;
    value: QueuedLocationRecord;
  };
}

export const OFFLINE_DB_NAME = 'rally_offline_db';
export const QUEUED_LOCATIONS_STORE = 'queued_locations';
export const OFFLINE_DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<RallyOfflineDB>> | null = null;

/**
 * Lazily opens and initializes the IndexedDB store for offline GPS pings.
 */
export function getOfflineDB(): Promise<IDBPDatabase<RallyOfflineDB>> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('IndexedDB is not available in non-browser environments.'));
  }
  if (!dbPromise) {
    dbPromise = openDB<RallyOfflineDB>(OFFLINE_DB_NAME, OFFLINE_DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(QUEUED_LOCATIONS_STORE)) {
          db.createObjectStore(QUEUED_LOCATIONS_STORE, {
            keyPath: 'id',
            autoIncrement: true,
          });
        }
      },
    });
  }
  return dbPromise;
}

/**
 * Enqueues a failed or offline GPS ping into IndexedDB.
 */
export async function enqueueLocation(locationPayload: LocationCreate): Promise<number | undefined> {
  if (typeof window === 'undefined') return undefined;
  try {
    const db = await getOfflineDB();
    const entry: QueuedLocationRecord = {
      ...locationPayload,
      queued_at: Date.now(),
    };
    const id = await db.add(QUEUED_LOCATIONS_STORE, entry);
    return id;
  } catch (err) {
    console.warn('[offlineStore] Failed to enqueue location ping:', err);
    return undefined;
  }
}

/**
 * Retrieves all buffered GPS pings currently stored in IndexedDB.
 */
export async function getQueuedLocations(): Promise<QueuedLocationRecord[]> {
  if (typeof window === 'undefined') return [];
  try {
    const db = await getOfflineDB();
    return await db.getAll(QUEUED_LOCATIONS_STORE);
  } catch (err) {
    console.warn('[offlineStore] Failed to retrieve queued locations:', err);
    return [];
  }
}

/**
 * Purges all processed pings after successful backend synchronization.
 */
export async function clearQueuedLocations(): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    const db = await getOfflineDB();
    await db.clear(QUEUED_LOCATIONS_STORE);
  } catch (err) {
    console.warn('[offlineStore] Failed to clear queued locations:', err);
  }
}

/**
 * Deletes specific queued items by IDs (useful for partial batches).
 */
export async function deleteQueuedLocations(ids: number[]): Promise<void> {
  if (typeof window === 'undefined' || ids.length === 0) return;
  try {
    const db = await getOfflineDB();
    const tx = db.transaction(QUEUED_LOCATIONS_STORE, 'readwrite');
    await Promise.all(ids.map((id) => tx.store.delete(id)));
    await tx.done;
  } catch (err) {
    console.warn('[offlineStore] Failed to delete specific queued locations:', err);
  }
}
