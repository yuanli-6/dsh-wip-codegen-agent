/**
 * Runtime probe for the `wip-codegen` preset.
 *
 * Everything else in this repo checks the bundle *offline* — that the definition
 * is well-formed, that the lifecycle disposes, that the spec text is intact.
 * None of that proves what the harness actually mounted: whether every row
 * resolved and reached ACTIVE, whether the companion's skill really landed in
 * *this preset's* skill layer, or whether the spec text the persona carries is
 * the file on disk.
 *
 * So this probe mounts inside a real DSH profile (see `run.mjs`), reads the live
 * composition and the preset-scoped skill catalog through the same services the
 * Agent uses, prints one JSON block, and exits. It never calls a model, so it
 * costs nothing and needs no credentials.
 *
 * It deliberately reads instead of asserts: `run.mjs` owns the verdict, so the
 * probe stays a pure observation and the checks can evolve without editing it.
 *
 * @module dsh-wip-codegen-agent/verify-runtime/probe
 */

/** Cordis plugin name of the probe row. */
export const name = 'wip-codegen-verify-probe'

/** The registry is the only service the probe needs; `skills` is read optionally. */
export const inject = ['agentPresets']

/** Markers the runner looks for in stdout. */
const START = '<<<WIP-CODEGEN-PROBE>>>'
const END = '<<<END-WIP-CODEGEN-PROBE>>>'

/** Fiber states, by the numeric values of the harness's `FiberState` enum. */
const FIBER_STATES = ['PENDING', 'LOADING', 'ACTIVE', 'FAILED', 'DISPOSED', 'UNLOADING']

/**
 * Sleep for a bounded interval.
 *
 * @param {number} ms - milliseconds to wait.
 * @returns {Promise<void>} resolves after the delay.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Read everything the runner wants to assert on.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - probe context.
 * @returns {Promise<object>} the observation, JSON-serializable.
 */
async function observe(ctx) {
  const observation = { at: new Date().toISOString(), presetId: 'wip-codegen' }

  // Rows mount asynchronously and a row may legitimately be waiting on a host
  // service, so poll until this preset settles or the budget runs out.
  let composition
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const inventory = await ctx.agentPresets.compositionInventory()
    observation.inventoryIds = inventory.map((preset) => preset.id)
    composition = inventory.find((preset) => preset.id === observation.presetId)
    if (composition !== undefined) {
      const settled = composition.rows.every((row) => row.enabled === false || row.fiberState === 2 || row.fiberState === 3)
      if (settled) break
    }
    await sleep(500)
  }

  if (composition === undefined) {
    observation.composition = null
    return observation
  }

  // Before anything else: would a model request get past prompt assembly?
  observation.assembly = await observeAssembly(ctx, observation.presetId)

  observation.composition = {
    id: composition.id,
    name: composition.name,
    isDefault: composition.isDefault,
    broken: composition.broken ?? null,
    rows: composition.rows.map((row) => ({
      entryId: row.entryId,
      moduleName: row.moduleName,
      enabled: row.enabled,
      condition: row.condition ?? null,
      fiberState: row.fiberState ?? null,
      fiberStateName: typeof row.fiberState === 'number' ? (FIBER_STATES[row.fiberState] ?? String(row.fiberState)) : null
    }))
  }

  try {
    const document = await ctx.agentPresets.readDocument(observation.presetId)
    observation.document = { name: document.name ?? null, description: document.description ?? null, content: document.content }
  } catch (error) {
    observation.document = { error: String(error?.message ?? error) }
  }

  const skills = ctx.get('skills')
  if (skills === undefined) {
    observation.skills = { error: 'ctx.skills is not available in this profile' }
    return observation
  }

  let lease
  try {
    lease = await ctx.agentPresets.acquireScope(observation.presetId)
    const snapshot = await skills.snapshot({ scope: lease.key })
    observation.skills = {
      complete: snapshot.complete,
      names: snapshot.skills.map((skill) => skill.name),
      summaries: snapshot.skills.map((skill) => ({
        name: skill.name,
        source: skill.source,
        provider: skill.provider,
        modelInvocable: skill.invocation?.modelInvocable ?? null,
        userInvocable: skill.invocation?.userInvocable ?? null,
        descriptionLength: typeof skill.description === 'string' ? skill.description.length : null
      }))
    }
    const loaded = await skills.get('api-test', { scope: lease.key })
    observation.skills.apiTest = loaded === undefined
      ? null
      : {
          contentLength: loaded.content.length,
          resourceBase: loaded.resourceBase ?? null,
          hasTestCaseRules: loaded.content.includes('测试用例交付'),
          hasFieldSourceRules: loaded.content.includes('接口返回字段来源关系图'),
          hasNormalRangePolicy: loaded.content.includes('参数取值口径'),
          hasContractCoveredTable: loaded.content.includes('契约校验已覆盖'),
          mentionsXlsxScript: loaded.content.includes('cases2xlsx.mjs')
        }
  } catch (error) {
    observation.skills = { error: String(error?.stack ?? error) }
  } finally {
    try {
      await lease?.[Symbol.asyncDispose]?.()
    } catch {
      // A disposable lease that refuses to release must not hide the result.
    }
  }

  // The persona carries the spec; compare what the registry would render with
  // the asset the package ships, so a stale copy cannot go unnoticed.
  try {
    const own = await import('dsh-wip-codegen-agent')
    const definition = own.buildDefinition()
    // Read the body the way the live row does — from the file, not from row
    // config. The persona row deliberately carries no prompt text (that is what
    // makes it hot-reloadable), so `config.prefix` no longer exists to read.
    const body = own.specBody()
    observation.bundle = {
      rowCount: definition.plugins.length,
      rows: definition.plugins.map((row) => row.name),
      specChars: body.length,
      specHasSqlSection: body.includes('十三、SQL Server 建表脚本生成规范'),
      specHasConfirmation: body.includes('十四、强制交互流程'),
      specHasGlobalRules: body.includes('十五、全局规则（用户追加）'),
      specPathInjected: body.includes('system-prompt.md')
    }
  } catch (error) {
    observation.bundle = { error: String(error?.message ?? error) }
  }

  return observation
}

