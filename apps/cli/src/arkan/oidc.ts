/**
 * PKCE authorization-code flow against the corporate Keycloak realm, mirroring
 * `arkan/app/scripts/cli_login.py` so both clients share one session.
 *
 * The shape is the standard CLI login (gh/gcloud/aws): open a throwaway
 * loopback server, send the browser to Keycloak, catch the redirect, exchange
 * the code. Two details are load-bearing and were learned the hard way, so do
 * not "simplify" them:
 *
 * - The redirect URI is **`http://127.0.0.1:8765/callback`**, literally. The
 *   port is fixed rather than ephemeral because Ops registers the redirect on
 *   the public client, and the host is `127.0.0.1` rather than `localhost` so
 *   the browser cannot resolve to `::1` and miss an IPv4-bound listener.
 * - Every request carries an explicit `User-Agent`. The WAF in front of
 *   a WAF in front of the realm may reject the default agent with 403.
 * @module @deepseek-ai/dsh/arkan/oidc
 */

import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { toCredentials, type ArkanCredentials } from './credentials.ts'

/** Realm URL; `ARKAN_AUTHORITY` overrides it for staging realms. */
export const DEFAULT_AUTHORITY = ''

/** Public client registered by Ops with PKCE + the loopback redirect below. */
export const DEFAULT_CLIENT_ID = 'aip-cli'

/** Fixed because the redirect URI is registered on the client, not negotiated. */
const CALLBACK_PORT = 8765

/** IPv4 literal: `localhost` may resolve to `::1` and miss the listener. */
const CALLBACK_HOST = '127.0.0.1'

/** Path half of the registered redirect URI. */
const CALLBACK_PATH = '/callback'

/**
 * Proven to pass the WAF. The Python client uses this exact string; the
 * default Node agent is rejected with 403 before reaching Keycloak.
 */
const USER_AGENT = 'arkan-cli/1.0'

/** Abandon a login that the operator never completes in the browser. */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

/** @returns the registered redirect URI, spelled identically everywhere. */
export function redirectUri(): string {
  return `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`
}

/**
 * @param authority - realm URL.
 * @param name - endpoint leaf, e.g. `auth`, `token`, `logout`.
 * @returns the absolute OpenID Connect endpoint.
 */
function endpoint(authority: string, name: string): string {
  return `${authority.replace(/\/+$/, '')}/protocol/openid-connect/${name}`
}

/** @returns URL-safe base64 without padding, as PKCE requires. */
function base64Url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** One PKCE challenge pair. */
interface Pkce {
  verifier: string
  challenge: string
}

/** @returns a fresh S256 PKCE pair. */
function createPkce(): Pkce {
  const verifier = base64Url(randomBytes(64))
  return { verifier, challenge: base64Url(createHash('sha256').update(verifier).digest()) }
}

/**
 * POST a form to Keycloak and parse the JSON reply.
 * @param url - endpoint to call.
 * @param form - form fields to send.
 * @returns the parsed response body.
 * @throws when the endpoint answers with a non-2xx status.
 */
async function postForm(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      'user-agent': USER_AGENT,
    },
    body: new URLSearchParams(form).toString(),
  })
  const text = await response.text()
  if (!response.ok) {
    // Keycloak returns a JSON error body; show it verbatim so `invalid_grant`
    // (expired refresh token) is distinguishable from a WAF or network fault.
    throw new Error(`${url} -> HTTP ${response.status} ${text.slice(0, 300)}`)
  }
  return JSON.parse(text) as Record<string, unknown>
}

/**
 * What the loopback server captured from the browser redirect. Every field is
 * a required key that may hold `undefined`, not an optional key: the repo
 * builds with `exactOptionalPropertyTypes`, under which an absent key and a
 * key set to `undefined` are different types.
 */
interface CallbackResult {
  code: string | undefined
  state: string | undefined
  error: string | undefined
  errorDescription: string | undefined
}

/**
 * Serve the registered loopback URI until the browser delivers the redirect
 * belonging to THIS login.
 *
 * A stale tab from an abandoned attempt keeps retrying this exact URL, so the
 * first request to arrive is not necessarily ours. Taking it would fail the
 * live login with a CSRF mismatch caused by a tab the operator forgot about —
 * so a request carrying the wrong `state` is answered and ignored, and the
 * server keeps listening for the real one.
 * @param expectedState - the `state` this login generated.
 * @param signal - aborts the wait when the operator gives up.
 * @returns the query parameters of the matching redirect.
 */
