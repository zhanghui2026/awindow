export interface RateLimitPolicy {
  limit: number
  windowMs: number
  blockMs: number
}

interface RateLimitEntry {
  timestamps: number[]
  blockedUntil?: number
}

export class RateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>()

  constructor(
    private readonly policy: RateLimitPolicy,
    private readonly now: () => number = Date.now,
  ) {}

  consume(key: string): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    const now = this.now()
    const entry = this.entries.get(key) ?? { timestamps: [] }
    if (entry.blockedUntil !== undefined && entry.blockedUntil > now) {
      return { allowed: false, retryAfterSeconds: Math.ceil((entry.blockedUntil - now) / 1000) }
    }

    entry.blockedUntil = undefined
    entry.timestamps = entry.timestamps.filter((timestamp) => timestamp > now - this.policy.windowMs)
    if (entry.timestamps.length >= this.policy.limit) {
      entry.blockedUntil = now + this.policy.blockMs
      this.entries.set(key, entry)
      return { allowed: false, retryAfterSeconds: Math.ceil(this.policy.blockMs / 1000) }
    }

    entry.timestamps.push(now)
    this.entries.set(key, entry)
    return { allowed: true }
  }

  reset(key: string): void {
    this.entries.delete(key)
  }
}
