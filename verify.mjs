/**
 * Local self-check for dsh-wip-codegen-agent.
 *
 * Runs on a bare checkout with no DSH and no dependencies: it imports the
 * plugin's own `buildDefinition()` and asserts it against the contract that
 * `agentPresets.register()` accepts, then checks the spec asset byte-for-byte.
 *
 * The point is to catch the failures that only show up at install time on
 * someone else's machine — a spec that got mangled, a fallback body silently
 * taking over, a tool row that is not a real harness package, a preset id that
 * drifted, or an asset left out of the `files` whitelist so the package that
 * gets installed is missing the very text that makes the Agent useful.
 *
 * Run: node verify.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PKG = JSON.parse(readFileSync('package.json', 'utf8'))
const SPEC_URL = new URL('./assets/wip-codegen/system-prompt.md', import.meta.url)

const failures = []
const warnings = []

/**
 * Run one named assertion.
 *
 * @param {string} label - what is being checked.
 * @param {() => void} fn - throws with a reason when the check fails.
 */
const check = (label, fn) => {
  try {
    fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures.push(label)
    console.log(`  FAIL ${label} -> ${error.message}`)
  }
}

/** Soft assertion: recorded, printed, but does not fail the run. */
const warnIf = (label, fn) => {
  try {
    fn()
  } catch (error) {
    warnings.push(label)
    console.log(`  warn ${label} -> ${error.message}`)
  }
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

// ── the spec asset ────────────────────────────────────────────────────────────
const rawSpec = readFileSync(SPEC_URL, 'utf8')

console.log('spec asset')
check('spec file is present and non-empty', () => {
  assert(rawSpec.trim().length > 0, 'spec is empty')
})
check('spec has no UTF-8 BOM', () => {
  assert(!rawSpec.startsWith('\uFEFF'), 'file starts with a BOM')
})
check('spec is substantial (guards against a truncated asset)', () => {
  assert(rawSpec.length > 5000, `only ${rawSpec.length} chars — expected the full team spec`)
})
check('spec mentions the four required inputs', () => {
  for (const needle of ['建表 SQL', 'UI 截图', 'Excel 样例', 'SAP 字段映射']) {
    assert(rawSpec.includes(needle), `spec no longer mentions "${needle}"`)
  }
})
check('spec carries the SQL Server table-script rules', () => {
  for (const needle of [
    '## 十三、SQL Server 建表脚本生成规范',
    'sp_addextendedproperty',
    'DATETIME2(0)',
    'IX_{表名}_{字段名}',
    'IF OBJECT_ID',
    '未测试-未发生产.sql'
  ]) {
    assert(rawSpec.includes(needle), `spec no longer contains "${needle}"`)
  }
})
check('spec carries the mandatory confirmation flow', () => {
  for (const needle of [
    '## 十四、强制交互流程：先确认，再落地',
    '14.2 SQL 字段确认',
    '14.3 Java 代码生成确认',
    '14.4 风格基准',
    '14.5 删除确认',
    '14.6 全局规则沉淀',
    'ask_user_question'
  ]) {
    assert(rawSpec.includes(needle), `spec no longer contains "${needle}"`)
  }
})
check('spec exposes an append target for global rules', () => {
  assert(rawSpec.includes('## 十五、全局规则（用户追加）'), '§十五 is missing, §14.6 would have nowhere to append')
})

// ── the definition handed to agentPresets.register() ──────────────────────────
const { buildDefinition, companionAvailable, name: pluginName, inject } = await import('./index.js')

// Rows are asserted against the *intended* shape (companion present); the
// resolvability gate itself is exercised in its own section below.
const definition = buildDefinition((message) => warnings.push(message), { apiTest: true })

console.log('')
console.log('plugin shape')
check('plugin exports a cordis name', () => {
  assert(typeof pluginName === 'string' && pluginName.length > 0, 'name is not a non-empty string')
})
check('plugin injects exactly the agentPresets service', () => {
  assert(Array.isArray(inject), 'inject is not an array')
  assert(inject.length === 1 && inject[0] === 'agentPresets', `inject = ${JSON.stringify(inject)}`)
})

console.log('')
console.log('preset definition')
check('definition carries a stable preset id', () => {
  assert(definition.id === 'wip-codegen', `id is "${definition.id}"`)
})
check('definition has display metadata', () => {
  assert(typeof definition.name === 'string' && definition.name.length > 0, 'name missing')
  assert(typeof definition.description === 'string' && definition.description.length > 0, 'description missing')
})
check('definition has a numeric order after the shipped presets', () => {
  assert(typeof definition.order === 'number', 'order is not a number')
  assert(definition.order > 4, `order ${definition.order} would collide with a shipped preset (1..4)`)
})
check('definition.plugins is a non-empty array', () => {
  assert(Array.isArray(definition.plugins) && definition.plugins.length > 0, 'plugins is empty')
})
check('every row is a well-formed entry', () => {
  for (const row of definition.plugins) {
    assert(typeof row === 'object' && row !== null, 'a row is not an object')
    assert(typeof row.id === 'string' && row.id.length > 0, `row ${JSON.stringify(row)} has no id`)
    assert(typeof row.name === 'string' && row.name.length > 0, `row ${row.id} has no name`)
  }
})
check('every row names either a first-party harness package or the declared companion', () => {
  for (const row of definition.plugins) {
    const firstParty = row.name.startsWith('@deepseek-ai/dsh-')
    assert(
      firstParty || row.name === 'dsh-api-test-bundle',
      `row ${row.id} names "${row.name}", which is neither first-party nor the companion`
    )
  }
})
check('row ids are unique', () => {
  const ids = definition.plugins.map((row) => row.id)
  assert(new Set(ids).size === ids.length, `duplicate ids in ${ids.join(', ')}`)
})
check('exactly one persona row exists', () => {
  const personaRows = definition.plugins.filter((row) => row.name.includes('dsh-persona'))
  assert(personaRows.length === 1, `found ${personaRows.length} persona rows`)
})

// ── the persona carries the whole spec ────────────────────────────────────────
const persona = definition.plugins.find((row) => row.name.includes('dsh-persona'))

console.log('')
console.log('persona (the system prompt)')
check('persona is not disabled', () => {
  assert(persona.disabled !== true, 'the persona row is disabled, so the spec would never load')
})
check('persona uses complete:true (spec becomes the whole system prompt)', () => {
  assert(persona.config?.complete === true, 'complete is not true — profile sections would dilute the spec')
})
check('persona prefix starts with the spec verbatim', () => {
  const expected = rawSpec.replace(/^\uFEFF/, '').trim()
  assert(
    persona.config.prefix.startsWith(expected),
    'the prompt does not begin with the spec — the asset may have been mangled or replaced by a fallback'
  )
})
check('persona prefix is the spec plus only the trailing notes', () => {
  const expected = rawSpec.replace(/^\uFEFF/, '').trim()
  const extra = persona.config.prefix.slice(expected.length)
  assert(
    extra.includes('system-prompt.md'),
    'the spec-path note is missing, so §14.6 has no file to append global rules to'
  )
  assert(extra.length < 400, `unexpected extra prose after the spec (${extra.length} chars)`)
})
check('persona references only prompt variables the loop registers', () => {
  // The agent loop registers exactly `provider` and `model`; renderPrompt()
  // throws on any other reference, which fails every model request in the
  // session ("unknown prompt variable … in section deployment:persona-prefix").
  // 2.0.0 shipped `{{cwd}}` here and took the whole preset down. The working
  // directory already arrives as required runtime context, so nothing is owed.
  const registered = new Set(['provider', 'model'])
  const referenced = [...persona.config.prefix.matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/g)].map((m) => m[1])
  const unknown = [...new Set(referenced)].filter((variable) => !registered.has(variable))
  assert(
    unknown.length === 0,
    `unregistered prompt variable(s) ${unknown.join(', ')} — assembly throws before the first model request`
  )
})
check('no fallback body was served', () => {
  assert(!persona.config.prefix.includes('规范正文未能读取'), 'the asset failed to load during this check')
})

