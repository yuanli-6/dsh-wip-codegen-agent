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

// ── the definition handed to agentPresets.register() ──────────────────────────
const { buildDefinition, name: pluginName, inject } = await import('./index.js')

const definition = buildDefinition((message) => warnings.push(message))

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
check('every row names a first-party harness package', () => {
  for (const row of definition.plugins) {
    assert(row.name.startsWith('@deepseek-ai/dsh-'), `row ${row.id} names "${row.name}"`)
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
check('persona prefix is the spec plus only the cwd note', () => {
  const expected = rawSpec.replace(/^\uFEFF/, '').trim()
  const extra = persona.config.prefix.slice(expected.length)
  assert(extra.includes('{{cwd}}'), 'the working-directory note is missing, so the agent cannot find a path to write to')
  assert(extra.length < 200, `unexpected extra prose after the spec (${extra.length} chars)`)
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
check('tool-skill is NOT mounted (keeps the skill catalog out of context)', () => {
  assert(!definition.plugins.some((row) => row.name.includes('dsh-tool-skill')), 'tool-skill is mounted')
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
