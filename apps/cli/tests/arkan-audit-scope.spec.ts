/**
 * The audit log is tenant-wide, so a `satellite_link_create` lookup without
 * `principal_id` returns the newest such row in the WHOLE tenant.
 *
 * That is not theoretical. An operator's `tad status` printed a binding id
 * belonging to a different employee, right beside the correct one recovered
 * from the local cache — the same class of cross-employee disclosure the
 * server review closed on `POST /satellite-links` (ARKAN-CR-DEV-022).
 *
 * Scoping therefore cannot be best-effort: when the caller's own employee id
 * cannot be established, the lookup must report nothing rather than something
 * that may belong to someone else.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { findLinkIdsInAudit } from '../src/arkan/session.ts'
import type { ArkanCredentials } from '../src/arkan/credentials.ts'

const BASE = 'https://arkan.example'
const TYPE = 'llm_deepseek_harness'
const CREDENTIALS = { access_token: 'token' } as ArkanCredentials
const ME = 'eeee5555-0000-4000-8000-000000000005'

/** One matching audit row. */
const ROWS = {
  items: [
    { resource_id: 'aaaa1111-0000-4000-8000-000000000001', reason: `Tự khai báo dùng ${TYPE}`, created_at: '2026-09-06T01:14:47Z' },
  ],
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('findLinkIdsInAudit', () => {
  it('scopes the query to the caller, not the tenant', async () => {
    // Declared so the recorded calls stay typed; an empty signature makes
    // `stub.mock.calls[0]` a zero-length tuple and the URL unreachable.
    const stub = vi.fn(async (_url: string | URL) => new Response(JSON.stringify(ROWS), { status: 200 }))
    vi.stubGlobal('fetch', stub)

    await findLinkIdsInAudit(BASE, CREDENTIALS, TYPE, ME)

    const url = new URL(String(stub.mock.calls[0]?.[0]))
    expect(url.searchParams.get('principal_id')).toBe(ME)
    expect(url.searchParams.get('action')).toBe('satellite_link_create')
    // The caller supplied the id, so no profile round trip was needed.
    expect(stub).toHaveBeenCalledTimes(1)
  })

  it('looks the caller up when the id was not supplied', async () => {
    const stub = vi.fn(async (input: string | URL) => {
      if (String(input).includes('/api/auth/me')) {
        return new Response(JSON.stringify({ id: ME, permissions: [] }), { status: 200 })
      }
      return new Response(JSON.stringify(ROWS), { status: 200 })
    })
    vi.stubGlobal('fetch', stub)

    const result = await findLinkIdsInAudit(BASE, CREDENTIALS, TYPE)

    expect(result.ids).toEqual(['aaaa1111-0000-4000-8000-000000000001'])
    expect(new URL(String(stub.mock.calls[1]?.[0])).searchParams.get('principal_id')).toBe(ME)
  })

  it('reports nothing rather than tenant-wide rows when the caller is unknown', async () => {
    // An unscoped query would answer here, and the answer could be anyone's.
    const stub = vi.fn(async (input: string | URL) => {
      if (String(input).includes('/api/auth/me')) return new Response('nope', { status: 500 })
      return new Response(JSON.stringify(ROWS), { status: 200 })
    })
    vi.stubGlobal('fetch', stub)

    const result = await findLinkIdsInAudit(BASE, CREDENTIALS, TYPE)

    expect(result).toEqual({ ids: [], denied: false })
    // Crucially: the audit route was never called at all.
    expect(stub.mock.calls.some(call => String(call[0]).includes('/api/audit/log'))).toBe(false)
  })

  it('still separates a 403 from an empty result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403 })))

    expect(await findLinkIdsInAudit(BASE, CREDENTIALS, TYPE, ME)).toEqual({ ids: [], denied: true })
  })
})
