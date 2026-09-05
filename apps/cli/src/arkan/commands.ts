/**
 * Command bodies for the Arkan authentication family: `dsh login`,
 * `dsh logout`, `dsh whoami`, `dsh token`, and `dsh session register`.
 *
 * Each returns a process exit code rather than calling `process.exit`, so the
 * dispatcher owns termination and these stay testable.
 * @module @deepseek-ai/dsh/arkan/commands
 */

import { createHash } from 'node:crypto'
import { hostname, networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import {
  clearCredentials,
  credentialPath,
  isExpired,
  readCredentials,
  writeCredentials,
  type ArkanCredentials,
} from './credentials.ts'
import {
  DEFAULT_AUTHORITY,
  DEFAULT_CLIENT_ID,
  deviceLogin,
  login,
  readClaims,
  refresh,
  revoke,
} from './oidc.ts'
import {
  approveMachine,
  approveSatelliteLink,
  CHECKLIST_ITEMS,
  createSatelliteLink,
  createWorkorder,
  fetchRegistryEntry,
  fetchProfile,
  findLinkIdsInAudit,
  isDefaultEmployeeRole,
  linksPath,
  recallLink,
  listAvailableWorkorders,
  listMachines,
  readStoredLease,
  registerMachine,
  revokeMachine,
  type ApprovedMachine,
  RISK_FLAGS,
  DEFAULT_STUDIO_BASE_URL,
  issueLease,
  type IssuedLease,
  SATELLITE_TYPES,
  sessionPath,
  storeLease,
} from './session.ts'

/** Options accepted by every command in this family. */
export interface ArkanOptions {
  authority?: string
  clientId?: string
  /** `dsh login --device`: RFC 8628 instead of the loopback redirect. */
  device?: boolean
  studioBaseUrl?: string
  workorder?: string
  satelliteLink?: string
  fingerprint?: string
  modelRef?: string
  type?: string
  approve?: boolean
  approveId?: string
  revokeId?: string
  title?: string
  description?: string
  repo?: string
  checklist?: string
  risk?: string
  diffBoundary?: string[]
  list?: boolean
  generateFingerprint?: boolean
  displayName?: string
  tailscaleHostname?: string
}

/**
 * Read a setting from the flag, then the environment, then the built-in.
 * @param flag - value passed on the command line, if any.
 * @param variable - environment variable consulted next.
 * @param fallback - built-in default.
 * @returns the effective value.
 */
function setting(flag: string | undefined, variable: string, fallback: string): string {
  const fromEnvironment = process.env[variable]
  if (flag !== undefined && flag !== '') return flag
  if (fromEnvironment !== undefined && fromEnvironment.trim() !== '') return fromEnvironment.trim()
  return fallback
}

/**
 * Resolve an endpoint that a build may ship no default for.
 *
 * The public distribution deliberately carries no SSO realm and no Studio URL:
 * those name one organisation's infrastructure. Without this guard an unset
 * endpoint reaches `fetch` as an empty string and surfaces as a confusing
 * network error, when the real problem is a missing setting the operator can
 * fix in one line.
 * @param flag - value passed on the command line, if any.
 * @param variable - environment variable consulted next.
 * @param fallback - build-time default, empty in the public distribution.
 * @param what - what the endpoint is, for the error message.
 * @returns the resolved endpoint.
 * @throws when nothing supplies it.
 */
function requireEndpoint(flag: string | undefined, variable: string, fallback: string, what: string): string {
  const value = setting(flag, variable, fallback)
  if (value.trim() !== '') return value
  throw new Error(
    `Chưa cấu hình ${what}. Bản phát hành này không kèm endpoint mặc định.\n`
    + `  Đặt biến môi trường ${variable}=<url>, hoặc truyền cờ tương ứng.`,
  )
}

/** @returns a short identity line for the operator, e.g. `alice@example.com`. */
function identity(credentials: ArkanCredentials): string {
  const claims = readClaims(credentials.access_token)
  const email = claims.email ?? claims.preferred_username ?? claims.sub
  return typeof email === 'string' ? email : '(không đọc được claim)'
}

/**
 * Load the stored session and silently refresh it when it has aged out.
 * @returns a session with a usable access token.
 * @throws when the machine has never logged in or the refresh token is dead.
 */
async function requireFreshCredentials(): Promise<ArkanCredentials> {
  const stored = readCredentials()
  if (stored === null) throw new Error('Chưa đăng nhập — chạy `dsh login` trước.')
  if (!isExpired(stored)) return stored
  let renewed: ArkanCredentials
  try {
    renewed = await refresh(stored)
  } catch (error) {
    // `invalid_grant` is the ordinary "your session aged out" case and is by
    // far the most common failure here; showing only Keycloak's wording sends
    // people hunting for a fault that does not exist.
    const message = (error as Error).message
    if (message.includes('invalid_grant')) {
      throw new Error('Phiên đăng nhập đã hết hạn — chạy `dsh login` để đăng nhập lại.')
    }
    throw error
  }
  writeCredentials(renewed)
  return renewed
}

/**
 * `dsh login` — interactive PKCE sign-in.
 * @param options - authority/client overrides.
 * @returns the process exit code.
 */
export async function runLogin(options: ArkanOptions): Promise<number> {
  const authority = requireEndpoint(options.authority, 'ARKAN_AUTHORITY', DEFAULT_AUTHORITY, 'realm SSO')
  const clientId = setting(options.clientId, 'ARKAN_CLIENT_ID', DEFAULT_CLIENT_ID)
  // The loopback flow needs a browser on THIS machine: it binds this host's
  // 127.0.0.1, so over SSH the redirect lands on the operator's own laptop
  // where nothing is listening. The device grant has no redirect at all.
  const credentials = options.device === true
    ? await deviceLogin(authority, clientId)
    : await login(authority, clientId)
  writeCredentials(credentials)
  process.stdout.write(`✅ Đã đăng nhập: ${identity(credentials)}\n`)
  process.stdout.write(`   Lưu tại ${credentialPath()} (dùng chung với arkan CLI)\n`)
  return 0
}

/**
 * `dsh logout` — revoke server-side, then delete the local session.
 * @returns the process exit code.
 */
export async function runLogout(): Promise<number> {
  const stored = readCredentials()
  if (stored === null) {
    process.stdout.write('Chưa đăng nhập, không có gì để thoát.\n')
    return 0
  }
  try {
    await revoke(stored)
  } catch (error) {
    // Deleting locally still matters even when the back-channel call fails,
    // so report and continue rather than leaving the token on disk.
    process.stderr.write(`Cảnh báo: thu hồi phía máy chủ thất bại — ${(error as Error).message}\n`)
  }
  clearCredentials()
  process.stdout.write('✅ Đã đăng xuất và xoá phiên cục bộ.\n')
  return 0
}

/**
 * `dsh whoami` — print the identity behind the stored token.
 * @returns the process exit code.
 */
export async function runWhoami(): Promise<number> {
  const credentials = await requireFreshCredentials()
  const claims = readClaims(credentials.access_token)
  process.stdout.write(`${identity(credentials)}\n`)
  process.stdout.write(`  realm : ${credentials.authority}\n`)
  process.stdout.write(`  client: ${credentials.client_id}\n`)
  process.stdout.write(`  sub   : ${String(claims.sub ?? '?')}\n`)
  process.stdout.write(`  hết hạn sau: ${Math.max(0, credentials.expires_at - Math.floor(Date.now() / 1000))}s\n`)
  return 0
}

/**
 * `dsh token` — print a valid access token for scripts and curl.
 * @returns the process exit code.
 */
export async function runToken(): Promise<number> {
  const credentials = await requireFreshCredentials()
  process.stdout.write(`${credentials.access_token}\n`)
  return 0
}

/**
 * `dsh session link` — declare that this engineer uses DSH, which is the
 * prerequisite the whole lease chain rests on: `register_machine` refuses
 * without at least one ACTIVE binding, and `issue_lease` re-checks it.
 *
 * Approval is a separate call behind `studio:machines:approve`, so it stays
 * behind `--approve` rather than happening implicitly: an engineer without
 * that permission would otherwise see the command half-succeed and have to
 * work out which half.
 * @param options - binding type and whether to approve in the same run.
 * @returns the process exit code.
 */
export async function runSessionLink(options: ArkanOptions): Promise<number> {
  const baseUrlOnly = requireEndpoint(options.studioBaseUrl, 'ARKAN_STUDIO_BASE_URL', DEFAULT_STUDIO_BASE_URL, 'Arkan Studio')

  // Approving an EXISTING binding must not go through create first: the unique
  // constraint on (employee_id, satellite_type) where revoked_at IS NULL would
  // answer 409 and the operator would never reach the approval they asked for.
  // Read the flag ONLY. `ARKAN_SATELLITE_LINK_ID` belongs to `session register`
  // and is commonly exported in a working shell; letting it fall through here
  // would silently approve whatever binding that variable happens to name.
  const existing = options.approveId ?? ''
  if (existing !== '') {
    const credentials = await requireFreshCredentials()
    const approved = await approveSatelliteLink(baseUrlOnly, credentials, existing)
    process.stdout.write(`✅ Đã duyệt binding ${approved.satellite_type}: ${approved.status}\n\n`)
    process.stdout.write('Dùng id này cho bước xin lease:\n')
    process.stdout.write(`  dsh session register --workorder <id> --satellite-link ${approved.id}\n`)
    return 0
  }

  const satelliteType = setting(options.type, 'ARKAN_SATELLITE_TYPE', 'llm_deepseek_harness')
  if (!(SATELLITE_TYPES as readonly string[]).includes(satelliteType)) {
    process.stderr.write(`Loại không hợp lệ: ${satelliteType}\n  Chọn một trong: ${SATELLITE_TYPES.join(', ')}\n`)
    return 2
  }
  const credentials = await requireFreshCredentials()
  const link = await createSatelliteLink(baseUrlOnly, credentials, satelliteType)
  process.stdout.write(`✅ Đã tạo binding ${link.satellite_type}\n`)
  process.stdout.write(`   id     : ${link.id}\n`)
  process.stdout.write(`   trạng thái: ${link.status}\n`)

  if (options.approve !== true) {
    // Point at --approve-id, never at a bare --approve: a second run would try
    // to CREATE again and hit the unique constraint, so the operator would be
    // told to run a command that cannot work.
    process.stdout.write('\nBinding chưa dùng được cho tới khi được duyệt. Người có quyền\n')
    process.stdout.write('studio:machines:approve chạy (KHÔNG chạy lại lệnh tạo — sẽ 409):\n')
    process.stdout.write(`  dsh session link --approve-id ${link.id}\n`)
    return 0
  }

  // The create above SUCCEEDED. Letting an approve failure propagate as a bare
  // error made the whole command read as "nothing happened", so the operator
  // ran it again and met a 409 whose id nothing could look up. Whatever goes
  // wrong here, the binding exists and its id must survive the message.
  let approved
  try {
    approved = await approveSatelliteLink(baseUrlOnly, credentials, link.id)
  } catch (error) {
    process.stderr.write(`\n⚠️  Binding ĐÃ TẠO XONG, chỉ bước duyệt thất bại:\n  ${(error as Error).message}\n`)
    process.stderr.write('\nĐừng chạy lại lệnh này — nó sẽ tạo lại và bị 409.\n')
    process.stderr.write(`Đưa id ${link.id} cho người có quyền studio:machines:approve, họ chạy:\n`)
    process.stderr.write(`  dsh session link --approve-id ${link.id}\n`)
    process.stderr.write(`\nId cũng đã được ghi lại ở ${linksPath()}.\n`)
    return 1
  }
  process.stdout.write(`✅ Đã duyệt: ${approved.status}\n\n`)
  process.stdout.write('Dùng id này cho bước xin lease:\n')
  process.stdout.write(`  dsh session register --workorder <id> --satellite-link ${approved.id}\n`)
  return 0
}

/**
 * Split a comma list and reject unknown keys. The server treats an unknown
 * `gate_inputs` key as simply absent, so a typo would silently become an
 * unmet checklist item and the rejection would name the wrong cause.
 * @param raw - the comma-separated flag value.
 * @param allowed - the keys the server actually reads.
 * @param label - flag name, for the error message.
 * @returns the validated keys.
 * @throws when a key is not recognised.
 */
function parseKeys(raw: string, allowed: readonly string[], label: string): string[] {
  const keys = raw.split(',').map(part => part.trim()).filter(part => part !== '')
  const unknown = keys.filter(key => !allowed.includes(key))
  if (unknown.length > 0) {
    throw new Error(`${label}: khóa không hợp lệ ${unknown.join(', ')}
  Hợp lệ: ${allowed.join(', ')}`)
  }
  return keys
}

/**
 * Derive a fingerprint that stays the same across reboots and reinstalls.
 *
 * The value only has to be stable and unique per machine — the server treats it
 * as an opaque key. Hostname alone can collide across a fleet, so the first
 * non-internal MAC is mixed in when one exists.
 * @returns 24 hex characters.
 */
function deriveFingerprint(): string {
  const interfaces = Object.values(networkInterfaces())
    .flat()
    .filter((entry): entry is NetworkInterfaceInfo => entry !== undefined && !entry.internal)
    .map(entry => entry.mac)
    .filter(mac => mac !== '00:00:00:00:00:00')
    .sort()
  const seed = `${hostname()}|${process.platform}|${interfaces[0] ?? 'no-mac'}`
  return createHash('sha256').update(seed).digest('hex').slice(0, 24)
}

/**
 * `dsh session machine` — declare this machine as a dev machine, the gate that
 * `issue_lease` checks the device fingerprint against.
 *
 * Approval is separate because it needs `studio:machines:approve` AND because
 * it mints the machine token, which the server returns in the clear exactly
 * once — a step worth taking deliberately rather than as a side effect.
 * @param options - fingerprint, labels, and which action to take.
 * @returns the process exit code.
 */
export async function runSessionMachine(options: ArkanOptions): Promise<number> {
  const baseUrl = requireEndpoint(options.studioBaseUrl, 'ARKAN_STUDIO_BASE_URL', DEFAULT_STUDIO_BASE_URL, 'Arkan Studio')

  if (options.list === true) {
    const credentials = await requireFreshCredentials()
    const machines = await listMachines(baseUrl, credentials)
    if (machines.length === 0) {
      process.stdout.write('Chưa có máy nào trong tenant này.\n')
      return 0
    }
    for (const machine of machines) {
      process.stdout.write(`${machine.id}  ${machine.status.padEnd(17)}`
        + `${(machine.display_name ?? '(chưa đặt tên)').padEnd(26)}`
        + `fp:${machine.fingerprint_prefix}\n`)
    }
    return 0
  }

  // Revoking is destructive and one-way, so it takes its own explicit flag and
  // never rides along with another action.
  const revoking = options.revokeId ?? ''
  if (revoking !== '') {
    const credentials = await requireFreshCredentials()
    const revoked = await revokeMachine(baseUrl, credentials, revoking)
    process.stdout.write(`✅ Đã thu hồi máy: ${revoked.status}\n`)
    process.stdout.write(`   lease bị thu hồi theo: ${revoked.leases_revoked}\n\n`)
    process.stdout.write('Fingerprint của máy này KHÔNG đăng ký lại được — lần sau phải\n')
    process.stdout.write('dùng giá trị khác (--fingerprint <giá-trị-mới>).\n')
    return 0
  }

  // Approving an existing machine must not register first: registration is
  // idempotent and would return the row untouched, so the operator would think
  // the command did nothing.
  const existing = options.approveId ?? ''
  if (existing !== '') {
    const credentials = await requireFreshCredentials()
    const approved = await approveMachine(baseUrl, credentials, existing)
    reportApproval(approved)
    return 0
  }

  const fingerprint = options.generateFingerprint === true
    ? deriveFingerprint()
    : setting(options.fingerprint, 'ARKAN_DEVICE_FINGERPRINT', '')
  if (fingerprint === '') {
    process.stderr.write('Thiếu fingerprint. Dùng một trong hai:\n')
    process.stderr.write('  --fingerprint <chuỗi>      giá trị bạn tự chọn (>= 8 ký tự)\n')
    process.stderr.write('  --generate-fingerprint     suy ra từ hostname + MAC, ổn định qua khởi động lại\n')
    return 2
  }
  if (fingerprint.length < 8) {
    process.stderr.write(`Fingerprint phải >= 8 ký tự, hiện có ${fingerprint.length}.\n`)
    return 2
  }

  const credentials = await requireFreshCredentials()
  const machine = await registerMachine(
    baseUrl, credentials, fingerprint,
    options.displayName ?? '', options.tailscaleHostname ?? '',
  )

  process.stdout.write('✅ Máy đã đăng ký\n')
  process.stdout.write(`   id        : ${machine.id}\n`)
  process.stdout.write(`   trạng thái : ${machine.status}\n`)
  process.stdout.write(`   fingerprint: ${fingerprint}\n`)
  if (options.generateFingerprint === true) {
    process.stdout.write('   ^ LƯU LẠI giá trị này — lease đối chiếu đúng chuỗi đó.\n')
  }
  process.stdout.write('\n')

  if (machine.status !== 'PENDING_APPROVAL') {
    // Registration is idempotent, so an existing row comes back as-is.
    process.stdout.write(`Máy đã tồn tại ở trạng thái ${machine.status}, không tạo mới.\n`)
    if (machine.status === 'REVOKED') {
      process.stdout.write('Máy REVOKED KHÔNG hồi sinh được — phải dùng fingerprint khác.\n')
      return 1
    }
    return 0
  }

  if (options.approve !== true) {
    process.stdout.write('Máy chưa dùng được cho tới khi được duyệt. Người có quyền\n')
    process.stdout.write('studio:machines:approve chạy (KHÔNG chạy lại lệnh đăng ký):\n')
    process.stdout.write(`  dsh session machine --approve-id ${machine.id}\n`)
    return 0
  }

  // As with bindings: the register above SUCCEEDED, and an approve failure that
  // propagates as a bare error makes the whole command read as "nothing
  // happened". Registration is idempotent, so a rerun is harmless — but it is
  // also pointless, and saying so beats leaving the operator to guess.
  try {
    reportApproval(await approveMachine(baseUrl, credentials, machine.id))
  } catch (error) {
    process.stderr.write(`\n⚠️  Máy ĐÃ ĐĂNG KÝ XONG, chỉ bước duyệt thất bại:\n  ${(error as Error).message}\n`)
    process.stderr.write(`\nĐưa id ${machine.id} cho người có quyền studio:machines:approve, họ chạy:\n`)
    process.stderr.write(`  dsh session machine --approve-id ${machine.id}\n`)
    process.stderr.write('\nChạy lại lệnh đăng ký không hỏng gì (idempotent) nhưng cũng không giúp gì.\n')
    return 1
  }
  return 0
}

/**
 * Print an approval result, giving the one-time token the prominence it needs.
 * @param approved - the approve response, including the plaintext token.
 */
function reportApproval(approved: ApprovedMachine): void {
  process.stdout.write(`✅ Đã duyệt máy: ${approved.status}\n\n`)
  process.stdout.write('   machine token (HIỆN ĐÚNG MỘT LẦN — máy chủ chỉ giữ sha256):\n')
  process.stdout.write(`   ${approved.machine_token}\n\n`)
  process.stdout.write('   Lưu vào ARKAN_DM_TOKEN cùng ARKAN_MACHINE_ID và\n')
  process.stdout.write('   ARKAN_DEVICE_FINGERPRINT. Mất token thì phải revoke rồi\n')
  process.stdout.write('   đăng ký lại bằng fingerprint mới — không cấp lại được.\n')
}

/**
 * `dsh session workorder` — create the Studio work order a lease hangs off.
 *
 * The tier is scored by the SERVER from the risk flags and is never sent: any
 * of `touches_pii|payment|auth|production_migration` is rejected outright
 * (AC-DEV-10), the two structural flags give tier B, and `issue_lease` accepts
 * only tier C (FR-TEN-06). So this declares what is true and reports the
 * verdict rather than predicting it.
 * @param options - work order fields plus declared checklist and risk keys.
 * @returns the process exit code.
 */
export async function runSessionWorkorder(options: ArkanOptions): Promise<number> {
  const title = options.title ?? ''
  const description = options.description ?? ''
  const targetRepo = options.repo ?? ''
  const missing = [
    title === '' ? '--title' : null,
    description === '' ? '--description' : null,
    targetRepo === '' ? '--repo' : null,
  ].filter((entry): entry is string => entry !== null)
  if (missing.length > 0) {
    process.stderr.write(`Thiếu tham số:\n  ${missing.join('\n  ')}\n`)
    return 2
  }

  const checklist = parseKeys(options.checklist ?? '', CHECKLIST_ITEMS, '--checklist')
  const risk = parseKeys(options.risk ?? '', RISK_FLAGS, '--risk')

  const credentials = await requireFreshCredentials()
  const workorder = await createWorkorder(
    requireEndpoint(options.studioBaseUrl, 'ARKAN_STUDIO_BASE_URL', DEFAULT_STUDIO_BASE_URL, 'Arkan Studio'),
    credentials,
    { title, description, targetRepo, diffBoundary: options.diffBoundary ?? [], checklist, risk },
  )

  process.stdout.write('✅ Đã tạo work order\n')
  process.stdout.write(`   id        : ${workorder.id}\n`)
  process.stdout.write(`   tier      : ${workorder.tier}\n`)
  process.stdout.write(`   trạng thái : ${workorder.status}\n\n`)

  if (workorder.tier !== 'C') {
    process.stderr.write(`⚠  Tier ${workorder.tier} — lease CHỈ nhận Tier C (FR-TEN-06).\n`)
    process.stderr.write('   Cờ rủi ro bạn khai đã đẩy nó lên tier này. Work order vẫn tồn tại\n')
    process.stderr.write('   nhưng không xin lease được.\n')
    return 1
  }

  process.stdout.write('Bước kế tiếp:\n')
  process.stdout.write(`  dsh session register --workorder ${workorder.id} --satellite-link <uuid> --model-ref <ref ACTIVE>\n`)
  return 0
}
/**
 * `dsh session register` — obtain an EngineLease so the relay plugin may
 * report this session's progress instead of only a heartbeat.
 * @param options - lease inputs, each also readable from the environment.
 * @returns the process exit code.
 */
export async function runSessionRegister(options: ArkanOptions): Promise<number> {
  const workorderId = setting(options.workorder, 'ARKAN_WORKORDER_ID', '')
  const satelliteLinkId = setting(options.satelliteLink, 'ARKAN_SATELLITE_LINK_ID', '')
  const deviceFingerprint = setting(options.fingerprint, 'ARKAN_DEVICE_FINGERPRINT', '')

  // No default model ref. `clinepass/default` used to sit here, but it is a
  // PLACEHOLDER row seeded at status DEV (migration 069, Open Item #2 "model cu
  // the CHUA CHOT") — defaulting to it guarantees a 403 from `_live_checks` and
  // sends people debugging their own command instead of reading the gate.
  const modelRef = setting(options.modelRef, 'ARKAN_MODEL_REF', '')

  const missing = [
    workorderId === '' ? '--workorder (hoặc ARKAN_WORKORDER_ID)' : null,
    satelliteLinkId === '' ? '--satellite-link (hoặc ARKAN_SATELLITE_LINK_ID)' : null,
    deviceFingerprint === '' ? '--fingerprint (hoặc ARKAN_DEVICE_FINGERPRINT)' : null,
    modelRef === '' ? '--model-ref (hoặc ARKAN_MODEL_REF) — phải là ref ACTIVE trong Model Registry' : null,
  ].filter((entry): entry is string => entry !== null)
  if (missing.length > 0) {
    process.stderr.write(`Thiếu tham số:\n  ${missing.join('\n  ')}\n`)
    return 2
  }

  // Credentials are demanded only after the arguments check out: a typo should
  // not cost an interactive login round-trip.
  const credentials = await requireFreshCredentials()

  const lease = await issueLease(
    requireEndpoint(options.studioBaseUrl, 'ARKAN_STUDIO_BASE_URL', DEFAULT_STUDIO_BASE_URL, 'Arkan Studio'),
    credentials,
    {
      workorderId,
      satelliteLinkId,
      deviceFingerprint,
      modelRef,
    },
  )
  storeLease(lease)

  process.stdout.write(`✅ Phiên đã vào danh sách theo dõi của Work Order ${lease.workorder_id}\n`)
  process.stdout.write(`   lease  : ${lease.id} (${lease.status})\n`)
  process.stdout.write(`   model  : ${lease.model_ref}\n`)
  process.stdout.write(`   hết hạn: ${lease.expires_at ?? '?'} (trần ${lease.absolute_expires_at ?? '?'})\n`)
  process.stdout.write(`   lưu tại: ${sessionPath()}\n\n`)
  // The relay plugin reads process.env directly, so a session started from a
  // shell that predates this command still needs the value exported by hand.
  process.stdout.write('Chạy dsh trong shell đã có biến này thì plugin mới gửi tiến độ:\n')
  process.stdout.write(`  export ARKAN_LEASE_ID=${lease.id}\n`)
  return 0
}

/** One line of the status report: a label, a value, and how to read it. */
/**
 * The four permissions the DSH chain needs, and what each one unlocks.
 *
 * Ordered as the chain uses them. `studio:machines:read` is included even
 * though it blocks nothing — an operator who sees its 403 needs to be told it
 * is harmless, and silence would not do that.
 */
const CHAIN_PERMISSIONS: readonly (readonly [string, string])[] = [
  ['studio:read:tenant', 'liệt kê work order (dsh workorders)'],
  ['studio:write:own', 'tạo work order và xin lease'],
  ['studio:machines:read', 'xem danh sách máy — thiếu cũng KHÔNG chặn gì'],
  ['studio:machines:approve', 'duyệt binding và máy dev — thiếu là tắc'],
]

export interface StatusLine {
  label: string
  value: string
  /** Set when the line reports a broken or missing precondition. */
  problem?: string
}

/**
 * Format one report section.
 * @param title - the section heading.
 * @param lines - the section's lines.
 * @returns the printable block.
 */
function section(title: string, lines: StatusLine[]): string {
  const width = Math.max(...lines.map(line => line.label.length))
  const body = lines.map((line) => {
    const head = `  ${line.label.padEnd(width)} : ${line.value}`
    return line.problem === undefined ? head : `${head}\n  ${' '.repeat(width)}   -> ${line.problem}`
  })
  return `${title}\n${body.join('\n')}\n`
}

/** @returns the value's presence, never the value: these are secrets. */
function secretPresence(variable: string): StatusLine {
  const raw = process.env[variable] ?? ''
  if (raw.trim() === '') {
    return { label: variable, value: 'chưa đặt', problem: 'plugin relay đọc biến này trực tiếp từ môi trường' }
  }
  return { label: variable, value: `đã đặt (${raw.trim().length} ký tự)` }
}

/**
 * Describe a lease's remaining life from its own timestamps.
 *
 * `status` in the cache file is not evidence: nothing rewrites it when the
 * lease ages out, so a long-dead lease still reads ACTIVE there. Only the
 * timestamps say whether §8c will accept a checkpoint.
 * @param lease - the cached lease.
 * @returns the lines describing it.
 */
export function leaseLines(lease: IssuedLease): StatusLine[] {
  const now = Date.now()
  const expiry = lease.expires_at === null ? Number.NaN : Date.parse(lease.expires_at)
  const ceiling = lease.absolute_expires_at === null ? Number.NaN : Date.parse(lease.absolute_expires_at)
  const lines: StatusLine[] = [
    { label: 'lease id', value: lease.id },
    { label: 'work order', value: lease.workorder_id },
    { label: 'model_ref', value: lease.model_ref },
  ]
  if (Number.isNaN(expiry)) {
    lines.push({ label: 'hết hạn', value: '(không đọc được)', problem: 'không xác định được lease còn hiệu lực hay không' })
    return lines
  }
  const left = Math.round((expiry - now) / 60_000)
  if (left > 0) {
    lines.push({ label: 'hết hạn', value: `${String(lease.expires_at)} — còn ${left} phút` })
  } else {
    lines.push({
      label: 'hết hạn',
      value: `${String(lease.expires_at)} — QUÁ HẠN ${Math.abs(left)} phút`,
      problem: 'xin lại trên CÙNG work order: dsh session register --workorder <id> ...',
    })
  }
  if (!Number.isNaN(ceiling)) {
    const ceilingLeft = Math.round((ceiling - now) / 60_000)
    if (ceilingLeft > 0) {
      lines.push({ label: 'trần tuyệt đối', value: `${String(lease.absolute_expires_at)} — còn ${ceilingLeft} phút` })
    } else {
      lines.push({
        label: 'trần tuyệt đối',
        value: `${String(lease.absolute_expires_at)} — ĐÃ VƯỢT`,
        problem: 'quá trần thì gia hạn không được nữa, phải tạo work order mới',
      })
    }
  }
  // The cache is the only local record, so say when it disagrees with the clock
  // rather than letting the operator read ACTIVE and trust it.
  if (lease.status !== 'ACTIVE') {
    lines.push({ label: 'status (đã lưu)', value: lease.status, problem: 'không phải ACTIVE — §8c sẽ từ chối' })
  } else if (left <= 0) {
    lines.push({
      label: 'status (đã lưu)',
      value: 'ACTIVE',
      problem: 'giá trị này KHÔNG đáng tin: file cache không được ghi lại khi lease hết hạn',
    })
  }
  return lines
}

/**
 * `dsh status` — report every link of the tracked-session chain at once.
 *
 * The chain has preconditions the server re-checks independently (login →
 * binding → dev machine → work order → lease → model registry), and each one
 * used to need a different command to probe while the failure surfaced only as
 * an opaque 403 from the relay. This reads all of them in one pass and names
 * the broken link, because that is the question an operator actually has.
 *
 * Never prints a secret: machine and access tokens are reported by presence
 * and length only.
 * @param options - Studio base URL override.
 * @returns the process exit code; non-zero when a precondition is broken.
 */
export async function runStatus(options: ArkanOptions): Promise<number> {
  const baseUrl = requireEndpoint(options.studioBaseUrl, 'ARKAN_STUDIO_BASE_URL', DEFAULT_STUDIO_BASE_URL, 'Arkan Studio')
  const problems: string[] = []

  let credentials: ArkanCredentials
  try {
    credentials = await requireFreshCredentials()
  } catch (error) {
    process.stdout.write(section('ĐĂNG NHẬP', [
      { label: 'trạng thái', value: 'CHƯA ĐĂNG NHẬP', problem: (error as Error).message },
    ]))
    process.stdout.write('\nDừng ở đây: mọi mắt còn lại đều cần token người dùng để tra.\n')
    return 1
  }

  const claims = readClaims(credentials.access_token)
  const secondsLeft = credentials.expires_at - Math.floor(Date.now() / 1000)
  process.stdout.write(section('ĐĂNG NHẬP', [
    { label: 'tài khoản', value: identity(credentials) },
    { label: 'realm', value: credentials.authority },
    { label: 'client', value: credentials.client_id },
    { label: 'sub', value: typeof claims.sub === 'string' ? claims.sub : '?' },
    { label: 'access token', value: `còn ${Math.max(0, secondsLeft)}s (tự refresh khi hết)` },
    { label: 'Studio', value: baseUrl },
  ]))

  // Permissions, read from `GET /auth/me` — the one Studio read that no
  // permission gates. Without it every question about access had to be answered
  // by provoking a 403 somewhere and interpreting the error, which is how a
  // harmless refusal and a blocking one ended up looking identical.
  const permissionLines: StatusLine[] = []
  try {
    const profile = await fetchProfile(baseUrl, credentials)
    permissionLines.push({ label: 'nhân sự', value: `${profile.name} — ${profile.department_name}` })
    permissionLines.push({ label: 'role', value: profile.role })
    if (!profile.is_active) {
      permissionLines.push({ label: 'trạng thái', value: 'ĐÃ VÔ HIỆU HOÁ', problem: 'nhờ quản trị viên kích hoạt lại' })
      problems.push('nhân sự bị vô hiệu hoá')
    }
    // The role's NAME is not in the response, so say what can be checked: is
    // this still the untouched default? An approver needs that before writing a
    // new role's permission list, because a custom role REPLACES the default
    // rather than adding to it.
    permissionLines.push(isDefaultEmployeeRole(profile.permissions)
      ? { label: 'custom role', value: 'chưa có — đang dùng role mặc định Employee (9 quyền)' }
      : { label: 'custom role', value: `có (${profile.permissions.length} quyền hiệu lực, khác mặc định)` })
    for (const [permission, what] of CHAIN_PERMISSIONS) {
      permissionLines.push(profile.permissions.includes(permission)
        ? { label: permission, value: `có — ${what}` }
        : { label: permission, value: `THIẾU — ${what}`, problem: 'xem arkan-docs/REQUEST-STUDIO-PERMISSIONS.md' })
    }
    if (!profile.permissions.includes('studio:machines:approve')) problems.push('thiếu quyền duyệt')
  } catch (error) {
    permissionLines.push({ label: 'tra quyền', value: 'không đọc được', problem: (error as Error).message.split('\n')[0] ?? '' })
  }
  process.stdout.write(`\n${section('QUYỀN', permissionLines)}`)

  // Binding: Studio has no GET route, so this is the local record plus audit.
  const linkFromEnv = process.env['ARKAN_SATELLITE_LINK_ID']?.trim() ?? ''
  const remembered = recallLink('llm_deepseek_harness')
  const audited = await findLinkIdsInAudit(baseUrl, credentials, 'llm_deepseek_harness')
  const bindingLines: StatusLine[] = []
  if (linkFromEnv !== '') bindingLines.push({ label: 'ARKAN_SATELLITE_LINK_ID', value: linkFromEnv })
  if (remembered !== null) {
    bindingLines.push({ label: 'máy này đã tạo', value: `${remembered.id} (lúc ${remembered.created_at})` })
  }
  if (audited.denied) {
    // Not a problem to fix, and not evidence of a missing binding: the route
    // needs `org:audit:read`, which the engineer creating bindings does not hold.
    bindingLines.push({ label: 'tra audit log', value: '403 — thiếu quyền org:audit:read, không kết luận được gì' })
  } else if (audited.ids.length === 0) {
    bindingLines.push({
      label: 'tra audit log',
      value: 'không thấy binding llm_deepseek_harness',
      problem: 'chưa khai báo: dsh session link --approve',
    })
    problems.push('binding')
  } else {
    const extra = audited.ids.length > 1 ? ` (+${audited.ids.length - 1} bản ghi cũ)` : ''
    bindingLines.push({ label: 'tra audit log', value: `${String(audited.ids[0])}${extra}` })
    // Audit records creations, never current status: say so instead of implying
    // the row is ACTIVE just because an entry exists.
    bindingLines.push({ label: 'lưu ý', value: 'audit chỉ ghi lúc TẠO, không ghi trạng thái hiện tại' })
  }
  if (remembered === null && audited.denied && linkFromEnv === '') problems.push('binding')
  process.stdout.write(`\n${section('BINDING (satellite link)', bindingLines)}`)

  // Dev machine: the fingerprint every lease is checked against.
  const derived = deriveFingerprint()
  const fingerprint = process.env['ARKAN_DEVICE_FINGERPRINT']?.trim() ?? ''
  const machineId = process.env['ARKAN_MACHINE_ID']?.trim() ?? ''
  const machineLines: StatusLine[] = [{ label: 'fingerprint máy này', value: derived }]
  if (fingerprint === '') {
    machineLines.push({
      label: 'ARKAN_DEVICE_FINGERPRINT',
      value: 'chưa đặt',
      problem: 'issue_lease so fingerprint này với DevMachine ACTIVE',
    })
  } else if (fingerprint === derived) {
    machineLines.push({ label: 'ARKAN_DEVICE_FINGERPRINT', value: fingerprint })
  } else {
    machineLines.push({
      label: 'ARKAN_DEVICE_FINGERPRINT',
      value: fingerprint,
      problem: 'KHÁC fingerprint dẫn xuất ở trên — cố ý thì bỏ qua, không thì lease sẽ bị từ chối',
    })
  }
  machineLines.push(machineId === ''
    ? { label: 'ARKAN_MACHINE_ID', value: 'chưa đặt', problem: 'plugin relay cần biến này để gửi heartbeat' }
    : { label: 'ARKAN_MACHINE_ID', value: machineId })
  machineLines.push(secretPresence('ARKAN_DM_TOKEN'))
  try {
    const machines = await listMachines(baseUrl, credentials)
    const mine = machines.find(row => row.id === machineId)
    machineLines.push({ label: 'máy đã đăng ký', value: `${machines.length} máy trong tenant` })
    if (mine === undefined) {
      machineLines.push({
        label: 'máy này trong Studio',
        value: machineId === '' ? '(không tra được vì thiếu ARKAN_MACHINE_ID)' : 'KHÔNG thấy id này',
        problem: 'đăng ký: dsh session machine --generate-fingerprint --approve',
      })
      problems.push('dev machine')
    } else {
      const name = mine.display_name === null ? '' : ` — ${mine.display_name}`
      machineLines.push({ label: 'máy này trong Studio', value: `${mine.status}${name}` })
      if (mine.status !== 'ACTIVE') problems.push('dev machine không ACTIVE')
      if (mine.last_seen_at !== null) machineLines.push({ label: 'lần cuối thấy', value: mine.last_seen_at })
    }
  } catch (error) {
    // Listing needs `studio:machines:read`, an administrative permission that
    // engineers do not hold and do not need. Putting that in the `problem` slot
    // made a normal 403 read as a fault to fix, right next to the real ones.
    const message = (error as Error).message
    if (message.includes('studio:machines:read')) {
      machineLines.push({ label: 'tra Studio', value: 'không xem được danh sách máy (thiếu studio:machines:read — không sao)' })
    } else {
      machineLines.push({ label: 'tra Studio', value: 'không tra được', problem: message.split('\n')[0] ?? '' })
    }
  }
  process.stdout.write(`\n${section('DEV MACHINE', machineLines)}`)

  // Work order and lease: the part that expires every four hours.
  const workorderFromEnv = process.env['ARKAN_WORKORDER_ID']?.trim() ?? ''
  const lease = readStoredLease()
  const leaseSection: StatusLine[] = []
  leaseSection.push(workorderFromEnv === ''
    ? { label: 'ARKAN_WORKORDER_ID', value: 'chưa đặt', problem: 'plugin gửi kèm work order theo mỗi sự kiện §8c' }
    : { label: 'ARKAN_WORKORDER_ID', value: workorderFromEnv })
  leaseSection.push(secretPresence('ARKAN_LEASE_ID'))
  if (lease === undefined) {
    leaseSection.push({
      label: `cache (${sessionPath()})`,
      value: 'chưa có lease nào được cấp trên máy này',
      problem: 'xin lease: dsh session register --workorder <id> --satellite-link <uuid> --model-ref <ref>',
    })
    problems.push('lease')
  } else {
    leaseSection.push(...leaseLines(lease))
    const envLease = process.env['ARKAN_LEASE_ID']?.trim() ?? ''
    if (envLease !== '' && envLease !== lease.id) {
      leaseSection.push({
        label: 'lệch',
        value: 'ARKAN_LEASE_ID khác lease trong cache',
        problem: 'phiên đang chạy dùng giá trị trong môi trường, không phải cache',
      })
    }
  }
  process.stdout.write(`\n${section('WORK ORDER & LEASE', leaseSection)}`)

  // Model registry: an ACTIVE row is a precondition issue_lease re-checks.
  if (lease !== undefined) {
    const entry = await fetchRegistryEntry(baseUrl, credentials, lease.model_ref)
    const registryLines: StatusLine[] = []
    if (entry === undefined) {
      registryLines.push({
        label: lease.model_ref,
        value: 'không thấy trong Model Registry (hoặc không tra được)',
        problem: 'ref chưa đăng ký thì không xin lease được',
      })
    } else {
      registryLines.push(entry.status === 'ACTIVE'
        ? { label: lease.model_ref, value: entry.status }
        : { label: lease.model_ref, value: entry.status, problem: 'chỉ ref ACTIVE mới back được lease' })
      if (entry.purpose !== undefined && entry.purpose !== '') {
        registryLines.push({ label: 'mục đích', value: entry.purpose.slice(0, 96) })
      }
      if (entry.limits !== undefined && entry.limits !== null && entry.limits !== '') {
        registryLines.push({ label: 'giới hạn', value: entry.limits.slice(0, 96) })
      }
      if (entry.status !== 'ACTIVE') problems.push('model registry')
    }
    process.stdout.write(`\n${section('MODEL REGISTRY', registryLines)}`)
  }

  process.stdout.write(problems.length === 0
    ? '\nChuỗi đủ mắt — phiên chạy trong shell có ARKAN_LEASE_ID sẽ báo tiến độ lên Console.\n'
    : `\nCòn thiếu: ${problems.join(', ')}. Sửa theo gợi ý -> ở trên, theo thứ tự trên xuống.\n`)
  return problems.length === 0 ? 0 : 1
}

/**
 * One message for "does not exist" and for "belongs to someone else".
 *
 * AC-DEV-22: telling the two apart would confirm that an id someone guessed is
 * real, which is exactly what the listing endpoint refuses to leak. The price
 * is that a typo and a permission problem read alike — so the text names both
 * possibilities instead of asserting either.
 */
const UNKNOWN_WORKORDER = 'Work order không tồn tại, hoặc không thuộc về bạn, hoặc chưa đủ điều kiện chạy.\n'
  + '  Xem danh sách chạy được: dsh workorders'

/** What a lease refusal turns out to be about, once read. */
export type RefusalKind = 'busy' | 'caller' | 'unknown-workorder'

/**
 * Classify why `issue_lease` refused, from the server's own wording.
 *
 * Three outcomes, because they need three different things from the operator:
 *
 * - `busy` — this work order already has an ACTIVE lease (AC-DEV-23). Matched
 *   on the phrase that names the blocking lease, NOT on the 422 label from
 *   `explain()`: that label lists every 422 cause ("tier / máy / đã có lease
 *   ACTIVE") and so matches a work order that merely does not exist.
 * - `caller` — the refusal describes the CALLER's own setup: revoked or
 *   unapproved dev machine, binding, model registry, repo gate. It says
 *   nothing about the work order, so it stays verbatim; collapsing it would
 *   send the operator hunting the wrong thing entirely.
 * - `unknown-workorder` — everything else, reported with one message shared
 *   with "does not exist" so a guessed id is never confirmed (AC-DEV-22).
 * @param message - the explained failure from `issueLease`.
 * @returns which of the three the refusal is.
 */
export function classifyLeaseRefusal(message: string): RefusalKind {
  if (/đã có lease ACTIVE \(id=/i.test(message)) return 'busy'
  // Machine state is the one most likely to be hit and the least guessable
  // from the outside, so it is named explicitly rather than left to a generic
  // keyword: a REVOKED machine reported as "work order not found" is exactly
  // the wrong repair.
  if (/máy dev đang|dev_machine|REVOKED|PENDING_APPROVAL/i.test(message)) return 'caller'
  if (/binding|Model Registry|repo_gate|kill switch|fingerprint/i.test(message)) return 'caller'
  return 'unknown-workorder'
}

/**
 * `dsh workorders` — list the work orders this engineer can start now.
 *
 * Authenticated with the employee JWT plus the machine token rather than a
 * lease: this runs before any lease exists (FR-DEV-09).
 * @param options - Studio base URL override.
 * @returns the process exit code.
 */
export async function runWorkorders(options: ArkanOptions): Promise<number> {
  const baseUrl = requireEndpoint(options.studioBaseUrl, 'ARKAN_STUDIO_BASE_URL', DEFAULT_STUDIO_BASE_URL, 'Arkan Studio')
  const credentials = await requireFreshCredentials()
  const machineToken = process.env['ARKAN_DM_TOKEN']?.trim() ?? ''

  const items = await listAvailableWorkorders(baseUrl, credentials, machineToken)
  if (items.length === 0) {
    // AC-DEV-24: an empty list is a real answer, but only once the caller is
    // past the gates. Say which state produced it instead of leaving a bare
    // blank that reads the same as "not allowed to look".
    process.stdout.write('Không có work order nào chạy được lúc này.\n')
    process.stdout.write('  Điều kiện: tier C, đã qua Value & Risk Gate, chưa có lease ACTIVE, và thuộc về bạn.\n')
    if (machineToken === '') {
      process.stdout.write('  Lưu ý: chưa đặt ARKAN_DM_TOKEN. Tenant này chưa bắt buộc máy đăng ký nên danh sách\n')
      process.stdout.write('  vẫn trả về, nhưng `dsh run` sẽ cần máy ACTIVE — kiểm bằng: dsh status\n')
    }
    return 0
  }

  const idWidth = Math.max(...items.map(item => item.id.length))
  process.stdout.write(`${items.length} work order chạy được:\n`)
  for (const item of items) {
    process.stdout.write(`  ${item.id.padEnd(idWidth)}  ${item.tier}  ${item.created_at.slice(0, 10)}  ${item.title}\n`)
  }
  process.stdout.write(`\nChạy một cái: dsh run ${items[0]?.id ?? '<workorder_id>'}\n`)
  return 0
}

/**
 * `dsh run <workorder_id>` — take a work order and obtain its lease.
 *
 * Deliberately no new lease path: this calls the same `issue_lease` every
 * other route uses, so every existing check (repo gate, fingerprint, model
 * kill switch, tier) applies unchanged.
 * @param options - the work order plus the lease inputs, flags over environment.
 * @returns the process exit code.
 */
export async function runRun(options: ArkanOptions): Promise<number> {
  const workorderId = options.workorder ?? ''
  if (workorderId === '') {
    process.stderr.write('Thiếu work order id: dsh run <workorder_id>\n')
    return 2
  }
  const baseUrl = requireEndpoint(options.studioBaseUrl, 'ARKAN_STUDIO_BASE_URL', DEFAULT_STUDIO_BASE_URL, 'Arkan Studio')

  // Resolved before the network call so a missing input is reported as the one
  // thing to fix, not as a refusal from Studio.
  const satelliteLinkId = setting(options.satelliteLink, 'ARKAN_SATELLITE_LINK_ID', '')
  const deviceFingerprint = setting(options.fingerprint, 'ARKAN_DEVICE_FINGERPRINT', '')
  const modelRef = setting(options.modelRef, 'ARKAN_MODEL_REF', '')
  const missing: string[] = []
  if (satelliteLinkId === '') missing.push('--satellite-link (hoặc ARKAN_SATELLITE_LINK_ID)')
  if (deviceFingerprint === '') missing.push('--fingerprint (hoặc ARKAN_DEVICE_FINGERPRINT)')
  if (modelRef === '') missing.push('--model-ref (hoặc ARKAN_MODEL_REF) — phải là ref ACTIVE trong Model Registry')
  if (missing.length > 0) {
    process.stderr.write(`Thiếu tham số để xin lease:\n${missing.map(item => `  ${item}`).join('\n')}\n`)
    return 2
  }

  const credentials = await requireFreshCredentials()
  let lease
  try {
    lease = await issueLease(baseUrl, credentials, {
      workorderId,
      satelliteLinkId,
      deviceFingerprint,
      modelRef,
    })
  } catch (error) {
    const message = (error as Error).message
    const kind = classifyLeaseRefusal(message)
    // AC-DEV-23: a work order already running keeps its own reason — the
    // one-lease-per-work-order invariant is the operator's to see.
    if (kind === 'busy') {
      process.stderr.write(`Work order này đang có phiên chạy (1 lease / 1 work order).\n  ${message}\n`)
      return 1
    }
    if (kind === 'caller') {
      process.stderr.write(`${message}\n`)
      return 1
    }
    process.stderr.write(`${UNKNOWN_WORKORDER}\n`)
    return 1
  }

  storeLease(lease)
  process.stdout.write(`✅ Đã nhận lease cho work order ${lease.workorder_id}\n`)
  process.stdout.write(`   lease  : ${lease.id} (${lease.status})\n`)
  process.stdout.write(`   model  : ${lease.model_ref}\n`)
  process.stdout.write(`   hết hạn: ${String(lease.expires_at)} (trần ${String(lease.absolute_expires_at)})\n`)
  process.stdout.write(`   lưu tại: ${sessionPath()}\n\n`)
  // The relay plugin reads process.env directly, so a shell that predates this
  // command still needs the value exported by hand.
  process.stdout.write('Chạy dsh trong shell đã có biến này thì plugin mới gửi tiến độ:\n')
  process.stdout.write(`  export ARKAN_LEASE_ID=${lease.id}\n`)
  return 0
}
