/**
 * `wip-codegen` Agent bundle — declares one DSH Agent preset.
 *
 * What "an Agent" is in DSH: a *preset* composes the plugins a session runs,
 * and those plugins own the model-visible prompt and tools. So this bundle
 * does exactly one thing — it calls `agentPresets.register()` with a preset
 * definition whose rows are already-public harness packages. There is no new
 * tool, no client half, and no dependency: installing the bundle makes the
 * Agent appear, disabling the row makes it disappear.
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
 * the body cannot be mangled by any serializer on the way in.
 *
 * @module dsh-wip-codegen-agent
 */

import { readFileSync } from 'node:fs'

/** Cordis plugin name; also the patch row id. */
export const name = 'wip-codegen-agent'

/** The only Service this plugin needs. */
export const inject = ['agentPresets']

/** Preset identity. Sessions store this id, so it must stay stable. */
const PRESET_ID = 'wip-codegen'

/** Display metadata for the preset picker. */
const PRESET_NAME = 'WIP/HRP 代码生成'
const PRESET_DESCRIPTION =
  '在制品管理（wip）与人事管理（hrp）的 Java 代码生成 Agent：按团队规范从建表 SQL / UI 截图 / Excel 样例 / SAP 字段映射生成 Spring Boot 3 + MyBatis-Plus 代码。'

/** Sorts the picker after the four shipped presets (standard=1 … cordis=4). */
const PRESET_ORDER = 5

/** The spec body. Kept next to this module so packaging is obvious. */
const SPEC_FILE_URL = new URL('./assets/wip-codegen/system-prompt.md', import.meta.url)

/**
 * Appended to the spec as its own trailing block.
 *
 * The spec itself never says where the project lives, and under
 * `complete: true` no other section can supply that, so the agent would have
 * to guess a path before it could write a file. `{{cwd}}` is a harness
 * built-in prompt variable and resolves at render time.
 *
 * Delete this constant (and its use below) if you want the system prompt to be
 * the spec and nothing else.
 */
const CWD_NOTE = '工作目录（当前项目根）：{{cwd}}'

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
 * The row list is intentionally small and made only of shipped packages:
 * the persona (which carries the spec), a shell, file access, search, and the
 * two interaction tools. Notably absent, and deliberately so: `tool-skill`
 * (without it no skill catalog is injected), the delegation/workflow rows
 * (this agent writes code, it does not dispatch), and `plan-mode` (the spec is
 * already a complete procedure).
 *
 * The shell row is chosen at activation rather than declared with a `!!js`
 * condition, because the definition is built in JS here — a plain boolean is
 * exactly what `PresetDefinition.disabled` accepts.
 *
 * @param {(message: string) => void} [warn] - sink for non-fatal diagnostics.
 * @returns {{id: string, name: string, description: string, order: number, plugins: object[]}} the definition.
 */
export function buildDefinition(warn) {
  const spec = `${readSpec(warn)}\n\n---\n\n${CWD_NOTE}\n`

  return {
    id: PRESET_ID,
    name: PRESET_NAME,
    description: PRESET_DESCRIPTION,
    order: PRESET_ORDER,
    plugins: [
      {
        id: 'persona',
        name: '@deepseek-ai/dsh-persona',
        config: {
          prefix: spec,
          complete: true
        }
      },
      {
        id: 'tool-fs',
        name: '@deepseek-ai/dsh-tool-fs'
      },
      {
        id: 'tool-fs-search',
        name: '@deepseek-ai/dsh-tool-fs-search'
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
        name: '@deepseek-ai/dsh-tool-todo'
      }
    ]
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
