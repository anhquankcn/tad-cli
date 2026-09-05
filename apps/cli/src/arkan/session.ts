/**
 * Register the machine's current work into Arkan Studio's tracked-session list
 * by obtaining an `EngineLease`, which is what the session-relay plugin needs
 * before it may report anything richer than a heartbeat.
 *
 * This client deliberately does **not** pre-check whether the machine is an
 * approved dev device. `issue_lease` on the server already verifies the device
 * fingerprint against an ACTIVE `DevMachine`, that the binding belongs to the
 * caller, the work order's tier, the repo gate for local models, and the
 * one-lease-per-work-order rule. Re-implementing any of that here would give
 * two answers that can disagree, and the server's is the only one that counts;
 * so we attempt the call and translate its verdict.
 *
 * Two inputs cannot be discovered through the API today and must be supplied:
 * `GET /dev-machines` requires an admin permission and returns only a
 * fingerprint *prefix*, and `satellite-links` has no GET route at all. For the
 * binding there is one indirect read: the audit log records `resource_id` on
 * every write, so a create entry names the row. That is what a duplicate-link
 * 409 uses to hand back an id instead of a dead end.
 * @module @deepseek-ai/dsh/arkan/session
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ArkanCredentials } from './credentials.ts'

/** Studio base URL; `ARKAN_STUDIO_BASE_URL` overrides it. */
export const DEFAULT_STUDIO_BASE_URL = ''

/** Same agent as the SSO calls: the WAF rejects the default one. */
const USER_AGENT = 'arkan-cli/1.0'

/** Where the issued lease is cached for the next `dsh` boot to pick up. */
const SESSION_PATH = join(homedir(), '.arkan', 'session.json')

/**
 * Where binding ids are kept, because Studio offers no way to read one back.
 *
 * `POST /satellite-links` returns the id exactly once and there is no GET
 * route. The two indirect read paths both need a permission the engineer who
 * created the binding does not have — the audit log needs `org:audit:read`,
 * and `GET /dev-machines` needs `studio:machines:read` — so an operator who
 * loses the scrollback loses the id permanently. Writing it here makes the id
 * recoverable with no permission at all.
 * @returns the path to the binding cache.
 */
function linksFile(): string {
  // Resolved per call, not once at import: a test (and an operator switching
  // identities) can point HOME elsewhere without reloading the module.
  return join(homedir(), '.arkan', 'links.json')
}

/** One remembered binding, as `POST /satellite-links` reported it. */
interface RememberedLink {
  id: string
  satellite_type: string
  /** Status AT CREATION — never refreshed, so it may be stale. */
  status_at_create: string
  created_at: string
}

/**
 * Record a binding id locally so a later 409 can name it.
 * @param link - the binding just created.
 */
function rememberLink(link: SatelliteLink): void {
  const all = readLinks()
  all[link.satellite_type] = {
    id: link.id,
    satellite_type: link.satellite_type,
    status_at_create: link.status,
    created_at: new Date().toISOString(),
  }
  try {
    mkdirSync(dirname(linksFile()), { recursive: true })
    writeFileSync(linksFile(), `${JSON.stringify(all, null, 2)}\n`)
  } catch {
    // Best-effort: an unwritable home must not fail a binding that the server
    // already created. The id is still on stdout.
  }
}

/** @returns every remembered binding, keyed by satellite type. */
function readLinks(): Record<string, RememberedLink> {
  try {
    return JSON.parse(readFileSync(linksFile(), 'utf8')) as Record<string, RememberedLink>
  } catch {
    return {}
  }
}

/**
 * Look up a binding id remembered from an earlier run on this machine.
 * @param satelliteType - the binding type to recall.
 * @returns the remembered record, or null.
 */
export function recallLink(satelliteType: string): RememberedLink | null {
  return readLinks()[satelliteType] ?? null
}

/** @returns the binding cache path, for messages. */
export function linksPath(): string {
  return linksFile()
}

/** Everything `POST /workorders/{id}/lease` needs from the operator. */
export interface LeaseRequest {
  /** Work order this session's work belongs to. */
  workorderId: string
  /** The engineer's approved identity binding. */
  satelliteLinkId: string
  /** This machine's fingerprint, matched against `DevMachine.fingerprint`. */
  deviceFingerprint: string
  /** Model registry ref the lease authorizes; the row must be ACTIVE. */
  modelRef: string
}

/** The subset of the lease response this CLI reports and stores. */
export interface IssuedLease {
  id: string
  status: string
  model_ref: string
  workorder_id: string
  expires_at: string | null
  absolute_expires_at: string | null
}

/**
 * Explain a 401 from Studio, which covers two quite different situations.
 *
 * Studio maps a Keycloak token to an `Employee` row **by email**, and answers
 * 401 `Not authenticated` when no row matches — the token is perfectly valid,
 * the organisation simply has no record of that person. Reporting that as
 * "token expired" sends the operator to `dsh login`, which cannot help: signing
 * in again as the same account produces the same 401.
 *
 * The server's own `detail` separates the cases, so read it rather than listing
 * possibilities and leaving the operator to guess.
 * @param body - response body, verbatim.
 * @returns the message to show.
 */
