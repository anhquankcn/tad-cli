/**
 * `tad status` reads the lease from `~/.arkan/session.json`, which is the only
 * local record of what was issued — and a record that keeps saying ACTIVE long
 * after the lease died, because nothing rewrites it when the clock passes
 * `expires_at`. Trusting that field is exactly the mistake that leaves an
 * operator hunting an opaque 403, so these specs pin that the report decides
 * from the timestamps and says out loud when the stored status disagrees.
 */

import { describe, expect, it } from 'vitest'
import { leaseLines } from '../src/arkan/commands.ts'
import type { IssuedLease } from '../src/arkan/session.ts'
import { parseDshArgs } from '../src/args.ts'

const parse = (argv: string[]) => parseDshArgs(argv, '1.2.3')

/**
 * Build a lease whose windows sit a given distance from now.
 * @param minutesToExpiry - minutes until `expires_at`; negative is past.
 * @param minutesToCeiling - minutes until `absolute_expires_at`.
 * @param status - the value cached in the file.
 * @returns the lease.
 */
function lease(minutesToExpiry: number, minutesToCeiling = 600, status = 'ACTIVE'): IssuedLease {
  const now = Date.now()
  return {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    status,
    model_ref: 'aws/claude-sonnet-5-medium',
    workorder_id: '01ABCDEF',
    expires_at: new Date(now + minutesToExpiry * 60_000).toISOString(),
    absolute_expires_at: new Date(now + minutesToCeiling * 60_000).toISOString(),
  }
}

/**
 * Flatten a report section to one string for assertions.
 * @param lines - the section's lines.
 * @returns label, value and advice joined.
 */
function flat(lines: ReturnType<typeof leaseLines>): string {
  return lines.map(line => `${line.label} ${line.value} ${line.problem ?? ''}`).join('\n')
}

describe('tad status — lease reporting', () => {
  it('reports a live lease with the minutes it has left', () => {
    const text = flat(leaseLines(lease(90)))

    expect(text).toContain('còn 90 phút')
    expect(text).not.toContain('QUÁ HẠN')
    // A healthy lease must carry no advice: every arrow in the report is a
    // problem, so a spurious one sends the operator fixing nothing.
    expect(leaseLines(lease(90)).every(line => line.problem === undefined)).toBe(true)
  })

  it('calls an expired lease expired even while the file still says ACTIVE', () => {
    const text = flat(leaseLines(lease(-462)))

    expect(text).toContain('QUÁ HẠN 462 phút')
    expect(text).toContain('tad session register')
    // The whole point: the cached ACTIVE must be contradicted, not echoed.
    expect(text).toContain('KHÔNG đáng tin')
  })

  it('flags a non-ACTIVE stored status on its own', () => {
    const text = flat(leaseLines(lease(90, 600, 'REVOKED')))

    expect(text).toContain('REVOKED')
    expect(text).toContain('§8c sẽ từ chối')
  })

  it('separates the absolute ceiling from the rolling window', () => {
    // Past the ceiling, renewing cannot help — that needs a different action
    // from an ordinary expiry, so it gets its own advice.
    const text = flat(leaseLines(lease(-10, -10)))

    expect(text).toContain('ĐÃ VƯỢT')
    expect(text).toContain('work order mới')
  })

  it('says so rather than guessing when the timestamp is unreadable', () => {
    const text = flat(leaseLines({ ...lease(90), expires_at: null }))

    expect(text).toContain('không đọc được')
    expect(text).not.toContain('phút')
  })
})

describe('tad status — argument parsing', () => {
  it('routes the bare command', () => {
    expect(parse(['status'])).toMatchObject({ mode: 'arkan', action: 'status' })
  })

  it('accepts a Studio base URL override', () => {
    expect(parse(['status', '--studio-base-url', 'https://stage.example']))
      .toMatchObject({ mode: 'arkan', action: 'status', options: { studioBaseUrl: 'https://stage.example' } })
  })
})
