/**
 * `wip-codegen` Agent bundle — declares one DSH Agent preset.
 *
 * What "an Agent" is in DSH: a *preset* composes the plugins a session runs,
 * and those plugins own the model-visible prompt and tools. So this bundle
 * does exactly one thing — it calls `agentPresets.register()` with a preset
 * definition whose rows are already-public harness packages, plus one optional
 * companion bundle (the API-testing plugin). There is no new tool, no client
 * half, and no dependency: installing the bundle makes the Agent appear,
 * disabling the row makes it disappear.
 *
 * Why the spec rides on `dsh-persona` with `complete: true`: that is the
 * first-party way to say "this text is the whole system prompt". Without it
 * every profile-level plugin (memory guide, team policy, plan policy, tool
 * guidance) would also inject its own section, diluting a spec that is
 * deliberately prescriptive. With it, assembly still resolves the variables
 * the loop registers (`provider`, `model`) and still ships tool *schemas*, so
 * the tools remain callable. It does NOT make arbitrary `{{…}}` names valid:
 * an unregistered reference throws during assembly, before any model request.
 *
 * That is why the working directory is never restated here. It already reaches
 * the model as *required* runtime context ("Current working directory: …"),
 * which survives `complete: true`; restating it as `{{cwd}}` took the whole
 * preset down with `unknown prompt variable "{{cwd}}"`.
 *
 * The prompt body is read from `assets/wip-codegen/system-prompt.md` at
 * activation, so that file stays the editable source of truth. Because the
 * definition is handed to the registry as a plain JS object (not YAML text),
 * the body cannot be mangled by any serializer on the way in. The same file is
 * the spec's §十五 global-rules store, so its absolute path is injected into
 * the prompt: the Agent must be able to find the file it appends rules to.
 *
 * The API-testing companion is mounted *gated on resolvability*. A preset row
 * that cannot import its module fails the activation audit, and a failed audit
 * rejects the whole preset mount — so an unguarded row would turn "the testing
 * plugin is not installed" into "the code-generation Agent disappeared". The
 * gate turns it into one warning and an Agent that still works.
 *
 * @module dsh-wip-codegen-agent
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

/** Cordis plugin name; also the patch row id. */
export const name = 'wip-codegen-agent'

/** The only Service this plugin needs. */
export const inject = ['agentPresets']

/** Preset identity. Sessions store this id, so it must stay stable. */
const PRESET_ID = 'wip-codegen'

/** Display metadata for the preset picker. */
const PRESET_NAME = 'WIP/HRP 代码生成'
const PRESET_DESCRIPTION =
  '在制品管理（wip）与人事管理（hrp）的代码生成 Agent：按团队规范生成 SQL Server 建表脚本与 Spring Boot 3 + MyBatis-Plus 代码（SQL 字段确认、逐类确认、复制现有 Controller 风格、删除先确认），并内置接口测试与字段来源关系图技能。'

/** Sorts the picker after the four shipped presets (standard=1 … cordis=4). */
const PRESET_ORDER = 5

/** The spec body. Kept next to this module so packaging is obvious. */
const SPEC_FILE_URL = new URL('./assets/wip-codegen/system-prompt.md', import.meta.url)

/** Companion bundle: the API-testing skill plugin, mounted alongside when present. */
const COMPANION_PACKAGE = 'dsh-api-test-bundle'

/**
 * The persona row this bundle ships itself.
 *
 * Not `@deepseek-ai/dsh-persona`: that row takes the body as a config string,
 * and preset configs are cloned at mount, so the spec would freeze at
 * activation. `./persona-hot.js` owns the same section name with a function
 * body instead, which is what lets the file be re-read without a reinstall.
 * A subpath rather than a file URL so the row resolves through the same
 * `exports` map the host loader uses.
 */
const PERSONA_HOT_PACKAGE = 'dsh-wip-codegen-agent/persona-hot'

/**
 * Name of the row that renders the skill catalog and the `skill` tool.
 *
 * The testing companion only *registers* a skill; without this consumer nothing
 * puts a catalog in front of the model and nothing can load the body, so the
 * companion is useless on its own. Both rows therefore travel together.
 */
const SKILL_TOOL_PACKAGE = '@deepseek-ai/dsh-tool-skill'

/** Cap for each catalog description; the companion's description is long and this is a one-skill catalog. */
const CATALOG_DESCRIPTION_MAX_LENGTH = 400

/** Cordis' built-in row type: mounts its own `config` array as a nested group. */
const GROUP_PACKAGE = 'cordis:group'