function explainUnauthenticated(body: string): string {
  if (body.includes('Account not found or deactivated')) {
    return 'Tài khoản đã bị vô hiệu hoá trong Arkan.\n'
      + '  Đăng nhập lại không giúp được — cần quản trị viên kích hoạt lại nhân sự.\n'
      + `  ${body}`
  }
  if (body.includes('Not authenticated')) {
    return 'Token hợp lệ, nhưng Arkan không có nhân sự nào khớp email của tài khoản này.\n'
      + '  Xem đang đăng nhập bằng tài khoản nào: dsh whoami\n'
      + '  Nếu sai tài khoản: dsh logout rồi đăng nhập lại bằng tài khoản đã được cấp.\n'
      + '  Nếu đúng tài khoản: nhờ quản trị viên tạo Employee với ĐÚNG email đó (so khớp không phân biệt hoa thường).\n'
      + `  ${body}`
  }
  if (body.includes('Invalid or expired token')) {
    return 'Token hết hạn hoặc không hợp lệ — chạy `dsh login` lại.'
  }
  return 'Không xác thực được (401). Hai nguyên nhân thường gặp:\n'
    + '  · token hết hạn hoặc không hợp lệ — chạy `dsh login` lại;\n'
    + '  · Arkan chưa có nhân sự khớp email của tài khoản — kiểm bằng `dsh whoami`.\n'
    + `  ${body}`
}

/**
 * Turn a Studio rejection into a message that names the actual gate, because
 * the raw text alone rarely tells an engineer which of several preconditions
 * they tripped.
 * @param status - HTTP status returned by Studio.
 * @param body - response body, verbatim.
 * @returns the message to show.
 */
function explain(status: number, body: string): string {
  if (status === 401) return explainUnauthenticated(body)
  if (status === 403 && body.includes('satellite_link')) {
    return 'Binding không thuộc bạn — chỉ cấp lease bằng identity/máy của chính mình.'
  }
  if (status === 403 && /đang '(?:DEV|DRAFT|RETIRED)'/.test(body)) {
    return `Model chưa ACTIVE trong Model Registry nên kill switch chặn (T4-4).\n  ${body}`
  }
  if (status === 403) return `Kiểm tra sống từ chối (employee/binding/model): ${body}`
  if (status === 422 && body.includes('repo_gate')) {
    return `Lease model LOCAL bị chặn vì repo_gate chưa PASS (AC-TEN-10), bất kể tier.\n  ${body}`
  }
  if (status === 422) return `Studio từ chối (tier / máy / đã có lease ACTIVE): ${body}`
  if (status === 404) return `Không tìm thấy: ${body}`
  return `HTTP ${status}: ${body}`
}

/**
 * Ask Studio for a lease covering this session.
 * @param baseUrl - Studio base URL.
 * @param credentials - a session whose access token is still valid.
 * @param request - the operator-supplied lease inputs.
 * @returns the issued lease.
 * @throws with an explained message when Studio refuses.
 */
