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
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

/**
 * Every row, group rows expanded into their children.
 *
 * A `cordis:group` row is itself a row, but the plugins that actually mount are
 * in its `config` array. Assertions about "what is mounted" must read this
 * flattened view; assertions about the definition's own shape read
 * `definition.plugins` directly.
 *
 * @param {object[]} rows - a row list, possibly containing groups.
 * @returns {object[]} the leaf rows.
 */
const flattenRows = (rows) =>
  rows.flatMap((row) => (row.group === true && Array.isArray(row.config) ? flattenRows(row.config) : [row]))

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
check('spec tells the model when to delegate, since the tool rows cannot', () => {
  // `tool-subagent` and `tool-workflow` register their own prompt sections, and
  // this preset's persona is `complete: true` — assembly keeps only that one
  // section, so their guidance never reaches the model. §16.10 is the only
  // thing that tells it the tools exist and what they cost.
  for (const needle of ['### 16.10', 'subagent', 'workflow', '正在改的那一个文件必须自己读']) {
    assert(rawSpec.includes(needle), `§16.10 no longer mentions "${needle}"`)
  }
})
check('spec makes the project index the default way in (§十七)', () => {
  // The `project_index` tool description states the contract of the tool; §十七
  // states the contract of the *session* — query first, do not read sources
  // unless the user asked for a source change. Both are needed: the tool
  // description is only read when the model is already considering the tool.
  for (const needle of [
    '## 十七、项目索引优先（本预设的默认工作方式）',
    '.dsh/index/project_index.json',
    'project_meta',
    'directory_index',
    'content_logic_index',
    'logic_details',
    '除非用户明确要求改源码，否则绝不全量读取源码文件',
    '已触发后台索引构建，当前我先基于原生检索为您解答',
    'action=verify',
    'sha256'
  ]) {
    assert(rawSpec.includes(needle), `§十七 no longer mentions "${needle}"`)
  }
  // Trust is decided by content hash, never by the age of the index. A lease
  // cannot distinguish a fresh entry from a stale one — an index built one
  // second ago can still describe an older file. Pinning the wording here keeps
  // the spec from drifting back to "built within 30 minutes means trustworthy".
  assert(
    rawSpec.includes('### 17.2 可信度看 hash，不看时间'),
    '§十七 lost the section that makes hash the trust criterion'
  )
  assert(
    rawSpec.includes('hash 一致') && rawSpec.includes('hash 不一致'),
    '§十七 no longer states what hash agreement and disagreement mean'
  )
  assert(
    !/`last_updated` 在 30 分钟内/.test(rawSpec),
    '§十七 has drifted back to a time-based freshness rule'
  )
})

// ── the definition handed to agentPresets.register() ──────────────────────────
const { buildDefinition, companionAvailable, name: pluginName, inject } = await import('./index.js')

// The persona row is this bundle's own module; importing it here is what lets
// the prompt body be asserted without standing up a DSH host. It has no harness
// dependency on purpose, so this import stays valid on a bare checkout.
const { readSpecBody } = await import('./persona-hot.js')

/** The row name `index.js` must use for the persona. */
const PERSONA_ROW = 'dsh-wip-codegen-agent/persona-hot'

/** The row name `index.js` must use for the project index. */
const PROJECT_INDEX_ROW = 'dsh-wip-codegen-agent/project-index'

