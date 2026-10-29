/**
 * Runtime verification for the `wip-codegen` Agent, against a real DSH install.
 *
 * This is the check that the offline scripts cannot make: it boots an isolated
 * DSH profile, mounts this bundle (plus the API-testing companion), lets the
 * probe plugin read the *live* preset composition and the *preset-scoped* skill
 * catalog, then asserts on what came back.
 *
 * Everything runs under its own `DSH_HOME`, so it never touches the user's
 * profile, sessions, credentials or running app. It calls no model and needs no
 * account: the probe exits the process as soon as it has observed.
 *
 * Usage:
 *   node verify-runtime/run.mjs                       # local dirs, isolated profile
 *   node verify-runtime/run.mjs --from-github         # install from GitHub instead
 *   node verify-runtime/run.mjs --home D:\tmp\dshhome --profile my-verify
 *
 * Flags: --home <dir> --profile <name> --dsh <launcher> --bundle <dir>
 *        --companion <dir> --timeout <ms> --from-github --keep
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE_PACKAGE = 'dsh-wip-codegen-agent'
const COMPANION_PACKAGE = 'dsh-api-test-bundle'
const GITHUB_OWNER = 'yuanli-6'

const failures = []
const check = (label, fn) => {
  try {
    fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures.push(label)
    console.log(`  FAIL ${label} -> ${error.message}`)
  }
}
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

// ── arguments ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? fallback : argv[index + 1]
}
const has = (name) => argv.includes(`--${name}`)

const defaultLauncher = process.platform === 'win32'
  ? 'G:/tool/deepseekharness/resources/runtime/cli/bin/dsh.cmd'
  : 'dsh'

const options = {
  dsh: flag('dsh', defaultLauncher),
  home: resolve(flag('home', join(PACKAGE_ROOT, '.verify-runtime', 'home'))),
  profile: flag('profile', 'wip-codegen-verify'),
  bundle: resolve(flag('bundle', PACKAGE_ROOT)),
  companion: resolve(flag('companion', join(PACKAGE_ROOT, '..', COMPANION_PACKAGE))),
  timeout: Number(flag('timeout', 120000)),
  fromGithub: has('from-github'),
  keep: has('keep')
}

if (!existsSync(options.dsh)) throw new Error(`launcher not found: ${options.dsh} (pass --dsh <path>)`)
if (!options.fromGithub && !existsSync(options.companion)) {
  throw new Error(`companion bundle not found: ${options.companion} (pass --companion <dir> or --from-github)`)
}

/** Quote one argument for cmd.exe; refuses what cmd cannot represent. */
function quote(value) {
  const text = String(value)
  if (text.includes('"')) throw new Error(`cannot pass an argument containing a double quote: ${text}`)
  return /\s/.test(text) ? `"${text}"` : text
}

/**
 * Run the dsh launcher with the isolated home.
 *
 * @param {string[]} args - launcher arguments.
 * @param {{timeout?: number}} [runOptions] - timeout override; 0 disables it.
 * @returns {{status: number|null, stdout: string, stderr: string, timedOut: boolean}} the run result.
 */
function runDsh(args, runOptions = {}) {
  // Inherit PATH and friends, but never the harness variables that pin the
  // *current* session's profile: this run must see only its own scratch home.
  const env = {}
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('DSH_')) env[key] = value
  env.DSH_HOME = options.home

  const isWindowsCommand = process.platform === 'win32' && /\.(cmd|bat)$/iu.test(options.dsh)
  const launcher = isWindowsCommand ? options.dsh.replace(/\//g, '\\') : options.dsh
  const result = isWindowsCommand
    ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', [launcher, ...args].map(quote).join(' ')], {
        env,
        encoding: 'utf8',
        windowsVerbatimArguments: true,
        timeout: runOptions.timeout ?? options.timeout,
        maxBuffer: 64 * 1024 * 1024
      })
    : spawnSync(launcher, args, {
        env,
        encoding: 'utf8',
        shell: false,
        timeout: runOptions.timeout ?? options.timeout,
        maxBuffer: 64 * 1024 * 1024
      })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut: result.error?.code === 'ETIMEDOUT' || result.signal !== null
  }
}

console.log(`bundle      ${options.bundle}`)
console.log(`companion   ${options.fromGithub ? `github:${GITHUB_OWNER}/${COMPANION_PACKAGE}` : options.companion}`)
console.log(`DSH_HOME    ${options.home}`)
console.log(`profile     ${options.profile}`)
console.log('')