export async function issueLease(
  baseUrl: string,
  credentials: ArkanCredentials,
  request: LeaseRequest,
): Promise<IssuedLease> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/studio/v1/workorders/${encodeURIComponent(request.workorderId)}/lease`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': USER_AGENT,
      authorization: `Bearer ${credentials.access_token}`,
    },
    body: JSON.stringify({
      satellite_link_id: request.satelliteLinkId,
      model_ref: request.modelRef,
      device_fingerprint: request.deviceFingerprint,
    }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(explain(response.status, text.slice(0, 500)))
  return JSON.parse(text) as IssuedLease
}

/**
 * The seven Value & Risk Gate checklist items, spelled exactly as the server
 * reads them (`app/studio/gate.py: CHECKLIST_ITEMS`). Keys are validated here
 * because a typo does not error — it simply leaves that item false, and the
 * work order comes back NEEDS_CLARIFICATION for a reason the operator did not
 * cause.
 */
export const CHECKLIST_ITEMS = [
  'business_outcome', 'primary_users', 'happy_path', 'exception_flow',
  'sample_data_masked', 'uat_owner', 'uat_criteria',
] as const

/**
 * Risk flags that decide the tier. Any TIER_A flag makes the gate reject the
 * work order outright (AC-DEV-10); any TIER_B flag yields tier B, which
 * `issue_lease` then refuses because it takes only tier C (FR-TEN-06).
 */
export const RISK_FLAGS = [
  'touches_pii', 'touches_payment', 'touches_auth', 'touches_production_migration',
  'touches_cross_service', 'changes_data_model',
] as const

/** What `POST /workorders` returns. */
export interface Workorder {
  id: string
  status: string
  tier: string
  target_repo: string
}

/** One row of `GET /workorders?available=me`, as `_to_summary` returns it. */
export interface AvailableWorkorder {
  id: string
  title: string
  tier: string
  status: string
  owner_id: string
  created_at: string
  updated_at: string
}

/**
 * List the work orders this engineer may start right now (`BR-W16` Đợt A).
 *
 * Authenticated with the employee JWT **plus** the machine token, not with a
 * lease: listing happens before any lease exists, while `issue_lease` needs a
 * `workorder_id` to issue one — the two point opposite ways, so lease-auth
 * cannot serve this call.
 *
 * `status`/`tier` are deliberately not sent: the server locks both in this
 * mode and answers 422 when either is supplied.
 * @param baseUrl - Studio base URL.
 * @param credentials - a session whose access token is still valid.
 * @param machineToken - this machine's token, when one is configured.
 * @returns the available work orders, newest first.
 * @throws with an explained message when Studio refuses.
 */
export async function listAvailableWorkorders(
  baseUrl: string,
  credentials: ArkanCredentials,
  machineToken?: string,
): Promise<AvailableWorkorder[]> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': USER_AGENT,
    authorization: `Bearer ${credentials.access_token}`,
  }
  // Only sent when configured: the tenant flag that makes it mandatory is off
  // by default, and sending an empty header would fail the check outright.
  if (machineToken !== undefined && machineToken !== '') headers['x-arkan-machine-token'] = machineToken

  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/studio/v1/workorders?available=me`, { headers })
  const text = await response.text()
  if (!response.ok) throw new Error(explainAvailable(response.status, text.slice(0, 400)))
  return (JSON.parse(text) as { items?: AvailableWorkorder[] }).items ?? []
}

/**
 * Name the gate a listing call tripped, in terms of the step the operator has
 * to take next — an empty list and a refused call mean different things and
 * must never read the same (AC-DEV-24).
 * @param status - HTTP status returned by Studio.
 * @param body - response body, verbatim.
 * @returns the message to show.
 */
function explainAvailable(status: number, body: string): string {
  if (status === 401 && body.includes('machine token')) {
    return 'Tenant yêu cầu máy đã đăng ký, mà machine token thiếu hoặc máy chưa ACTIVE.\n'
      + '  Đăng ký và duyệt máy: dsh session machine --generate-fingerprint --approve\n'
      + `  ${body}`
  }
  if (status === 401) return explainUnauthenticated(body)
  if (status === 403 && body.includes('ADR-DEV-02')) {
    return 'Machine token thuộc máy của kỹ sư khác — mỗi máy gắn với một kỹ sư.\n'
      + `  Đăng ký máy này cho chính bạn: dsh session machine --generate-fingerprint --approve\n  ${body}`
  }
  if (status === 403) return `Thiếu quyền studio:read:tenant.\n  ${body}`
  if (status === 422) return `Studio từ chối tham số: ${body}`
  return `HTTP ${status}: ${body}`
}

/** Operator-supplied work order fields. */
export interface WorkorderRequest {
  title: string
  description: string
  targetRepo: string
  diffBoundary: string[]
  /** Checklist keys the requester states are genuinely satisfied. */
  checklist: string[]
  /** Risk flags the requester states genuinely apply. */
  risk: string[]
}

/**
 * Create a work order. The tier is NOT chosen here — the server scores it from
 * the risk flags, so this client sends what the requester declares and reports
 * the verdict rather than predicting it.
 * @param baseUrl - Studio base URL.
 * @param credentials - a session whose access token is still valid.
 * @param request - the declared work order.
 * @returns the created work order, including the tier the gate assigned.
 */
