"""
Background scheduler: every INTELLIGENCE_EVALUATION_INTERVAL_SECONDS,
re-evaluates every currently ACTIVE trip. One centralized loop, not one
task per trip or per user — this phase's spec explicitly allows either
"one evaluator per active trip" or "a scalable centralized worker model";
this picks the centralized model for simplicity, since duplicate-
evaluation safety is already guaranteed independently at the Redis-lock
and database-constraint level (see engine.py / events.py), not by this
loop's own structure.

Started once from app.main's lifespan; designed so this loop body (one
tick, over one process) can later be replaced by Celery/RQ/Redis
Streams/Kafka consuming the same evaluate_and_persist_trip() without
touching app/intelligence/engine.py at all.
"""

import asyncio
import logging
import os
import time
from datetime import datetime, timezone
from typing import List, Optional, Tuple
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.core import metrics
from app.core.config import settings
from app.core.database import SessionLocal
from app.core.redis import get_redis
from app.core.redis_keys import intel_worker_leader_key
from app.intelligence.engine import evaluate_and_persist_trip
from app.models.enums import TripStatus
from app.models.trip import Trip

logger = logging.getLogger("rally.intelligence.worker")

# Updated after every completed tick — read by /health (see
# worker_health_status() below). Process-local, deliberately not in Redis:
# it only needs to answer "is *this instance's* loop alive," which a
# restart trivially resets.
_last_tick_completed_at: Optional[datetime] = None

# Distributed leader-election lock TTL: 3× the evaluation interval so a
# slow-but-alive leader doesn't accidentally lose the lock mid-tick, while
# a dead/frozen process releases within ~3 intervals. Stored in Redis as
# milliseconds for SET PX compatibility.
_LEADER_LOCK_TTL_FACTOR = 3

# Module-level PID string — computed once, reused every tick as the lock
# value. Purely for debuggability (redis-cli GET intel:worker_leader shows
# which OS process is leader); the lock's correctness comes from NX, not
# from inspecting the value.
_WORKER_PID = str(os.getpid())


async def _try_acquire_or_renew_leader_lock(redis, ttl_ms: int) -> bool:
    """Attempt to acquire the distributed worker leader lock or, if this
    process already holds it (value matches our PID), renew its TTL.

    Returns True if this worker is (or just became) the leader and should
    run the tick.  Returns False if another process holds the lock — the
    caller should skip this tick entirely.

    Failure modes:
    - Redis command raises: returns True (fail-open — better to duplicate
      work than to silently stop all evaluation when Redis hiccups).
    - Redis is unavailable (RuntimeError from get_redis): caller already
      handles that before reaching here; this function is only called with
      a real client.
    """
    key = intel_worker_leader_key()
    try:
        # Attempt NX acquisition first (fast path for the common case where
        # no leader exists yet or the previous leader's key has expired).
        acquired = await redis.set(key, _WORKER_PID, nx=True, px=ttl_ms)
        if acquired:
            return True

        # Key exists — check whether *we* already hold it (e.g. we're mid-
        # way through the same process's second tick).  If so, renew the TTL
        # with PEXPIRE rather than a SET so we never accidentally overwrite
        # another worker's value with ours.
        current_holder = await redis.get(key)
        if current_holder == _WORKER_PID:
            await redis.pexpire(key, ttl_ms)
            return True

        # Another process holds the lock — skip this tick.
        logger.debug(
            "[leader-lock] pid=%s skipping tick — leader is pid=%s",
            _WORKER_PID,
            current_holder,
        )
        return False
    except Exception:
        # Any Redis error (timeout, connection refused, etc.) — fail open so
        # a transient Redis outage never silently stops intelligence evaluation.
        logger.warning(
            "[leader-lock] Redis error acquiring/renewing leader lock — "
            "running tick without distributed lock (fail-open)"
        )
        return True


async def _release_leader_lock(redis) -> None:
    """Delete the leader lock key on clean shutdown. Best-effort: errors
    are logged but never re-raised (we're already in shutdown path)."""
    key = intel_worker_leader_key()
    try:
        current_holder = await redis.get(key)
        if current_holder == _WORKER_PID:
            await redis.delete(key)
            logger.debug("[leader-lock] pid=%s released leader lock on shutdown", _WORKER_PID)
    except Exception as exc:
        logger.warning("[leader-lock] Could not release leader lock on shutdown: %s", exc)


def _active_trips_sync(db: Session) -> List[Tuple[UUID, UUID]]:
    rows = db.execute(select(Trip.id, Trip.group_id).where(Trip.status == TripStatus.ACTIVE)).all()
    return [(row.id, row.group_id) for row in rows]