/** The body the persona row serves right now. */
const personaBody = readSpecBody((message) => warnings.push(message))

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
    if (row.group === true) {
      assert(Array.isArray(row.config), `group ${row.id} has no config array — its children would never mount`)
    }
  }
})
check('every row names a first-party package, the companion, a group, or one of this bundle own rows', () => {
  const ownRows = new Set([PERSONA_ROW, PROJECT_INDEX_ROW])
  for (const row of flattenRows(definition.plugins)) {
    const firstParty = row.name.startsWith('@deepseek-ai/dsh-')
    assert(
      firstParty || row.name === 'dsh-api-test-bundle' || ownRows.has(row.name),
      `row ${row.id} names "${row.name}", which is neither first-party, the companion, nor one of ${[...ownRows].join(' / ')}`
    )
  }
})
check('row ids are unique across groups', () => {
  const ids = flattenRows(definition.plugins).map((row) => row.id)
  assert(new Set(ids).size === ids.length, `duplicate ids in ${ids.join(', ')}`)
})
check('exactly one persona row exists', () => {
  const personaRows = definition.plugins.filter((row) => row.name === PERSONA_ROW)
  assert(personaRows.length === 1, `found ${personaRows.length} persona rows named ${PERSONA_ROW}`)
})

// ── the persona carries the whole spec ────────────────────────────────────────
const persona = definition.plugins.find((row) => row.name === PERSONA_ROW)

console.log('')
console.log('persona (the system prompt)')
check('persona is this bundle own hot-reloading row', () => {
  assert(persona !== undefined, `no row named ${PERSONA_ROW}`)
  assert(persona.disabled !== true, 'the persona row is disabled, so the spec would never load')
})
check('persona does NOT use @deepseek-ai/dsh-persona (its body would freeze at mount)', () => {
  // `dsh-persona` takes the body as a row-config string and preset configs are
  // structuredClone'd at mount, so editing the asset would change nothing until
  // a reinstall. The shipped row exists to remove exactly that.
  assert(
    !definition.plugins.some((row) => row.name === '@deepseek-ai/dsh-persona'),
    'the static persona row is back — the spec would no longer hot-reload'
  )
})
check('persona row carries the served character count as a diagnostic', () => {
  const count = persona.config?.specCharacters
  assert(Number.isInteger(count) && count > 5000, `specCharacters = ${JSON.stringify(count)}`)
})
check('persona row config holds no prompt body (it must re-read the file)', () => {
  const serialized = JSON.stringify(persona.config ?? {})
  assert(
    !serialized.includes('WIP/HRP'),
    'a prompt body was frozen into the row config — structuredClone would pin it to mount time'
  )
})
check('the persona module registers the deployment persona section', () => {
  const source = readFileSync(new URL('./persona-hot.js', import.meta.url), 'utf8')
  assert(source.includes("'deployment:persona-prefix'"), 'the section name drifted; the row would not shadow the deployment persona')
  assert(source.includes('getSectionOrder('), 'the section order is not read from the registry')
})
check('the persona module keeps complete:true and a function body', () => {
  // Both halves are load-bearing: `complete: true` makes the spec the whole
  // system prompt, and a *function* `text` is the only thing the registry
  // re-resolves per assembly. A plain string here silently re-freezes the spec.
  const source = readFileSync(new URL('./persona-hot.js', import.meta.url), 'utf8')
  assert(/complete:\s*true/.test(source), 'complete: true is gone — profile sections would dilute the spec')
  assert(/text:\s*\(\s*\)\s*=>/.test(source), 'the section text is not a function — the spec would freeze at activation')
})
check('persona body starts with the spec verbatim', () => {
  const expected = rawSpec.replace(/^\uFEFF/, '').trim()
  assert(
    personaBody.startsWith(expected),
    'the prompt does not begin with the spec — the asset may have been mangled or replaced by a fallback'
  )
})
check('persona body is the spec plus only the trailing notes', () => {
  const expected = rawSpec.replace(/^\uFEFF/, '').trim()
  const extra = personaBody.slice(expected.length)
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
  const referenced = [...personaBody.matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/g)].map((m) => m[1])
  const unknown = [...new Set(referenced)].filter((variable) => !registered.has(variable))
  assert(
    unknown.length === 0,
    `unregistered prompt variable(s) ${unknown.join(', ')} — assembly throws before the first model request`
  )
})
check('no fallback body was served', () => {
  assert(!personaBody.includes('规范正文未能读取'), 'the asset failed to load during this check')
})

// ── the tool surface ──────────────────────────────────────────────────────────
console.log('')
console.log('tool surface')

