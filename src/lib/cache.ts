import { kv } from '@vercel/kv';

interface CacheOptions {
  ttl?: number; // Time to live in seconds
  namespace?: string;
}

const DEFAULT_TTL = {
  product_search: 900,     // 15 minutes
  pricing: 300,            // 5 minutes  
  ai_response: 3600,       // 1 hour
  order_status: 3600,      // 1 hour
  quote: 1800,            // 30 minutes
};

/**
 * Generic cache wrapper for Vercel KV
 */
export class CacheService {
  private namespace: string;

  constructor(namespace: string = 'alliance') {
    this.namespace = namespace;
  }

  private getKey(key: string): string {
    return `${this.namespace}:${key}`;
  }

  /**
   * Get value from cache
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const cachedValue = await kv.get<T>(this.getKey(key));
      if (cachedValue) {
        console.log(`Cache HIT: ${key}`);
        return cachedValue;
      }
      console.log(`Cache MISS: ${key}`);
      return null;
    } catch (error) {
      console.error('Cache get error:', error);
      return null;
    }
  }

  /**
   * Set value in cache with TTL
   */
  async set<T>(key: string, value: T, options?: CacheOptions): Promise<void> {
    try {
      const ttl = options?.ttl || DEFAULT_TTL.ai_response;
      await kv.set(this.getKey(key), value, { ex: ttl });
      console.log(`Cache SET: ${key} (TTL: ${ttl}s)`);
    } catch (error) {
      console.error('Cache set error:', error);
    }
  }

  /**
   * Delete value from cache
   */
  async delete(key: string): Promise<void> {
    try {
      await kv.del(this.getKey(key));
      console.log(`Cache DELETE: ${key}`);
    } catch (error) {
      console.error('Cache delete error:', error);
    }
  }

  /**
   * Get or set pattern - fetch from cache or compute and cache
   */
  async getOrSet<T>(
    key: string,
    factory: () => Promise<T>,
    options?: CacheOptions
  ): Promise<T> {
    // Try to get from cache first
    const cached = await this.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    // Compute the value
    const value = await factory();
    
    // Cache it for next time
    await this.set(key, value, options);
    
    return value;
  }

  /**
   * Create a cache key from multiple parts
   */
  static createKey(...parts: (string | number | boolean)[]): string {
    return parts
      .map(p => String(p).toLowerCase().replace(/[^a-z0-9]/g, '_'))
      .join(':');
  }
}

// Pre-configured cache instances for different use cases
export const productCache = new CacheService('product');
export const pricingCache = new CacheService('pricing');
export const orderCache = new CacheService('order');
export const aiCache = new CacheService('ai');

/**
 * Cache decorator for async functions
 */
export function cached(namespace: string, ttl?: number) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    const cache = new CacheService(namespace);

    descriptor.value = async function (...args: any[]) {
      const cacheKey = CacheService.createKey(propertyKey, ...args.map(a => JSON.stringify(a)));
      
      return cache.getOrSet(
        cacheKey,
        () => originalMethod.apply(this, args),
        { ttl }
      );
    };

    return descriptor;
  };
}