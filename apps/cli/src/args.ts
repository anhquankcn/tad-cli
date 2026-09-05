/**
 * Commander adapter for the `dsh` command line.
 *
 * The launcher parses only what it owns — which profile to boot, which extra
 * patch overlays to apply, and the config dumps — and hands **everything after
 * its own flags** to the booted tree verbatim, where injected app plugins parse
 * their own flag families and print their own `--help` (see
 * `@deepseek-ai/dsh-cmdline`). Launcher flags therefore come first: the first
 * token this parser does not recognize starts the inner arguments, so
 * `dsh --profile tui --resume abc` boots the tui profile with `--resume abc`,
 * and `dsh --profile web -h` prints the web app's help, not this one's.
 *
 * `web` is a hardcoded alias for `--profile web`; `plugin` manages a profile's
 * plugin dependencies by forwarding to pnpm.
 * @module @deepseek-ai/dsh/args
 */

import { Command, CommanderError } from 'commander'

/** Boot a named profile and hand it the invocation's inner arguments. */
interface ProfileInvocation {
  mode: 'profile'
  profile: string
  /** Extra patch-list overlays applied after the profile's own layer, in argv order. */
  patches: string[]
  /** Everything after the launcher's own flags, verbatim, for injected app plugins. */
  args: string[]
}

/** Print a composed profile tree and exit without booting. */
interface DumpConfigInvocation {
  mode: 'dump-config'
  profile: string
  /** Omit the profile's user layer and --patch overlays; print bundle layers only. */
  defaultOnly: boolean
  patches: string[]
}

/** Manage a profile's plugins: forward `args` to pnpm inside the profile directory. */
interface PluginInvocation {
  mode: 'plugin'
  profile: string
  /** Raw pnpm arguments, verbatim. */
  args: string[]
}

/** Which Arkan identity/session action to run. */
export type ArkanAction = 'login' | 'logout' | 'whoami' | 'token' | 'status' | 'workorders' | 'session-run' | 'session-register' | 'session-link' | 'session-workorder' | 'session-machine'

/**
 * Authenticate against the corporate SSO, or register this machine's work into
 * Arkan Studio's tracked-session list. Downstream addition — not upstream dsh.
 */
interface ArkanInvocation {
  mode: 'arkan'
  action: ArkanAction
  /** Flag values; each also has an environment fallback, resolved downstream. */
  options: {
    authority?: string
    clientId?: string
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
    list?: boolean
    generateFingerprint?: boolean
    displayName?: string
    tailscaleHostname?: string
    title?: string
    description?: string
    repo?: string
    checklist?: string
    risk?: string
    diffBoundary?: string[]
  }
}

/** The resolved `dsh` invocation. Help, version, and errors exit inside {@link parseDshArgs}. */
export type DshInvocation
  = ProfileInvocation | DumpConfigInvocation | PluginInvocation | ArkanInvocation

/** Launcher flags shared by the default command and the `web` alias. */
interface BootOptions {
  patch?: string[]
  dumpConfig?: boolean
  dumpDefaultConfig?: boolean
}

/**
 * Repeatable single-value collector: `--patch a.yml --patch b.yml`. Never
 * variadic — a variadic `--patch` would swallow the inner arguments.
 */
const collect = (value: string, previous: string[] = []): string[] => [...previous, value]

/** The launcher's own help text; each app prints its own. */
const HELP_EXAMPLES = `
Examples:
  dsh --profile web                          boot the web profile (same as: dsh web)
  dsh --profile headless "run the tests"     answer one task, print the result, and exit
  dsh --profile tui --patch ./extra.yml      boot a custom profile with one extra overlay
  dsh --profile tui --resume <session>       arguments after the launcher flags reach the app
  dsh --profile web --help                   the web app's own flags and help
  dsh plugin --profile tui add <package>     install a plugin into the tui profile
`

/**
 * Resolve a boot or dump invocation from the launcher flags and the leftover
 * inner arguments.
 * @param program - the command whose options were parsed (the root, or the `web` alias).
 * @param profile - the profile these flags boot.
 * @param options - the launcher flags commander collected.
 * @param args - the leftover arguments, in argv order.
 * @returns the resolved invocation.
 */