/**
 * Byte cap for the instruction files the `agent-instructions` row reads.
 *
 * Required with no fallback, so omitting it fails the activation audit — and a
 * failed audit rejects the whole preset, not just this row. The value matches
 * the shipped `standard` preset.
 */
const AGENTS_MAX_BYTES = 65536

/**
 * Appended to the spec as its own trailing block.
 *
 * The spec itself never says where the project lives. Nothing is added for
 * that on purpose: the harness working-directory service supplies the
 * required "Current working directory: …" context on every step, including
 * under `complete: true`, so a template variable would be both redundant and
 * fatal — the loop registers only `provider` and `model`, and strict
 * interpolation throws on anything else.
 *
 * The spec path is the remaining fact the agent cannot derive: §14.6 tells it
 * to append user-declared global rules to §十五 of *this* file, and the file
 * lives in the installed package, whose location the agent cannot guess.
 */
function trailingNotes() {
  return [
    '---',
    '',
    `规范正文路径（§十五 全局规则追加到该文件）：${fileURLToPath(SPEC_FILE_URL)}`
  ].join('\n')
}

/**
 * Absolute path of the spec asset.
 *
 * Resolved from this module's own URL, so it names the file the running install
 * actually serves. `persona-hot` watches exactly this path — deriving it from
 * config instead would let a checkout elsewhere be watched by accident.
 *
 * @returns {string} the spec's absolute path.
 */
export function specPath() {
  return fileURLToPath(SPEC_FILE_URL)
}

/**
 * The complete prompt body: the spec plus its trailing notes.
 *
 * This is the single composition point. Both the hot-reloading persona row and
 * `verify.mjs` call it, so what the tests assert and what the model receives
 * cannot drift apart.
 *
 * @param {(message: string) => void} [warn] - sink for non-fatal diagnostics.
 * @returns {string} the body served as the system prompt.
 */
export function specBody(warn) {
  return `${readSpec(warn)}\n\n${trailingNotes()}\n`
}

/**
 * Whether the companion API-test bundle resolves from this install.
 *
 * Resolution is attempted the way Node will attempt it for the preset row —
 * from this module's own directory, so a sibling install in the same profile is
 * found. Any failure (not installed, broken link, half-finished install) means
 * "mount without the companion".
 *
 * @returns {boolean} true when the companion package can be resolved.
 */
export function companionAvailable() {
  try {
    createRequire(import.meta.url).resolve(COMPANION_PACKAGE)
    return true
  } catch {
    return false
  }
}

/**
 * Body served when the spec asset cannot be read.
 *
 * Registration must not fail just because packaging went wrong: a preset that
 * exists and explains its own damage is far easier to diagnose than a missing
 * one. Mirrors the fallback style of the other DSH skill bundles.
 *
 * @param {string} reason - why the asset could not be used.
 * @returns {string} a short diagnostic prompt.
 */
function fallbackSpec(reason) {
  return [
    '# WIP/HRP 代码生成 Agent',
    '',
    `> 本 Agent 的规范正文未能读取（${SPEC_FILE_URL.pathname}）。`,
    `> 原因：${reason}`,
    '> 请检查 dsh-wip-codegen-agent 安装是否完整（assets/ 必须随包一起安装），然后重新加载插件。',
    '',
    '在正文恢复之前：请向用户索要团队规范，不要凭空编造包路径、类名或接口约定。'
  ].join('\n')
}

/**
 * Read the spec body from disk.
 *
 * No frontmatter handling is needed here (unlike the skill bundles): this file
 * is a prompt, not a skill, so the whole file is the body. A leading BOM and a
 * trailing newline are stripped so the text handed to the renderer is exactly
 * what a reviewer sees in the asset.
 *
 * @param {(message: string) => void} [warn] - sink for non-fatal diagnostics.
 * @returns {string} the spec body.
 */
function readSpec(warn) {
  let raw
  try {
    raw = readFileSync(SPEC_FILE_URL, 'utf8')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    warn?.(`wip-codegen: cannot read ${SPEC_FILE_URL.pathname} (${reason}); serving fallback prompt`)
    return fallbackSpec(reason)
  }

  const body = raw.replace(/^\uFEFF/, '').trim()
  if (body.length === 0) {
    warn?.(`wip-codegen: ${SPEC_FILE_URL.pathname} is empty; serving fallback prompt`)
    return fallbackSpec('文件为空')
  }
  return body
}