export async function createWorkorder(
  baseUrl: string,
  credentials: ArkanCredentials,
  request: WorkorderRequest,
): Promise<Workorder> {
  const gateInputs: Record<string, boolean> = {}
  for (const key of request.checklist) gateInputs[key] = true
  for (const key of request.risk) gateInputs[key] = true

  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/studio/v1/workorders`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': USER_AGENT,
      authorization: `Bearer ${credentials.access_token}`,
    },
    body: JSON.stringify({
      title: request.title,
      description: request.description,
      target_repo: request.targetRepo,
      diff_boundary: request.diffBoundary,
      gate_inputs: gateInputs,
    }),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(explainWorkorder(response.status, text.slice(0, 600), request.checklist))
  }
  return JSON.parse(text) as Workorder
}

/** The rejection envelope the value/risk gate returns inside `detail`. */
interface GateRejection {
  error?: string
  stage?: string
  reason_code?: string
  reason?: string | null
}

/**
 * Read the gate's verdict out of a rejection body.
 *
 * The fields live under `detail` and the codes are lower snake case, so
 * substring matching against display spellings silently never fires — which is
 * how a rejection with a known cause ends up printed as a raw body.
 * @param body - response body, verbatim.
 * @returns the parsed envelope, or an empty one when the body is not the
 * shape this endpoint documents.
 */
function readGateRejection(body: string): GateRejection {
  try {
    // Parsed JSON is genuinely unknown: `detail` is an object here but a plain
    // string on other endpoints, and null is always reachable.
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const detail: unknown = (parsed as Record<string, unknown>)['detail']
    if (typeof detail !== 'object' || detail === null) return {}
    return detail
  } catch {
    return {}
  }
}

/**
 * Translate a gate rejection into the decision the requester actually has to
 * make, since the raw body carries stage/reason_code rather than advice.
 * @param status - HTTP status returned by Studio.
 * @param body - response body, verbatim.
 * @returns the message to show.
 */
function explainWorkorder(status: number, body: string, checklist: string[] = []): string {
  if (status === 401) return explainUnauthenticated(body)
  if (status === 403) return `Thiếu quyền studio:write:own.\n  ${body}`
  if (status === 409) return `Engine plan chưa cấu hình cho tenant này.\n  ${body}`
  if (status !== 422) return `HTTP ${status}: ${body}`

  const verdict = readGateRejection(body)
  const code = (verdict.reason_code ?? '').toLowerCase()

  if (code.includes('needs_clarification')) {
    // The server names no item, so name them here: the requester needs to know
    // which key to add, not that "something" was missing.
    const missing = CHECKLIST_ITEMS.filter(item => !checklist.includes(item))
    const head = 'Hồ sơ chưa đủ để chấm — không phải bị từ chối vì rủi ro.\n'
    if (missing.length === 0) {
      return `${head}  Đủ cả ${CHECKLIST_ITEMS.length} mục checklist, nên nguyên nhân nằm ở nội dung\n`
        + '  (title/description quá mỏng để người duyệt chấm được).\n'
        + `  ${body}`
    }
    return `${head}  Thiếu ${missing.length}/${CHECKLIST_ITEMS.length} mục checklist: ${missing.join(', ')}\n`
      + '  Chỉ khai mục nào thật sự thoả — cổng này tin lời khai, và khai sai là\n'
      + '  vấn đề nặng hơn nhiều so với việc bổ sung thiếu.\n'
      + `  Gửi lại với: --checklist ${CHECKLIST_ITEMS.join(',')}`
  }

  if (code.includes('tier_a')) {
    return 'Cổng từ chối: Tier A (PII / thanh toán / auth / migration production) không được tạo ở giai đoạn POC (AC-DEV-10).\n'
      + '  Việc chạm những vùng đó phải đi đường khác, không xin lease được.\n'
      + `  ${body}`
  }

  // An unknown code is still worth naming: the stage says which gate spoke,
  // and printing the code beats printing the envelope it arrived in.
  if (code !== '') {
    const why = verdict.reason ? `\n  Lý do: ${verdict.reason}` : ''
    return `Cổng thẩm định từ chối ở bước '${verdict.stage ?? '?'}', mã '${verdict.reason_code}'.${why}\n  ${body}`
  }
  return `Cổng thẩm định từ chối: ${body}`
}

/** One `dev_machine` row as Studio reports it. Never carries the full fingerprint. */
export interface DevMachine {
  id: string
  display_name: string | null
  owner_name: string | null
  fingerprint_prefix: string
  machine_token_prefix: string | null
  status: string
  last_seen_at: string | null
}

/** Approving a machine mints its token — returned in the clear exactly once. */
export interface ApprovedMachine {
  id: string
  status: string
  /** Plaintext, shown by the server ONE time. The database keeps only a sha256. */
  machine_token: string
}

/**
 * Explain a dev-machine rejection in terms of the gate it hit.
 * @param status - HTTP status returned by Studio.
 * @param body - response body, verbatim.
 * @returns the message to show.
 */
/**
 * Explain a 403, naming the permission and — more usefully — whether the
 * refusal actually stops the operator getting work done.
 *
 * Studio is deny-by-default and answers `Permission required: <name>`. Two of
 * these are the NORMAL state for an engineer, not a fault: listing machines and
 * reading the audit log are administrative views, and nothing in the register →
 * lease → run path needs either. Reporting them as bare "missing permission"
 * had operators chasing an access request they did not need.
 * @param body - response body, verbatim.
 * @returns the message to show.
 */
function explainMissingPermission(body: string): string {
  const needed = /Permission required:\s*([\w:]+)/.exec(body)?.[1] ?? ''
  if (needed === 'studio:machines:read') {
    return 'Không xem được danh sách máy — cần quyền `studio:machines:read`.\n'
      + '  Đây là màn quản trị. Việc của bạn KHÔNG cần nó: đăng ký máy\n'
      + '  (`dsh session machine`) và xin lease đều không gọi route này.\n'
      + '  Máy chủ vẫn tự đối chiếu fingerprint khi cấp lease.\n'
      + `  ${body}`
  }
  if (needed === 'studio:machines:approve') {
    return 'Không duyệt được — cần quyền `studio:machines:approve`.\n'
      + '  Quyền này thuộc nhóm Studio, tài khoản kỹ sư thường không có.\n'
      + '  Nhờ người có quyền duyệt bằng id ở trên; đừng chạy lại lệnh tạo.\n'
      + `  ${body}`
  }
  if (needed !== '') return `Thiếu quyền \`${needed}\` cho thao tác này.\n  ${body}`
  return `Thiếu quyền cho thao tác này.\n  ${body}`
}

