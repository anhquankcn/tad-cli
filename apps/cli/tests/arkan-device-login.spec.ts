/**
 * `tad login --device` exists because the loopback flow cannot work over SSH:
 * the callback server binds the REMOTE host's `127.0.0.1`, while the browser
 * runs on the operator's own machine, so the redirect reaches a port nothing
 * is listening on. The device grant has no redirect at all.
 *
 * The error bodies below are the ones the realm actually returned while this
 * was built — in particular the `unauthorized_client` body, which is what a
 * client with the grant switched off answers and is a configuration change,
 * not a login failure.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { deviceLogin } from '../src/arkan/oidc.ts'
import { parseDshArgs } from '../src/args.ts'

const AUTHORITY = 'https://sso.example.com/realms/test'
const CLIENT = 'aip-cli'
const parse = (argv: string[]) => parseDshArgs(argv, '1.2.3')

/**
 * Stub fetch with one scripted reply per call, in order.
 * @param replies - status and body for each successive call.
 * @returns the stub, so a test can assert how many calls happened.
 */
function scriptFetch(replies: { status: number; body: unknown }[]) {
  let index = 0
  // The parameters are declared even though the replies ignore them: a stub
  // with an empty signature types every recorded call as `[]`, so a test that
  // wants to assert what was SENT cannot reach it.
  const stub = vi.fn(async (_url: string | URL, _init?: RequestInit) => {
    const reply = replies[Math.min(index, replies.length - 1)]
    index += 1
    return new Response(JSON.stringify(reply?.body ?? {}), { status: reply?.status ?? 500 })
  })
  vi.stubGlobal('fetch', stub)
  return stub
}

/** A device authorization that is already usable, with no waiting. */
const GRANT = {
  device_code: 'dev-code-1',
  user_code: 'WDJB-MJHT',
  verification_uri: 'https://sso.example.com/realms/test/device',
  verification_uri_complete: 'https://sso.example.com/realms/test/device?user_code=WDJB-MJHT',
  expires_in: 600,
  interval: 0,
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('deviceLogin', () => {
  it('names the Keycloak switch when the client has the grant disabled', async () => {
    // Verbatim from the realm: the endpoint exists and the realm advertises the
    // grant, yet the client is not allowed to start it.
    scriptFetch([{
      status: 400,
      body: {
        error: 'unauthorized_client',
        error_description: 'Client is not allowed to initiate OAuth 2.0 Device Authorization Grant. The flow is disabled for the client.',
      },
    }])

    const error = await deviceLogin(AUTHORITY, CLIENT).catch((e: unknown) => e as Error)

    // The operator cannot fix this by retrying, so the message has to name the
    // setting rather than read as a failed sign-in.
    expect((error as Error).message).toContain('Device Authorization Grant')
    expect((error as Error).message).toContain(`Clients → ${CLIENT}`)
  })

  it('polls past authorization_pending and returns the session', async () => {
    const stub = scriptFetch([
      { status: 200, body: GRANT },
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 200, body: { access_token: 'at', refresh_token: 'rt', expires_in: 300 } },
    ])

    const credentials = await deviceLogin(AUTHORITY, CLIENT)

    expect(credentials).toMatchObject({ authority: AUTHORITY, client_id: CLIENT, access_token: 'at' })
    // Start + one pending poll + the successful poll.
    expect(stub).toHaveBeenCalledTimes(3)
  })

  it('sends PKCE on both legs, which this realm requires', async () => {
    // Found by calling the real endpoint, not by reading the RFC: PKCE is
    // optional in RFC 8628, but a client configured with a mandatory challenge
    // method answers `invalid_request: Missing parameter: code_challenge_method`
    // and the flow never starts.
    const stub = scriptFetch([
      { status: 200, body: GRANT },
      { status: 200, body: { access_token: 'at', refresh_token: 'rt', expires_in: 300 } },
    ])

    await deviceLogin(AUTHORITY, CLIENT)

    const start = new URLSearchParams(String(stub.mock.calls[0]?.[1]?.body ?? ''))
    expect(start.get('code_challenge_method')).toBe('S256')
    expect(start.get('code_challenge')).toBeTruthy()

    // The verifier must reach the token leg, or the challenge proves nothing.
    const poll = new URLSearchParams(String(stub.mock.calls[1]?.[1]?.body ?? ''))
    expect(poll.get('code_verifier')).toBeTruthy()
    expect(poll.get('code_verifier')).not.toBe(start.get('code_challenge'))
  })

  it('stops immediately when the operator declines', async () => {
    scriptFetch([
      { status: 200, body: GRANT },
      { status: 400, body: { error: 'access_denied' } },
    ])

    const error = await deviceLogin(AUTHORITY, CLIENT).catch((e: unknown) => e as Error)

    expect((error as Error).message).toContain('từ chối')
  })

  it('reports a non-JSON reply instead of a parse error', async () => {
    // A WAF in front of the realm answers HTML; hiding it behind "invalid JSON"
    // would send the operator debugging the wrong layer.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>403 Forbidden</html>', { status: 403 })))

    const error = await deviceLogin(AUTHORITY, CLIENT).catch((e: unknown) => e as Error)

    expect((error as Error).message).toContain('403 Forbidden')
  })
})

describe('tad login --device — argument parsing', () => {
  it('carries the flag through', () => {
    expect(parse(['login', '--device']))
      .toMatchObject({ mode: 'arkan', action: 'login', options: { device: true } })
  })

  it('leaves the loopback flow as the default', () => {
    const parsed = parse(['login'])
    expect(parsed).toMatchObject({ mode: 'arkan', action: 'login' })
    expect((parsed as { options: { device?: boolean } }).options.device).toBeUndefined()
  })
})
