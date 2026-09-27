/**
 * Compose a dsh profile's loader rows the way the launcher does (each bundle
 * layer in order, the profile's own patch, the home-level patch, then the
 * DSH_TELEMETRY_DISABLED patch) and audit the result for rows that could send data off this machine.
 *
 * The audit fails closed: a row counts as disabled only when its own
 * `disabled`, or an enclosing group's, is literally `true`. A `!!js`
 * expression (such as the desktop-profile gate) does not count.
 * @module dsh-no-phone-home/audit
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Rows this bundle disables, with the package each id carries upstream. Older
 * dsh releases lack some ids (otel and the desktop rows arrived after
 * 0.1.7-rc.2); a patch for an absent id is skipped with a "not found" warning,
 * which is harmless. A denied package appearing under a different id means
 * upstream renamed the row, and the pattern scan below reports it if enabled.
 */
export const DENIED = Object.freeze([
  { id: 'otel', package: '@deepseek-ai/dsh-otel' },
  { id: 'session-telemetry-otel', package: '@deepseek-ai/dsh-session-telemetry-otel' },
  { id: 'session-log-deepseek', package: '@deepseek-ai/dsh-session-log-deepseek' },
  { id: 'plugin-package-inventory-deepseek', package: '@deepseek-ai/dsh-plugin-package-inventory-deepseek' },
  { id: 'desktop-product-telemetry', package: '@deepseek-ai/dsh-host-product-telemetry-otel' },
  { id: 'product-analytics', package: '@deepseek-ai/dsh-client-product-analytics' },
  { id: 'command-feedback', package: '@deepseek-ai/dsh-command-feedback' },
  { id: 'message-feedback', package: '@deepseek-ai/dsh-message-feedback' },
  { id: 'ui-message-feedback', package: '@deepseek-ai/dsh-client-ui-message-feedback' },
])

/** The denied row ids. */
export const DENIED_ROWS = Object.freeze(DENIED.map(row => row.id))

/**
 * Package-name shapes of rows that report, export, or collect for upload. An
 * enabled row matching this that is not in DENIED_ROWS is a new upstream
 * channel this bundle does not cover yet.
 */
export const TELEMETRY_PATTERN = /telemetry|analytics|otel|feedback|inventory-deepseek|session-log-deepseek|anonymous-user-id/i

/** The launcher's own opt-out row (app-boot TELEMETRY_ROW_ID). */
const TELEMETRY_ROW_ID = 'session-telemetry-otel'

/**
 * Locate the installed `@deepseek-ai/dsh` package, whose dependencies carry the
 * patch applier, js-yaml, and the shipped bundles. DSH_PACKAGE_DIR names it
 * directly; DSH_CHECKOUT names a source checkout (its apps/cli); otherwise the
 * `dsh` on PATH is followed to its package.
 * @returns the package directory.
 */
export function locateDshPackage() {
  if (process.env.DSH_PACKAGE_DIR) return process.env.DSH_PACKAGE_DIR
  if (process.env.DSH_CHECKOUT) return join(process.env.DSH_CHECKOUT, 'apps/cli')
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const bin = join(dir, 'dsh')
    if (!existsSync(bin)) continue
    let current = dirname(realpathSync(bin))
    while (current !== dirname(current)) {
      const manifest = join(current, 'package.json')
      if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === '@deepseek-ai/dsh') return current
      current = dirname(current)
    }
  }
  throw new Error('cannot locate @deepseek-ai/dsh: put dsh on PATH, or set DSH_PACKAGE_DIR or DSH_CHECKOUT')
}

/**
 * Resolve a package directory from an anchor directory's module search paths.
 * Walks the paths instead of require.resolve: a package whose exports map
 * omits ./package.json still has one, and dsh locates bundles this way.
 * @param anchorDir - directory whose node_modules resolution to use.
 * @param name - package name.
 * @returns the package's real manifest path.
 */
export function resolveManifest(anchorDir, name) {
  const paths = createRequire(join(anchorDir, 'package.json')).resolve.paths(name) ?? []
  for (const directory of paths) {
    const candidate = join(directory, name, 'package.json')
    if (existsSync(candidate)) return realpathSync(candidate)
  }
  throw new Error(`cannot resolve ${name} from ${anchorDir}`)
}

/**
 * Load dsh's patch applier and YAML schema from the installed dsh package.
 * @param dshDir - the @deepseek-ai/dsh package directory.
 * @returns the include module's applyEntryPatches, entryListSchema, and js-yaml.
 */
export async function loadIncludeTools(dshDir = locateDshPackage()) {
  const includeDir = dirname(resolveManifest(dshDir, '@deepseek-ai/cordis-plugin-include'))
  const include = await import(pathToFileURL(join(includeDir, 'lib/index.js')).href)
  const yaml = createRequire(join(includeDir, 'package.json'))('js-yaml')
  return { applyEntryPatches: include.applyEntryPatches, entryListSchema: include.entryListSchema, yaml }
}

/**
 * Read one patch file as a loader patch list.
 * @param tools - loadIncludeTools result.
 * @param file - YAML path.
 * @returns the patch list (empty for an empty file).
 */
