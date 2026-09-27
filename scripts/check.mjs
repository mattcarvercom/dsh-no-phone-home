#!/usr/bin/env node
// Audit an installed dsh profile as the launcher would compose it right now:
// every bundle layer, the profile's own patch (which the Plugins page writes),
// and the DSH_TELEMETRY_DISABLED value in this environment. Exits 1 when any
// telemetry row is enabled or this bundle is not mounted. A denied id this dsh
// version does not have is listed as `absent` and is not a failure.
//   node scripts/check.mjs [profileDir]
import { homedir } from 'node:os'
import { join } from 'node:path'
import { auditProfile } from '../src/audit.mjs'

const profileDir = process.argv[2] ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles/web')
const result = await auditProfile(profileDir, { telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED })

const problems = [...result.violations]
if (!result.bundles.includes('dsh-no-phone-home')) problems.push(`profile ${profileDir} does not mount the dsh-no-phone-home bundle`)

console.log(`profile: ${profileDir}`)
console.log(`bundles: ${result.bundles.join(', ')}`)
console.log(`DSH_TELEMETRY_DISABLED: ${process.env.DSH_TELEMETRY_DISABLED ? 'set' : 'unset'}`)
for (const { id, state } of result.denied) console.log(`  ${state.padEnd(8)} ${id}`)
for (const warning of result.warnings) if (!/^patch: entry ".*" not found$/.test(warning)) console.log(`warning: ${warning}`)
if (problems.length === 0) {
  console.log('ok: no telemetry rows enabled')
} else {
  for (const problem of problems) console.error(`FAIL: ${problem}`)
  process.exit(1)
}
