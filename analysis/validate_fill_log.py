#!/usr/bin/env python3
"""Sanity-check a market_maker fill log before trusting it for analysis.

Checks, per the phase 1 design spec:
  1. global_sequence has no gaps.
  2. The running inventory implied by summing signed fills matches the
     recorded inventory_after column.
  3. The empirical arrival rate is in a plausible range (just a sanity
     print, not a strict pass/fail -- real arrivals are random).
"""
import sys
import pandas as pd


def main(path: str) -> int:
    df = pd.read_csv(path)
    ok = True

    expected_seq = range(df["global_sequence"].iloc[0], df["global_sequence"].iloc[0] + len(df))
    if list(df["global_sequence"]) != list(expected_seq):
        print("FAIL: global_sequence has gaps or is out of order")
        ok = False
    else:
        print(f"OK: global_sequence is contiguous ({len(df)} rows)")

    signed_qty = df["quantity"].where(df["side"] == "SELL", -df["quantity"])
    running_inventory = signed_qty.cumsum()
    if not (running_inventory.round(9) == df["inventory_after"].round(9)).all():
        print("FAIL: recorded inventory_after does not match cumulative signed fills")
        ok = False
    else:
        print("OK: inventory_after matches cumulative signed fills")

    duration_s = (df["timestamp_ns"].iloc[-1] - df["timestamp_ns"].iloc[0]) / 1e9
    if duration_s > 0:
        rate = len(df) / duration_s
        print(f"INFO: empirical fill rate = {rate:.2f} fills/sec over {duration_s:.1f}s")

    return 0 if ok else 1


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <fill_log.csv>")
        sys.exit(1)
    sys.exit(main(sys.argv[1]))
