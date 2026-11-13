'use client';

import { useEffect, useRef, useCallback } from 'react';
import { getQueuedLocations, clearQueuedLocations, enqueueLocation } from '@/lib/offlineStore';
import { submitLocation } from '@/lib/api/locations';
import type { LocationCreate } from '@/lib/api/types';

/**
 * useOfflineSync — drains the IndexedDB queue of GPS pings that were
 * recorded while the device was offline (or the backend was unreachable),
 * uploading them to the backend as soon as connectivity is restored.
 *
 * The hook fires:
 *   1. on mount (picks up anything left from a previous session)
 *   2. whenever the browser's `online` event fires (actual reconnect)
 *   3. on a periodic interval (SYNC_INTERVAL_MS) as a safety net
 *
 * Each sync attempt is de-duplicated: only one flush runs at a time.
 * After a successful flush the queue is cleared — partial failures
 * (some points accepted, some rejected) are not retried individually;
 * the backend's own dedup layer (timestamp + user_id) handles that.
 */

const SYNC_INTERVAL_MS = 30_000; // 30s safety-net poll

export function useOfflineSync(tripId: string | null, enabled: boolean = true): {
  /** Manually enqueue a location that couldn't be sent in real time. */
  bufferLocation: (payload: LocationCreate) => Promise<void>;
  /** Force a sync attempt now. */
  syncNow: () => Promise<number>;
} {
  const flushingRef = useRef(false);

  const flush = useCallback(async (): Promise<number> => {
    if (!tripId || flushingRef.current) return 0;
    flushingRef.current = true;
    try {
      const queued = await getQueuedLocations();
      if (queued.length === 0) return 0;

      console.log(`[offlineSync] Flushing ${queued.length} buffered location(s) for trip ${tripId}`);

      let sent = 0;
      // Send in chronological order (oldest first)
      const sorted = queued.sort((a, b) => (a.queued_at ?? 0) - (b.queued_at ?? 0));
      for (const loc of sorted) {
        try {
          await submitLocation(tripId, {
            latitude: loc.latitude,
            longitude: loc.longitude,
            accuracy: loc.accuracy,
            speed: loc.speed,
            heading: loc.heading,
          });
          sent++;
        } catch (err) {
          console.warn('[offlineSync] Failed to submit buffered location:', err);
          // Stop on first failure — remaining items stay queued for next attempt
          break;
        }
      }

      if (sent === sorted.length) {
        // All sent successfully — clear the entire queue
        await clearQueuedLocations();
      }
      console.log(`[offlineSync] Flushed ${sent}/${queued.length} buffered locations`);
      return sent;
    } catch (err) {
      console.warn('[offlineSync] Flush error:', err);
      return 0;
    } finally {
      flushingRef.current = false;
    }
  }, [tripId]);

  const bufferLocation = useCallback(async (payload: LocationCreate): Promise<void> => {
    await enqueueLocation(payload);
  }, []);

  useEffect(() => {
    if (!enabled || !tripId) return;

    // Flush on mount (pick up from previous session)
    void flush();

    // Flush when browser comes back online
    const onOnline = () => {
      console.log('[offlineSync] Browser came online — syncing buffered locations');
      void flush();
    };
    window.addEventListener('online', onOnline);

    // Safety-net periodic flush
    const interval = setInterval(() => {
      if (navigator.onLine) void flush();
    }, SYNC_INTERVAL_MS);

    return () => {
      window.removeEventListener('online', onOnline);
      clearInterval(interval);
    };
  }, [enabled, tripId, flush]);

  return { bufferLocation, syncNow: flush };
}