function explainMachine(status: number, body: string): string {
  if (status === 401) return explainUnauthenticated(body)
  if (status === 403 && body.includes('satellite_identity_link')) {
    return 'Chưa có binding danh tính ACTIVE — máy chưa đăng ký được.\n'
      + '  Chạy `dsh session link --approve` trước (FR-TEN-07).\n  ' + body
  }
  if (status === 403) return explainMissingPermission(body)
  if (status === 404) return 'Máy không tồn tại (hoặc thuộc tenant khác).'
  if (status === 422) {
    return 'Máy không ở trạng thái PENDING_APPROVAL nên không duyệt được.\n'
      + '  Máy đã REVOKED thì KHÔNG hồi sinh được — phải đăng ký fingerprint mới.\n  ' + body
  }
  return `HTTP ${status}: ${body}`
}

/**
 * Declare this machine, leaving it at `PENDING_APPROVAL`.
 *
 * Idempotent on (tenant, fingerprint): calling twice returns the existing row
 * untouched rather than resetting it — which also means a REVOKED machine
 * cannot be revived by re-registering.
 * @param baseUrl - Studio base URL.
 * @param credentials - a session whose access token is still valid.
 * @param fingerprint - this machine's stable identifier, at least 8 characters.
 * @param displayName - human label shown in the console.
 * @param tailscaleHostname - optional tailnet name.
 * @returns the machine row.
 */
export async function registerMachine(
  baseUrl: string,
  credentials: ArkanCredentials,
  fingerprint: string,
  displayName: string,
  tailscaleHostname: string,
): Promise<DevMachine> {
  const body: Record<string, string> = { fingerprint }
  if (displayName !== '') body.display_name = displayName
  if (tailscaleHostname !== '') body.tailscale_hostname = tailscaleHostname

  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/studio/v1/dev-machines/register`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': USER_AGENT,
      authorization: `Bearer ${credentials.access_token}`,
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(explainMachine(response.status, text.slice(0, 400)))
  return JSON.parse(text) as DevMachine
}

/**
 * Approve a machine, which mints its token.
 * @param baseUrl - Studio base URL.
 * @param credentials - a session holding `studio:machines:approve`.
 * @param machineId - the machine to approve.
 * @returns the machine plus its one-time plaintext token.
 */
export async function approveMachine(
  baseUrl: string,
  credentials: ArkanCredentials,
  machineId: string,
): Promise<ApprovedMachine> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/studio/v1/dev-machines/${encodeURIComponent(machineId)}/approve`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'user-agent': USER_AGENT,
      authorization: `Bearer ${credentials.access_token}`,
    },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(explainMachine(response.status, text.slice(0, 400)))
  return JSON.parse(text) as ApprovedMachine
}

/** Result of revoking a machine: the cascade count matters, so it is reported. */
export interface RevokedMachine {
  id: string
  status: string
  /** ACTIVE leases torn down in the same transaction. */
  leases_revoked: number
}

/**
 * Revoke a machine. ONE-WAY: the same fingerprint can never register again,
 * because `register_machine` is idempotent on (tenant, fingerprint) and hands
 * back the REVOKED row untouched rather than reviving it. The call also tears
 * down every ACTIVE lease on that machine in the same transaction.
 * @param baseUrl - Studio base URL.
 * @param credentials - a session holding `studio:machines:approve`.
 * @param machineId - the machine to revoke.
 * @returns the machine plus how many leases went with it.
 */
export async function revokeMachine(
  baseUrl: string,
  credentials: ArkanCredentials,
  machineId: string,
): Promise<RevokedMachine> {
  const base = baseUrl.replace(/\/+$/, '')
  const response = await fetch(`${base}/api/studio/v1/dev-machines/${encodeURIComponent(machineId)}/revoke`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'user-agent': USER_AGENT,
      authorization: `Bearer ${credentials.access_token}`,
    },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(explainMachine(response.status, text.slice(0, 400)))
  return JSON.parse(text) as RevokedMachine
}

/**
 * List the tenant's dev machines. Unlike satellite links, this route exists —
 * so a machine id lost from the terminal is recoverable without touching the
 * database.
 * @param baseUrl - Studio base URL.
 * @param credentials - a session holding `studio:machines:read`.
 * @returns every machine in the caller's tenant.
 */
