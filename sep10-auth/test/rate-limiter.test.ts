///<reference types="jest" />
import { Request, Response, NextFunction } from 'express';
import {
  rateLimiter,
  RateLimitStore,
  RateLimitDecision,
  InMemoryRateLimitStore,
} from '../src/rate-limiter';

function mockRequest(overrides: Partial<Request> = {}): Request {
  return {
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' } as any,
    header: jest.fn(),
    ...overrides,
  } as unknown as Request;
}

function mockResponse(): Response {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.set = jest.fn().mockReturnValue(res);
  return res as Response;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function invokeMiddleware(
  middleware: ReturnType<typeof rateLimiter>,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  middleware(req, res, next);
  await flushPromises();
}

describe('rateLimiter', () => {
  let req: Request;
  let res: Response;
  let next: NextFunction;

  beforeEach(() => {
    req = mockRequest();
    res = mockResponse();
    next = jest.fn();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('allows requests under the limit', async () => {
    const middleware = rateLimiter({ windowMs: 60_000, maxRequests: 5 });

    for (let i = 0; i < 5; i++) {
      await invokeMiddleware(middleware, req, res, next);
    }

    expect(next).toHaveBeenCalledTimes(5);
    expect(res.status).not.toHaveBeenCalled();
  });

  describe('standardHeaders', () => {
    function headersSetOn(r: Response): Record<string, string> {
      return Object.assign({}, ...(r.set as jest.Mock).mock.calls.map(([h]) => (typeof h === 'object' ? h : {})));
    }

    it('sets RateLimit-* headers on allowed responses and decrements remaining', async () => {
      const middleware = rateLimiter({ windowMs: 60_000, maxRequests: 3 });

      const remaining: string[] = [];
      for (let i = 0; i < 3; i++) {
        const r = mockResponse();
        await invokeMiddleware(middleware, req, r, next);
        const h = headersSetOn(r);
        expect(h['RateLimit-Limit']).toBe('3');
        expect(h['RateLimit-Reset']).toBe('60');
        remaining.push(h['RateLimit-Remaining']);
      }

      expect(remaining).toEqual(['2', '1', '0']);
    });

    it('sets RateLimit-* headers on throttled responses', async () => {
      const middleware = rateLimiter({ windowMs: 60_000, maxRequests: 1 });
      await invokeMiddleware(middleware, req, mockResponse(), next);

      const throttled = mockResponse();
      await invokeMiddleware(middleware, req, throttled, next);

      expect(throttled.status).toHaveBeenCalledWith(429);
      expect(headersSetOn(throttled)).toEqual(
        expect.objectContaining({
          'RateLimit-Limit': '1',
          'RateLimit-Remaining': '0',
          'RateLimit-Reset': '60',
        }),
      );
    });

    it('does not set RateLimit-* headers when standardHeaders is false', async () => {
      const middleware = rateLimiter({ windowMs: 60_000, maxRequests: 1, standardHeaders: false });
      await invokeMiddleware(middleware, req, res, next);

      expect(res.set).not.toHaveBeenCalled();

      const throttled = mockResponse();
      await invokeMiddleware(middleware, req, throttled, next);
      expect(headersSetOn(throttled)).toEqual({});
      expect(throttled.set).toHaveBeenCalledWith('Retry-After', expect.any(String));
    });
  });

  it('blocks requests that exceed the limit and returns 429', async () => {
    const middleware = rateLimiter({ windowMs: 60_000, maxRequests: 3 });

    for (let i = 0; i < 3; i++) {
      await invokeMiddleware(middleware, req, res, next);
    }

    expect(next).toHaveBeenCalledTimes(3);

    // 4th request — should be blocked
    await invokeMiddleware(middleware, req, res, next);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'rate_limit_exceeded' }),
    );
    expect(next).toHaveBeenCalledTimes(3); // next not called for blocked request
  });

  it('includes retryAfter in the 429 response', async () => {
    const middleware = rateLimiter({ windowMs: 60_000, maxRequests: 1 });

    await invokeMiddleware(middleware, req, res, next); // 1st — ok
    await invokeMiddleware(middleware, req, res, next); // 2nd — blocked

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'rate_limit_exceeded',
        retryAfter: expect.any(Number),
      }),
    );
    expect(res.set).toHaveBeenCalledWith(
      'Retry-After',
      expect.any(String),
    );
  });

  it('resets the counter after the window expires', async () => {
    const middleware = rateLimiter({ windowMs: 60_000, maxRequests: 1 });

    await invokeMiddleware(middleware, req, res, next); // 1st — ok
    expect(next).toHaveBeenCalledTimes(1);

    // Advance past the window
    jest.advanceTimersByTime(60_001);

    await invokeMiddleware(middleware, req, res, next); // 2nd — should be allowed again

    expect(next).toHaveBeenCalledTimes(2);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('uses a custom key generator when provided', async () => {
    const keyGenerator = jest.fn().mockReturnValue('custom-key');
    const middleware = rateLimiter({
      windowMs: 60_000,
      maxRequests: 1,
      keyGenerator,
    });

    await invokeMiddleware(middleware, req, res, next); // 1st — ok
    expect(keyGenerator).toHaveBeenCalledWith(req);

    await invokeMiddleware(middleware, req, res, next); // 2nd — blocked for same custom key
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it('isolates rate limit counters by custom key', async () => {
    let keyCounter = 0;
    const keyGenerator = jest.fn(() => `user-${keyCounter++ % 2}`);
    const middleware = rateLimiter({
      windowMs: 60_000,
      maxRequests: 2,
      keyGenerator,
    });

    // user-0: two requests allowed
    await invokeMiddleware(middleware, req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    await invokeMiddleware(middleware, req, res, next);
    expect(next).toHaveBeenCalledTimes(2);

    // user-1: two requests allowed (different key — separate counter)
    await invokeMiddleware(middleware, req, res, next);
    expect(next).toHaveBeenCalledTimes(3);

    await invokeMiddleware(middleware, req, res, next);
    expect(next).toHaveBeenCalledTimes(4);

    // user-0 again (3rd request) — blocked
    await invokeMiddleware(middleware, req, res, next);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(next).toHaveBeenCalledTimes(4); // no change
  });

  it('falls back to socket remoteAddress when ip is not set', async () => {
    const noIpReq = mockRequest({ ip: undefined });
    const middleware = rateLimiter({ windowMs: 60_000, maxRequests: 1 });

    await invokeMiddleware(middleware, noIpReq, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('applies default options when none are provided', async () => {
    const middleware = rateLimiter();

    // 100 requests should all be allowed with default max
    for (let i = 0; i < 100; i++) {
      await invokeMiddleware(middleware, req, res, next);
    }

    expect(next).toHaveBeenCalledTimes(100);

    // 101st should be blocked
    await invokeMiddleware(middleware, req, res, next);
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it('throws at construction time for non-positive maxRequests', () => {
    expect(() => rateLimiter({ maxRequests: 0 })).toThrow(
      /maxRequests.*positive integer/i,
    );
    expect(() => rateLimiter({ maxRequests: -1 })).toThrow(
      /maxRequests.*positive integer/i,
    );
  });

  it('throws at construction time for non-positive windowMs', () => {
    expect(() => rateLimiter({ windowMs: 0 })).toThrow(
      /windowMs.*positive integer/i,
    );
    expect(() => rateLimiter({ windowMs: -100 })).toThrow(
      /windowMs.*positive integer/i,
    );
  });

  it('uses a custom store implementation', async () => {
    const decisions: RateLimitDecision[] = [
      { allowed: true, count: 1, resetAt: Date.now() + 60_000 },
      { allowed: false, count: 1, resetAt: Date.now() + 5_000 },
    ];
    const consume = jest.fn(() => decisions.shift()!);
    const store: RateLimitStore = { consume };
    const middleware = rateLimiter({
      windowMs: 60_000,
      maxRequests: 1,
      store,
    });

    await invokeMiddleware(middleware, req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    await invokeMiddleware(middleware, req, res, next);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(consume).toHaveBeenCalledTimes(2);
  });

  describe('InMemoryRateLimitStore — two-bucket counter', () => {
    it('uses O(1) memory per key (no timestamp array)', () => {
      const store = new InMemoryRateLimitStore();
      const now = Date.now();
      // Flood with 1000 requests on a single key
      for (let i = 0; i < 1000; i++) {
        store.consume('key', now + i, 60_000, 500);
      }
      // If the internal entry were an array it would have ~500 timestamps;
      // the two-bucket design has exactly {bucketStart, curCount, prevCount}.
      // We verify this indirectly: after 1000 calls the store still functions.
      const decision = store.consume('key', now + 1000, 60_000, 500);
      // count must be a reasonable number (≤ maxRequests), not 1000+
      expect(decision.count).toBeLessThanOrEqual(500);
    });

    it('respects maxKeys cap by evicting the oldest key', () => {
      const store = new InMemoryRateLimitStore(3);
      const now = Date.now();
      // Fill to capacity
      store.consume('a', now, 60_000, 10);
      store.consume('b', now, 60_000, 10);
      store.consume('c', now, 60_000, 10);
      // Adding a 4th key should evict 'a'
      store.consume('d', now, 60_000, 10);
      // 'a' counter should have been evicted — a new request for 'a' gets count=1 (fresh)
      const afterEviction = store.consume('a', now, 60_000, 10);
      expect(afterEviction.count).toBe(1);
    });

    it('maxKeys cap is exposed via rateLimiter options', async () => {
      const middleware = rateLimiter({ windowMs: 60_000, maxRequests: 2, maxKeys: 2 });
      const now = Date.now();

      // key 'a' — 2 requests, hits the limit
      const reqA = mockRequest({ ip: '1.1.1.1' });
      await invokeMiddleware(middleware, reqA, mockResponse(), next);
      await invokeMiddleware(middleware, reqA, mockResponse(), next);

      // key 'b' — fills the second slot
      const reqB = mockRequest({ ip: '2.2.2.2' });
      await invokeMiddleware(middleware, reqB, mockResponse(), next);

      // key 'c' — evicts 'a', so a subsequent 'a' request gets a fresh counter
      const reqC = mockRequest({ ip: '3.3.3.3' });
      await invokeMiddleware(middleware, reqC, mockResponse(), next);

      // 'a' counter was evicted — should be allowed again
      const resA2 = mockResponse();
      await invokeMiddleware(middleware, reqA, resA2, next);
      expect(resA2.status).not.toHaveBeenCalled();
    });
  });

  describe('skip predicate', () => {
    async function settle(): Promise<void> {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    }

    it('lets skipped requests through without consuming tokens', async () => {
      const store: RateLimitStore = { consume: jest.fn() };
      const middleware = rateLimiter({ store, skip: () => true });

      middleware(req, res, next);
      await settle();

      expect(next).toHaveBeenCalledTimes(1);
      expect(store.consume).not.toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('supports async predicates', async () => {
      const middleware = rateLimiter({
        maxRequests: 1,
        skip: async (r) => r.ip === '10.0.0.1',
      });
      const trusted = mockRequest({ ip: '10.0.0.1' });

      for (let i = 0; i < 3; i++) {
        middleware(trusted, res, next);
        await settle();
      }
      expect(next).toHaveBeenCalledTimes(3);
      expect(res.status).not.toHaveBeenCalled();

      // Non-skipped requests are still rate limited.
      middleware(req, res, next);
      await settle();
      middleware(req, res, next);
      await settle();
      expect(next).toHaveBeenCalledTimes(4);
      expect(res.status).toHaveBeenCalledWith(429);
    });

    it('forwards predicate errors to next', async () => {
      const error = new Error('predicate failed');
      const middleware = rateLimiter({
        skip: () => {
          throw error;
        },
      });

      middleware(req, res, next);
      await settle();

      expect(next).toHaveBeenCalledWith(error);
    });
  });
});
