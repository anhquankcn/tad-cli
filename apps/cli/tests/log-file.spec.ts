/**
 * The harness logger routes through exporters, and this repo registered none —
 * so `ctx.logger.warn(...)` discarded every message. A plugin author who
 * noticed reached for `console.warn`, which in the TUI writes over the frame
 * being drawn. That is the bug this sink exists to remove: it gives the
 * idiomatic call somewhere to land, off the terminal.
 *
 * The rules below all come from the same premise — a logging sink must never
 * be the reason a session fails.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { exportLogsToFile } from '../src/log-file.ts'

let dir = ''

/** Collects what was registered, standing in for the cordis logger service. */
function fakeContext() {
  const registered: { colors?: unknown; export: (m: unknown) => void }[] = []
  return {
    registered,
    logger: {
      exporter(exporter: { colors?: unknown; export: (m: unknown) => void }) {
        registered.push(exporter)
        return () => undefined
      },
    },
  }
}

/** One record shaped like the logger service's `Message`. */
const record = (args: unknown[], type = 'warn', name = 'arkan-relay') => ({
  sn: 1, ts: Date.parse('2026-09-06T03:11:33.000Z'), name, type, level: 2, args,
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-log-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('exportLogsToFile', () => {
  it('writes a line the reader can grep, with no ANSI in it', () => {
    const path = join(dir, 'logs', 'dsh.log')
    const ctx = fakeContext()

    exportLogsToFile(ctx as never, path)
    ctx.registered[0]?.export(record(['relay gửi %s lỗi', 'session/event']))

    const written = readFileSync(path, 'utf8')
    expect(written).toBe('2026-09-06T03:11:33.000Z WARN  arkan-relay relay gửi session/event lỗi\n')
    // A file sink that emits colour codes makes its own output harder to read.
    expect(ctx.registered[0]?.colors).toBe(false)
    expect(written).not.toContain('\u001b')
  })

  it('creates the directory rather than requiring one', () => {
    const path = join(dir, 'nested', 'deeper', 'dsh.log')
    const ctx = fakeContext()

    exportLogsToFile(ctx as never, path)
    ctx.registered[0]?.export(record(['hello']))

    expect(readFileSync(path, 'utf8')).toContain('hello')
  })

  it('appends rather than truncating, so a restart keeps the history', () => {
    const path = join(dir, 'dsh.log')
    const ctx = fakeContext()

    exportLogsToFile(ctx as never, path)
    ctx.registered[0]?.export(record(['first']))
    // A second boot registers again against the same file.
    const next = fakeContext()
    exportLogsToFile(next as never, path)
    next.registered[0]?.export(record(['second']))

    const written = readFileSync(path, 'utf8')
    expect(written).toContain('first')
    expect(written).toContain('second')
  })

  it('rolls one generation aside once the file grows too large', () => {
    const path = join(dir, 'dsh.log')
    writeFileSync(path, 'x'.repeat(5 * 1024 * 1024))

    exportLogsToFile(fakeContext() as never, path)

    expect(existsSync(`${path}.1`)).toBe(true)
    expect(existsSync(path)).toBe(false)
  })


  it('renders %o without hidden properties, which made empty arrays unreadable', () => {
    // Observed verbatim in the first run of this sink: `hmr watching` logged
    // `[ [length]: 0 ]` where the useful rendering is `[]`.
    const path = join(dir, 'dsh.log')
    const ctx = fakeContext()

    exportLogsToFile(ctx as never, path)
    ctx.registered[0]?.export(record(['watching %o', []], 'info', 'hmr'))

    expect(readFileSync(path, 'utf8')).toContain('hmr watching []')
  })

  it('swallows a write it cannot perform instead of throwing at the caller', () => {
    // The session is the thing being logged about; losing a line beats losing
    // the session.
    const path = join(dir, 'dsh.log', 'not-a-directory', 'x.log')
    const ctx = fakeContext()

    expect(() => exportLogsToFile(ctx as never, path)).not.toThrow()
    expect(() => ctx.registered[0]?.export(record(['dropped']))).not.toThrow()
  })
})
