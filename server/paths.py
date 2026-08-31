from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BUILD_DIR = REPO_ROOT / "build"
DRIVER_BINARY = REPO_ROOT / "third_party" / "aeron" / "cmake-build" / "binaries" / "aeronmd"
RUNS_DIR = Path(__file__).resolve().parent / "runs"

REQUIRED_BINARIES = ["sequencer", "market_maker", "optimal_market_maker", "liquidity_taker"]


def require_built():
    missing = [name for name in REQUIRED_BINARIES if not (BUILD_DIR / name).exists()]
    if missing:
        raise RuntimeError(
            f"Missing binaries: {', '.join(missing)}. "
            "Build the project first -- see the README's Setting Up section "
            "(cmake -S . -B build && cmake --build build --parallel)."
        )
    if not DRIVER_BINARY.exists():
        raise RuntimeError(
            f"Media driver not found at {DRIVER_BINARY}. "
            "Build it first -- see the README's Setting Up section."
        )