// ── 1. an isolated profile ────────────────────────────────────────────────────
console.log('isolated profile')
const profileDir = join(options.home, 'profiles', options.profile)
if (!existsSync(join(profileDir, 'package.json'))) {
  const created = runDsh([options.profile, '--from-default-profile', 'web', '--dump-config'])
  check('creates the profile from the shipped web template', () => {
    assert(existsSync(join(profileDir, 'package.json')), `profile was not created (exit ${String(created.status)}): ${created.stderr.slice(0, 400)}`)
  })
} else {
  console.log(`  ok   reusing the existing profile at ${profileDir}`)
}

// ── 2. install the bundle and its companion ───────────────────────────────────
console.log('')
console.log('install')
const installs = options.fromGithub
  ? [
      { name: COMPANION_PACKAGE, spec: `github:${GITHUB_OWNER}/${COMPANION_PACKAGE}` },
      { name: BUNDLE_PACKAGE, spec: `github:${GITHUB_OWNER}/${BUNDLE_PACKAGE}` }
    ]
  : [
      { name: COMPANION_PACKAGE, spec: `file:${options.companion.replace(/\\/g, '/')}` },
      { name: BUNDLE_PACKAGE, spec: `file:${options.bundle.replace(/\\/g, '/')}` }
    ]

for (const { name, spec } of installs) {
  // Remove first, always. pnpm keys a dependency by its spec and reuses the
  // store when the spec is unchanged — so re-adding `file:<dir>` after editing
  // the bundle silently keeps testing the OLD copy. That is exactly how this
  // harness first ran against pre-fix code while the fix sat on disk.
  runDsh(['plugin', '--profile', options.profile, 'remove', name])
  const result = runDsh(['plugin', '--profile', options.profile, 'add', spec], { timeout: 600000 })
  check(`installs ${spec}`, () => {
    assert(result.status === 0, `exit ${String(result.status)}: ${(result.stderr || result.stdout).slice(-600)}`)
  })
}
check('both packages are present in the profile node_modules', () => {
  for (const { name } of installs) {
    assert(existsSync(join(profileDir, 'node_modules', name, 'package.json')), `${name} is missing`)
  }
})
if (!options.fromGithub) {
  check('the installed bundle is the code under test, byte for byte', () => {
    const fingerprint = (root) => {
      const hash = createHash('sha256')
      // The files that decide behaviour: the preset rows and the spec text.
      for (const rel of ['index.js', 'persona-hot.js', 'assets/wip-codegen/system-prompt.md']) {
        hash.update(rel)
        hash.update(readFileSync(join(root, rel)))
      }
      return hash.digest('hex')
    }
    assert(
      fingerprint(join(profileDir, 'node_modules', BUNDLE_PACKAGE)) === fingerprint(options.bundle),
      'the profile holds a different bundle revision than the working tree'
    )
  })
}

// ── 3. boot with the probe mounted, and capture what it sees ──────────────────
console.log('')
console.log('live probe')
const probeSource = join(profileDir, 'node_modules', BUNDLE_PACKAGE, 'verify-runtime', 'probe.js')
const installedProbe = existsSync(probeSource) ? probeSource : join(PACKAGE_ROOT, 'verify-runtime', 'probe.js')
const patchPath = join(options.home, 'verify-probe.patch.yml')
mkdirSync(options.home, { recursive: true })
writeFileSync(
  patchPath,
  ['# generated by verify-runtime/run.mjs — mounts the observation probe only', '- insert:', '    - id: wip-codegen-verify-probe', `      name: '${pathToFileURL(installedProbe).href}'`, ''].join('\n'),
  'utf8'
)

const boot = runDsh(['--profile', options.profile, '--patch', patchPath])
const START = '<<<WIP-CODEGEN-PROBE>>>'
const END = '<<<END-WIP-CODEGEN-PROBE>>>'
const start = boot.stdout.indexOf(START)
const end = boot.stdout.indexOf(END)

check('the probe ran and printed its observation', () => {
  assert(start !== -1 && end !== -1, `markers not found (exit ${String(boot.status)}, timedOut ${String(boot.timedOut)}):\n${boot.stdout.slice(-1500)}\n${boot.stderr.slice(-1500)}`)
})