/**
 * Build the preset definition handed to the registry.
 *
 * The row list is intentionally small. The persona carries the spec; a shell,
 * file access, search, and the two interaction tools do the work.
 *
 * Three additions since v2.3.0, each for a concrete cost it removes:
 *
 * - `agent-instructions` reads `AGENTS.md` into a *user* message, so it is the
 *   only way to make repository conventions stick without retyping them per
 *   session. User messages survive `complete: true`; prompt sections do not.
 * - `delegation` (subagent + workflow) lets one assistant turn fan out N file
 *   reads into N child contexts and return only the summaries. Reading them in
 *   the parent is what makes a multi-file change cost one full re-read per
 *   file.
 * - Still absent, deliberately: `plan-mode`. It enforces nothing on its own —
 *   it registers a prompt section and an `exit_plan_mode` tool, and this
 *   preset's `complete: true` persona is the only section assembly keeps, so
 *   the guidance would be dropped and the row would be a `/plan` switch that
 *   changes no behaviour.
 *
 * The skill rows are the exception to "no skills": the testing companion is
 * part of this Agent's job, so `tool-skill` is mounted to render the catalog
 * and load the body. That reverses the earlier "keep the catalog out of
 * context" choice — a one-skill catalog is the price of the Agent being able
 * to run interface tests at all.
 *
 * The shell row is chosen at activation rather than declared with a `!!js`
 * condition, because the definition is built in JS here — a plain boolean is
 * exactly what `PresetDefinition.disabled` accepts.
 *
 * @param {(message: string) => void} [warn] - sink for non-fatal diagnostics.
 * @param {{apiTest?: boolean}} [options] - `apiTest` overrides the resolvability probe (tests inject it).
 * @returns {{id: string, name: string, description: string, order: number, plugins: object[]}} the definition.
 */
