/**
 * `POST /satellite-links` answers 409 once a binding of that type exists, and
 * using it needs the row's id — which Studio exposes through no GET route.
 *
 * Both indirect reads need a permission the engineer who created the binding
 * does not hold: the audit log needs `org:audit:read` and `GET /dev-machines`
 * needs `studio:machines:read`. An operator hit exactly that — `dsh session
 * link --approve` created the row, the approve leg 403'd, the rerun 409'd, and
 * the audit lookup answered 403 while the message said the id could not be
 * found. So the id is now written locally at creation, which needs no
 * permission, and a 403 from audit is reported as "you may not look" rather
 * than as "there is nothing there".
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSatelliteLink, linksPath, recallLink } from '../src/arkan/session.ts'
import type { ArkanCredentials } from '../src/arkan/credentials.ts'

const BASE = 'https://arkan.example'
const TYPE = 'llm_deepseek_harness'
const CREDENTIALS = { access_token: 'token' } as ArkanCredentials

/** The 409 body Studio returns, verbatim in shape. */
const CONFLICT = JSON.stringify({ detail: `Đã có liên kết '${TYPE}' chưa thu hồi cho kỹ sư này.` })

let home = ''
let realHome: string | undefined
let realProfile: string | undefined

beforeEach(() => {
  // The cache lives under the operator's home, so every spec gets its own.
  // Without this the developer's real `~/.arkan/links.json` would decide which
  // branch runs, and the suite would pass or fail by machine.
  home = mkdtempSync(join(tmpdir(), 'arkan-home-'))
  realHome = process.env['HOME']
  realProfile = process.env['USERPROFILE']
  process.env['HOME'] = home
  process.env['USERPROFILE'] = home
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (realHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = realHome
  if (realProfile === undefined) delete process.env['USERPROFILE']
  else process.env['USERPROFILE'] = realProfile
  rmSync(home, { recursive: true, force: true })
})

/**
 * Route the two calls the 409 path makes: the create that conflicts, then the
 * audit read.
 * @param audit - status and body for the audit route.
 * @returns a fetch stub.
 */
function stubFetch(audit: { status: number; body: unknown }) {
  return vi.fn(async (input: string | URL) => {
    const url = String(input)
    if (url.includes('/api/studio/v1/satellite-links')) {
      return new Response(CONFLICT, { status: 409 })
    }
    if (url.includes('/api/audit/log')) {
      return new Response(JSON.stringify(audit.body), { status: audit.status })
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

/**
 * Seed the local cache as an earlier successful create would have.
 * @param id - binding id to remember.
 */
function seedCache(id: string): void {
  mkdirSync(join(home, '.arkan'), { recursive: true })
  writeFileSync(linksPath(), JSON.stringify({
    [TYPE]: { id, satellite_type: TYPE, status_at_create: 'PENDING_APPROVAL', created_at: '2026-09-01T03:52:57.000Z' },
  }))
}

describe('remembering the binding id', () => {
  it('writes the id on a successful create, since nothing can read it back', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ id: 'aaaa1111-0000-4000-8000-000000000001', satellite_type: TYPE, status: 'PENDING_APPROVAL' }),
      { status: 200 },
    )))

    await createSatelliteLink(BASE, CREDENTIALS, TYPE)

    expect(recallLink(TYPE)?.id).toBe('aaaa1111-0000-4000-8000-000000000001')
    expect(JSON.parse(readFileSync(linksPath(), 'utf8'))).toMatchObject({
      [TYPE]: { status_at_create: 'PENDING_APPROVAL' },
    })
  })

  it('does not fail the create when the cache cannot be written', async () => {
    // The server already made the binding; losing the local note must not turn
    // a success into an error the operator would retry into a 409.
    process.env['HOME'] = join(home, 'missing', '\0invalid')
    process.env['USERPROFILE'] = process.env['HOME']
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ id: 'bbbb2222-0000-4000-8000-000000000002', satellite_type: TYPE, status: 'PENDING_APPROVAL' }),
      { status: 200 },
    )))

    const link = await createSatelliteLink(BASE, CREDENTIALS, TYPE)

    expect(link.id).toBe('bbbb2222-0000-4000-8000-000000000002')
  })
})

describe('duplicate satellite link', () => {
  it('names the locally remembered binding without calling audit at all', async () => {
    seedCache('cccc3333-0000-4000-8000-000000000003')
    const fetchStub = stubFetch({ status: 403, body: { detail: 'Forbidden' } })

    const message = await messageFor(fetchStub)

    expect(message).toContain('cccc3333-0000-4000-8000-000000000003')
    expect(message).toContain('dsh session link --approve-id cccc3333-0000-4000-8000-000000000003')
    // The local record answers it, so no permission-gated call is needed.
    expect(fetchStub.mock.calls.some(call => String(call[0]).includes('/api/audit/log'))).toBe(false)
  })

  it('names the binding the audit log recorded, and both ways to use it', async () => {
    const message = await messageFor(stubFetch({
      status: 200,
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
      status: 200,
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

  it('says the audit route refused, not that the binding is missing', async () => {
    // The distinction is the whole point: 403 here is the NORMAL answer for an
    // engineer, and reporting it as "not found" sent one hunting for a row the
    // log could see perfectly well.
    const message = await messageFor(stubFetch({ status: 403, body: { detail: 'Permission required: org:audit:read' } }))

    expect(message).toContain('org:audit:read')
    expect(message).toContain('cuộn lên trong terminal')
    // No id was recovered, so no id may be spelled into a runnable command.
    expect(message).toContain('--approve-id <uuid>')
  })

  it('falls back to the manual routes when the audit route is simply absent', async () => {
    const message = await messageFor(stubFetch({ status: 404, body: { detail: 'Not Found' } }))

    expect(message).toContain('satellite_identity_link')
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
