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
    const persona = definition.plugins.find((row) => row.name.includes('dsh-persona'))
    observation.bundle = {
      rowCount: definition.plugins.length,
      rows: definition.plugins.map((row) => row.name),
      specChars: persona.config.prefix.length,
      specHasSqlSection: persona.config.prefix.includes('十三、SQL Server 建表脚本生成规范'),
      specHasConfirmation: persona.config.prefix.includes('十四、强制交互流程'),
      specHasGlobalRules: persona.config.prefix.includes('十五、全局规则（用户追加）'),
      specPathInjected: persona.config.prefix.includes('system-prompt.md')
    }
  } catch (error) {
    observation.bundle = { error: String(error?.message ?? error) }
  }

  return observation
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
