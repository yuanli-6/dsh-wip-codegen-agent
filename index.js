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
 * deliberately prescriptive. With it, assembly still resolves variables and
 * still ships tool *schemas*, so `{{cwd}}` works and the tools remain callable.
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
 * Name of the row that renders the skill catalog and the `skill` tool.
 *
 * The testing companion only *registers* a skill; without this consumer nothing
 * puts a catalog in front of the model and nothing can load the body, so the
 * companion is useless on its own. Both rows therefore travel together.
 */
const SKILL_TOOL_PACKAGE = '@deepseek-ai/dsh-tool-skill'

/** Cap for each catalog description; the companion's description is long and this is a one-skill catalog. */
const CATALOG_DESCRIPTION_MAX_LENGTH = 400

/**
 * Appended to the spec as its own trailing block.
 *
 * The spec itself never says where the project lives, and under
 * `complete: true` no other section can supply that, so the agent would have
 * to guess a path before it could write a file. `{{cwd}}` is a harness
 * built-in prompt variable and resolves at render time.
 *
 * The spec path is the second half of the same problem: §14.6 tells the agent
 * to append user-declared global rules to §十五 of *this* file, and the file
 * lives in the installed package, whose location the agent cannot guess.
 */
function trailingNotes() {
  return [
    '---',
    '',
    '工作目录（当前项目根）：{{cwd}}',
    `规范正文路径（§十五 全局规则追加到该文件）：${fileURLToPath(SPEC_FILE_URL)}`
  ].join('\n')
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
 * file access, search, and the two interaction tools do the work. Notably
 * absent, and deliberately so: the delegation/workflow rows (this agent writes
 * code, it does not dispatch) and `plan-mode` (the spec is already a complete
 * procedure).
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
  const spec = `${readSpec(warn)}\n\n${trailingNotes()}\n`
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
      name: '@deepseek-ai/dsh-persona',
      config: {
        prefix: spec,
        complete: true
      }
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
