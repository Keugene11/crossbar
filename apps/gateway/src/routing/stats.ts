/**
 * Rolling per-endpoint health and performance windows.
 *
 * In-memory and therefore single-node: with several gateway instances each one
 * learns independently. That is an acceptable v1 trade because the windows are
 * short and self-healing; this module is the seam where a shared store would go.
 */

export interface EndpointStats {
  /** A failure inside the outage window -- deprioritised, never excluded. */
  recentOutage: boolean;
  /** Median time to first token, ms. Null until a sample exists. */
  ttftMsP50: number | null;
  /** Median completion tokens per second. Null until a sample exists. */
  throughputP50: number | null;
}

export const EMPTY_STATS: EndpointStats = {
  recentOutage: false,
  ttftMsP50: null,
  throughputP50: null,
};

export interface StatsTrackerOptions {
  /** How long a failure keeps deprioritising an endpoint. */
  outageWindowMs?: number;
  /** Samples retained per endpoint per metric. */
  sampleSize?: number;
  now?: () => number;
}

interface EndpointState {
  lastFailureAt: number;
  ttft: number[];
  throughput: number[];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lo = sorted[mid - 1] ?? 0;
  const hi = sorted[mid] ?? 0;
  return (lo + hi) / 2;
}

export class StatsTracker {
  readonly #state = new Map<string, EndpointState>();
  readonly #outageWindowMs: number;
  readonly #sampleSize: number;
  readonly #now: () => number;

  constructor(opts: StatsTrackerOptions = {}) {
    this.#outageWindowMs = opts.outageWindowMs ?? 30_000;
    this.#sampleSize = opts.sampleSize ?? 50;
    this.#now = opts.now ?? Date.now;
  }

  #entry(endpointId: string): EndpointState {
    let s = this.#state.get(endpointId);
    if (!s) {
      s = { lastFailureAt: 0, ttft: [], throughput: [] };
      this.#state.set(endpointId, s);
    }
    return s;
  }

  #push(list: number[], value: number): void {
    list.push(value);
    if (list.length > this.#sampleSize) list.shift();
  }

  recordFailure(endpointId: string): void {
    this.#entry(endpointId).lastFailureAt = this.#now();
  }

  recordSuccess(
    endpointId: string,
    sample: { ttftMs?: number; tokensPerSecond?: number } = {},
  ): void {
    const s = this.#entry(endpointId);
    if (typeof sample.ttftMs === "number") this.#push(s.ttft, sample.ttftMs);
    if (typeof sample.tokensPerSecond === "number" && sample.tokensPerSecond > 0) {
      this.#push(s.throughput, sample.tokensPerSecond);
    }
  }

  get(endpointId: string): EndpointStats {
    const s = this.#state.get(endpointId);
    if (!s) return EMPTY_STATS;
    return {
      recentOutage: this.#now() - s.lastFailureAt < this.#outageWindowMs,
      ttftMsP50: median(s.ttft),
      throughputP50: median(s.throughput),
    };
  }

  /** Test helper. */
  reset(): void {
    this.#state.clear();
  }
}
