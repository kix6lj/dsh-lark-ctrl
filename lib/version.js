/**
 * Plugin version, read from the package manifest at runtime.
 *
 * The startup card must never lag the release: a hardcoded version string goes
 * stale on every bump. Resolution is relative to this module, so it works both
 * for a profile-linked checkout and for an installed package.
 */

import { readFileSync } from 'node:fs'

let cached

/**
 * @returns {string} `package.json`'s version, or `unknown` when unreadable.
 */
export function pluginVersion() {
  if (cached !== undefined) return cached
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    cached = typeof manifest?.version === 'string' && manifest.version !== '' ? manifest.version : 'unknown'
  } catch {
    cached = 'unknown'
  }
  return cached
}