function resolveBoot(program: Command, profile: string, options: BootOptions, args: string[]): DshInvocation {
  const patches = options.patch ?? []
  if (patches.includes('')) program.error('error: --patch needs a path')
  if (options.dumpConfig !== true && options.dumpDefaultConfig !== true) {
    return { mode: 'profile', profile, patches, args }
  }
  if (options.dumpConfig === true && options.dumpDefaultConfig === true) {
    program.error('error: --dump-config and --dump-default-config are mutually exclusive')
  }
  // The dump is boot-free: it never runs app command-line providers, so it
  // cannot show what those flags would decide, and printing a tree that differs
  // from the same invocation's boot would mislead.
  if (args.length > 0) {
    program.error(`error: config dumps take no app arguments, got ${args.map(argument => JSON.stringify(argument)).join(' ')}`)
  }
  const defaultOnly = options.dumpDefaultConfig === true
  if (defaultOnly && patches.length > 0) {
    program.error('error: --dump-default-config prints the bundle layers and takes no --patch')
  }
  return { mode: 'dump-config', profile, defaultOnly, patches }
}

/**
 * Whether this invocation boots a profile, in which case every token after the
 * launcher's own flags belongs to the app.
 *
 * Only the launcher's own spellings count: `--profile <name>` and the `web`
 * alias. A task's words are never inspected — the point is to leave them
 * alone.
 * @param argv - arguments after the Node binary and script.
 * @returns true when the invocation boots a profile.
 */
function isProfileBoot(argv: readonly string[]): boolean {
  return argv.includes('--profile') || argv[0] === 'web'
}

/**
 * Resolve argv into one invocation, or print and exit for help, version, or an
 * error.
 * @param argv - arguments after the Node binary and script.
 * @param version - version string printed by `--version`.
 * @returns the resolved invocation.
 */
