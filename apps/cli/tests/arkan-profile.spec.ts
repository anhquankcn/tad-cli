/**
 * `GET /api/auth/me` is the only Studio read guarded by authentication alone.
 *
 * Every permission question in this CLI used to be answered by provoking a 403
 * somewhere and interpreting the error, which is how a harmless refusal
 * (`studio:machines:read`) and a blocking one (`studio:machines:approve`) came
 * to look identical to an operator. The profile answers both directly.
 *
 * `isDefaultEmployeeRole` exists for a question the response cannot answer on
 * its own: it carries the permission list but never the role's NAME. Whether an
 * account still holds the untouched default decides what an approver must write
 * into a new role, because a custom role REPLACES the default rather than
 * adding to it — granting four Studio permissions alone would silently strip
 * document, wiki, KB and meeting access.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EMPLOYEE_DEFAULT_PERMISSIONS,
  fetchProfile,
  isDefaultEmployeeRole,
} from '../src/arkan/session.ts'
import type { ArkanCredentials } from '../src/arkan/credentials.ts'

const BASE = 'https://arkan.example'
const CREDENTIALS = { access_token: 'token' } as ArkanCredentials

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchProfile', () => {
  it('reads the caller\'s own effective permissions', async () => {
    // Parameters are declared even though the reply ignores them: a stub with
    // an empty signature types every recorded call as `[]`, so the assertion
    // on what was REQUESTED cannot reach it.
    const stub = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(JSON.stringify({
      name: 'Nguyễn Anh Quân',
      email: 'q@example.com',
      role: 'employee',
      department_name: 'TMO',
      is_active: true,
      permissions: ['kb:read', 'studio:read:tenant'],
    }), { status: 200 }))
    vi.stubGlobal('fetch', stub)

    const profile = await fetchProfile(BASE, CREDENTIALS)

    expect(profile.permissions).toContain('studio:read:tenant')
    expect(String(stub.mock.calls[0]?.[0])).toBe(`${BASE}/api/auth/me`)
  })

  it('reports a 401 as a missing personnel record, not a dead token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ detail: 'Not authenticated' }), { status: 401 },
    )))

    const error = await fetchProfile(BASE, CREDENTIALS).catch((e: unknown) => e as Error)

    expect((error as Error).message).toContain('không có nhân sự nào khớp email')
  })
})

describe('isDefaultEmployeeRole', () => {
  it('recognises the untouched default', () => {
    expect(isDefaultEmployeeRole([...EMPLOYEE_DEFAULT_PERMISSIONS])).toBe(true)
    // Order is not identity: the server sorts its response.
    expect(isDefaultEmployeeRole([...EMPLOYEE_DEFAULT_PERMISSIONS].reverse())).toBe(true)
  })

  it('treats a superset as a real custom role', () => {
    // The case that matters: this account's existing permissions must be
    // carried into any new role, not replaced by the Studio four.
    expect(isDefaultEmployeeRole([...EMPLOYEE_DEFAULT_PERMISSIONS, 'studio:read:tenant'])).toBe(false)
  })

  it('treats a narrower role as custom too, not as the default', () => {
    // A count check alone would pass a role that swapped one permission for
    // another, so membership is checked as well.
    const swapped = [...EMPLOYEE_DEFAULT_PERMISSIONS.slice(1), 'studio:read:tenant']
    expect(swapped).toHaveLength(EMPLOYEE_DEFAULT_PERMISSIONS.length)
    expect(isDefaultEmployeeRole(swapped)).toBe(false)
  })

  it('does not call an empty permission list the default', () => {
    expect(isDefaultEmployeeRole([])).toBe(false)
  })
})