// ── the tool surface ──────────────────────────────────────────────────────────
console.log('')
console.log('tool surface')

const enabledNames = definition.plugins.filter((row) => row.disabled !== true).map((row) => row.name)
check('a shell row is enabled for this platform', () => {
  const shell = enabledNames.filter((n) => n.includes('tool-pwsh') || n.includes('tool-bash'))
  assert(shell.length === 1, `expected exactly 1 enabled shell row, found ${shell.length}`)
})
check('the Windows/other shell split is correct for this platform', () => {
  const hasPwsh = enabledNames.some((n) => n.includes('tool-pwsh'))
  const hasBash = enabledNames.some((n) => n.includes('tool-bash'))
  if (process.platform === 'win32') assert(hasPwsh && !hasBash, 'on win32 the enabled shell should be pwsh only')
  else assert(hasBash && !hasPwsh, 'off win32 the enabled shell should be bash only')
})
check('file access, search and interaction tools are present', () => {
  for (const needle of ['dsh-tool-fs', 'dsh-tool-fs-search', 'dsh-tool-ask-user', 'dsh-tool-todo']) {
    assert(enabledNames.some((n) => n.includes(needle)), `missing ${needle}`)
  }
})

// ── the mounted testing companion ─────────────────────────────────────────────
console.log('')
console.log('testing companion (dsh-api-test-bundle)')