if (start === -1 || end === -1) {
  console.log('')
  console.log(`${String(failures.length)} CHECK(S) FAILED`)
  process.exitCode = 1
} else {
  const observation = JSON.parse(boot.stdout.slice(start + START.length, end))
  const composition = observation.composition
  const skills = observation.skills ?? {}

  console.log('')
  console.log('preset composition (what the harness really mounted)')
  check('the probe reported no fatal error', () => assert(!observation.fatal, observation.fatal))
  check('the preset is registered and discoverable', () => {
    assert(composition, `wip-codegen absent; registered presets: ${String(observation.inventoryIds)}`)
  })
  check('the preset is not broken', () => assert(composition.broken === null, `broken: ${String(composition.broken)}`))
  check('every enabled row reached ACTIVE', () => {
    const stuck = composition.rows.filter((row) => row.enabled !== false && row.fiberStateName !== 'ACTIVE')
    assert(stuck.length === 0, `not active: ${stuck.map((row) => `${row.moduleName}=${String(row.fiberStateName)}`).join(', ')}`)
  })
  check('the persona row is mounted', () => {
    // The row is this bundle's own `persona-hot` module, not `dsh-persona`:
    // that is what makes the spec re-read the file instead of freezing at mount.
    assert(
      composition.rows.some((row) => row.moduleName === `${BUNDLE_PACKAGE}/persona-hot`),
      `no persona-hot row (rows: ${composition.rows.map((row) => row.moduleName).join(', ')})`
    )
  })
  check('the static dsh-persona row is NOT mounted alongside it', () => {
    // Two rows owning `deployment:persona-prefix` would let a static body
    // shadow the live one, and the reload would silently stop working.
    assert(
      !composition.rows.some((row) => row.moduleName === '@deepseek-ai/dsh-persona'),
      'the static persona row is mounted too — the live body would lose to it'
    )
  })
  check('the testing companion and its skill tool are mounted', () => {
    for (const needle of [COMPANION_PACKAGE, 'dsh-tool-skill']) {
      assert(composition.rows.some((row) => row.moduleName.includes(needle) && row.enabled !== false), `${needle} row missing`)
    }
  })
  check('the core tool rows are mounted', () => {
    for (const needle of ['dsh-tool-fs', 'dsh-tool-fs-search', 'dsh-tool-ask-user', 'dsh-tool-todo']) {
      assert(composition.rows.some((row) => row.moduleName.includes(needle)), `${needle} row missing`)
    }
  })
  check('agent-instructions is mounted, so AGENTS.md reaches the model', () => {
    assert(
      composition.rows.some((row) => row.moduleName.includes('dsh-agent-instructions') && row.enabled !== false),
      `no agent-instructions row (rows: ${composition.rows.map((row) => row.moduleName).join(', ')})`
    )
  })
  check('the delegation tools are mounted', () => {
    for (const needle of ['dsh-tool-subagent', 'dsh-workflow-ptc', 'dsh-tool-workflow']) {
      assert(
        composition.rows.some((row) => row.moduleName.includes(needle) && row.enabled !== false),
        `${needle} row missing`
      )
    }
  })
  check('plan-mode is not mounted', () => {
    assert(!composition.rows.some((row) => row.moduleName.includes('dsh-plan-mode')), 'plan-mode row is mounted')
  })
  check('the declared document lists the companion row', () => {
    assert(typeof observation.document?.content === 'string', 'readDocument returned nothing')
    assert(observation.document.content.includes(COMPANION_PACKAGE), 'the companion row is not in the declared composition')
  })

  console.log('')
  console.log('skill catalog inside the preset scope')
  check('the preset-scoped catalog is complete', () => assert(skills.complete === true, `complete = ${String(skills.complete)}`))
  check('api-test is visible to this preset', () => assert(Array.isArray(skills.names) && skills.names.includes('api-test'), `names = ${JSON.stringify(skills.names)}`))
  check('api-test keeps both invocation policies', () => {
    const summary = (skills.summaries ?? []).find((entry) => entry.name === 'api-test')
    assert(summary, 'no summary for api-test')
    assert(summary.modelInvocable === true && summary.userInvocable === true, JSON.stringify(summary))
  })
  check('the loaded body carries the v1.4.0 rules', () => {
    const loaded = skills.apiTest
    assert(loaded, 'api-test could not be loaded in this scope')
    assert(loaded.contentLength > 5000, `body is only ${String(loaded.contentLength)} chars`)
    for (const [label, value] of [
      ['测试用例交付', loaded.hasTestCaseRules],
      ['接口返回字段来源关系图', loaded.hasFieldSourceRules],
      ['参数取值口径', loaded.hasNormalRangePolicy],
      ['契约校验已覆盖', loaded.hasContractCoveredTable],
      ['cases2xlsx.mjs', loaded.mentionsXlsxScript]
    ]) {
      assert(value === true, `body is missing ${label}`)
    }
  })
  check('the body resolves its bundled resources', () => {
    const base = skills.apiTest?.resourceBase
    assert(base?.kind === 'directory', `resourceBase = ${JSON.stringify(base)}`)
    assert(base.path.includes(COMPANION_PACKAGE) || base.path.includes('assets'), base.path)
  })

  console.log('')
  console.log('prompt assembly (what the first model request would do)')
  const assembly = observation.assembly ?? {}
  check('the probe reported an assembly observation', () => {
    // Without this, the checks below pass vacuously against a probe that never
    // produced `assembly` — exactly the blind spot this section exists to close.
    assert(typeof observation.assembly === 'object' && observation.assembly !== null, 'observation.assembly is missing')
    assert(Array.isArray(assembly.sectionNames), 'assembly.sectionNames is missing')
  })
  check('prompt assembly does not throw', () => {
    assert(!assembly.assemblyError, `assemble() failed: ${String(assembly.assemblyError)}`)
  })
  check('every referenced prompt variable is registered by the loop', () => {
    const unknown = assembly.unknownVariables ?? []
    assert(
      unknown.length === 0,
      `unregistered variable(s) ${unknown.join(', ')} — renderPrompt() would throw on every model request ` +
        `(registered: ${String(assembly.variableNames)})`
    )
  })
  check('every registered variable has a value for this assembly', () => {
    const valueless = assembly.valuelessVariables ?? []
    assert(valueless.length === 0, `valueless variable(s) ${valueless.join(', ')}`)
  })
  check('the persona section is present and non-empty', () => {
    assert(assembly.personaChars > 5000, `deployment:persona-prefix carries ${String(assembly.personaChars)} chars`)
  })
  check('the persona is the complete prompt, without a rival', () => {
    const complete = (assembly.sectionNames ?? []).length === 1
    assert(complete, `complete:true expects one effective section, got ${JSON.stringify(assembly.sectionNames)}`)
  })
  check('the live section serves the file on disk, not a copy frozen at mount', () => {
    // The whole point of the persona-hot row: the text is re-read from the
    // asset on every assembly. If the two lengths differ, something pinned the
    // body at mount time and editing the file would silently do nothing.
    const live = assembly.personaChars
    const file = observation.bundle?.specChars
    assert(Number.isInteger(file) && file > 5000, `the installed bundle reported specChars = ${String(file)}`)
    assert(
      live === file,
      `the live section carries ${String(live)} chars but the file holds ${String(file)} — the body is stale`
    )
  })

  console.log('')
  console.log('spec text carried by the persona')
  check('the installed bundle reports its own definition', () => {
    assert(!observation.bundle?.error, String(observation.bundle?.error))
    assert(observation.bundle.rowCount === 10, `rowCount = ${String(observation.bundle?.rowCount)}`)
    assert(observation.bundle.flatRowCount === 15, `flatRowCount = ${String(observation.bundle?.flatRowCount)}`)
  })
  check('the spec carries the SQL, confirmation and global-rule sections', () => {
    assert(observation.bundle.specHasSqlSection, 'SQL section missing')
    assert(observation.bundle.specHasConfirmation, 'confirmation section missing')
    assert(observation.bundle.specHasGlobalRules, 'global-rules section missing')
  })
  check('the spec path is injected so §14.6 has a file to append to', () => {
    assert(observation.bundle.specPathInjected, 'spec path note missing from the prompt')
  })
}

// ── cleanup ──────────────────────────────────────────────────────────────────
if (!options.keep) {
  const realHome = join(homedir(), '.dsh')
  if (resolve(options.home) === resolve(realHome)) {
    console.log('')
    console.log(`refusing to remove the real DSH home (${options.home}); pass --home to a scratch directory`)
  } else if (existsSync(options.home) && options.home.includes('verify-runtime')) {
    // Only ever the scratch home this script created (or was pointed at explicitly).
    rmSync(options.home, { recursive: true, force: true })
    console.log('')
    console.log(`removed the scratch DSH_HOME at ${options.home}`)
  } else {
    console.log('')
    console.log(`kept ${options.home} (not a verify-runtime scratch dir; pass --keep to silence this)`)
  }
}

console.log('')
console.log(
  failures.length === 0
    ? 'ALL RUNTIME CHECKS PASSED (preset mounted, rows active, api-test visible in the preset scope)'
    : `${String(failures.length)} RUNTIME CHECK(S) FAILED:\n${failures.map((line) => `  - ${line}`).join('\n')}`
)
process.exitCode = failures.length === 0 ? 0 : 1
