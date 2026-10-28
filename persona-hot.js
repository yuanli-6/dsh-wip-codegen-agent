/**
 * The persona row, made hot-reloadable.
 *
 * `@deepseek-ai/dsh-persona` takes the prompt body as a plain string in its
 * row config, and a preset row's config is `structuredClone`d when the preset
 * is mounted. So the body is frozen at activation: editing
 * `assets/wip-codegen/system-prompt.md` changes nothing until the whole plugin
 * is reinstalled, which for a file whose §十五 grows every session is the
 * single most annoying property of this bundle.
 *
 * This row exists to remove that. It registers the *same* section name
 * (`deployment:persona-prefix`) at the *same* order, so it shadows the
 * deployment persona inside a preset scope exactly as `dsh-persona` does — but
 * its `text` is a function, and the registry resolves that function on every
 * assembly (`text: typeof section.text === "function" ? section.text(context)
 * : section.text`). Assembly runs once per agent step, so a function that
 * re-reads the file makes the body live.
 *
 * It is not enough to just re-read on every step, though: the model is told
 * which file holds the spec, so it can edit that file itself, and a silent
 * swap mid-conversation would change the rules under a half-finished task with
 * nobody noticing. So the file is watched, and a change is applied only after
 * the user confirms it in a dialog. That dialog is the entire point — the
 * reload is the user's decision, not a side effect of saving a file.
 *
 * Timing, stated plainly because it is surprising: assembly for step N happens
 * *before* `agent/pre-step` for step N fires. So a change confirmed during
 * step N is visible from step N+1 onward, never within the step that asked.
 *
 * @module dsh-wip-codegen-agent/persona-hot
 */

import { watch } from 'node:fs'
import { specBody, specPath } from './index.js'

/** Cordis plugin name. */
export const name = 'wip-codegen-persona-hot'

/**
 * The prompt registry this row contributes to.
 *
 * `userQuestions` is deliberately *not* listed: it is optional here (a headless
 * host has no answerer, and that must degrade to "reload unavailable", not
 * "the Agent never activates"), so it is looked up leniently at call time.
 */
export const inject = ['systemPrompt']

/**
 * The section this row owns.
 *
 * Spelled out instead of imported from `@deepseek-ai/dsh-system-prompt` on
 * purpose: a preset row is resolved by the host loader, not by this package,
 * and this package has no dependency on the harness internals. The name is a
 * documented contract — `dsh-persona` exports the same constant for the same
 * reason — and the order is read from the registry itself, so only the name
 * has to be duplicated.
 */
const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix'

/** Registry key for the persona prefix's order slot. */
const SECTION_ORDER_KEY = 'DEPLOYMENT_PERSONA_PREFIX'

/** Dialog identity; the answer is matched back by this id. */
const QUESTION_ID = 'reload-spec'

/** Option labels. Compared by exact string, so they are declared once. */
const RELOAD = '立即热加载'
const LATER = '稍后再说'

/** Coalesces the burst of events a single editor save produces. */
const DEBOUNCE_MS = 400

/**
 * Marker the fallback body carries.
 *
 * A save is not atomic: an editor truncates the file and then writes it, so a
 * read landing in that window yields empty or partial text. Adopting that as
 * the new prompt would blank the spec, so any candidate containing this marker
 * is rejected and the current body is kept.
 */
const FALLBACK_MARKER = '规范正文未能读取'

/**
 * Read the body this row would serve.
 *
 * Exported so `verify.mjs` can assert the composition (spec + trailing notes)
 * without standing up a plugin context.
 *
 * @param {(message: string) => void} [warn] - sink for non-fatal diagnostics.
 * @returns {string} the full prompt body.
 */
export function readSpecBody(warn) {
  return specBody(warn)
}

/**
 * Register the live persona section and watch the spec asset.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - preset-scoped context, relying on the injected `systemPrompt` Service.
 * @returns {void}
 */
