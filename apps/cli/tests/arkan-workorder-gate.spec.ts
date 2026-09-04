/**
 * The value/risk gate reports its verdict as `detail.reason_code` in lower
 * snake case. The earlier explainer matched display spellings ('NEEDS_
 * CLARIFICATION', 'Tier A') as substrings of the raw body, so the branch never
 * fired and a rejection with a perfectly known cause printed as an envelope.
 *
 * The bodies below are the ones Studio actually returned, pasted verbatim from
 * a real rejection — the point of these specs is that the code is checked
 * against observed output rather than against the shape it was assumed to have.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHECKLIST_ITEMS, createWorkorder } from '../src/arkan/session.ts'
import type { ArkanCredentials } from '../src/arkan/credentials.ts'

const BASE = 'https://arkan.example'
const CREDENTIALS = { access_token: 'token' } as ArkanCredentials

/** Verbatim rejection observed for a work order missing one checklist item. */
const NEEDS_CLARIFICATION = JSON.stringify({
  detail: { error: 'workorder_rejected', stage: 'value_risk_gate', reason_code: 'needs_clarification', reason: null },
})

/**
 * Attempt a work order that the stubbed gate rejects.
 * @param body - the rejection body the server answers with.
 * @param checklist - keys the requester declared.
 * @returns the thrown message.
 */
async function messageFor(body: string, checklist: string[]): Promise<string> {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 422 })))
  const error = await createWorkorder(BASE, CREDENTIALS, {
    title: 'Rà soát payroll',
    description: 'Kiểm tra module payroll và payslip',
    targetRepo: 'anhquankcn/aqhrm-edu',
    diffBoundary: [],
    checklist,
    risk: [],
  }).catch((e: unknown) => e as Error)
  return (error as Error).message
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('value/risk gate rejection', () => {
  it('names the checklist item that is missing, not just that one is', async () => {
    const declared = CHECKLIST_ITEMS.filter(item => item !== 'sample_data_masked')

    const message = await messageFor(NEEDS_CLARIFICATION, [...declared])

    expect(message).toContain('Thiếu 1/7')
    // Check the missing-items line itself: the message also prints the full
    // suggested command, which naturally names every key.
    const line = message.split('\n').find(l => l.includes('Thiếu 1/7')) ?? ''
    expect(line).toContain('sample_data_masked')
    for (const declaredItem of declared) expect(line).not.toContain(declaredItem)
  })

  it('points at the description when every checklist key was declared', async () => {
    const message = await messageFor(NEEDS_CLARIFICATION, [...CHECKLIST_ITEMS])

    expect(message).toContain('Đủ cả 7 mục')
    expect(message).toContain('description')
    expect(message).not.toContain('Thiếu')
  })

  it('recognises a tier A block from the code, not a display spelling', async () => {
    const body = JSON.stringify({
      detail: { error: 'workorder_rejected', stage: 'value_risk_gate', reason_code: 'tier_a_blocked', reason: 'touches_payment' },
    })

    const message = await messageFor(body, [...CHECKLIST_ITEMS])

    expect(message).toContain('Tier A')
    expect(message).toContain('AC-DEV-10')
  })

  it('names stage and code for a verdict it does not have advice for', async () => {
    const body = JSON.stringify({
      detail: { error: 'workorder_rejected', stage: 'repo_gate', reason_code: 'repo_not_allowlisted', reason: 'repo ngoài danh sách' },
    })

    const message = await messageFor(body, [...CHECKLIST_ITEMS])

    // Assert against the rendered first line, not the whole message: the raw
    // body is appended below it and contains every one of these strings, so a
    // whole-message check would pass even with no rendering at all.
    const [first] = message.split('\n')
    expect(first).toContain("bước 'repo_gate'")
    expect(first).toContain("mã 'repo_not_allowlisted'")
    expect(message).toContain('Lý do: repo ngoài danh sách')
  })

  // Passes with OR without the parser, by design: it pins the pre-existing
  // fallback. Not evidence for the fix — the four specs above go red without it.
  it('degrades to the raw body when the rejection is not the documented shape', async () => {
    const message = await messageFor('<html>502 Bad Gateway</html>', [...CHECKLIST_ITEMS])

    expect(message).toContain('Cổng thẩm định từ chối')
    expect(message).toContain('502 Bad Gateway')
  })
})
