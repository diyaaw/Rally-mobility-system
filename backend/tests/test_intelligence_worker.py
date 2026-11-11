import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest

from app.intelligence import worker


def test_worker_status_is_starting_before_any_tick():
    worker._last_tick_completed_at = None
    assert worker.worker_health_status() == "starting"


def test_worker_status_is_ok_shortly_after_a_tick():
    worker._last_tick_completed_at = datetime.now(timezone.utc)
    assert worker.worker_health_status() == "ok"


def test_worker_status_is_stalled_when_far_overdue(monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "INTELLIGENCE_EVALUATION_INTERVAL_SECONDS", 3.0)
    worker._last_tick_completed_at = datetime.now(timezone.utc) - timedelta(seconds=1000)
    assert worker.worker_health_status() == "stalled"


async def test_evaluation_tick_returns_zero_without_redis(monkeypatch):
    from app.core.database import SessionLocal as real_session_local

    with patch("app.intelligence.worker.get_redis", side_effect=RuntimeError("no redis")):
        count = await worker.run_evaluation_tick()
    assert count == 0


async def test_evaluation_tick_returns_zero_without_database(monkeypatch):
    with patch("app.intelligence.worker.SessionLocal", None):
        count = await worker.run_evaluation_tick()
    assert count == 0


async def test_evaluation_tick_evaluates_every_active_trip(fake_redis):
    trip_a, trip_b = uuid.uuid4(), uuid.uuid4()
    group_a, group_b = uuid.uuid4(), uuid.uuid4()

    class FakeSession:
        def close(self):
            pass

    evaluated = []

    async def fake_evaluate(db, redis, trip_id, group_id):
        evaluated.append(trip_id)
        return None

    with patch("app.intelligence.worker.get_redis", return_value=fake_redis), \
         patch("app.intelligence.worker.SessionLocal", return_value=FakeSession()), \
         patch("app.intelligence.worker._active_trips_sync", return_value=[(trip_a, group_a), (trip_b, group_b)]), \
         patch("app.intelligence.worker.evaluate_and_persist_trip", side_effect=fake_evaluate):
        count = await worker.run_evaluation_tick()

    assert count == 2
    assert set(evaluated) == {trip_a, trip_b}


async def test_evaluation_tick_continues_after_one_trip_fails(fake_redis):
    trip_a, trip_b = uuid.uuid4(), uuid.uuid4()

    class FakeSession:
        def close(self):
            pass

    async def flaky_evaluate(db, redis, trip_id, group_id):
        if trip_id == trip_a:
            raise RuntimeError("boom")
        return None

    with patch("app.intelligence.worker.get_redis", return_value=fake_redis), \
         patch("app.intelligence.worker.SessionLocal", return_value=FakeSession()), \
         patch("app.intelligence.worker._active_trips_sync", return_value=[(trip_a, uuid.uuid4()), (trip_b, uuid.uuid4())]), \
         patch("app.intelligence.worker.evaluate_and_persist_trip", side_effect=flaky_evaluate):
        count = await worker.run_evaluation_tick()

    # trip_a failed but trip_b still got evaluated — one bad trip must
    # never take down the whole tick.
    assert count == 1


# ---------------------------------------------------------------------------
# Distributed leader-lock tests
# ---------------------------------------------------------------------------

async def test_leader_lock_acquired_when_key_absent(fake_redis):
    """A worker with no existing lock in Redis becomes the leader."""
    pid = worker._WORKER_PID
    result = await worker._try_acquire_or_renew_leader_lock(fake_redis, ttl_ms=30_000)
    assert result is True
    # Verify the key was written with our PID as the value.
    stored = await fake_redis.get("intel:worker_leader")
    assert stored == pid


async def test_non_leader_skips_when_lock_held_by_other_pid(fake_redis):
    """A worker with a different PID in the lock value is told to skip."""
    from app.core.redis_keys import intel_worker_leader_key
    other_pid = str(int(worker._WORKER_PID) + 9999)
    await fake_redis.set(intel_worker_leader_key(), other_pid, px=30_000)

    result = await worker._try_acquire_or_renew_leader_lock(fake_redis, ttl_ms=30_000)
    assert result is False


async def test_leader_renews_its_own_lock(fake_redis):
    """The same process can renew the lock it already holds."""
    from app.core.redis_keys import intel_worker_leader_key
    pid = worker._WORKER_PID
    # Simulate a lock this process already holds with a short TTL.
    await fake_redis.set(intel_worker_leader_key(), pid, px=2_000)

    result = await worker._try_acquire_or_renew_leader_lock(fake_redis, ttl_ms=30_000)
    assert result is True
    # TTL should have been refreshed (fakeredis exposes pttl).
    remaining_ms = await fake_redis.pttl(intel_worker_leader_key())
    assert remaining_ms > 2_000  # renewed to 30s, not still at <= 2s


async def test_leader_lock_fails_open_on_redis_error():
    """If Redis raises, the helper returns True so no tick is silently lost."""
    broken_redis = AsyncMock()
    broken_redis.set.side_effect = Exception("connection refused")

    result = await worker._try_acquire_or_renew_leader_lock(broken_redis, ttl_ms=30_000)
    assert result is True


async def test_release_leader_lock_removes_key_for_current_pid(fake_redis):
    """Clean shutdown deletes the key when this process holds it."""
    from app.core.redis_keys import intel_worker_leader_key
    pid = worker._WORKER_PID
    await fake_redis.set(intel_worker_leader_key(), pid, px=30_000)

    await worker._release_leader_lock(fake_redis)
    assert await fake_redis.get(intel_worker_leader_key()) is None


async def test_release_leader_lock_leaves_key_held_by_other_pid(fake_redis):
    """Shutdown must NOT delete a lock held by a different process."""
    from app.core.redis_keys import intel_worker_leader_key
    other_pid = str(int(worker._WORKER_PID) + 1)
    await fake_redis.set(intel_worker_leader_key(), other_pid, px=30_000)

    await worker._release_leader_lock(fake_redis)
    assert await fake_redis.get(intel_worker_leader_key()) == other_pid
