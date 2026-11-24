/**
 * Memory benchmark: InMemoryRateLimitStore — two-bucket counter vs. the old
 * timestamp-array approach.
 *
 * Run with:
 *   npx ts-node bench/rate-limit-store-memory.ts
 *
 * Outputs a BENCHMARK_RESULT_JSON line for CI regression checks.
 */

import { InMemoryRateLimitStore } from '../src/rate-limiter';

const UNIQUE_KEYS = 10_000;
const REQUESTS_PER_KEY = 100;
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 50;

function heapMB(): number {
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

function gc(): void {
  if (global.gc) global.gc();
}

/** Simulate the old timestamp-array store. Kept live in memory. */
function buildOldStore(): Map<string, number[]> {
  const store = new Map<string, number[]>();
  const now = Date.now();
  for (let k = 0; k < UNIQUE_KEYS; k++) {
    const key = `ip-${k}`;
    const timestamps: number[] = [];
    for (let r = 0; r < REQUESTS_PER_KEY; r++) {
      const t = now + r;
      // Sliding-window filter (mirrors the old implementation exactly)
      const inWindow = timestamps.filter((ts) => t - ts < WINDOW_MS);
      if (inWindow.length < MAX_REQUESTS) {
        inWindow.push(t);
      }
      store.set(key, inWindow);
    }
  }
  return store;
}

/** Populate the new two-bucket store. Kept live in memory. */
function buildNewStore(): InMemoryRateLimitStore {
  const store = new InMemoryRateLimitStore();
  const now = Date.now();
  for (let k = 0; k < UNIQUE_KEYS; k++) {
    const key = `ip-${k}`;
    for (let r = 0; r < REQUESTS_PER_KEY; r++) {
      store.consume(key, now + r, WINDOW_MS, MAX_REQUESTS);
    }
  }
  return store;
}

interface BenchmarkResult {
  benchmark: 'sep10-auth-rate-limit-store-memory';
  uniqueKeys: number;
  requestsPerKey: number;
  maxRequestsPerWindow: number;
  oldStoreDeltaMB: number;
  newStoreDeltaMB: number;
  memoryReductionMB: number;
  memoryReductionPct: number;
  timestamp: string;
}

// Measure old store
gc();
const beforeOld = heapMB();
const oldStore = buildOldStore();  // kept alive so GC can't collect it
gc();
const afterOld = heapMB();
const oldDelta = Number((afterOld - beforeOld).toFixed(2));

// Discard old store, measure new store
(oldStore as unknown) && void oldStore; // prevent optimisation-away
gc();
const beforeNew = heapMB();
const newStore = buildNewStore();
gc();
const afterNew = heapMB();
const newDelta = Number((afterNew - beforeNew).toFixed(2));

// Keep newStore alive past the measurement
void newStore;

const reductionMB = Number((oldDelta - newDelta).toFixed(2));
const reductionPct =
  oldDelta > 0 ? Number(((reductionMB / oldDelta) * 100).toFixed(1)) : 0;

const result: BenchmarkResult = {
  benchmark: 'sep10-auth-rate-limit-store-memory',
  uniqueKeys: UNIQUE_KEYS,
  requestsPerKey: REQUESTS_PER_KEY,
  maxRequestsPerWindow: MAX_REQUESTS,
  oldStoreDeltaMB: oldDelta,
  newStoreDeltaMB: newDelta,
  memoryReductionMB: reductionMB,
  memoryReductionPct: reductionPct,
  timestamp: new Date().toISOString(),
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`\nRate-limit store memory benchmark`);
  console.log(`  Keys: ${UNIQUE_KEYS.toLocaleString()}  ·  Requests/key: ${REQUESTS_PER_KEY}  ·  maxRequests: ${MAX_REQUESTS}`);
  console.log(`  Old store (timestamp array): +${oldDelta.toFixed(2)} MB`);
  console.log(`  New store (two-bucket):      +${newDelta.toFixed(2)} MB`);
  if (reductionMB >= 0) {
    console.log(`  Reduction: ${reductionMB} MB  (${reductionPct}% less)\n`);
  } else {
    console.log(`  Overhead: ${Math.abs(reductionMB)} MB  (new store uses more in this scenario)\n`);
  }
  console.log(`BENCHMARK_RESULT_JSON=${JSON.stringify(result)}`);
}
