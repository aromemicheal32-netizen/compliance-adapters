/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

import { RequestHandler } from 'express';

export interface RateLimiterOptions {
  windowMs?: number;
  maxRequests?: number;
  keyGenerator?: (req: import('express').Request) => string;
  store?: RateLimitStore;
  /**
   * Return `true` (or a promise resolving to `true`) to exempt a request from
   * rate limiting, e.g. internal health checkers or trusted partner IPs.
   * Skipped requests never consume tokens.
   */
  skip?: (req: import('express').Request) => boolean | Promise<boolean>;
  /**
   * Maximum number of unique keys tracked by the built-in store before the
   * oldest entry is evicted. Defaults to no limit.
   * Pass a value to bound memory under key-flood attacks (e.g. spoofed IPs).
   */
  maxKeys?: number;
  /**
   * When `true` (default), set `RateLimit-Limit`, `RateLimit-Remaining`, and
   * `RateLimit-Reset` headers on every response. Set to `false` to suppress them.
   */
  standardHeaders?: boolean;
}

export interface RateLimitDecision {
  allowed: boolean;
  count: number;
  resetAt: number;
}

export interface RateLimitStore {
  consume(
    key: string,
    now: number,
    windowMs: number,
    maxRequests: number,
  ): RateLimitDecision | Promise<RateLimitDecision>;
}

/**
 * Two-bucket sliding-window entry.
 *
 * Memory is O(1) per key regardless of maxRequests. The window is divided into
 * two half-windows (current and previous). On each request we check whether the
 * current-bucket start is still within the first half-window; if the full
 * window has rolled past we discard the previous bucket and promote current →
 * previous. The effective count is:
 *
 *   prevCount * (elapsed in current bucket / windowMs) + curCount
 *
 * This gives a continuous approximation equivalent to a true sliding window
 * while storing only two integers per key.
 */
interface RateLimitEntry {
  /** Start timestamp of the current bucket (ms). */
  bucketStart: number;
  /** Request count in the current (most recent) bucket. */
  curCount: number;
  /** Request count in the previous bucket. */
  prevCount: number;
}

const DEFAULT_WINDOW_MS = 60_000; // 1 minute
const DEFAULT_MAX_REQUESTS = 100;

function defaultKeyGenerator(req: import('express').Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly store = new Map<string, RateLimitEntry>();
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private readonly maxKeys: number | undefined;

  constructor(maxKeys?: number) {
    this.maxKeys = maxKeys;
  }

  consume(
    key: string,
    now: number,
    windowMs: number,
    maxRequests: number,
  ): RateLimitDecision {
    this.ensureSweepTimer(windowMs);

    let entry = this.store.get(key);
    if (!entry) {
      // Evict the oldest key when the cap is reached.
      if (this.maxKeys !== undefined && this.store.size >= this.maxKeys) {
        const oldest = this.store.keys().next().value;
        if (oldest !== undefined) this.store.delete(oldest);
      }
      entry = { bucketStart: now, curCount: 0, prevCount: 0 };
      this.store.set(key, entry);
    }

    const elapsed = now - entry.bucketStart;

    if (elapsed >= windowMs * 2) {
      // Both buckets are entirely outside the window — reset.
      entry.bucketStart = now;
      entry.curCount = 0;
      entry.prevCount = 0;
    } else if (elapsed >= windowMs) {
      // Current bucket has aged past one full window; it becomes the previous bucket.
      entry.prevCount = entry.curCount;
      entry.curCount = 0;
      entry.bucketStart = entry.bucketStart + windowMs;
    }

    // Weighted count: portion of the previous bucket still inside the window
    // plus all requests in the current bucket. We use floor to avoid rounding
    // a near-zero fraction up to 1 (which would cause a spurious block).
    const prevWeight = Math.max(0, 1 - (now - entry.bucketStart) / windowMs);
    const count = Math.floor(entry.prevCount * prevWeight) + entry.curCount;

    // resetAt: when the current bucket will have fully aged out of the window.
    const resetAt = entry.bucketStart + windowMs;

    if (count >= maxRequests) {
      return { allowed: false, count, resetAt };
    }

    entry.curCount += 1;
    return { allowed: true, count: count + 1, resetAt };
  }

  private ensureSweepTimer(windowMs: number): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.store) {
        if (now - entry.bucketStart >= windowMs * 2) {
          this.store.delete(key);
        }
      }
    }, windowMs);

    if (this.sweepTimer.unref) {
      this.sweepTimer.unref();
    }
  }
}

function validatePositiveInteger(value: number, optionName: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `rateLimiter: "${optionName}" must be a positive integer. Received ${value}.`,
    );
  }
}

/**
 * Creates an Express middleware that rate-limits incoming requests.
 *
 * Uses a two-bucket sliding-window counter keyed by client IP (or a
 * custom key generator). Memory per key is O(1) regardless of maxRequests —
 * only two integer counts are stored. Old entries are evicted lazily when both
 * of their buckets have expired — no external store (Redis, etc.) is required.
 * Pass `maxKeys` to cap the number of tracked keys and bound memory under a
 * key-flood attack (spoofed IPs, etc.).
 *
 * When the limit is exceeded the middleware responds with **429**
 * and a JSON body:
 *
 * ```json
 * { "error": "rate_limit_exceeded", "retryAfter": <seconds> }
 * ```
 *
 * Unless `standardHeaders` is `false`, every response also carries the IETF
 * draft `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` headers.
 *
 * @example
 * ```ts
 * import express from 'express';
 * import { rateLimiter } from 'sep10-auth';
 *
 * const app = express();
 *
 * // 10 requests per 30 seconds
 * app.use('/api/challenge', rateLimiter({ windowMs: 30_000, maxRequests: 10 }));
 * ```
 */
export function rateLimiter(options: RateLimiterOptions = {}): RequestHandler {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const keyFn = options.keyGenerator ?? defaultKeyGenerator;
  validatePositiveInteger(windowMs, 'windowMs');
  validatePositiveInteger(maxRequests, 'maxRequests');
  const standardHeaders = options.standardHeaders ?? true;
  const store = options.store ?? new InMemoryRateLimitStore(options.maxKeys);

  const skip = options.skip;

  const consume: RequestHandler = (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    Promise.resolve(store.consume(key, now, windowMs, maxRequests))
      .then((decision) => {
        if (standardHeaders) {
          res.set({
            'RateLimit-Limit': String(maxRequests),
            'RateLimit-Remaining': String(Math.max(0, maxRequests - decision.count)),
            'RateLimit-Reset': String(Math.max(0, Math.ceil((decision.resetAt - now) / 1000))),
          });
        }
        if (!decision.allowed) {
          const retryAfter = Math.max(
            1,
            Math.ceil((decision.resetAt - now) / 1000),
          );
          res
            .status(429)
            .set('Retry-After', String(retryAfter))
            .json({ error: 'rate_limit_exceeded', retryAfter });
          return;
        }
        next();
      })
      .catch(next);
  };

  if (!skip) return consume;

  return (req, res, next) => {
    Promise.resolve()
      .then(() => skip(req))
      .then((skipped) => (skipped ? next() : consume(req, res, next)), next);
  };
}