export function parseDshArgs(argv: readonly string[], version: string): DshInvocation {
  let resolved: DshInvocation | undefined
  // Annotated, not inferred: the actions below call back into `program`, and an
  // inferred type would be circular through its own chain.
  const program: Command = new Command()
  program
    .name('dsh')
    .version(version, '-V, --version', 'output the version number')
    .description('dsh: boot a DeepSeek Harness profile — an ordered stack of plugin-bundle patch layers under your own overrides.')
    .addHelpText('after', HELP_EXAMPLES)
    .exitOverride()
    // The launcher's flags come first and end at the first token it does not
    // know; everything from there on belongs to the booted app, including
    // its -h. `dsh -h` with no profile still prints this help, below.
    .helpOption(false)
    .allowUnknownOption()
    .passThroughOptions()
    .enablePositionalOptions()
    .argument('[args...]', 'arguments for the booted profile\'s app (see: dsh --profile <name> --help)')
    .option('--profile <name>', 'the profile under $DSH_HOME/profiles to boot')
    .option('--patch <path>', 'extra patch-list overlay applied after the profile layer (repeatable)', collect)
    .option('--dump-config', 'print the composed profile tree and exit')
    .option('--dump-default-config', 'print the profile tree without its user layer or --patch overlays and exit')
    .action((args: string[], options: BootOptions & { profile?: string }) => {
      // With the app owning -h, the launcher's own help is what a bare
      // `dsh -h` (no profile to hand it to) must print.
      if (options.profile === undefined) {
        if (args.some(argument => argument === '-h' || argument === '--help')) program.help()
        program.error('error: --profile <name> is required')
      }
      const profile = options.profile
      if (profile === '') program.error('error: --profile needs a name')
      resolved = resolveBoot(program, profile, options, args)
    })

  /** Reject parent options supplied before a subcommand. */
  const rejectParentOptions = (command: string): void => {
    const parent = program.opts<BootOptions & { profile?: string }>()
    if (parent.profile !== undefined || parent.patch !== undefined
      || parent.dumpConfig !== undefined || parent.dumpDefaultConfig !== undefined) {
      program.error(`error: ${command} takes none of parent --profile, --patch, --dump-config, or --dump-default-config`)
    }
  }

  const web = program.command('web').description('boot the web profile (alias of --profile web); the web app\'s own flags follow')
  web
    .helpOption(false)
    .allowUnknownOption()
    .passThroughOptions()
    .enablePositionalOptions()
    .argument('[args...]', 'arguments for the web app (see: dsh web --help)')
    .option('--patch <path>', 'extra patch-list overlay applied after the profile layer (repeatable)', collect)
    .option('--dump-config', 'print the composed web-profile tree (with the user layer and any --patch) and exit')
    .option('--dump-default-config', 'print the web profile\'s bundle layers (no user layer) and exit')
    .action((args: string[], options: BootOptions) => {
      rejectParentOptions('web')
      resolved = resolveBoot(web, 'web', options, args)
    })

  const plugin = program.command('plugin').description('manage a profile\'s plugins by forwarding the remaining arguments to pnpm in the profile directory')
  plugin
    .requiredOption('--profile <name>', 'the profile whose plugins to manage (initialized on first use)')
    .allowUnknownOption()
    .argument('[args...]', 'pnpm arguments, forwarded verbatim (add <pkg>, remove <pkg>, why <pkg>, ...)')
    .action((args: string[], options: { profile: string }) => {
      rejectParentOptions('plugin')
      if (options.profile === '') program.error('error: --profile needs a name')
      if (args.length === 0) program.error('error: plugin needs pnpm arguments to forward (e.g. add <package>)')
      resolved = { mode: 'plugin', profile: options.profile, args }
    })

  // ── Arkan identity family (downstream addition) ──────────────────────────
  // Not registered at all on a profile boot. Commander resolves a registered
  // subcommand name before the root's `[args...]`, so `dsh --profile headless
  // "run the tests"` would otherwise be captured by the `run` command below
  // and never reach the app — and that is the launcher's own documented
  // example. A profile boot never carries an arkan command, so skipping the
  // registration costs nothing and keeps the task text verbatim.
  if (!isProfileBoot(argv)) {
    // Grouped here so a future upstream merge sees one contiguous block rather
    // than edits scattered through the launcher's own command definitions.
    const login = program.command('login').description('sign in to the corporate SSO (PKCE, opens a browser)')
    login
      .helpOption('-h, --help', 'show help for this command')
      .option('--authority <url>', 'Keycloak realm URL (default: env ARKAN_AUTHORITY, then the corporate realm)')
      .option('--client-id <id>', 'public client id registered with the loopback redirect')
      .option('--device', 'RFC 8628 device grant: no browser needed on this machine (for SSH sessions)')
      .action((options: { authority?: string; clientId?: string; device?: boolean }) => {
        rejectParentOptions('login')
        resolved = { mode: 'arkan', action: 'login', options }
      })

    program.command('logout').description('revoke the stored refresh token and delete the local session')
      .helpOption('-h, --help', 'show help for this command')
      .action(() => {
        rejectParentOptions('logout')
        resolved = { mode: 'arkan', action: 'logout', options: {} }
      })

    program.command('whoami').description('print the identity behind the stored SSO token')
      .helpOption('-h, --help', 'show help for this command')
      .action(() => {
        rejectParentOptions('whoami')
        resolved = { mode: 'arkan', action: 'whoami', options: {} }
      })

    program.command('token').description('print a valid access token, refreshing it when needed')
      .helpOption('-h, --help', 'show help for this command')
      .action(() => {
        rejectParentOptions('token')
        resolved = { mode: 'arkan', action: 'token', options: {} }
      })

    program.command('status')
      .description('report every link of the tracked-session chain and name the broken one')
      .option('--studio-base-url <url>', 'Arkan Studio base URL')
      .helpOption('-h, --help', 'show help for this command')
      .action((options: { studioBaseUrl?: string }) => {
        rejectParentOptions('status')
        resolved = {
          mode: 'arkan',
          action: 'status',
          options: options.studioBaseUrl === undefined ? {} : { studioBaseUrl: options.studioBaseUrl },
        }
      })

    // BR-W16 Đợt A / FR-DEV-09. Registered here rather than through a plugin
    // seam: `bin.ts` dispatches the arkan family without booting a profile, and
    // plugins only exist once a profile has booted — while listing must run
    // BEFORE any lease, so the seam opens after the moment these commands need.
    program.command('workorders')
      .description('list the work orders you can start right now')
      .option('--studio-base-url <url>', 'Arkan Studio base URL')
      .helpOption('-h, --help', 'show help for this command')
      .action((options: { studioBaseUrl?: string }) => {
        rejectParentOptions('workorders')
        resolved = {
          mode: 'arkan',
          action: 'workorders',
          options: options.studioBaseUrl === undefined ? {} : { studioBaseUrl: options.studioBaseUrl },
        }
      })

    const session = program.command('session').description('Arkan Studio session tracking')

    session.command('run')
      .argument('<workorder_id>', 'the work order to start')
      .description('take a work order and obtain its lease')
      .option('--studio-base-url <url>', 'Arkan Studio base URL')
      .option('--satellite-link <uuid>', 'binding id (else ARKAN_SATELLITE_LINK_ID)')
      .option('--fingerprint <value>', 'device fingerprint (else ARKAN_DEVICE_FINGERPRINT)')
      .option('--model-ref <ref>', 'model registry ref (else ARKAN_MODEL_REF)')
      .helpOption('-h, --help', 'show help for this command')
      .action((workorderId: string, options: {
        studioBaseUrl?: string
        satelliteLink?: string
        fingerprint?: string
        modelRef?: string
      }) => {
        rejectParentOptions('session')
        resolved = {
          mode: 'arkan',
          action: 'session-run',
          options: {
            workorder: workorderId,
            ...options.studioBaseUrl === undefined ? {} : { studioBaseUrl: options.studioBaseUrl },
            ...options.satelliteLink === undefined ? {} : { satelliteLink: options.satelliteLink },
            ...options.fingerprint === undefined ? {} : { fingerprint: options.fingerprint },
            ...options.modelRef === undefined ? {} : { modelRef: options.modelRef },
          },
        }
      })
    session.command('machine')
      .helpOption('-h, --help', 'show help for this command')
      .description('declare this machine as a dev machine (the fingerprint a lease checks)')
      .option('--list', 'list dev machines in your tenant with their ids')
      .option('--fingerprint <value>', 'stable machine id, >= 8 chars (env: ARKAN_DEVICE_FINGERPRINT)')
      .option('--generate-fingerprint', 'derive one from hostname + MAC instead of supplying it')
      .option('--display-name <text>', 'label shown in the console')
      .option('--tailscale-hostname <name>', 'tailnet hostname, if any')
      .option('--approve', 'also approve the new machine (needs studio:machines:approve)')
      .option('--approve-id <uuid>', 'approve an EXISTING machine instead of registering one')
      .option('--revoke-id <uuid>', 'REVOKE a machine — one-way, also tears down its ACTIVE leases')
      .option('--studio-base-url <url>', 'Arkan Studio base URL (env: ARKAN_STUDIO_BASE_URL)')
      .action((options: ArkanInvocation['options']) => {
        rejectParentOptions('session')
        resolved = { mode: 'arkan', action: 'session-machine', options }
      })

    session.command('workorder')
      .helpOption('-h, --help', 'show help for this command')
      .description('create the Studio work order a lease hangs off (tier is scored by the server)')
      .requiredOption('--title <text>', 'work order title')
      .requiredOption('--description <text>', 'what the work actually is')
      .requiredOption('--repo <name>', 'target repository')
      .option('--checklist <keys>', 'comma list of Value & Risk Gate items you genuinely satisfy')
      .option('--risk <keys>', 'comma list of risk flags that genuinely apply (raises the tier)')
      .option('--diff-boundary <path>', 'path the change is bounded to (repeatable)', collect)
      .option('--studio-base-url <url>', 'Arkan Studio base URL (env: ARKAN_STUDIO_BASE_URL)')
      .action((options: ArkanInvocation['options']) => {
        rejectParentOptions('session')
        resolved = { mode: 'arkan', action: 'session-workorder', options }
      })

    session.command('link')
      .helpOption('-h, --help', 'show help for this command')
      .description('declare that you use DSH — the ACTIVE binding every lease depends on')
      .option('--type <name>', 'binding type (default: llm_deepseek_harness)')
      .option('--approve', 'also approve the new binding (needs studio:machines:approve)')
      .option('--approve-id <uuid>', 'approve an EXISTING binding instead of creating one')
      .option('--studio-base-url <url>', 'Arkan Studio base URL (env: ARKAN_STUDIO_BASE_URL)')
      .action((options: ArkanInvocation['options']) => {
        rejectParentOptions('session')
        resolved = { mode: 'arkan', action: 'session-link', options }
      })

    session.command('register')
      .helpOption('-h, --help', 'show help for this command')
      .description('obtain an EngineLease so the relay plugin reports this session\'s progress')
      .option('--workorder <id>', 'work order the session belongs to (env: ARKAN_WORKORDER_ID)')
      .option('--satellite-link <uuid>', 'your approved identity binding (env: ARKAN_SATELLITE_LINK_ID)')
      .option('--fingerprint <value>', 'this machine\'s fingerprint (env: ARKAN_DEVICE_FINGERPRINT)')
      .option('--model-ref <ref>', 'Model Registry ref the lease authorizes; must be ACTIVE (env: ARKAN_MODEL_REF)')
      .option('--studio-base-url <url>', 'Arkan Studio base URL (env: ARKAN_STUDIO_BASE_URL)')
      .action((options: ArkanInvocation['options']) => {
        rejectParentOptions('session')
        resolved = { mode: 'arkan', action: 'session-register', options }
      })
  }

  try {
    program.parse(argv, { from: 'user' })
  } catch (error) {
    return process.exit(error instanceof CommanderError ? error.exitCode : 1)
  }
  /* v8 ignore next -- an action resolves or Commander throws */
  if (resolved === undefined) throw new Error('dsh: no invocation resolved')
  return resolved
}
