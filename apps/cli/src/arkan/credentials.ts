/**
 * Credential store for Arkan SSO, deliberately byte-compatible with the Python
 * reference client (`arkan/app/scripts/cli_login.py`): the same
 * `~/.arkan/credentials` JSON, so one `login` serves both CLIs and neither
 * invalidates the other's session.
 *
 * The file holds a refresh token, so it is written through an exclusive
 * temporary file and renamed — never opened in place. Writing in place would
 * leave a window where the token sits in a mode-0644 file, and following an
 * existing path would let a pre-planted symlink redirect the write.
 * @module @deepseek-ai/dsh/arkan/credentials
 */

import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Directory holding the shared Arkan credential file. */
const CREDENTIAL_DIR = join(homedir(), '.arkan')

/** The credential file itself, shared with the Python `cli_login.py`. */
const CREDENTIAL_PATH = join(CREDENTIAL_DIR, 'credentials')

/**
 * One stored session. Field names and types mirror `_tokens_to_creds` in the
 * Python client — renaming any of them silently breaks cross-CLI interop,
 * because neither side validates the other's schema.
 */
export interface ArkanCredentials {
  /** Keycloak realm URL, e.g. `https://sso.example.com/realms/<realm>`. */
  authority: string
  /** Public client id the tokens were issued to. */
  client_id: string
  /** Current access token; may already be expired, see {@link isExpired}. */
  access_token: string
  /** Long-lived token used to mint new access tokens without a browser. */
  refresh_token: string
  /** Absolute expiry of `access_token`, in whole Unix seconds. */
  expires_at: number
}

/** Refresh this many seconds early, so a token cannot expire mid-request. */
const REFRESH_SKEW_SECONDS = 60

/** @returns the current time in whole Unix seconds, matching `expires_at`. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * @param credentials - the stored session to test.
 * @returns true when the access token is expired or within the refresh skew.
 */
export function isExpired(credentials: ArkanCredentials): boolean {
  return credentials.expires_at - REFRESH_SKEW_SECONDS <= nowSeconds()
}

/**
 * Build a credential record from a Keycloak token response.
 * @param authority - realm URL the tokens came from.
 * @param clientId - public client id used for the exchange.
 * @param tokens - raw JSON body of the token endpoint.
 * @returns the record to persist.
 */
export function toCredentials(
  authority: string,
  clientId: string,
  tokens: Record<string, unknown>,
): ArkanCredentials {
  // Keycloak omits `expires_in` on some client configurations; the Python
  // client falls back to 300s and we must agree, or the two CLIs would
  // disagree on when the very same token expires.
  const lifetime = typeof tokens.expires_in === 'number' ? tokens.expires_in : 300
  return {
    authority,
    client_id: clientId,
    access_token: String(tokens.access_token ?? ''),
    refresh_token: String(tokens.refresh_token ?? ''),
    expires_at: nowSeconds() + lifetime,
  }
}

/** @returns the stored session, or null when this machine has never logged in. */
export function readCredentials(): ArkanCredentials | null {
  try {
    return JSON.parse(readFileSync(CREDENTIAL_PATH, 'utf8')) as ArkanCredentials
  } catch {
    return null
  }
}

/**
 * Persist a session at mode 0600 through an exclusive temp file.
 * @param credentials - the session to store.
 */
export function writeCredentials(credentials: ArkanCredentials): void {
  mkdirSync(CREDENTIAL_DIR, { recursive: true, mode: 0o700 })
  // mkdir leaves an existing directory's mode alone, so tighten it explicitly.
  try { chmodSync(CREDENTIAL_DIR, 0o700) } catch { /* best effort on Windows */ }

  const temporary = `${CREDENTIAL_PATH}.tmp`
  rmSync(temporary, { force: true })
  // O_EXCL refuses to follow a pre-planted symlink or reuse a stale temp file.
  const handle = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(handle, `${JSON.stringify(credentials, null, 2)}\n`)
  } finally {
    closeSync(handle)
  }
  renameSync(temporary, CREDENTIAL_PATH)
  try { chmodSync(CREDENTIAL_PATH, 0o600) } catch { /* best effort on Windows */ }
}

/** Remove the stored session; missing file is not an error. */
export function clearCredentials(): void {
  rmSync(CREDENTIAL_PATH, { force: true })
}

/** @returns the path shown to the user in messages. */
export function credentialPath(): string {
  return CREDENTIAL_PATH
}