check('the companion skill plugin is mounted', () => {
  assert(
    definition.plugins.some((row) => row.name === 'dsh-api-test-bundle'),
    'the api-test skill bundle is not in the preset'
  )
})
check('tool-skill IS mounted, otherwise the companion skill can never load', () => {
  assert(
    definition.plugins.some((row) => row.name.includes('dsh-tool-skill')),
    'without tool-skill nothing renders a catalog and the api-test skill is unreachable'
  )
})
check('the companion row is marked enabled', () => {
  const row = definition.plugins.find((r) => r.name === 'dsh-api-test-bundle')
  assert(row.disabled !== true, 'the companion row is disabled')
})
check('the catalog description cap is a sane positive integer', () => {
  const row = definition.plugins.find((r) => r.name.includes('dsh-tool-skill'))
  const cap = row.config?.catalogDescriptionMaxLength
  assert(Number.isInteger(cap) && cap >= 3, `catalogDescriptionMaxLength = ${cap}`)
})

console.log('')
console.log('companion resolvability gate (a bad row must not kill the Agent)')

const gated = buildDefinition((message) => warnings.push(message), { apiTest: false })
check('with the companion absent the two skill rows are dropped', () => {
  assert(!gated.plugins.some((r) => r.name === 'dsh-api-test-bundle'), 'companion row survived the gate')
  assert(!gated.plugins.some((r) => r.name.includes('dsh-tool-skill')), 'tool-skill row survived the gate')
  assert(definition.plugins.length - gated.plugins.length === 2, 'the gate should drop exactly two rows')
})
check('with the companion absent the Agent still mounts its core rows', () => {
  const names = gated.plugins.map((r) => r.name)
  for (const needle of ['dsh-persona', 'dsh-tool-fs', 'dsh-tool-fs-search', 'dsh-tool-ask-user', 'dsh-tool-todo']) {
    assert(names.some((n) => n.includes(needle)), `core row ${needle} was dropped too`)
  }
  const shells = names.filter((n) => n.includes('tool-pwsh') || n.includes('tool-bash'))
  assert(shells.length === 1, `expected exactly 1 shell row without the companion, got ${shells.length}`)
  assert(gated.plugins.length === 6, `expected 6 rows without the companion, got ${gated.plugins.length}`)
})
check('with the companion absent a diagnostic is emitted', () => {
  assert(
    warnings.some((message) => message.includes('dsh-api-test-bundle')),
    'no warning names the missing companion'
  )
})
check('the real probe is a boolean and the definition is deterministic', () => {
  assert(typeof companionAvailable() === 'boolean', 'companionAvailable() did not return a boolean')
  const a = buildDefinition(undefined, { apiTest: true })
  const b = buildDefinition(undefined, { apiTest: true })
  assert(JSON.stringify(a) === JSON.stringify(b), 'two builds with the same options differ')
})
check('the persona is identical with and without the companion', () => {
  const withRows = buildDefinition(undefined, { apiTest: true })
  const without = buildDefinition(undefined, { apiTest: false })
  const prefixOf = (d) => d.plugins.find((r) => r.name.includes('dsh-persona')).config.prefix
  assert(prefixOf(withRows) === prefixOf(without), 'the spec text changed with the companion gate')
})
check('no delegation or workflow rows are mounted', () => {
  for (const needle of ['dsh-tool-subagent', 'dsh-tool-workflow', 'dsh-tool-ralph']) {
    assert(!definition.plugins.some((row) => row.name.includes(needle)), `${needle} is mounted`)
  }
})
check('no memory or plugin-manager rows are mounted', () => {
  for (const needle of ['meow-memory', 'plugin-manager']) {
    assert(!definition.plugins.some((row) => row.name.includes(needle)), `${needle} is mounted`)
  }
})

