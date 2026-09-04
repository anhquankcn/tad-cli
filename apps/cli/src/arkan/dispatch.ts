/**
 * Single entry point for the Arkan identity family, kept apart from the
 * launcher's own dispatch so the whole downstream addition is one directory
 * and one `case` in `bin.ts` — the smallest surface to re-apply when this fork
 * merges a new upstream release.
 * @module @deepseek-ai/dsh/arkan/dispatch
 */

import type { ArkanAction } from '../args.ts'
import {
  runLogin,
  runLogout,
  runSessionLink,
  runSessionMachine,
  runSessionRegister,
  runSessionWorkorder,
  runToken,
  runStatus,
  runRun,
  runWhoami,
  runWorkorders,
  type ArkanOptions,
} from './commands.ts'

/**
 * Run one Arkan action, turning any failure into a message plus exit code 1.
 * @param action - which command was invoked.
 * @param options - its flag values.
 * @returns the process exit code.
 */
export async function runArkan(action: ArkanAction, options: ArkanOptions): Promise<number> {
  try {
    switch (action) {
      case 'login': return await runLogin(options)
      case 'logout': return await runLogout()
      case 'whoami': return await runWhoami()
      case 'token': return await runToken()
      case 'status': return await runStatus(options)
      case 'workorders': return await runWorkorders(options)
      case 'session-run': return await runRun(options)
      case 'session-link': return await runSessionLink(options)
      case 'session-machine': return await runSessionMachine(options)
      case 'session-register': return await runSessionRegister(options)
      case 'session-workorder': return await runSessionWorkorder(options)
    }
  } catch (error) {
    // These commands talk to corporate infrastructure, where the useful part
    // is the server's own words; a stack trace would bury them.
    process.stderr.write(`${(error as Error).message}\n`)
    return 1
  }
}
