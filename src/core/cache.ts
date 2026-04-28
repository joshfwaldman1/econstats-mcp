import { Redis } from "@upstash/redis";

export interface CacheBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

type CacheEntry = {
  value: string;
  expiresAt: number;
};

export class MemoryCacheBackend implements CacheBackend {
  private store = new Map<string, CacheEntry>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }
}

export class UpstashRedisCacheBackend implements CacheBackend {
  private redis: Redis;

  constructor(url: string, token: string, private namespace = "econstats:v2") {
    this.redis = new Redis({ url, token });
  }

  private key(key: string): string {
    return `${this.namespace}:${key}`;
  }

  async get(key: string): Promise<string | null> {
    const result = await this.redis.get<string>(this.key(key));
    return typeof result === "string" ? result : null;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(this.key(key), value, { ex: ttlSeconds });
  }
}

export class LayeredCache {
  private inFlight = new Map<string, Promise<string>>();

  constructor(
    private l1: CacheBackend,
    private l2?: CacheBackend,
    private l1MaxTtlSeconds = 900,
  ) {}

  async getOrCompute(
    key: string,
    ttlSeconds: number,
    compute: () => Promise<string>,
  ): Promise<string> {
    const localHit = await this.l1.get(key);
    if (localHit !== null) return localHit;

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const work = (async () => {
      if (this.l2) {
        try {
          const sharedHit = await this.l2.get(key);
          if (sharedHit !== null) {
            await this.l1.set(key, sharedHit, Math.min(ttlSeconds, this.l1MaxTtlSeconds));
            return sharedHit;
          }
        } catch (error) {
          console.error(`[cache] L2 get failed for ${key}:`, error);
        }
      }

      const value = await compute();
      await this.l1.set(key, value, Math.min(ttlSeconds, this.l1MaxTtlSeconds));
      if (this.l2) {
        try {
          await this.l2.set(key, value, ttlSeconds);
        } catch (error) {
          console.error(`[cache] L2 set failed for ${key}:`, error);
        }
      }
      return value;
    })().finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, work);
    return work;
  }
}

export function createLayeredCache(): LayeredCache {
  const l1 = new MemoryCacheBackend();
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const namespace = process.env.CACHE_NAMESPACE || "econstats:v2";

  if (url && token) {
    return new LayeredCache(
      l1,
      new UpstashRedisCacheBackend(url, token, namespace),
    );
  }

  return new LayeredCache(l1);
}