const enabledNames = flattenRows(definition.plugins)
  .filter((row) => row.disabled !== true)
  .map((row) => row.name)
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
  assert(
    flattenRows(definition.plugins).length - flattenRows(gated.plugins).length === 2,
    'the gate should drop exactly two rows'
  )
})
check('with the companion absent the Agent still mounts its core rows', () => {
  const names = flattenRows(gated.plugins).map((r) => r.name)
  for (const needle of [PERSONA_ROW, 'dsh-tool-fs', 'dsh-tool-fs-search', 'dsh-tool-ask-user', 'dsh-tool-todo']) {
    assert(names.some((n) => n.includes(needle)), `core row ${needle} was dropped too`)
  }
  assert(names.includes(PROJECT_INDEX_ROW), `the project-index row was dropped without the companion`)
  const shells = names.filter((n) => n.includes('tool-pwsh') || n.includes('tool-bash'))
  assert(shells.length === 1, `expected exactly 1 shell row without the companion, got ${shells.length}`)
  assert(
    flattenRows(gated.plugins).length === 14,
    `expected 14 rows without the companion, got ${flattenRows(gated.plugins).length}`
  )
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
  const specOf = (d) => d.plugins.find((r) => r.name === PERSONA_ROW).config.specCharacters
  assert(specOf(withRows) === specOf(without), 'the spec text changed with the companion gate')
})
check('the delegation group is mounted and isolates workflowEngine', () => {
  // `workflow-ptc` publishes `workflowEngine`. A provider mounted without an
  // `isolate` realm publishes into the ROOT realm, and the preset registry
  // rejects that mount with "Preset services require isolate realms" — the
  // whole preset goes broken, not just the row. The group is what carries it.
  const group = definition.plugins.find((row) => row.group === true && row.id === 'delegation')
  assert(group !== undefined, 'the delegation group is not mounted')
  assert(group.disabled !== true, 'the delegation group is disabled')
  assert(group.isolate?.workflowEngine === true, 'the delegation group does not isolate workflowEngine')
})
check('the delegation tools are present, so one turn can fan out file reads', () => {
  const names = flattenRows(definition.plugins).map((row) => row.name)
  for (const needle of [
    'dsh-tool-subagent',
    'dsh-tool-subagent-control',
    'dsh-workflow-ptc',
    'dsh-tool-workflow'
  ]) {
    assert(names.some((n) => n.includes(needle)), `missing ${needle}`)
  }
})
check('subagents inherit this preset instead of defaulting to another one', () => {
  // A child on a different preset would not carry the spec, so its summaries
  // would be written against a different ruleset than the parent's.
  const rows = flattenRows(definition.plugins).filter((row) => row.name === '@deepseek-ai/dsh-tool-subagent')
  assert(rows.length === 2, `expected a spawn and a fork row, found ${rows.length}`)
  for (const row of rows) {
    assert(!('agentPreset' in (row.config ?? {})), `row ${row.id} pins agentPreset — children would lose the spec`)
  }
})
check('the delegation providers stay in the host plane', () => {
  // `subagents` / `ptc-runtime` are process singletons the host already owns.
  // A second copy in the preset would fight the first.
  for (const needle of ['dsh-subagent-spawn-in-process', 'dsh-ptc-runtime']) {
    assert(
      !flattenRows(definition.plugins).some((row) => row.name.includes(needle)),
      `${needle} is mounted again — the host plane already provides it`
    )
  }
})
check('plan-mode is NOT mounted', () => {
  // It registers a prompt section and an `exit_plan_mode` tool and enforces
  // nothing else. This preset's persona is `complete: true`, so every other
  // section is dropped at assembly: the guidance would vanish and the row would
  // be a `/plan` switch that changes no behaviour.
  assert(
    !flattenRows(definition.plugins).some((row) => row.name.includes('dsh-plan-mode')),
    'plan-mode is mounted — its section cannot survive the complete persona'
  )
})
check('agent-instructions is mounted with its required maxBytes', () => {
  const row = flattenRows(definition.plugins).find((r) => r.name === '@deepseek-ai/dsh-agent-instructions')
  assert(row !== undefined, 'agent-instructions is missing — AGENTS.md would never reach the model')
  assert(
    Number.isInteger(row.config?.maxBytes) && row.config.maxBytes > 0,
    `maxBytes = ${JSON.stringify(row.config?.maxBytes)} (required, no default)`
  )
})
check('no memory or plugin-manager rows are mounted', () => {
  for (const needle of ['meow-memory', 'plugin-manager']) {
    assert(!flattenRows(definition.plugins).some((row) => row.name.includes(needle)), `${needle} is mounted`)
  }
})

