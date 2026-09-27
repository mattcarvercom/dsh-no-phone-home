// Guards against upstream drift: run after every dsh upgrade (`npm test`; set
// DSH_CHECKOUT=<checkout> to test a source checkout instead of the dsh on PATH).
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  DENIED, DENIED_ROWS, audit, compose, flatten, loadIncludeTools, locateDshPackage, readBundleLayer, readPatchFile, resolveManifest,
} from '../src/audit.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const dshDir = locateDshPackage()
const tools = await loadIncludeTools(dshDir)
// The web profile's shipped layers (app-boot PROFILE_TEMPLATES.web), as the installed dsh resolves them.
const shipped = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'].map(bundle => readBundleLayer(tools, resolveManifest(dshDir, bundle)))
const ours = readPatchFile(tools, join(REPO, 'cordis.patch.yml'))

test('no denied package was moved to another id', () => {
  // An absent id is fine on older dsh releases; its package appearing under a
  // different id means upstream renamed the row and the patch must follow.
  const rows = flatten(compose(tools, shipped).entries)
  const moved = DENIED.flatMap(({ id, package: name }) => rows
    .filter(row => row.entry.name === name && row.entry.id !== id)
    .map(row => `${name} is now row ${row.entry.id} (was ${id})`))
  assert.deepEqual(moved, [])
})

test('the patch disables exactly DENIED_ROWS, by id only', () => {
  assert.deepEqual(ours.map(patch => patch.id).sort(), [...DENIED_ROWS].sort())
  for (const patch of ours) {
    assert.deepEqual(Object.keys(patch).sort(), ['disabled', 'id'], `${patch.id} must not pin a name or insert`)
    assert.equal(patch.disabled, true)
  }
})

test('shipped web plus this bundle leaves no telemetry row enabled', () => {
  const { entries, warnings } = compose(tools, [...shipped, ours])
  const absent = audit(compose(tools, shipped).entries).denied.filter(row => row.state === 'absent').map(row => row.id)
  assert.deepEqual(warnings, absent.map(id => `patch: entry "${id}" not found`))
  const result = audit(entries)
  assert.deepEqual(result.violations, [])
  assert.ok(result.denied.every(row => row.state !== 'ENABLED'))
})

test('the audit detects the shipped defaults (so a clean result means something)', () => {
  const result = audit(compose(tools, shipped).entries)
  for (const id of ['session-telemetry-otel', 'session-log-deepseek', 'plugin-package-inventory-deepseek']) {
    assert.ok(result.violations.some(v => v.includes(`denied row ${id} `)), `expected ${id} to be reported`)
  }
  // Where present, desktop-gated rows carry a !!js disabled expression, which must not count as off.
  if (result.denied.find(row => row.id === 'product-analytics').state !== 'absent') {
    assert.ok(result.violations.some(v => v.includes('denied row product-analytics ')))
  }
})

test('a later layer re-enabling a denied row is reported', () => {
  const result = audit(compose(tools, [...shipped, ours, [{ id: 'session-log-deepseek', disabled: false }]]).entries)
  assert.ok(result.violations.some(v => v.includes('denied row session-log-deepseek ')))
})

test('DSH_TELEMETRY_DISABLED keeps session telemetry off over a later re-enable', () => {
  const layers = [...shipped, ours, [{ id: 'session-telemetry-otel', disabled: false }]]
  const result = audit(compose(tools, layers, { telemetryDisabledEnv: '1' }).entries)
  assert.ok(!result.violations.some(v => v.includes('session-telemetry-otel')))
})

test('an uncovered telemetry-shaped row is reported', () => {
  const extra = [{ insert: [{ id: 'new-thing', name: '@deepseek-ai/dsh-future-analytics' }] }]
  const result = audit(compose(tools, [...shipped, ours, extra]).entries)
  assert.ok(result.violations.some(v => v.includes('dsh-future-analytics')))
})