async def run_evaluation_tick() -> int:
    """One pass over every active trip. Returns how many trips were
    evaluated (0 if Redis/the database are unavailable — logged, never
    raised, so a transient outage can't crash the whole worker loop)."""
    if SessionLocal is None:
        return 0
    try:
        redis = get_redis()
    except RuntimeError:
        return 0

    db = SessionLocal()
    try:
        try:
            active_trips = await run_in_threadpool(_active_trips_sync, db)
        except Exception:
            logger.exception("Failed to list active trips for intelligence evaluation")
            metrics.increment("intelligence_tick_errors_total", {"stage": "list_active_trips"})
            return 0

        evaluated = 0
        for trip_id, group_id in active_trips:
            start = time.monotonic()
            try:
                await evaluate_and_persist_trip(db, redis, trip_id, group_id)
                evaluated += 1
            except Exception:
                logger.exception("Intelligence evaluation failed for trip_id=%s", trip_id)
                metrics.increment("intelligence_tick_errors_total", {"stage": "evaluate_trip"})
            finally:
                metrics.observe("intelligence_evaluation_duration_ms", (time.monotonic() - start) * 1000)
        return evaluated
    finally:
        db.close()


async def run_intelligence_worker() -> None:
    """Long-lived loop, started as a background task from app.main's
    lifespan and cancelled on shutdown.

    Worker supervision (Part 12): every tick is wrapped in its own
    try/except — a failure logs (never `except: pass`), increments a
    metric, and the loop keeps running on its normal interval, exactly
    like every per-trip evaluation inside run_evaluation_tick() already
    does. Without this, an exception from something run_evaluation_tick()
    itself doesn't already catch internally (e.g. SessionLocal() failing
    to open a new session) would silently kill this entire background
    task — the intelligence engine would stop for the rest of the
    process's life with no log line and no restart.

    Distributed leader election (multi-worker Uvicorn): before each tick
    we attempt to acquire/renew `intel:worker_leader` in Redis. Only the
    process that holds the lock runs the tick; all others sleep for the
    next interval. This prevents N worker processes from all evaluating
    every active trip simultaneously — the per-trip `intel_eval_lock` in
    engine.py is a second layer of defence, but the leader lock eliminates
    the redundant work entirely rather than merely serialising it.

    Fail-open: if Redis is unavailable (_try_acquire_or_renew_leader_lock
    returns True despite a Redis error), all workers run — same behaviour
    as before this lock was added. A transient Redis outage must never
    silence intelligence evaluation."""
    global _last_tick_completed_at
    interval = settings.INTELLIGENCE_EVALUATION_INTERVAL_SECONDS
    leader_lock_ttl_ms = int(interval * _LEADER_LOCK_TTL_FACTOR * 1000)
    logger.info("Intelligence worker starting (pid=%s, interval=%.1fs)", _WORKER_PID, interval)
    redis_for_lock = None
    try:
        redis_for_lock = get_redis()
    except RuntimeError:
        logger.warning(
            "[leader-lock] Redis unavailable at worker startup — "
            "distributed leader election disabled; all workers will evaluate"
        )

    try:
        while True:
            await asyncio.sleep(interval)
            try:
                # ── Leader election ──────────────────────────────────────────
                # Refresh redis_for_lock every tick: Redis may have become
                # available after startup (e.g. a restart or delayed init).
                if redis_for_lock is None:
                    try:
                        redis_for_lock = get_redis()
                    except RuntimeError:
                        pass  # still unavailable — fail-open below

                if redis_for_lock is not None:
                    is_leader = await _try_acquire_or_renew_leader_lock(
                        redis_for_lock, leader_lock_ttl_ms
                    )
                    if not is_leader:
                        # Another worker holds the lock — skip this tick.
                        continue
                # ── End leader election ──────────────────────────────────────

                await run_evaluation_tick()
                _last_tick_completed_at = datetime.now(timezone.utc)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Intelligence worker tick failed unexpectedly — will retry next interval")
                metrics.increment("intelligence_tick_errors_total", {"stage": "tick"})
    except asyncio.CancelledError:
        logger.info("Intelligence worker stopped (pid=%s)", _WORKER_PID)
        if redis_for_lock is not None:
            await _release_leader_lock(redis_for_lock)
        raise


def worker_health_status() -> str:
    """"ok" once at least one tick has completed recently, "starting" if
    the loop just hasn't ticked yet, "stalled" if it has fallen far behind
    its own interval (e.g. stuck on a slow DB/Redis call) — used by
    GET /health, never exposes internal state beyond this label."""
    if _last_tick_completed_at is None:
        return "starting"
    age = (datetime.now(timezone.utc) - _last_tick_completed_at).total_seconds()
    stalled_after = max(settings.INTELLIGENCE_EVALUATION_INTERVAL_SECONDS * 5, 30)
    return "ok" if age <= stalled_after else "stalled"
