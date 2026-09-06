/**
 * The relay plugin is out-of-tree: `healProfilesModuleFallback` links only the
 * app's own dependency closure, so an operator copies the built package into
 * each profile's `node_modules` by hand. Two profiles therefore drift, and the
 * package's `version` stays put across many patches — meaning neither the
 * presence of the plugin nor its version answers "am I running the build I
 * just made".
 *
 * The built entry's size does, which is why these specs pin the comparison to
 * that rather than to the version string.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pluginsDiffer, readInstalledPlugins } from '../src/arkan/plugin-state.ts'

let profiles = ''

/**
 * Install a fake plugin build into one profile.
 * @param profile - profile directory name.
 * @param body - contents of `dist/index.js`; its length is the fingerprint.
 * @param version - version to declare in the manifest.
 */
function install(profile: string, body: string, version = '0.1.0'): void {
  const root = join(profiles, profile, 'node_modules', 'dsh-plugin-arkan-session')
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'dsh-plugin-arkan-session', version }))
  writeFileSync(join(root, 'dist', 'index.js'), body)
}

beforeEach(() => {
  profiles = mkdtempSync(join(tmpdir(), 'dsh-profiles-'))
})

afterEach(() => {
  rmSync(profiles, { recursive: true, force: true })
})

describe('readInstalledPlugins', () => {
  it('reports one entry per profile that has the plugin', () => {
    install('tui', 'export const apply = () => {}')
    install('headless', 'export const apply = () => {}')
    mkdirSync(join(profiles, 'web'), { recursive: true })

    const found = readInstalledPlugins(profiles)

    expect(found.map(one => one.profile).sort()).toEqual(['headless', 'tui'])
    expect(found[0]?.version).toBe('0.1.0')
    expect(found[0]?.bytes).toBeGreaterThan(0)
  })

  it('skips the flat module fallback, which is machinery not a profile', () => {
    // `profiles/node_modules` is maintained by the harness itself; reporting it
    // as a profile would invite an operator to install into it.
    mkdirSync(join(profiles, 'node_modules', 'dsh-plugin-arkan-session', 'dist'), { recursive: true })
    install('tui', 'x')

    expect(readInstalledPlugins(profiles).map(one => one.profile)).toEqual(['tui'])
  })

  it('ignores a half-copied install rather than reporting a broken entry', () => {
    // A manifest with no built entry is a copy interrupted partway; it is not
    // a running build and must not be counted as one.
    const root = join(profiles, 'tui', 'node_modules', 'dsh-plugin-arkan-session')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }))

    expect(readInstalledPlugins(profiles)).toEqual([])
  })

  it('returns nothing when the profiles directory does not exist', () => {
    expect(readInstalledPlugins(join(profiles, 'absent'))).toEqual([])
  })
})

describe('pluginsDiffer', () => {
  it('spots the profile that was forgotten during an update', () => {
    // The failure this exists to catch: rebuild, copy into `tui`, forget
    // `headless`, then conclude the patch did not work.
    install('tui', 'export const apply = () => { /* patched */ }')
    install('headless', 'export const apply = () => {}')

    expect(pluginsDiffer(readInstalledPlugins(profiles))).toBe(true)
  })

  it('does not flag identical builds', () => {
    install('tui', 'same')
    install('headless', 'same')

    expect(pluginsDiffer(readInstalledPlugins(profiles))).toBe(false)
  })

  it('compares builds, not versions, because the version does not move', () => {
    // Both declare 0.1.0 — as every patch of this plugin has — yet one carries
    // a different build. A version comparison would call these equal.
    install('tui', 'old build', '0.1.0')
    install('headless', 'a different build', '0.1.0')

    const found = readInstalledPlugins(profiles)
    expect(new Set(found.map(one => one.version)).size).toBe(1)
    expect(pluginsDiffer(found)).toBe(true)
  })

  it('cannot differ when only one profile has it', () => {
    install('tui', 'only')

    expect(pluginsDiffer(readInstalledPlugins(profiles))).toBe(false)
  })
})