export function readPatchFile(tools, file) {
  const parsed = tools.yaml.load(readFileSync(file, 'utf8'), { schema: tools.entryListSchema })
  if (parsed === undefined || parsed === null) return []
  if (!Array.isArray(parsed)) throw new Error(`${file} must be a top-level list of patches`)
  return parsed
}

/**
 * Read a bundle's patch layer.
 * @param tools - loadIncludeTools result.
 * @param manifestPath - the bundle's package.json.
 * @returns its concatenated patch lists.
 */
export function readBundleLayer(tools, manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const declared = manifest.dsh?.bundle?.patch
  const files = typeof declared === 'string' ? [declared] : declared
  if (!Array.isArray(files)) throw new Error(`${manifestPath} declares no dsh.bundle.patch`)
  return files.flatMap(file => readPatchFile(tools, join(dirname(manifestPath), file)))
}

/**
 * Compose rows from ordered patch layers.
 * @param tools - loadIncludeTools result.
 * @param layers - patch lists in application order.
 * @param options.telemetryDisabledEnv - the DSH_TELEMETRY_DISABLED value to model.
 * @returns the composed entries and every patch warning (a missing id is a warning).
 */
export function compose(tools, layers, { telemetryDisabledEnv } = {}) {
  const warnings = []
  const warn = (message, ...args) => {
    let index = 0
    warnings.push(message.replace(/%C/g, () => JSON.stringify(args[index++])))
  }
  // applyEntryPatches inserts rows by reference and later patches mutate them,
  // so compose over a copy: the caller's layers stay reusable.
  const patches = structuredClone(layers.flat())
  let entries = tools.applyEntryPatches([], patches, warn)
  const hasRow = flatten(entries).some(row => row.entry.id === TELEMETRY_ROW_ID)
  if ((telemetryDisabledEnv ?? '') !== '' && hasRow) {
    entries = tools.applyEntryPatches([], [...structuredClone(layers.flat()), { id: TELEMETRY_ROW_ID, disabled: true }], () => {})
  }
  return { entries, warnings }
}

/**
 * Rows in loader order with groups descended.
 * @param entries - composed entries.
 * @param inherited - enclosing groups' disabled values.
 * @returns rows with their own and inherited disabled values.
 */
export function flatten(entries, inherited = []) {
  const rows = []
  for (const entry of entries) {
    const disabled = [...inherited, entry.disabled]
    if (entry.group === true && Array.isArray(entry.config)) {
      rows.push(...flatten(entry.config, disabled))
      continue
    }
    rows.push({ entry, disabled })
  }
  return rows
}

/** Whether a row is off for certain: only a literal `true` counts. */
const isOff = row => row.disabled.some(value => value === true)

/**
 * Audit composed entries.
 * @param entries - composed entries.
 * @returns violations (empty when the composition is clean) and the denied rows' states.
 */
export function audit(entries) {
  const rows = flatten(entries)
  const violations = []
  const denied = DENIED_ROWS.map((id) => {
    const matches = rows.filter(row => row.entry.id === id)
    if (matches.length === 0) return { id, state: 'absent' }
    const on = matches.filter(row => !isOff(row))
    for (const row of on) violations.push(`denied row ${id} (${row.entry.name}) is enabled`)
    return { id, state: on.length === 0 ? 'disabled' : 'ENABLED' }
  })
  for (const row of rows) {
    if (DENIED_ROWS.includes(row.entry.id) || isOff(row)) continue
    if (typeof row.entry.name === 'string' && TELEMETRY_PATTERN.test(row.entry.name)) {
      violations.push(`enabled row ${row.entry.id ?? '(no id)'} (${row.entry.name}) looks like telemetry and is not covered`)
    }
  }
  return { violations, denied }
}

/**
 * Compose and audit an installed profile directory as the launcher runs it.
 * @param profileDir - e.g. ~/.dsh/profiles/web.
 * @param options.telemetryDisabledEnv - the DSH_TELEMETRY_DISABLED value to model.
 * @param options.dshDir - the @deepseek-ai/dsh package directory.
 * @returns audit result plus the bundle list and patch warnings.
 */
export async function auditProfile(profileDir, { telemetryDisabledEnv, dshDir = locateDshPackage() } = {}) {
  const tools = await loadIncludeTools(dshDir)
  const profile = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  const bundles = profile.dsh?.profile?.bundles ?? []
  const layers = bundles.map(name => readBundleLayer(tools, resolveManifest(profileDir, name)))
  // The profile's own patch (what the Plugins page writes), then the home-level
  // patch ($DSH_HOME/cordis.patch.yml), in the launcher's order.
  const optional = (file) => {
    try { return readPatchFile(tools, file) }
    catch (error) { if (error.code === 'ENOENT') return []; throw error }
  }
  const home = dirname(dirname(profileDir))
  const userLayers = [optional(join(profileDir, 'cordis.patch.yml')), optional(join(home, 'cordis.patch.yml'))]
  const { entries, warnings } = compose(tools, [...layers, ...userLayers], { telemetryDisabledEnv })
  return { bundles, warnings, ...audit(entries) }
}