// ── the project index ────────────────────────────────────────────────────────
//
// The engine is pure functions over strings, so it can be asserted without a
// host, a filesystem, or a model. That is deliberate: the listener's whole value
// is that it is deterministic, and a deterministic thing is worth testing.
console.log('')
console.log('project index')

const indexRow = definition.plugins.find((row) => row.name === PROJECT_INDEX_ROW)

check('the project-index row is mounted and enabled', () => {
  assert(indexRow !== undefined, `no row named ${PROJECT_INDEX_ROW}`)
  assert(indexRow.disabled !== true, 'the project-index row is disabled, so the index would never build')
  assert(indexRow.id === 'project-index', `row id is "${indexRow.id}"`)
})
check('the project-index row carries no config (the root comes from the working directory)', () => {
  // A path in the row config would be structuredClone'd at mount and keep
  // pointing at whatever project was open then. The row resolves the root from
  // the working-directory service on every build instead.
  assert(indexRow.config === undefined, `unexpected config ${JSON.stringify(indexRow.config)}`)
})
check('the project-index row sits right after agent-instructions', () => {
  const ids = definition.plugins.map((row) => row.id)
  const at = ids.indexOf('project-index')
  assert(at > 0, 'the project-index row is not in the top-level list')
  assert(ids[at - 1] === 'agent-instructions', `row order is ${ids.join(' → ')}`)
})

const indexModule = await import('./project-index.js')

check('the index module exports the pure engine pieces', () => {
  for (const name of [
    'parseJavaSource',
    'parseXmlMapper',
    'summarizeFile',
    'summarizeDirectory',
    'queryIndex',
    'readIndexEntry',
    'formatStatus',
    'formatQuery',
    'formatRead',
    'createProjectIndexTool',
    'shouldIgnorePath',
    'apply'
  ]) {
    assert(typeof indexModule[name] === 'function', `${name} is not exported`)
  }
})
check('the index module exports the index format constants', () => {
  assert(indexModule.INDEX_VERSION >= 1, `INDEX_VERSION = ${indexModule.INDEX_VERSION}`)
  assert(typeof indexModule.INDEX_RELATIVE_PATH === 'string', 'INDEX_RELATIVE_PATH is not a string')
  assert(
    indexModule.INDEX_RELATIVE_PATH.replace(/\\/g, '/') === '.dsh/index/project_index.json',
    `INDEX_RELATIVE_PATH = ${indexModule.INDEX_RELATIVE_PATH} — the spec fixes this path`
  )
  assert(
    indexModule.LEASE_MS === 30 * 60 * 1000,
    `LEASE_MS = ${indexModule.LEASE_MS} — the spec fixes a 30-minute listener lifetime`
  )
})
check('the index row declares tools as a required service, in array form', () => {
  // Both halves of this shipped broken once and only `verify-runtime` noticed.
  //
  // `inject` must be an ARRAY: cordis reads an object's keys as Service names, so
  // `{ required: [...], optional: [...] }` waits forever for services called
  // `required` and `optional` and leaves the row PENDING.
  //
  // `tools` must be REQUIRED: looked up lazily with `ctx.get('tools', false)` at
  // activation it is often not on the context yet, the registration silently
  // no-ops, and the only retry hung off `agent/pre-step` — so a preset that is
  // mounted but never runs a step ships a tool the model cannot see.
  assert(Array.isArray(indexModule.inject), `inject is ${JSON.stringify(indexModule.inject)}, not an array`)
  assert(
    indexModule.inject.includes('tools'),
    `inject = ${JSON.stringify(indexModule.inject)} — the project_index tool would never register`
  )
})

