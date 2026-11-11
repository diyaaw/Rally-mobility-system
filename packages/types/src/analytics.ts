/**
 * Analytics types mirroring the FastAPI backend''s Pydantic schemas.
 *
 * TripAnalyticsSnapshot corresponds to the `trip_analytics_snapshots` table
 * row that the backend generates once when a trip ends (see
 * backend/app/models/trip_analytics_snapshot.py and
 * backend/app/analytics/snapshot.py).
 *
 * The `GET /api/v1/trips/{trip_id}/analytics` endpoint returns a `TripAnalytics`
 * shape (see frontend/lib/api/types.ts::TripAnalytics) for live or computed
 * analytics, but `TripAnalyticsSnapshot` captures the flat, simplified fields
 * exposed for the trip summary UI (total_distance_m, top/avg speed, etc.)
 * as specified in the product requirements.
 *
 * Zero-vs-null contract: `null` means "could not be calculated" (no GPS
 * data, trip never started, etc.) -- never coerce to 0 in the UI.
 */

export interface TripAnalyticsSnapshot {
  /** UUID of this snapshot row. */
  id: string;
  /** UUID of the trip this snapshot belongs to (unique -- one per trip). */
  trip_id: string;
  /** Total GPS distance traveled in metres. Null when no location history exists. */
  total_distance_m: number | null;
  /** Peak speed recorded across all members, in m/s. Null when no speed data exists. */
  top_speed_m_s: number | null;
  /** Mean speed across the trip duration, in m/s. Null when duration or distance is unavailable. */
  avg_speed_m_s: number | null;
  /** Elapsed trip time in seconds. Null when the trip never started. */
  duration_seconds: number | null;
  /** Composite safety score 0-100 (higher = safer). Null when insufficient data. */
  safety_score: number | null;
  /** ISO-8601 UTC timestamp when this snapshot was generated. */
  created_at: string;
}