// ── required-without-fallback config ──────────────────────────────────────────
//
// These two rows declare their config fields as REQUIRED with no default. A row
// that omits one fails the activation audit, and one failed row breaks the
// entire preset: the Agent then exists but cannot be selected, with the reason
// visible only in the preset's `broken` field. Version 1.x of this bundle
// shipped that exact defect; `verify-runtime/run.mjs` is what caught it against
// a live install, and these assertions are what keep it caught offline.
console.log('')
console.log('required config (a missing required field breaks the whole preset)')

check('tool-fs-search carries the required sampleOverCapGlobResults', () => {
  const row = definition.plugins.find((r) => r.name.includes('dsh-tool-fs-search'))
  assert(row !== undefined, 'tool-fs-search row is missing')
  assert(
    row.config?.sampleOverCapGlobResults === false,
    `sampleOverCapGlobResults = ${JSON.stringify(row.config?.sampleOverCapGlobResults)} (required, no default)`
  )
})
check('tool-todo carries the required allowParallelInProgress', () => {
  const row = definition.plugins.find((r) => r.name.includes('dsh-tool-todo'))
  assert(row !== undefined, 'tool-todo row is missing')
  assert(
    row.config?.allowParallelInProgress === true,
    `allowParallelInProgress = ${JSON.stringify(row.config?.allowParallelInProgress)} (required, no default)`
  )
})
check('dropping the companion does not drop the required config with it', () => {
  for (const name of ['dsh-tool-fs-search', 'dsh-tool-todo']) {
    const row = gated.plugins.find((r) => r.name.includes(name))
    assert(row !== undefined, `${name} is not mounted without the companion`)
    assert(
      typeof row.config === 'object' && row.config !== null && Object.keys(row.config).length > 0,
      `${name} lost its required config without the companion`
    )
  }
})
check('the runtime harness is shipped so this class of defect stays catchable', () => {
  const files = PKG.files ?? []
  assert(files.includes('verify-runtime'), 'verify-runtime is not in the files whitelist')
})

// ── packaging ─────────────────────────────────────────────────────────────────
console.log('')
console.log('packaging')
const files = PKG.files ?? []
check('the spec asset is covered by the files whitelist', () => {
  assert(
    files.includes('assets') || files.some((entry) => entry.startsWith('assets/')),
    'assets is not in package.json files — the installed package would be missing the spec'
  )
})
check('the plugin entry is covered by the files whitelist', () => {
  assert(files.includes('index.js'), 'index.js is not in files')
})
check('the patch file is covered by the files whitelist', () => {
  assert(files.includes('cordis.patch.yml'), 'cordis.patch.yml is not in files')
})
check('the manifest declares the patch and the entry', () => {
  assert(PKG.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch is wrong')
  assert(PKG.exports?.['.'] === './index.js', 'exports["."] is wrong')
})
check('the bundle has no runtime dependencies', () => {
  const deps = { ...(PKG.dependencies ?? {}), ...(PKG.peerDependencies ?? {}) }
  assert(Object.keys(deps).length === 0, `unexpected dependencies: ${Object.keys(deps).join(', ')}`)
})

warnIf('spec line endings are LF (Windows checkouts are fine either way)', () => {
  assert(!rawSpec.includes('\r\n'), 'spec uses CRLF; .gitattributes should normalise this to LF')
})

// ── result ────────────────────────────────────────────────────────────────────
console.log('')
if (warnings.length > 0) {
  console.log(`${warnings.length} warning(s):`)
  for (const line of warnings) console.log(`  - ${line}`)
  console.log('')
}
if (failures.length === 0) {
  console.log(`ALL CHECKS PASSED (spec ${rawSpec.length} chars, ${definition.plugins.length} plugin rows, spec path ${fileURLToPath(SPEC_URL)})`)
} else {
  console.log(`${failures.length} CHECK(S) FAILED:`)
  for (const line of failures) console.log(`  - ${line}`)
}
process.exitCode = failures.length === 0 ? 0 : 1
