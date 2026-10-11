/**
 * Offline activation test: drive the plugin's `apply()` with a fake Cordis
 * context and assert the registration lifecycle.
 *
 * This is the check that actually proves the hot-plug claim. `verify.mjs`
 * proves the *definition* is right; this proves the *lifecycle* is right —
 * that registering passes a well-formed definition to the service, that the
 * disposer is adopted, and above all that **unloading calls it**, so disabling
 * the plugin row leaves no phantom preset behind.
 *
 * It also pins the ordering hazard: `register()` resolves asynchronously, so a
 * plugin unloaded before it settles must still dispose itself.
 *
 * No DSH, no dependencies — a fake context is enough because the plugin only
 * ever touches `ctx.logger`, `ctx.effect`, `ctx.agentPresets` and (on failure)
 * `ctx.logger.error`.
 *
 * Run: node verify-lifecycle.mjs
 */
import { buildDefinition } from './index.js'

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

/** A fake plugin context that records what the plugin does to it. */
function fakeContext({ registerImpl } = {}) {
  const state = { registered: [], disposers: [], effects: [], warnings: [], errors: [], teardown: [] }
  const ctx = {
    logger: {
      info: () => {},
      warn: (message) => state.warnings.push(String(message)),
      error: (...args) => state.errors.push(args.map(String).join(' '))
    },
    effect: (callback) => {
      // Cordis effects run the callback now (registering a disposer) and run
      // the returned disposer at teardown. Both halves are captured.
      const disposer = callback()
      state.effects.push(callback)
      if (typeof disposer === 'function') state.teardown.push(disposer)
    },
    agentPresets: {
      register: (definition) => {
        state.registered.push(definition)
        return registerImpl === undefined ? Promise.resolve(() => {}) : registerImpl(definition, state)
      }
    }
  }
  return { ctx, state }
}

const { apply } = await import('./index.js')

// ── happy path ────────────────────────────────────────────────────────────────
console.log('register on apply')

let leaseDisposed = 0
const happy = fakeContext({
  registerImpl: (definition, state) => {
    // The service returns a disposer; record when the plugin actually calls it.
    state.disposeCalls = 0
    return Promise.resolve(() => {
      leaseDisposed += 1
      state.disposeCalls += 1
    })
  }
})

apply(happy.ctx)
await new Promise((resolve) => setTimeout(resolve, 0))

check('apply() registers exactly one preset', () => {
  const n = happy.state.registered.length
  assert(n === 1, `registered ${n} presets`)
})
check('the registered definition is the built one', () => {
  const got = happy.state.registered[0]
  const want = buildDefinition()
  assert(got.id === want.id, `id ${got.id} !== ${want.id}`)
  assert(got.plugins.length === want.plugins.length, 'plugin row count differs')
  assert(got.plugins[0].config.prefix === want.plugins[0].config.prefix, 'spec text differs from buildDefinition()')
})
check('apply() registers an effect for teardown', () => {
  assert(happy.state.teardown.length === 1, `expected 1 teardown disposer, got ${happy.state.teardown.length}`)
})

// ── the hot-plug guarantee ────────────────────────────────────────────────────
console.log('')
console.log('unload disposes the registration (hot-plug)')

const before = leaseDisposed
for (const disposer of happy.state.teardown) await disposer()

check('unloading calls the registration disposer', () => {
  assert(leaseDisposed === before + 1, `disposer called ${leaseDisposed - before} times, expected 1`)
})
check('unloading twice is safe', () => {
  // The stored disposer is cleared on first teardown; a second pass must not throw.
  for (const disposer of happy.state.teardown) void disposer()
})

// ── the race: unloaded before register() settles ──────────────────────────────
console.log('')
console.log('unload racing an unresolved register()')

let lateDisposed = 0
let settle
const late = fakeContext({
  registerImpl: () =>
    new Promise((resolve) => {
      settle = () =>
        resolve(() => {
          lateDisposed += 1
        })
    })
})

apply(late.ctx)
// Tear the plugin down while register() is still pending.
for (const disposer of late.state.teardown) await disposer()
check('nothing was disposed while register() was pending', () => {
  assert(lateDisposed === 0, `disposed ${lateDisposed} time(s) before the registration resolved`)
})

// Now let the registration land; the plugin must clean itself up.
settle()
await new Promise((resolve) => setTimeout(resolve, 0))

check('a registration that lands after unload disposes itself (no phantom preset)', () => {
  assert(lateDisposed === 1, `disposed ${lateDisposed} time(s), expected exactly 1`)
})

// ── failure path ──────────────────────────────────────────────────────────────
console.log('')
console.log('registration failure')

const failing = fakeContext({
  registerImpl: () => Promise.reject(new Error('Duplicate agent preset: wip-codegen'))
})

apply(failing.ctx)
await new Promise((resolve) => setTimeout(resolve, 0))

check('a duplicate-id failure is logged, not thrown', () => {
  assert(failing.state.warnings.length >= 1, 'no warning was logged')
  const text = failing.state.warnings.join('\n')
  assert(text.includes('Duplicate agent preset'), 'the underlying reason was dropped from the warning')
  assert(text.includes('dsh-agent-studio') || text.includes('别的插件'), 'the warning does not point at the usual cause')
})
check('a failure does not surface through ctx.logger.error as an unhandled throw', () => {
  assert(failing.state.errors.length === 0, `unexpected error logs: ${failing.state.errors.join(' | ')}`)
})

// ── result ────────────────────────────────────────────────────────────────────
console.log('')
if (failures.length === 0) {
  console.log('ALL LIFECYCLE CHECKS PASSED (register → dispose on unload, race-safe, failure logged)')
} else {
  console.log(`${failures.length} LIFECYCLE CHECK(S) FAILED:`)
  for (const line of failures) console.log(`  - ${line}`)
}
process.exitCode = failures.length === 0 ? 0 : 1
