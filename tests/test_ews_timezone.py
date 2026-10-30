"""
Regression tests for EWS -> Firestore timestamp handling.

Bug (ews_firebase_sync.py, stream_ews_items):
    exchangelib returns `item.datetime_received` as a NAIVE datetime expressed in
    the mailbox server timezone (Africa/Cairo). The pipeline converted it with
    `datetime.fromtimestamp(dt.timestamp(), tz=utc)`, which interprets the naive
    value as UTC and therefore shifts every approval 2 hours EARLIER than reality.

These tests pin the conversion helper to the documented contract:
    naive Cairo 12:00  ->  2026-10-30T10:00:00+00:00 (UTC instant preserved)
"""

from datetime import datetime, timezone

import pytest

from crawler.pipelines.ews_firebase_sync import to_utc_datetime


def test_naive_server_time_is_interpreted_in_source_timezone():
    """A naive Cairo datetime must convert using Africa/Cairo, not UTC."""
    naive_cairo = datetime(2026, 10, 30, 12, 0, 0)

    result = to_utc_datetime(naive_cairo)

    assert result.tzinfo is timezone.utc
    assert result == datetime(2026, 10, 30, 10, 0, 0, tzinfo=timezone.utc)


def test_naive_during_dst_period_uses_three_hour_offset():
    """Egypt reinstated DST in 2023: Cairo is +03:00 in July, so naive 09:30 -> 06:30Z."""
    naive_cairo = datetime(2026, 7, 15, 9, 30, 0)

    result = to_utc_datetime(naive_cairo)

    assert result == datetime(2026, 7, 15, 6, 30, 0, tzinfo=timezone.utc)


def test_aware_input_is_converted_without_reinterpretation():
    """An already tz-aware value must be shifted, never re-based on wall clock."""
    aware = datetime(2026, 10, 30, 12, 0, 0, tzinfo=timezone.utc)

    result = to_utc_datetime(aware)

    assert result == aware


def test_none_falls_back_to_now_utc():
    result = to_utc_datetime(None)

    assert result.tzinfo is timezone.utc
    assert abs((datetime.now(timezone.utc) - result).total_seconds()) < 60


@pytest.mark.parametrize("hour", [0, 8, 14, 23])
def test_conversion_is_monotonic_and_lossless(hour):
    """Round-tripping back to Cairo wall time must reproduce the original."""
    from zoneinfo import ZoneInfo

    naive = datetime(2026, 10, 30, hour, 15, 0)
    utc = to_utc_datetime(naive)

    back = utc.astimezone(ZoneInfo("Africa/Cairo"))

    assert (back.hour, back.minute) == (hour, 15)
