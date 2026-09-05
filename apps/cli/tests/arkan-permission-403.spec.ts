/**
 * Studio is deny-by-default and answers `Permission required: <name>`. Two of
 * those refusals are the NORMAL state for an engineer rather than a fault:
 * `studio:machines:read` (listing machines) and `org:audit:read` are
 * administrative views, and nothing in the register → lease → run path needs
 * either.
 *
 * An operator reported `GET /dev-machines` failing with 403 as a blocker. It
 * was not one — but the CLI said only "Thiếu quyền cho thao tác này", which
 * gives no way to tell a harmless refusal from one that stops the work.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { listMachines } from '../src/arkan/session.ts'
import type { ArkanCredentials } from '../src/arkan/credentials.ts'

const BASE = 'https://arkan.example'
const CREDENTIALS = { access_token: 'token' } as ArkanCredentials

/**
 * Answer the machine listing with one 403 body.
 * @param detail - the `detail` field Studio returns.
 */
function stub403(detail: string): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail }), { status: 403 })))
}

/**
 * Run the listing and return the message it threw.
 * @returns the thrown message.
 */
async function messageFor(): Promise<string> {
  const error = await listMachines(BASE, CREDENTIALS).catch((e: unknown) => e as Error)
  return (error as Error).message
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('403 from Studio', () => {
  it('says the machine listing is an admin view the workflow does not need', async () => {
    stub403('Permission required: studio:machines:read')

    const message = await messageFor()

    expect(message).toContain('studio:machines:read')
    // The point the bare message missed: this refusal blocks nothing.
    expect(message).toContain('KHÔNG cần nó')
    expect(message).toContain('xin lease')
  })

  it('names the approve permission and warns against rerunning the create', async () => {
    stub403('Permission required: studio:machines:approve')

    const message = await messageFor()

    expect(message).toContain('studio:machines:approve')
    expect(message).toContain('đừng chạy lại lệnh tạo')
  })

  it('echoes an unfamiliar permission rather than guessing what it gates', async () => {
    stub403('Permission required: studio:repo_class:write')

    const message = await messageFor()

    expect(message).toContain('studio:repo_class:write')
  })

  it('still reports a 403 whose body names no permission', async () => {
    stub403('Forbidden')

    const message = await messageFor()

    expect(message).toContain('Thiếu quyền')
    expect(message).toContain('Forbidden')
  })
})