export function buildDefinition(warn, options = {}) {
  const spec = specBody(warn)
  const apiTest = options.apiTest ?? companionAvailable()

  if (!apiTest) {
    warn?.(
      `wip-codegen: 未找到 ${COMPANION_PACKAGE}，本次预设不含接口测试技能（tool-skill 与 api-test 两行都不挂载）。` +
        ' 需要接口测试能力时把 dsh-api-test-bundle 也装进同一个 profile，然后重载本插件。'
    )
  }

  const plugins = [
    {
      id: 'persona',
      name: PERSONA_HOT_PACKAGE,
      config: {
        // Handed over for diagnostics only. The row reads the asset itself so
        // it can re-read it later; a config string would be frozen by
        // `structuredClone` at mount time, which is the whole problem this row
        // exists to solve.
        specCharacters: spec.length
      }
    },
    {
      id: 'agent-instructions',
      name: '@deepseek-ai/dsh-agent-instructions',
      // `maxBytes` is required with no fallback; see the note on tool-fs-search.
      // With no other config the row reads `AGENTS.md` from `$DSH_HOME` and
      // `$DSH_AGENTS_HOME` (global) plus every ancestor of the working
      // directory up to the `.git` root (project), which is exactly the
      // global-plus-per-repository split the spec asks for.
      config: { maxBytes: AGENTS_MAX_BYTES }
    }
  ]

  if (apiTest) {
    plugins.push(
      {
        id: 'tool-skill',
        name: SKILL_TOOL_PACKAGE,
        config: { catalogDescriptionMaxLength: CATALOG_DESCRIPTION_MAX_LENGTH }
      },
      {
        id: 'api-test-bundle',
        name: COMPANION_PACKAGE
      }
    )
  }

  plugins.push(
    {
      id: 'tool-fs',
      name: '@deepseek-ai/dsh-tool-fs'
    },
    {
      id: 'tool-fs-search',
      name: '@deepseek-ai/dsh-tool-fs-search',
      // Required with no fallback. Omit it and the activation audit rejects the
      // definition — and because one bad row fails the *whole* preset, the
      // Agent goes `broken` and cannot be selected at all. This bundle shipped
      // exactly that bug in 1.x; `verify-runtime/run.mjs` is what caught it, and
      // `verify.mjs` now pins both required fields so it cannot come back.
      // The value matches the shipped `standard` preset.
      config: { sampleOverCapGlobResults: false }
    },
    process.platform === 'win32'
      ? { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh' }
      : { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
    {
      id: 'tool-ask-user',
      name: '@deepseek-ai/dsh-tool-ask-user'
    },
    {
      id: 'tool-todo',
      name: '@deepseek-ai/dsh-tool-todo',
      // Also required with no fallback; see the note on `tool-fs-search`.
      // `true` matches the shipped `standard` preset and fits the spec's
      // per-class confirmation loop, where several items can be open at once.
      config: { allowParallelInProgress: true }
    }
  )

  // The delegation group. One `cordis:group` row, because two of its members
  // publish services (`workflow-ptc` owns `workflowEngine`) and a provider
  // without an `isolate` realm publishes into the ROOT realm, where the
  // registry rejects the mount outright with "Preset services require isolate
  // realms". `isolate: { workflowEngine: true }` gives them a private realm.
  //
  // The providers themselves (`subagents`, `subagent-spawn-in-process`,
  // `ptc-runtime`) stay in the host plane on purpose: they are process
  // singletons, and what a preset picks is which delegation *tools* its agent
  // sees. Mounting them here would be a second copy fighting the first.
  //
  // `agentPreset` is left unset so a child inherits this agent's preset; the
  // spec's conventions must reach the subagent too, or its summaries are
  // written against a different ruleset. `modelSelectionSettings: true` needs
  // the host row `@deepseek-ai/dsh-tool-subagent/model-selection-settings`,
  // which `dsh-web-app` keeps enabled.
  plugins.push({
    id: 'delegation',
    name: GROUP_PACKAGE,
    group: true,
    isolate: { workflowEngine: true },
    config: [
      {
        id: 'tool-subagent-control',
        name: '@deepseek-ai/dsh-tool-subagent-control'
      },
      {
        id: 'tool-subagent-list-agents',
        name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'
      },
      {
        id: 'tool-subagent',
        name: '@deepseek-ai/dsh-tool-subagent',
        config: {
          provider: 'spawn',
          toolName: 'subagent',
          modelSelectionSettings: true
        }
      },
      {
        id: 'tool-subagent-fork',
        name: '@deepseek-ai/dsh-tool-subagent',
        config: { provider: 'fork', toolName: 'subagent_fork' }
      },
      {
        id: 'workflow-ptc',
        name: '@deepseek-ai/dsh-workflow-ptc',
        config: { provider: 'spawn' }
      },
      {
        id: 'tool-workflow',
        name: '@deepseek-ai/dsh-tool-workflow'
      }
    ]
  })

  return {
    id: PRESET_ID,
    name: PRESET_NAME,
    description: PRESET_DESCRIPTION,
    order: PRESET_ORDER,
    plugins
  }
}

/**
 * Register the preset, and release it again when this plugin is unloaded.
 *
 * Registration is async and the plugin may be unloaded before it settles, so
 * the disposer is adopted through an `effect` whose teardown reads whatever
 * has arrived by then. If the registration lands after teardown it disposes
 * itself immediately — otherwise a disabled row would leave a phantom preset
 * behind, which is exactly the hot-plug guarantee this bundle is for.
 *
 * A failure to register is logged, never thrown: this runs inside the host's
 * activation transaction, and taking that down would damage unrelated plugins.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning plugin context, relying on the injected `agentPresets` Service.
 * @returns {void}
 */
export function apply(ctx) {
  const warn = (message) => ctx.logger?.warn?.(message)
  const log = (message) => ctx.logger?.info?.(message)

  /** @type {false | (() => Promise<void>) | null} */
  let disposer = null
  let unloaded = false

  ctx.effect(() => () => {
    unloaded = true
    const pending = disposer
    disposer = null
    if (typeof pending === 'function') return pending()
    return undefined
  })

  let definition
  try {
    definition = buildDefinition(warn)
  } catch (error) {
    // buildDefinition reads the asset and should not throw, but a preset the
    // registry never sees must still not break the surrounding activation.
    ctx.logger?.error?.('wip-codegen: 构造预设定义失败，本次不注册', error)
    return
  }

  const rowCount = definition.plugins.length
  Promise.resolve(ctx.agentPresets.register(definition))
    .then((release) => {
      const dispose = typeof release === 'function' ? release : null
      if (unloaded) {
        void dispose?.()
        return
      }
      disposer = dispose
      log(`wip-codegen: 预设「${definition.id}」已注册 · 子插件 ${rowCount} 行`)
    })
    .catch((error) => {
      const reason = error instanceof Error ? error.message : String(error)
      warn(
        `wip-codegen: 预设「${definition.id}」注册失败（${reason}）。` +
          ' 最常见的原因是同一个 id 已被别的插件注册（例如 dsh-agent-studio 里自建的同名预设）——' +
          ' 先删掉那个，再重新加载本插件。'
      )
    })
}
