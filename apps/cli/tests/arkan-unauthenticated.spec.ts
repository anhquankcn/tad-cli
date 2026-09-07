/**
 * Studio answers 401 for two situations that need opposite responses, and the
 * CLI used to report both as "token expired".
 *
 * It maps a Keycloak token to an `Employee` row BY EMAIL (`auth_service.py`:
 * `where(func.lower(Employee.email) == email)`) and raises 401 `Not
 * authenticated` when no row matches. The token is then perfectly valid — the
 * organisation simply has no record of that person — and `tad login` cannot
 * fix it: signing in again as the same account produces the same 401.
 *
 * That is not hypothetical. An operator created a second account in the same
 * realm, signed in with it through the device flow, and spent several rounds
 * chasing a token problem that did not exist.
 *
 * The bodies below are the server's own wording, taken from `auth_service.py`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { listAvailableWorkorders } from '../src/arkan/session.ts'
import type { ArkanCredentials } from '../src/arkan/credentials.ts'

const BASE = 'https://arkan.example'
const CREDENTIALS = { access_token: 'token' } as ArkanCredentials

/**
 * Answer every call with one 401 body.
 * @param detail - the `detail` field Studio returns.
 */
function stub401(detail: string): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail }), { status: 401 })))
}

/**
 * Run a call that surfaces a 401 and return the message it threw.
 * @returns the thrown message.
 */
async function messageFor(): Promise<string> {
  const error = await listAvailableWorkorders(BASE, CREDENTIALS).catch((e: unknown) => e as Error)
  return (error as Error).message
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('401 from Studio', () => {
  it('says the account has no Employee record, and does not blame the token', async () => {
    stub401('Not authenticated')

    const message = await messageFor()

    expect(message).toContain('không có nhân sự nào khớp email')
    expect(message).toContain('tad whoami')
    // The old message sent people here, and re-running it changes nothing.
    expect(message).not.toContain('Token hết hạn')
  })

  it('separates a deactivated account from a missing one', async () => {
    // Different repair: an admin reactivates, rather than creating a record.
    stub401('Account not found or deactivated')

    const message = await messageFor()

    expect(message).toContain('vô hiệu hoá')
    expect(message).toContain('kích hoạt lại')
  })

  it('still points at re-login when the token really is the problem', async () => {
    stub401('Invalid or expired token')

    const message = await messageFor()

    expect(message).toContain('Token hết hạn hoặc không hợp lệ')
    expect(message).toContain('tad login')
  })

  it('names both causes when the body is wording we do not recognise', async () => {
    // A future release may reword these; guessing one cause would be worse
    // than admitting there are two.
    stub401('some future wording')

    const message = await messageFor()

    expect(message).toContain('token hết hạn')
    expect(message).toContain('chưa có nhân sự')
    expect(message).toContain('some future wording')
  })
})
