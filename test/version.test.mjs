/**
 * The startup card must report the version of the package that actually runs,
 * not a string a release forgot to bump.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { pluginVersion } from '../lib/version.js'

test('pluginVersion follows package.json', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pluginVersion(), manifest.version)
  assert.match(pluginVersion(), /^\d+\.\d+\.\d+/)
})

test('pluginVersion is stable across calls', () => {
  assert.equal(pluginVersion(), pluginVersion())
})