/**
 * Run the preset's prompt assembly and check what `renderPrompt()` would reject.
 *
 * This is the step the other observations miss. A preset can be mounted, every
 * row ACTIVE, and still be unusable: `renderPrompt()` interpolates `{{name}}`
 * strictly, so a section that references a variable the loop never registered
 * throws on *every* model request — "unknown prompt variable ... in section
 * deployment:persona-prefix" — while nothing about the composition looks wrong.
 * v2.0.0 shipped exactly that and nobody noticed until a session was started.
 *
 * The renderer itself lives in `@deepseek-ai/dsh-system-prompt`, which a profile
 * plugin cannot import by bare name, so the rule is re-applied here: every
 * `{{name}}` in an interpolating section must be a registered variable, and its
 * value must not be `undefined`.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - probe context.
 * @param {string} presetId - preset to assemble.
 * @returns {Promise<object>} the assembly observation, JSON-serializable.
 */
async function observeAssembly(ctx, presetId) {
  const prompt = ctx.get('systemPrompt')
  if (prompt === undefined) return { error: 'ctx.systemPrompt is not available in this profile' }

  let lease
  try {
    lease = await ctx.agentPresets.acquireScope(presetId)
    const assembly = await prompt.assemble({ scope: lease.key })
    const persona = assembly.sections.find((section) => section.name === 'deployment:persona-prefix')

    const unknowns = []
    const valueless = []
    for (const section of assembly.sections) {
      if (section.interpolate === false) continue
      for (const match of section.text.matchAll(/\{\{([^{}]*)\}\}/g)) {
        const variable = match[1]
        if (!Object.hasOwn(assembly.variables, variable)) unknowns.push(`${section.name}:{{${variable}}}`)
        else if (assembly.variables[variable] === undefined) valueless.push(`${section.name}:{{${variable}}}`)
      }
    }

    return {
      ok: unknowns.length === 0 && valueless.length === 0,
      sectionNames: assembly.sections.map((section) => section.name),
      variableNames: Object.keys(assembly.variables),
      personaChars: typeof persona?.text === 'string' ? persona.text.length : null,
      personaInterpolates: persona === undefined ? null : persona.interpolate !== false,
      unknownVariables: unknowns,
      valuelessVariables: valueless
    }
  } catch (error) {
    return { ok: false, assemblyError: String(error?.message ?? error) }
  } finally {
    try {
      await lease?.[Symbol.asyncDispose]?.()
    } catch {
      // A lease that refuses to release must not hide the result.
    }
  }
}

/**
 * Mount the probe: observe, print, exit.
 *
 * `apply` stays synchronous (the host treats a returned promise as plugin
 * teardown), so the work runs in a detached async function that terminates the
 * process itself — a probe that lingers would hold the profile open.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - probe context.
 * @returns {void}
 */
export function apply(ctx) {
  void (async () => {
    let payload
    try {
      payload = await observe(ctx)
    } catch (error) {
      payload = { fatal: String(error?.stack ?? error) }
    }
    process.stdout.write(`\n${START}\n${JSON.stringify(payload, null, 1)}\n${END}\n`)
    process.exit(0)
  })()
}
