import { describe, expect, it } from 'vitest'

import { RateLimiter } from './rate-limiter.js'

describe('RateLimiter', () => {
  it('blocks after the configured window limit and recovers after the block', () => {
    let now = 1_000
    const limiter = new RateLimiter({ limit: 2, windowMs: 1_000, blockMs: 5_000 }, () => now)

    expect(limiter.consume('client')).toEqual({ allowed: true })
    expect(limiter.consume('client')).toEqual({ allowed: true })
    expect(limiter.consume('client')).toEqual({ allowed: false, retryAfterSeconds: 5 })
    now += 5_000
    expect(limiter.consume('client')).toEqual({ allowed: true })
  })

  it('tracks keys independently', () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 1_000, blockMs: 1_000 })

    expect(limiter.consume('first')).toEqual({ allowed: true })
    expect(limiter.consume('second')).toEqual({ allowed: true })
    expect(limiter.consume('first')).toMatchObject({ allowed: false })
  })
})
