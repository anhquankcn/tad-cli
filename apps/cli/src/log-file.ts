/**
 * Give the harness logger somewhere to write.
 *
 * `ctx.logger` is exporter-based: a message reaches a sink only if something
 * registered one, and nothing in this repo did. So every plugin that logged
 * the idiomatic way — `ctx.logger.warn(...)` — was writing into a void, which
 * left `console.warn` looking like the only option that worked. It is not an
 * option in a full-screen surface: the TUI owns the terminal, and a raw write
 * lands in the middle of a frame and corrupts it.
 *
 * A file sink resolves both halves. Diagnostics survive, and nothing touches
 * the screen, so plugins can log without knowing which surface is running.
 * @module @deepseek-ai/dsh-cli/log-file
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { format } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'

/** Roll over past this size, so an unattended machine cannot fill its disk. */
const MAX_BYTES = 4 * 1024 * 1024

/**
 * Move an oversized log aside, keeping exactly one previous generation.
 *
 * One generation rather than a numbered series: the value of this file is the
 * last few minutes before something broke, and a rotation scheme is more
 * machinery than that need justifies.
 * @param path - the log file to check.
 */
function rollIfLarge(path: string): void {
  try {
    if (statSync(path).size < MAX_BYTES) return
    renameSync(path, `${path}.1`)
  } catch {
    // Missing file is the normal first run; anything else means the roll did
    // not happen, which is not worth failing a log write over.
  }
}

/**
 * Render one log record as a single line.
 *
 * Deliberately not the logger's own colour formatting: this goes to a file,
 * and ANSI escapes in a file are noise the reader has to strip before they can
 * grep it.
 * @param message - the structured record from the logger service.
 * @returns one line, newline included.
 */
function line(message: { ts: number; name: string; type: string; args: unknown[] }): string {
  const at = new Date(message.ts).toISOString()
  const [first, ...rest] = message.args
  // `%o` asks Node for hidden properties, which turns an empty array into
  // `[ [length]: 0 ]` — noise in a file someone is reading to find a fault.
  // `%O` is the same inspection without them.
  const pattern = typeof first === 'string' ? first.replaceAll('%o', '%O') : first
  const text = format(pattern, ...rest)
  return `${at} ${message.type.toUpperCase().padEnd(5)} ${message.name} ${text}\n`
}

/**
 * Register a file sink for the harness logger.
 *
 * Called from the boot `prepare` hook, before any config-tree entry mounts, so
 * a plugin that logs during its own activation is already covered.
 * @param ctx - the host context being prepared.
 * @param path - absolute path of the log file.
 */
export function exportLogsToFile(ctx: Context, path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    rollIfLarge(path)
  } catch {
    // An unwritable home must not stop the harness from starting; the export
    // below then fails per message and is swallowed there.
  }
  ctx.logger.exporter({
    colors: false,
    export(message) {
      try {
        appendFileSync(path, line(message))
      } catch {
        // A logging sink that throws takes down whatever was being logged
        // about. Losing a line is strictly better than losing the session.
      }
    },
  })
}