function awaitCallback(expectedState: string, signal: AbortSignal): Promise<CallbackResult> {
  return new Promise<CallbackResult>((resolve, reject) => {
    const page = (message: string): string =>
      '<!doctype html><meta charset="utf-8"><title>TAD</title>'
      + `<body style="font:16px system-ui;padding:3rem"><p>${message}</p></body>`

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${CALLBACK_HOST}:${CALLBACK_PORT}`)
      if (url.pathname !== CALLBACK_PATH) {
        response.writeHead(404).end()
        return
      }
      const result: CallbackResult = {
        code: url.searchParams.get('code') ?? undefined,
        state: url.searchParams.get('state') ?? undefined,
        error: url.searchParams.get('error') ?? undefined,
        errorDescription: url.searchParams.get('error_description') ?? undefined,
      }
      if (result.state !== expectedState) {
        // Someone else's redirect — almost always an abandoned tab replaying.
        response.writeHead(409, { 'content-type': 'text/html; charset=utf-8' })
          .end(page('Yêu cầu đăng nhập cũ — đóng tab này và dùng cửa sổ vừa mở.'))
        return
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
        page(result.error === undefined
          ? '✅ Đăng nhập xong — quay lại terminal.'
          : '❌ Đăng nhập thất bại.'),
      )
      server.close()
      resolve(result)
    })
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(
          `Cổng ${CALLBACK_PORT} đang bị chiếm nên không nhận được callback.\n`
          + '  Cổng này CỐ ĐỊNH vì redirect URI được đăng ký sẵn trên Keycloak, không đổi được.\n'
          + '  Thường là một tiến trình `dsh login` cũ chưa thoát. Tìm và tắt nó:\n'
          + `    netstat -ano | findstr :${CALLBACK_PORT}`,
        ))
        return
      }
      reject(error)
    })
    signal.addEventListener('abort', () => {
      server.close()
      reject(new Error(`Hết ${LOGIN_TIMEOUT_MS / 1000}s chờ trình duyệt — chưa hoàn tất đăng nhập.`))
    })
    server.listen(CALLBACK_PORT, CALLBACK_HOST)
  })
}

/**
 * Open the system browser without inheriting this process's lifetime.
 *
 * Windows uses `rundll32` rather than `cmd /c start`. An authorization URL is
 * full of `&`, which **cmd.exe treats as a command separator**: the browser
 * received only everything up to the first one, so Keycloak saw a request
 * missing `client_id`, `redirect_uri`, `scope`, `state` and `code_challenge`
 * and answered `invalid_request`. `rundll32` is launched directly, so the URL
 * never passes through a shell parser and arrives whole.
 * @param url - the authorization URL to show.
 */
function openBrowser(url: string): void {
  const [command, args] = process.platform === 'win32'
    ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]]
  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref()
  } catch {
    // Headless boxes have no browser; the caller already printed the URL.
  }
}

/**
 * Run the interactive login and return a fresh session.
 * @param authority - realm URL.
 * @param clientId - public client id.
 * @returns credentials ready to persist.
 */
export async function login(authority: string, clientId: string): Promise<ArkanCredentials> {
  const { verifier, challenge } = createPkce()
  const state = base64Url(randomBytes(24))

  const authorize = new URL(endpoint(authority, 'auth'))
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri(),
    scope: 'openid profile email',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString()

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LOGIN_TIMEOUT_MS)
  const pending = awaitCallback(state, controller.signal)

  process.stdout.write(`Mở trình duyệt để đăng nhập. Nếu không tự mở, dán liên kết này:\n\n  ${authorize.toString()}\n\n`)
  openBrowser(authorize.toString())

  let result: CallbackResult
  try {
    result = await pending
  } finally {
    clearTimeout(timer)
  }

  if (result.error !== undefined) {
    throw new Error(`Keycloak từ chối: ${result.error} — ${result.errorDescription ?? ''}`)
  }
  // Check state BEFORE spending the code: a mismatched state means the
  // redirect did not come from the request we started, so the code is not ours.
  if (result.state !== state) throw new Error('State không khớp — nghi ngờ CSRF, huỷ đăng nhập.')
  if (result.code === undefined) throw new Error('Callback thiếu authorization code.')

  const tokens = await postForm(endpoint(authority, 'token'), {
    grant_type: 'authorization_code',
    client_id: clientId,
    code: result.code,
    redirect_uri: redirectUri(),
    code_verifier: verifier,
  })
  return toCredentials(authority, clientId, tokens)
}

/**
 * Mint a new access token from the stored refresh token.
 * @param credentials - the expired session.
 * @returns a refreshed session.
 */
export async function refresh(credentials: ArkanCredentials): Promise<ArkanCredentials> {
  if (credentials.refresh_token === '') throw new Error('Không có refresh_token — đăng nhập lại.')
  const tokens = await postForm(endpoint(credentials.authority, 'token'), {
    grant_type: 'refresh_token',
    client_id: credentials.client_id,
    refresh_token: credentials.refresh_token,
  })
  const next = toCredentials(credentials.authority, credentials.client_id, tokens)
  if (next.access_token === '') {
    // A 200 without a token must not overwrite a still-valid stored session.
    throw new Error('Refresh thất bại (phản hồi không có access_token) — chạy `dsh login` lại.')
  }
  // Keycloak may not rotate the refresh token; keep the old one when absent.
  if (next.refresh_token === '') next.refresh_token = credentials.refresh_token
  return next
}

/**
 * Revoke the refresh token server-side so `logout` is not merely local.
 * @param credentials - the session to end.
 */
export async function revoke(credentials: ArkanCredentials): Promise<void> {
  if (credentials.refresh_token === '') return
  await postForm(endpoint(credentials.authority, 'logout'), {
    client_id: credentials.client_id,
    refresh_token: credentials.refresh_token,
  })
}

/**
 * Decode a JWT payload without verifying it. Display only — the server is the
 * only party that may decide whether a token is trustworthy.
 * @param token - the access token to inspect.
 * @returns the claim set, or an empty object when the token is unreadable.
 */
export function readClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1]
  if (payload === undefined) return {}
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}
