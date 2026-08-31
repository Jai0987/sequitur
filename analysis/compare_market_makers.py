#!/usr/bin/env python3
"""Compare a fixed-delta market maker's run against an Avellaneda-Stoikov
market maker's run on the same order flow: final inventory, how much
inventory risk each carried over the run, and realized spread P&L."""
import sys
import pandas as pd


def summarize(path: str) -> dict:
    df = pd.read_csv(path)
    signed_pnl = (df["price"] - df["true_price_at_trade"]) * df["quantity"].where(
        df["side"] == "SELL", -df["quantity"]
    )
    return {
        "fills": len(df),
        "final_inventory": df["inventory_after"].iloc[-1],
        "inventory_std": df["inventory_after"].std(),
        "max_abs_inventory": df["inventory_after"].abs().max(),
        "realized_pnl": signed_pnl.sum(),
    }


def main(baseline_path: str, optimal_path: str) -> int:
    baseline = summarize(baseline_path)
    optimal = summarize(optimal_path)

    print(f"{'metric':<20}{'fixed-delta':>15}{'avellaneda-stoikov':>22}")
    for key in ["fills", "final_inventory", "inventory_std", "max_abs_inventory", "realized_pnl"]:
        print(f"{key:<20}{baseline[key]:>15.3f}{optimal[key]:>22.3f}")

    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <baseline_fills.csv> <optimal_fills.csv>")
        sys.exit(1)
    sys.exit(main(sys.argv[1], sys.argv[2]))
