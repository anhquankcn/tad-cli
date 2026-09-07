/**
 * `tad run` has to answer three different refusals three different ways, and
 * the bodies below are the ones Studio actually returned during development —
 * not invented shapes. That matters here: the first version of this classifier
 * matched the phrase "lease ACTIVE" inside `explain()`'s own 422 label, which
 * lists every 422 cause, so a work order that simply did not exist was
 * reported as one that was busy.
 */

import { describe, expect, it } from 'vitest'
import { classifyLeaseRefusal } from '../src/arkan/commands.ts'
import { parseDshArgs } from '../src/args.ts'

const parse = (argv: string[]) => parseDshArgs(argv, '1.2.3')

/** The 422 label `explain()` puts in front of every 422 body. */
const LABEL = 'Studio từ chối (tier / máy / đã có lease ACTIVE): '

describe('classifyLeaseRefusal', () => {
  it('reads a nonexistent work order as unknown, despite the label naming leases', () => {
    const message = `${LABEL}{"detail":"Work order '01ZZZZ' không tồn tại"}`

    expect(classifyLeaseRefusal(message)).toBe('unknown-workorder')
  })

  it('reads a genuinely busy work order as busy', () => {
    const message = `${LABEL}{"detail":"Work order '01ABC' đã có lease ACTIVE (id=cccc3333-0000-4000-8000-000000000003) — thu hồi trước khi cấp mới"}`

    expect(classifyLeaseRefusal(message)).toBe('busy')
  })

  it('keeps a revoked dev machine as the caller\'s own problem', () => {
    // Observed verbatim. Reporting this as "work order not found" would send
    // the operator looking for a work order when the machine needs approving.
    const message = `${LABEL}{"detail":"Máy dev đang 'REVOKED' — chỉ máy ĐÃ DUYỆT (ACTIVE) được cấp lease (CR-DEV-011)"}`

    expect(classifyLeaseRefusal(message)).toBe('caller')
  })

  it('keeps binding, registry and repo-gate refusals verbatim', () => {
    expect(classifyLeaseRefusal('Binding không thuộc bạn — chỉ cấp lease bằng identity/máy của chính mình.')).toBe('caller')
    expect(classifyLeaseRefusal('Model chưa ACTIVE trong Model Registry nên kill switch chặn (T4-4).')).toBe('caller')
    expect(classifyLeaseRefusal('Lease model LOCAL bị chặn vì repo_gate chưa PASS (AC-TEN-10), bất kể tier.')).toBe('caller')
  })

  it('collapses a work order owned by someone else', () => {
    // AC-DEV-22: the same answer as "does not exist", so that running an id
    // someone guessed never confirms the id is real.
    expect(classifyLeaseRefusal('Không tìm thấy: {"detail":"Work order không thuộc kỹ sư này"}'))
      .toBe('unknown-workorder')
  })
})

describe('tad workorders / tad session run — argument parsing', () => {
  it('routes the listing command', () => {
    expect(parse(['workorders'])).toMatchObject({ mode: 'arkan', action: 'workorders' })
  })

  it('carries the work order id as an argument, not a flag', () => {
    expect(parse(['session', 'run', '01ABC'])).toMatchObject({
      mode: 'arkan',
      action: 'session-run',
      options: { workorder: '01ABC' },
    })
  })

  it('lets flags override the environment for every lease input', () => {
    expect(parse([
      'session', 'run', '01ABC',
      '--satellite-link', 'link-1',
      '--fingerprint', 'fp-1',
      '--model-ref', 'aws/model',
    ])).toMatchObject({
      options: {
        workorder: '01ABC',
        satelliteLink: 'link-1',
        fingerprint: 'fp-1',
        modelRef: 'aws/model',
      },
    })
  })
})
