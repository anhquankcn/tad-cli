/**
 * `POST /satellite-links` answers 409 once a binding of that type exists, and
 * approving it needs the row's id — which Studio exposes through no GET route.
 * The audit log is the one indirect read: it records `resource_id` on every
 * write, so the create entry names the row. These specs pin that the 409 hands
 * back that id, and that an unavailable audit route degrades to the manual
 * routes instead of failing or inventing one.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSatelliteLink } from '../src/arkan/session.ts'
import type { ArkanCredentials } from '../src/arkan/credentials.ts'

const BASE = 'https://arkan.example'
const TYPE = 'llm_deepseek_harness'
const CREDENTIALS = { access_token: 'token' } as ArkanCredentials

/** The 409 body Studio returns, verbatim in shape. */
const CONFLICT = JSON.stringify({ detail: `Đã có liên kết '${TYPE}' chưa thu hồi cho kỹ sư này.` })

/**
 * Route the two calls the 409 path makes: the create that conflicts, then the
 * audit read.
 * @param audit - what the audit route answers.
 * @returns a fetch stub.
 */
function stubFetch(audit: { ok: boolean; body: unknown }) {
  return vi.fn(async (input: string | URL) => {
    const url = String(input)
    if (url.includes('/api/studio/v1/satellite-links')) {
      return new Response(CONFLICT, { status: 409 })
    }
    if (url.includes('/api/audit/log')) {
      return new Response(JSON.stringify(audit.body), { status: audit.ok ? 200 : 403 })
    }
    throw new Error(`unexpected call: ${url}`)
  })
}

/**
 * Run the conflicting create and return the message it threw.
 * @param fetchStub - the stub to install for the call.
 * @returns the thrown message.
 */
async function messageFor(fetchStub: ReturnType<typeof stubFetch>): Promise<string> {
  vi.stubGlobal('fetch', fetchStub)
  const error = await createSatelliteLink(BASE, CREDENTIALS, TYPE).catch((e: unknown) => e as Error)
  return (error as Error).message
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('duplicate satellite link', () => {
  it('names the binding the audit log recorded, and both ways to use it', async () => {
    const message = await messageFor(stubFetch({
      ok: true,
      body: {
        items: [
          { resource_id: 'aaaa1111-0000-4000-8000-000000000001', reason: `Tự khai báo dùng ${TYPE}`, created_at: '2026-09-01T03:52:57Z' },
          { resource_id: 'bbbb2222-0000-4000-8000-000000000002', reason: 'Tự khai báo dùng llm_gh_copilot', created_at: '2026-08-27T16:42:49Z' },
        ],
      },
    }))

    expect(message).toContain('aaaa1111-0000-4000-8000-000000000001')
    expect(message).toContain('dsh session link --approve-id aaaa1111-0000-4000-8000-000000000001')
    // A different tool's binding must not be offered as this one's.
    expect(message).not.toContain('bbbb2222')
    // Audit records creation, never current status, so the message may not
    // claim the row still needs approving.
    expect(message).toContain('ACTIVE')
  })

  it('lists several candidates newest first when the type was re-declared', async () => {
    const message = await messageFor(stubFetch({
      ok: true,
      body: {
        items: [
          { resource_id: 'old00000-0000-4000-8000-00000000000a', reason: `dùng ${TYPE}`, created_at: '2026-07-01T00:00:00Z' },
          { resource_id: 'new00000-0000-4000-8000-00000000000b', reason: `dùng ${TYPE}`, created_at: '2026-09-01T00:00:00Z' },
        ],
      },
    }))

    const newest = message.indexOf('new00000-0000-4000-8000-00000000000b')
    const oldest = message.indexOf('old00000-0000-4000-8000-00000000000a')
    expect(newest).toBeGreaterThan(-1)
    expect(newest).toBeLessThan(oldest)
  })

  // The two fallback specs below pass with OR without the audit lookup, by
  // design: they pin the pre-existing message as the degradation path. Read
  // them as a guard against losing it, never as evidence for the lookup — the
  // two specs above are the ones that go red when the lookup is removed.
  it('falls back to the manual routes when the audit route is unavailable', async () => {
    const message = await messageFor(stubFetch({ ok: false, body: { detail: 'Forbidden' } }))

    expect(message).toContain('giao diện quản trị ASC')
    expect(message).toContain('satellite_identity_link')
    // No id was recovered, so no id may be spelled into a runnable command.
    expect(message).toContain('--approve-id <uuid>')
  })

  it('falls back when the audit call throws rather than answering', async () => {
    const fetchStub = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('/api/studio/v1/satellite-links')) return new Response(CONFLICT, { status: 409 })
      throw new Error('network down')
    })
    vi.stubGlobal('fetch', fetchStub)

    const error = await createSatelliteLink(BASE, CREDENTIALS, TYPE).catch((e: unknown) => e as Error)

    // The network failure belongs to the lookup, not the user's command: it
    // must not replace the 409 explanation with a connection error.
    expect((error as Error).message).toContain('Đã có binding loại này chưa thu hồi')
    expect((error as Error).message).not.toContain('network down')
  })
})