check('a Java class, its fields and its methods are extracted', () => {
  const entry = indexModule.parseJavaSource(
    [
      'package com.demo.controller;',
      '',
      '/**',
      ' * 考勤同步控制器。',
      ' */',
      '@RestController',
      '@RequestMapping("/attendance")',
      'public class AttendanceController extends BaseController implements InitializingBean {',
      '',
      '    /** 同步开关 */',
      '    private boolean syncEnabled = true;',
      '',
      '    /**',
      '     * 触发一次考勤同步。',
      '     */',
      '    @PostMapping("/sync")',
      '    public Result<List<AttendanceResp>> sync(AttendanceReq req, String operator) {',
      '        if (req.getBeginDate() == null) {',
      '            throw new IllegalArgumentException("开始日期不能为空");',
      '        }',
      '        return Result.ok(attendanceService.sync(req));',
      '    }',
      '}'
    ].join('\n'),
    'AttendanceController.java'
  )
  assert(entry.classes.length === 1, `expected 1 class, got ${entry.classes.length}`)
  const klass = entry.classes[0]
  assert(klass.name === 'AttendanceController', `class name is ${klass.name}`)
  assert(klass.extends === 'BaseController', `extends is "${klass.extends}"`)
  assert(klass.implements.includes('InitializingBean'), `implements is ${JSON.stringify(klass.implements)}`)
  assert(klass.annotations.includes('RestController'), `annotations are ${JSON.stringify(klass.annotations)}`)
  assert(klass.summary.includes('考勤同步控制器'), `class summary is "${klass.summary}"`)

  assert(entry.fields.some((field) => field.name === 'syncEnabled' && field.type === 'boolean'), 'field missing')
  assert(entry.fields.find((field) => field.name === 'syncEnabled').comment === '同步开关', 'field comment lost')

  const sync = entry.methods.find((method) => method.name === 'sync')
  assert(sync !== undefined, `methods are ${entry.methods.map((method) => method.name).join(', ')}`)
  assert(sync.return_type === 'Result<List<AttendanceResp>>', `return_type is "${sync.return_type}"`)
  assert(
    JSON.stringify(sync.parameters) === JSON.stringify(['AttendanceReq req', 'String operator']),
    `parameters are ${JSON.stringify(sync.parameters)}`
  )
  assert(sync.logic_summary.includes('触发一次考勤同步'), `logic_summary is "${sync.logic_summary}"`)
  assert(sync.key_dependencies.includes('attendanceService'), `dependencies are ${JSON.stringify(sync.key_dependencies)}`)

  const rule = entry.logic_details.find((detail) => detail.description.includes('开始日期不能为空'))
  assert(rule !== undefined, `logic_details are ${JSON.stringify(entry.logic_details)}`)
  assert(rule.rule_name.startsWith('sync'), `rule_name is "${rule.rule_name}"`)
})
check('a constructor is not mistaken for a method', () => {
  // The method regex captures modifiers separately from the return type, but a
  // constructor has no return type: with `\s` in the type group it parsed as a
  // method named `Foo` returning `public`, and a real method on the next line
  // was captured with a leading newline plus its modifier.
  const entry = indexModule.parseJavaSource(
    [
      'public class Foo {',
      '    public Foo(Bar bar) {',
      '        this.bar = bar;',
      '    }',
      '    public String name() {',
      '        return this.bar.name();',
      '    }',
      '}'
    ].join('\n'),
    'Foo.java'
  )
  assert(
    entry.methods.every((method) => method.name !== 'Foo'),
    `a constructor was recorded as a method: ${JSON.stringify(entry.methods)}`
  )
  assert(
    entry.methods.every((method) => !method.return_type.startsWith('\n')),
    `a return_type swallowed a newline: ${JSON.stringify(entry.methods.map((method) => method.return_type))}`
  )
  const name = entry.methods.find((method) => method.name === 'name')
  assert(name !== undefined, `methods are ${entry.methods.map((method) => method.name).join(', ')}`)
  assert(name.return_type === 'String', `name() return_type is "${name.return_type}"`)
})
check('a MyBatis mapper yields one logic rule per statement', () => {
  const entry = indexModule.parseXmlMapper(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">',
      '<mapper namespace="com.demo.mapper.AttendanceMapper">',
      '  <select id="selectPage" resultType="AttendanceResp">',
      '    SELECT * FROM WIP_ATTENDANCE WHERE DEL_FLAG = 0',
      '  </select>',
      '  <update id="updateStatus">',
      '    UPDATE WIP_ATTENDANCE SET STATUS = #{status} WHERE ID = #{id}',
      '  </update>',
      '</mapper>'
    ].join('\n'),
    'AttendanceMapper.xml'
  )
  assert(entry !== null, 'the mapper was not recognised')
  assert(entry.logic_details.length === 2, `expected 2 statements, got ${entry.logic_details.length}`)
  assert(
    entry.logic_details.some((detail) => detail.rule_name === 'select:selectPage'),
    `rule names are ${entry.logic_details.map((detail) => detail.rule_name).join(', ')}`
  )
  assert(entry.classes[0].summary.includes('com.demo.mapper.AttendanceMapper'), 'namespace lost')
})
check('a non-mapper XML is not indexed as logic', () => {
  const entry = indexModule.parseXmlMapper('<project><modelVersion>4.0.0</modelVersion></project>', 'pom.xml')
  assert(entry === null, 'a pom.xml was parsed as a mapper')
})
check('a file summary prefers the Javadoc and cleans the asterisks', () => {
  const summary = indexModule.summarizeFile(
    ['package com.demo;', '', '/**', ' * 考勤同步控制器。', ' * 负责把 SAP 的考勤数据拉进来。', ' */', 'public class A {}'].join('\n'),
    'A.java'
  )
  assert(!summary.includes('*'), `summary still carries comment furniture: "${summary}"`)
  assert(summary.includes('考勤同步控制器'), `summary is "${summary}"`)
})
check('an undocumented Java file is summarised by its declaration, not its package line', () => {
  const summary = indexModule.summarizeFile(
    ['package com.demo.service;', '', 'public interface AttendanceService {', '    void sync();', '}'].join('\n'),
    'AttendanceService.java'
  )
  assert(summary !== 'package com.demo.service;', 'summary fell through to the package declaration')
  assert(summary.includes('interface AttendanceService'), `summary is "${summary}"`)
})
check('the query finds a class, a method and a rule, and says what to do next', () => {
  const entry = indexModule.parseJavaSource(
    ['/** 考勤同步控制器。 */', 'public class AttendanceController {', '    public void sync(AttendanceReq req) {', '        if (req == null) { throw new IllegalArgumentException("x"); }', '    }', '}'].join('\n'),
    'src/AttendanceController.java'
  )
  const index = {
    project_meta: { project_name: 'demo', last_updated: new Date().toISOString(), file_count: 1, global_summary: '' },
    directory_index: [
      { path: 'src', type: 'directory', summary: 'src：1 个文件', children: [{ path: 'src/AttendanceController.java', type: 'file', language: 'Java', summary: '考勤同步控制器。' }] }
    ],
    content_logic_index: { 'src/AttendanceController.java': entry }
  }
  const hits = indexModule.queryIndex(index, 'attendance', 20)
  assert(hits.length > 0, 'no hits for a class that plainly exists')
  assert(hits.some((hit) => hit.kind === 'class'), `kinds are ${[...new Set(hits.map((hit) => hit.kind))].join(', ')}`)
  assert(hits.some((hit) => hit.kind === 'method'), 'the method was not indexed')
  const text = indexModule.formatQuery(hits, 'attendance')
  assert(text.includes('src/AttendanceController.java'), 'the hit text omits the file path')
  assert(text.includes('action=read'), 'the hit text does not point at action=read')
})
check('reading a symbol narrows the entry to that method', () => {
  const entry = indexModule.parseJavaSource(
    ['public class A {', '    public void alpha() {}', '    public void beta() {}', '}'].join('\n'),
    'A.java'
  )
  const index = {
    project_meta: {},
    directory_index: [{ path: '.', type: 'directory', summary: '', children: [{ path: 'A.java', type: 'file', language: 'Java', summary: '' }] }],
    content_logic_index: { 'A.java': entry }
  }
  const narrowed = indexModule.readIndexEntry(index, 'A.java', 'beta')
  assert(narrowed.logic.methods.length === 1, `expected 1 method, got ${narrowed.logic.methods.length}`)
  assert(narrowed.logic.methods[0].name === 'beta', `kept ${narrowed.logic.methods[0].name}`)
  const text = indexModule.formatRead(narrowed, 'A.java')
  assert(text.includes('beta'), 'the rendered entry omits the symbol')
  assert(!text.includes('alpha'), 'the rendered entry still lists the other method')
})
check('reading a path the index does not know says so instead of pretending', () => {
  const index = { project_meta: {}, directory_index: [], content_logic_index: {} }
  const text = indexModule.formatRead(indexModule.readIndexEntry(index, 'Nope.java'), 'Nope.java')
  assert(text.includes('索引里没有'), `text is "${text}"`)
  assert(text.includes('query'), 'the message does not point at action=query')
})
check('the tool definition is well-formed', () => {
  const tool = indexModule.createProjectIndexTool({ resolve: async () => ({ root: '.', service: {} }) })
  assert(tool.name === 'project_index', `tool name is "${tool.name}"`)
  assert(typeof tool.description === 'string' && tool.description.length > 100, 'tool description is too thin')
  assert(tool.parameters?.type === 'object', 'parameters is not an object schema')
  assert(Array.isArray(tool.parameters?.properties?.action?.enum), 'action has no enum')
  assert(tool.parameters.properties.action.enum.includes('query'), 'action is missing query')
  assert(tool.parameters.properties.action.enum.includes('verify'), 'action is missing verify')
  assert(typeof tool.output?.render === 'function', 'output.render is not a function')
  const rendered = tool.output.render({}, { text: 'hello' })
  assert(Array.isArray(rendered) && rendered[0].text === 'hello', 'render did not produce a text block')
})
check('the tool description carries the contract the model needs', () => {
  const tool = indexModule.createProjectIndexTool({ resolve: async () => ({ root: '.', service: {} }) })
  for (const needle of [
    '.dsh/index/project_index.json',
    'action=query',
    'action=read',
    'action=verify',
    'sha256'
  ]) {
    assert(tool.description.includes(needle), `tool description no longer mentions "${needle}"`)
  }
  // Trust is decided by content hash, not by how long ago the index was built.
  // A lease cannot tell a fresh entry from a stale one; a hash can.
  assert(
    tool.description.includes('hash 一致') && tool.description.includes('hash 不一致'),
    'the tool description no longer states the hash-consistency rule'
  )
  assert(
    !tool.description.includes('30 分钟内'),
    'the tool description has drifted back to a time-based freshness rule'
  )
})
check('every indexed file carries its sha256 in the index itself', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-hash-'))
  try {
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'Alpha.java'), 'public class Alpha {\n    int count;\n}\n', 'utf8')
    const built = await indexModule.buildProjectIndex({ root, now: Date.now() + 10_000 })
    const children = (built.index.directory_index ?? []).flatMap((entry) => entry.children ?? [])
    assert(children.length > 0, 'the index has no file children')
    for (const child of children) {
      assert(
        typeof child.hash === 'string' && /^[0-9a-f]{64}$/.test(child.hash),
        `"${child.path}" has no sha256 in directory_index (hash = ${JSON.stringify(child.hash)})`
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
check('verify reports agreement, disagreement and absence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-verify-'))
  try {
    mkdirSync(join(root, 'src'), { recursive: true })
    const file = join(root, 'src', 'Alpha.java')
    writeFileSync(file, 'public class Alpha {\n    int count;\n}\n', 'utf8')
    const built = await indexModule.buildProjectIndex({ root, now: Date.now() + 10_000 })
    const index = built.index

    const same = await indexModule.checkEntry(index, root, 'src/Alpha.java', (path) =>
      readFileSync(path, 'utf8')
    )
    assert(same !== null && same.same === true, 'an untouched file was not reported as matching')
    const sameText = indexModule.formatVerify(same, 'src/Alpha.java')
    assert(sameText.includes('未改动') && sameText.includes('sha256'), `same text is "${sameText}"`)

    writeFileSync(file, 'public class Alpha {\n    int count;\n    int extra;\n}\n', 'utf8')
    const changed = await indexModule.checkEntry(index, root, 'src/Alpha.java', (path) =>
      readFileSync(path, 'utf8')
    )
    assert(changed !== null && changed.same === false, 'an edited file was still reported as matching')
    const changedText = indexModule.formatVerify(changed, 'src/Alpha.java')
    assert(
      changedText.includes('已改动') && changedText.includes('索引记录') && changedText.includes('磁盘现状'),
      `changed text is "${changedText}"`
    )

    const missing = await indexModule.checkEntry(index, root, 'src/Nope.java', (path) =>
      readFileSync(path, 'utf8')
    )
    assert(missing === null, 'an unindexed path produced a comparison')
    const missingText = indexModule.formatVerify(missing, 'src/Nope.java')
    assert(missingText.includes('索引里没有'), `missing text is "${missingText}"`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
check('ignored paths cover the noise and keep the sources', () => {
  for (const [path, expected] of [
    ['node_modules/x.java', true],
    ['.git/config', true],
    ['target/classes/A.class', true],
    ['.dsh/index/project_index.json', true],
    ['src/main/java/A.java', false],
    ['.gitignore', false]
  ]) {
    assert(indexModule.shouldIgnorePath(path) === expected, `shouldIgnorePath("${path}") should be ${expected}`)
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
check('the persona row module is shipped and exported as a subpath', () => {
  assert(files.includes('persona-hot.js'), 'persona-hot.js is not in files — the preset row could not import')
  assert(
    PKG.exports?.['./persona-hot'] === './persona-hot.js',
    'exports["./persona-hot"] is missing — the row name would not resolve at mount'
  )
})
check('the persona row name matches the exported subpath', () => {
  assert(
    PERSONA_ROW === `${PKG.name}/persona-hot`,
    `row name ${PERSONA_ROW} does not match package name ${PKG.name}`
  )
})
check('the project-index row module is shipped and exported as a subpath', () => {
  assert(files.includes('project-index.js'), 'project-index.js is not in files — the preset row could not import')
  assert(
    PKG.exports?.['./project-index'] === './project-index.js',
    'exports["./project-index"] is missing — the row name would not resolve at mount'
  )
  assert(
    PROJECT_INDEX_ROW === `${PKG.name}/project-index`,
    `row name ${PROJECT_INDEX_ROW} does not match package name ${PKG.name}`
  )
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
  console.log(`ALL CHECKS PASSED (spec ${rawSpec.length} chars, ${flattenRows(definition.plugins).length} plugin rows in ${definition.plugins.length} top-level entries, spec path ${fileURLToPath(SPEC_URL)})`)
} else {
  console.log(`${failures.length} CHECK(S) FAILED:`)
  for (const line of failures) console.log(`  - ${line}`)
}
process.exitCode = failures.length === 0 ? 0 : 1