export async function listMachines(
  baseUrl: string,
  credentials: ArkanCredentials,
): Promise<DevMachine[]> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/studio/v1/dev-machines`, {
    headers: {
      accept: 'application/json',
      'user-agent': USER_AGENT,
      authorization: `Bearer ${credentials.access_token}`,
    },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(explainMachine(response.status, text.slice(0, 400)))
  return (JSON.parse(text) as { items?: DevMachine[] }).items ?? []
}

/** Self-declared LLM binding types the server accepts; DSH is the last one. */
export const SATELLITE_TYPES = ['llm_claude_code', 'llm_gh_copilot', 'llm_deepseek_harness'] as const

/** One `satellite_identity_link` row, as both endpoints return it. */
export interface SatelliteLink {
  id: string
  satellite_type: string
  status: string
}

/**
 * Name the gate a binding call tripped. The bodies are terse and the two
 * endpoints fail for quite different reasons, so translate rather than echo.
 * @param status - HTTP status returned by Studio.
 * @param body - response body, verbatim.
 * @returns the message to show.
 */
function explainLink(status: number, body: string): string {
  if (status === 401) return explainUnauthenticated(body)
  if (status === 403) return `Thiếu quyền. Duyệt binding cần \`studio:machines:approve\`.\n  ${body}`
  if (status === 404) return 'Binding không tồn tại (hoặc thuộc tenant khác).'
  if (status === 409) {
    // Reached only when the audit lookup below could not name the binding;
    // `createSatelliteLink` enriches this case whenever it can.
    return 'Đã có binding loại này chưa thu hồi cho bạn — không tạo thêm được.\n'
      + `  ${body}\n`
      + '  Nếu nó vẫn PENDING_APPROVAL thì cần id để duyệt. Studio không có route\n'
      + '  GET cho satellite-links, nên lấy id theo một trong hai cách:\n'
      + '    · cuộn lên trong terminal — lần tạo thành công đã in "id : <uuid>"\n'
      + '    · nhờ người có quyền `org:audit:read` tra audit log (action\n'
      + '      satellite_link_create), hoặc người có quyền DB tra bảng\n'
      + '      satellite_identity_link theo employee_id của bạn\n'
      + '  Có id rồi: dsh session link --approve-id <uuid>'
  }
  if (status === 422) return `Binding không ở trạng thái PENDING_APPROVAL nên không duyệt được.\n  ${body}`
  if (status === 503) return `Máy chủ chưa cấu hình khoá mã hoá vệ tinh (fail-closed).\n  ${body}`
  return `HTTP ${status}: ${body}`
}

/**
 * Declare that this engineer uses a given LLM tool, creating the binding in
 * `PENDING_APPROVAL`. The server takes employee and tenant from the token and
 * stores only a self-declared marker — never a real API key.
 * @param baseUrl - Studio base URL.
 * @param credentials - a session whose access token is still valid.
 * @param satelliteType - which tool is being declared.
 * @returns the created binding.
 */
export async function createSatelliteLink(
  baseUrl: string,
  credentials: ArkanCredentials,
  satelliteType: string,
): Promise<SatelliteLink> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/studio/v1/satellite-links`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': USER_AGENT,
      authorization: `Bearer ${credentials.access_token}`,
    },
    body: JSON.stringify({ satellite_type: satelliteType }),
  })
  const text = await response.text()
  if (response.status === 409) {
    throw new Error(await explainDuplicateLink(baseUrl, credentials, satelliteType, text.slice(0, 400)))
  }
  if (!response.ok) throw new Error(explainLink(response.status, text.slice(0, 400)))
  const link = JSON.parse(text) as SatelliteLink
  // The only moment this id is ever readable: no GET route exists for it.
  rememberLink(link)
  return link
}

/** What `GET /api/auth/me` reports about the caller. */
export interface ArkanProfile {
  name: string
  email: string
  /** Coarse role on the employee row: `admin` or `employee`. */
  role: string
  department_name: string
  is_active: boolean
  /** Effective permissions — exactly the custom role's list, not a union. */
  permissions: string[]
}

/**
 * The nine permissions of the `Employee` system role, in the server's order.
 *
 * Kept here to answer a question `GET /auth/me` cannot: it returns the
 * permission list but never the role's NAME, so the only way to tell a default
 * account from one carrying a real custom role is to compare the sets.
 */
export const EMPLOYEE_DEFAULT_PERMISSIONS = [
  'doc:read:own_dept',
  'doc:create:own_dept',
  'wiki:read:own_dept',
  'wiki:write:own_dept',
  'skill:read:own_dept',
  'org:departments:read',
  'kb:read',
  'kb:upload',
  'org:meeting:manage',
] as const

/**
 * Read the caller's own profile and effective permissions.
 *
 * Guarded by authentication alone — no permission gates it — which makes it
 * the one read an engineer can always perform. Every permission question in
 * this CLI was previously answered by provoking a 403 and reading the error.
 * @param baseUrl - Studio base URL.
 * @param credentials - the caller's session.
 * @returns the profile.
 * @throws when Studio refuses the token.
 */
export async function fetchProfile(baseUrl: string, credentials: ArkanCredentials): Promise<ArkanProfile> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/auth/me`, {
    headers: {
      accept: 'application/json',
      'user-agent': USER_AGENT,
      authorization: `Bearer ${credentials.access_token}`,
    },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(explainMachine(response.status, text.slice(0, 400)))
  return JSON.parse(text) as ArkanProfile
}