export function apply(ctx) {
  const warn = (message) => ctx.logger?.warn?.(message)
  const log = (message) => ctx.logger?.info?.(message)

  /** Body currently served to the model. */
  let cached = readSpecBody(warn)
  /** Body that changed on disk and is waiting for the user's answer. */
  let pending = null
  /** Whether a dialog is already open; guards against stacking them. */
  let asking = false
  /** Debounce handle for the watcher. */
  let timer = null
  /** Last agent seen on `agent/pre-step`; the dialog needs a live root agent. */
  let agent = null
  /** Set on teardown so a late watcher event cannot touch a dead context. */
  let disposed = false

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: PERSONA_PREFIX_SECTION,
        order: ctx.systemPrompt.getSectionOrder(SECTION_ORDER_KEY),
        // A function, not a string: the registry calls it once per assembly,
        // which is what makes `cached` the live body.
        text: () => cached,
        complete: true
      }),
    'persona-hot.section()'
  )

  /**
   * Adopt a body that changed on disk.
   *
   * Rejected when it is unchanged, unusable (fallback marker), or already
   * pending. Otherwise it is staged and the user is asked — unless there is no
   * live agent yet, in which case the next `agent/pre-step` asks instead.
   *
   * @returns {void}
   */
  function onFileChanged() {
    if (disposed) return
    const next = readSpecBody(warn)
    if (next === cached) return
    if (next.includes(FALLBACK_MARKER)) {
      warn('wip-codegen: 规范正文读取失败（文件可能正在保存），继续使用当前正文')
      return
    }
    if (pending === next) return
    pending = next
    if (agent === null) {
      log('wip-codegen: 规范正文已变更，等下一个请求开始时询问是否热加载')
      return
    }
    void askToReload()
  }

  /**
   * Ask the user whether to adopt the staged body.
   *
   * Awaited nowhere: the step that triggered it proceeds with the old body, and
   * the answer applies from the next assembly. Every failure path drops the
   * staged body rather than retrying — a host without an answerer would
   * otherwise re-ask on every single step.
   *
   * @returns {Promise<void>} resolves once the dialog is settled.
   */
  async function askToReload() {
    if (asking || pending === null) return
    const questions = ctx.get('userQuestions', false)
    if (questions === undefined) {
      pending = null
      warn('wip-codegen: 当前宿主没有问答服务，热加载不可用；改正文后仍需重装插件')
      return
    }
    const body = pending
    asking = true
    try {
      const answer = await questions.ask({
        questions: [
          {
            id: QUESTION_ID,
            header: '规范正文已修改',
            question:
              `检测到规范正文已修改（${cached.length} → ${body.length} 字符）。` +
              '是否立即热加载？确认后从下一步起生效，不需要重装插件。',
            options: [
              { label: RELOAD, description: '从下一步起使用新正文' },
              { label: LATER, description: '继续使用当前正文；再次修改文件会重新询问' }
            ]
          }
        ],
        ...(agent === null ? {} : { agent })
      })
      const picked = answer?.answers?.find((entry) => entry?.id === QUESTION_ID)
      const selected = picked?.selected?.[0] ?? picked?.custom ?? ''
      if (selected === RELOAD) {
        cached = body
        log(`wip-codegen: 规范正文已热加载（${body.length} 字符）`)
      } else {
        log('wip-codegen: 用户选择稍后再说，本次正文变更已丢弃')
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      warn(`wip-codegen: 热加载确认失败（${reason}）；继续使用当前正文`)
    } finally {
      asking = false
      pending = null
    }
  }

  ctx.on('agent/pre-step', (payload, next) => {
    if (payload?.agent !== undefined) agent = payload.agent
    if (pending !== null && !asking) void askToReload()
    return next()
  })

  /**
   * Watch the asset itself.
   *
   * The path comes from this package's own `import.meta.url`, not from config:
   * it is the file the running install actually serves, so a sibling checkout
   * cannot accidentally be watched instead. `persistent: false` keeps the
   * watcher from holding the host process open.
   *
   * @type {import('node:fs').FSWatcher | null}
   */
  let watcher = null
  try {
    watcher = watch(specPath(), { persistent: false }, () => {
      if (disposed) return
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        onFileChanged()
      }, DEBOUNCE_MS)
    })
    watcher.on('error', (error) => warn(`wip-codegen: 监视规范正文失败（${error.message}）`))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    warn(`wip-codegen: 无法监视规范正文（${reason}）；热加载不可用，改正文后仍需重装插件`)
  }

  ctx.effect(
    () => () => {
      disposed = true
      if (timer !== null) clearTimeout(timer)
      watcher?.close()
    },
    'persona-hot.watch'
  )
}
