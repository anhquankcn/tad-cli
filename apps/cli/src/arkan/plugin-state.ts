/**
 * Report which build of the out-of-tree relay plugin each profile is running.
 *
 * The plugin is not a dependency of this app, so `healProfilesModuleFallback`
 * never touches it: an operator copies the built package into each profile's
 * own `node_modules` by hand. That makes two silent failures easy. Updating
 * one profile and forgetting another leaves the forgotten one on the old
 * build, and the plugin's `version` does not move between patches, so nothing
 * on its face says which build is present.
 *
 * The fix is not a version string but a fingerprint: size and modification
 * time of the built entry, per profile, side by side. Two profiles that
 * disagree are visible at a glance, and an operator who just rebuilt can see
 * whether the copy actually landed.
 * @module @deepseek-ai/dsh/arkan/plugin-state
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Package name of the relay plugin, as the profile config names it. */
const PLUGIN = 'dsh-plugin-arkan-session'

/** What one profile has installed. */
export interface InstalledPlugin {
  profile: string
  version: string
  /** Size of `dist/index.js`, the only field that moves with a rebuild. */
  bytes: number
  builtAt: string
}

/**
 * Inspect every profile for an installed relay plugin.
 * @param profilesDir - the harness `profiles` directory.
 * @returns one entry per profile that has the plugin, in directory order.
 */
export function readInstalledPlugins(profilesDir: string): InstalledPlugin[] {
  let profiles: string[]
  try {
    profiles = readdirSync(profilesDir)
  } catch {
    return []
  }
  const found: InstalledPlugin[] = []
  for (const profile of profiles) {
    // The flat fallback `profiles/node_modules` is machinery, not a profile.
    if (profile === 'node_modules') continue
    const root = join(profilesDir, profile, 'node_modules', PLUGIN)
    try {
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown }
      const entry = statSync(join(root, 'dist', 'index.js'))
      found.push({
        profile,
        version: typeof manifest.version === 'string' ? manifest.version : '?',
        bytes: entry.size,
        builtAt: new Date(entry.mtimeMs).toISOString(),
      })
    } catch {
      // Absent or half-copied: not this function's business to distinguish,
      // and a profile without the plugin is a legitimate configuration.
    }
  }
  return found
}

/**
 * Decide whether the installed copies disagree.
 *
 * Compares the built entry's size rather than the version, because the version
 * stays at whatever the package declares across many patches while the built
 * bytes change with every one.
 * @param installed - what {@link readInstalledPlugins} found.
 * @returns true when at least two profiles carry different builds.
 */
export function pluginsDiffer(installed: InstalledPlugin[]): boolean {
  return new Set(installed.map(one => one.bytes)).size > 1
}