/**
 * Decide whether a permission list is just the untouched `Employee` default.
 *
 * A custom role REPLACES the default rather than adding to it, so an operator
 * being granted one must have their existing permissions carried across. That
 * makes "is this still the default?" the question an approver needs answered
 * before writing the new role's list.
 * @param permissions - effective permissions from the profile.
 * @returns true when the set is exactly the default nine.
 */
export function isDefaultEmployeeRole(permissions: string[]): boolean {
  const held = new Set(permissions)
  return held.size === EMPLOYEE_DEFAULT_PERMISSIONS.length
    && EMPLOYEE_DEFAULT_PERMISSIONS.every(permission => held.has(permission))
}

/** One audit row, narrowed to the fields this lookup reads. */
interface AuditEntry {
  resource_id?: string
  reason?: string
  created_at?: string
}

/** Result of an audit lookup: what it found, and whether it was allowed to look. */
export interface AuditLookup {
  /** Matching binding ids, newest first. */
  ids: string[]
  /** True when the route answered 403 — an empty `ids` then proves nothing. */
  denied: boolean
}

/**
 * Recover the id of the binding that a 409 refers to.
 *
 * `satellite-links` has no GET route, but every write is audited and the
 * create entry records the new row's `resource_id` — which makes the audit log
 * the one read path to an id the caller would otherwise have to obtain from a
 * DBA or by scrolling back through an old terminal.
 * @param baseUrl - Studio base URL.
 * @param credentials - a session whose access token is still valid.
 * @param satelliteType - the tool whose binding is being looked for.
 * @returns ids of matching create entries, newest first; empty when the lookup
 * is unavailable, which is why the caller must keep its manual fallback.
 */
export async function findLinkIdsInAudit(
  baseUrl: string,
  credentials: ArkanCredentials,
  satelliteType: string,
): Promise<AuditLookup> {
  const url = new URL('/api/audit/log', baseUrl.replace(/\/+$/, ''))
  url.searchParams.set('action', 'satellite_link_create')
  url.searchParams.set('page_size', '50')
  let payload: { items?: AuditEntry[]; data?: AuditEntry[] }
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        'user-agent': USER_AGENT,
        authorization: `Bearer ${credentials.access_token}`,
      },
    })
    // 403 is the normal answer here, not an edge case: the route needs
    // `org:audit:read`, which sits in the Organization permission group and is
    // not held by the engineers who create bindings. Reporting it as "audit has
    // no record" sent an operator hunting for a binding the log could see
    // perfectly well — the caller must be able to say "you may not look".
    if (response.status === 403) return { ids: [], denied: true }
    if (!response.ok) return { ids: [], denied: false }
    payload = JSON.parse(await response.text()) as typeof payload
  } catch {
    return { ids: [], denied: false }
  }
  const rows = payload.items ?? payload.data ?? []
  const ids = rows
    .filter(row => typeof row.resource_id === 'string' && (row.reason ?? '').includes(satelliteType))
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
    .map(row => row.resource_id as string)
  return { ids, denied: false }
}

/**
 * Turn "a binding already exists" into the command that acts on it.
 * @param baseUrl - Studio base URL.
 * @param credentials - a session whose access token is still valid.
 * @param satelliteType - the tool whose binding already exists.
 * @param body - the 409 body, verbatim.
 * @returns the message to show.
 */
