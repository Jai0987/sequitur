#!/usr/bin/env python3
"""Phase 2: does the fill arrival process actually look like the Poisson
process the classical Avellaneda-Stoikov model assumes, or does the real
system (sequencing, queueing under load) produce something different?

Three checks:
  1. Inter-arrival time distribution vs the theoretical exponential
     (Kolmogorov-Smirnov goodness-of-fit test), both against the rate the
     model predicts and against the best-fit rate to the data itself, to
     separate "wrong rate" from "wrong shape".
  2. Lag-1 autocorrelation of inter-arrival times. True Poisson gaps are
     independent of each other. Positive autocorrelation is a signature of
     clustering or queueing: a slow patch causes a burst once it clears.
  3. Whether the arrival rate is stable over the run. A Poisson process
     assumes a constant rate; systematic drift breaks that assumption
     regardless of what the gaps' distribution looks like.
"""
import sys

import numpy as np
import pandas as pd
from scipy import stats
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt


def main(path: str, theoretical_rate: float, out_png: str) -> int:
    df = pd.read_csv(path)
    t = df["timestamp_ns"].values / 1e9
    t = t - t[0]
    gaps = np.diff(t)

    n = len(gaps)
    empirical_rate = n / t[-1]
    empirical_mean_gap = gaps.mean()
    theoretical_mean_gap = 1.0 / theoretical_rate

    print(f"Fills: {len(df)}  (gaps analyzed: {n})")
    print(f"Run duration: {t[-1]:.1f}s")
    print(f"Empirical rate:   {empirical_rate:.4f} fills/sec  (mean gap {empirical_mean_gap * 1000:.2f} ms)")
    print(f"Theoretical rate: {theoretical_rate:.4f} fills/sec  (mean gap {theoretical_mean_gap * 1000:.2f} ms)")
    print()

    ks_stat, ks_p = stats.kstest(gaps, "expon", args=(0, theoretical_mean_gap))
    print(f"KS test vs Exponential(theoretical rate={theoretical_rate:.3f}): D={ks_stat:.4f}, p={ks_p:.4g}")
    if ks_p < 0.05:
        print("  -> REJECT: gaps do not look like the theoretical exponential (p < 0.05)")
    else:
        print("  -> cannot reject: gaps are consistent with the theoretical exponential")
    print()

    ks_stat_emp, ks_p_emp = stats.kstest(gaps, "expon", args=(0, empirical_mean_gap))
    print(f"KS test vs Exponential(fit to empirical rate): D={ks_stat_emp:.4f}, p={ks_p_emp:.4g}")
    if ks_p_emp < 0.05:
        print("  -> REJECT: even at the best-fit rate, the SHAPE is not exponential")
    else:
        print("  -> cannot reject: shape is exponential, just at a different rate than theory predicted")
    print()

    autocorr = np.corrcoef(gaps[:-1], gaps[1:])[0, 1]
    print(f"Lag-1 autocorrelation of gaps: {autocorr:+.4f}")
    if abs(autocorr) > 0.1:
        print("  -> notable correlation: consecutive gaps are NOT independent (queueing/clustering signature)")
    else:
        print("  -> negligible correlation: consistent with independent gaps")
    print()

    window_s = max(5.0, t[-1] / 30)
    bins = np.arange(0, t[-1] + window_s, window_s)
    counts, _ = np.histogram(t, bins=bins)
    rolling_rate = counts / window_s

    fig, axes = plt.subplots(1, 3, figsize=(15, 4.2))

    ax = axes[0]
    ax.hist(gaps, bins=40, density=True, alpha=0.55, color="#1FA37D", label="empirical")
    xs = np.linspace(0, gaps.max(), 300)
    ax.plot(xs, stats.expon.pdf(xs, scale=theoretical_mean_gap), color="#D9A441", lw=2, label="theoretical exponential")
    ax.set_xlabel("inter-arrival gap (s)")
    ax.set_ylabel("density")
    ax.set_title("Gap distribution vs theory")
    ax.legend(fontsize=8)

    ax = axes[1]
    stats.probplot(gaps, dist=stats.expon(scale=theoretical_mean_gap), plot=ax)
    ax.set_title("QQ plot vs theoretical exponential")

    ax = axes[2]
    ax.plot(bins[:-1], rolling_rate, color="#1FA37D", lw=1.5)
    ax.axhline(theoretical_rate, color="#D9A441", lw=2, linestyle="--", label="theoretical rate")
    ax.set_xlabel("time (s)")
    ax.set_ylabel("fills / sec")
    ax.set_title(f"Rolling arrival rate ({window_s:.0f}s windows)")
    ax.legend(fontsize=8)

    fig.tight_layout()
    fig.savefig(out_png, dpi=150)
    print(f"Saved plot to {out_png}")

    return 0


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} <fill_log.csv> <theoretical_rate> [out.png]")
        sys.exit(1)
    sys.exit(main(sys.argv[1], float(sys.argv[2]), sys.argv[3] if len(sys.argv) > 3 else "phase2_arrivals.png"))