async function explainDuplicateLink(
  baseUrl: string,
  credentials: ArkanCredentials,
  satelliteType: string,
  body: string,
): Promise<string> {
  const head = 'Đã có binding loại này chưa thu hồi cho bạn — không tạo thêm được.\n'
    + `  ${body}\n`

  // The local record first: it needs no permission, and the id it holds is the
  // one this machine created, so it is the answer far more often than audit is.
  const remembered = recallLink(satelliteType)
  if (remembered !== null) {
    return `${head}  Binding đó là cái máy này đã tạo lúc ${remembered.created_at}:\n`
      + `    ${remembered.id}\n`
      + `  (ghi trong ${linksFile()}; trạng thái lúc tạo: ${remembered.status_at_create})\n`
      + '  Nếu còn PENDING_APPROVAL, người có quyền studio:machines:approve chạy:\n'
      + `    dsh session link --approve-id ${remembered.id}\n`
      + '  Nếu đã ACTIVE thì dùng thẳng id đó cho `dsh session register --satellite-link`.'
  }

  const { ids, denied } = await findLinkIdsInAudit(baseUrl, credentials, satelliteType)
  if (denied) {
    return `${head}  Binding có thật, nhưng CLI không đọc được id của nó:\n`
      + '    · audit log trả 403 — cần quyền `org:audit:read`\n'
      + '    · Studio không có route GET cho satellite-links\n'
      + '  Lấy id bằng một trong hai cách:\n'
      + '    · cuộn lên trong terminal — lần tạo thành công đã in "id : <uuid>"\n'
      + '    · nhờ người có quyền `org:audit:read` tra audit log, action\n'
      + '      satellite_link_create, hoặc người có quyền DB tra bảng\n'
      + '      satellite_identity_link theo employee_id của bạn\n'
      + '  Có id rồi: dsh session link --approve-id <uuid>'
  }
  if (ids.length === 0) return explainLink(409, body)
  // The audit log records creations, never the current status, so the binding
  // named here may already be ACTIVE. Say so rather than implying it needs
  // approving: `--approve-id` on an ACTIVE row answers 422, not success.
  if (ids.length === 1) {
    return `${head}  Tra audit log ra binding: ${ids[0]}\n`
      + '  Nếu nó còn PENDING_APPROVAL thì duyệt bằng:\n'
      + `    dsh session link --approve-id ${ids[0]}\n`
      + '  Nếu đã ACTIVE thì dùng thẳng id đó cho `dsh session register --satellite-link`.'
  }
  const list = ids.slice(0, 5).map(id => `    · ${id}`).join('\n')
  return `${head}  Tra audit log ra ${ids.length} binding cùng loại, mới nhất trước:\n${list}\n`
    + '  Audit chỉ ghi lúc tạo, không ghi trạng thái hiện tại — cái chưa thu hồi\n'
    + '  thường là cái mới nhất. Duyệt: dsh session link --approve-id <uuid>'
}

/**
 * Move a binding from `PENDING_APPROVAL` to `ACTIVE`.
 * @param baseUrl - Studio base URL.
 * @param credentials - a session holding `studio:machines:approve`.
 * @param linkId - the binding to approve.
 * @returns the approved binding.
 */
export async function approveSatelliteLink(
  baseUrl: string,
  credentials: ArkanCredentials,
  linkId: string,
): Promise<SatelliteLink> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/studio/v1/satellite-links/${encodeURIComponent(linkId)}/approve`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'user-agent': USER_AGENT,
      authorization: `Bearer ${credentials.access_token}`,
    },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(explainLink(response.status, text.slice(0, 400)))
  return JSON.parse(text) as SatelliteLink
}

/**
 * Cache the lease so a later `dsh` boot can export it to the relay plugin
 * without the operator pasting it into the environment by hand.
 * @param lease - the lease just issued.
 */
export function storeLease(lease: IssuedLease): void {
  writeFileSync(SESSION_PATH, `${JSON.stringify(lease, null, 2)}\n`)
}

/** @returns the cache path, for messages. */
export function sessionPath(): string {
  return SESSION_PATH
}

/**
 * Read the cached lease back.
 *
 * The cache is a convenience, not a source of truth: Studio has no GET route
 * for a lease, so this file is the only local record of what was issued — and
 * it keeps saying ACTIVE long after `expires_at` has passed, because nothing
 * rewrites it. Callers must compare the timestamps themselves rather than
 * trusting `status`.
 * @returns the cached lease, or undefined when absent or unreadable.
 */
export function readStoredLease(): IssuedLease | undefined {
  try {
    return JSON.parse(readFileSync(SESSION_PATH, 'utf8')) as IssuedLease
  } catch {
    return undefined
  }
}

/** One `model_registry` row, narrowed to what a status report shows. */
export interface RegistryEntry {
  ref: string
  status: string
  purpose?: string
  limits?: string | null
}

/**
 * Look up one model ref's governance row, because an ACTIVE registry entry is
 * a precondition `issue_lease` re-checks: a ref missing here cannot back a
 * lease no matter how well the rest of the chain is set up.
 * @param baseUrl - Studio base URL.
 * @param credentials - a session whose access token is still valid.
 * @param ref - the model ref to look for.
 * @returns the row, or undefined when absent or the listing is unavailable.
 */
export async function fetchRegistryEntry(
  baseUrl: string,
  credentials: ArkanCredentials,
  ref: string,
): Promise<RegistryEntry | undefined> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/governance/registry`, {
      headers: {
        accept: 'application/json',
        'user-agent': USER_AGENT,
        authorization: `Bearer ${credentials.access_token}`,
      },
    })
    if (!response.ok) return undefined
    const body = JSON.parse(await response.text()) as { items?: RegistryEntry[] }
    return (body.items ?? []).find(row => row.ref === ref)
  } catch {
    return undefined
  }
}
