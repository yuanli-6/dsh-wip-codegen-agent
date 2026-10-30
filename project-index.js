/**
 * Composite project index: the `.dsh/index/` directory that §十七 of the spec
 * tells the Agent to trust before it reads any source file.
 *
 * One 10 MB JSON file is not an index, it is a trap: a mid-sized Java project
 * blows past the context window the moment anyone opens it. The artefacts are
 * therefore split by business area — `master_index.json` holds the shape,
 * `shards/*.json` hold the per-file entries (800 KB ceiling each),
 * `logic_rules.json` holds every business rule, and `agent_rules.json` holds the
 * Agent's own rules sliced per heading. Reading is a lookup, not a download.
 *
 * Three pieces live here.
 *
 * 1. A deterministic extractor. Every field of the index is derived from file
 *    bytes by plain JavaScript: a directory walk, a brace-aware Java scanner,
 *    and a MyBatis statement scan. Nothing in here calls a model.
 *
 * 2. A background listener. It starts itself the first time an Agent runs a
 *    step, rebuilds when the 30-minute lease has expired, and rebuilds again
 *    (incrementally) when the watched tree changes. It never asks the user
 *    anything, never posts into the conversation, and never blocks a step.
 *
 * 3. The `project_index` tool, which is the only way the model is meant to
 *    spend tokens on project structure: `status` first, then `query` or `read`.
 *
 * Why not a real subagent: the spec calls the listener a "后台监听器子代理",
 * and that word normally means `subagents.startActivation`. A spawned child
 * here would inherit this preset — which means every 30 minutes it would load
 * the whole 40 KB spec (≈12k tokens) to produce a deterministic artefact, it
 * would deliver its result into the parent conversation through
 * `delivery: 'parent'` and so break the "silent" requirement, and it would
 * mount this very row again, so it would have to be gated against recursing
 * into a listener of its own. The role the spec wants — owned lifecycle, full
 * build, incremental build, conflict skip — is a job, not a conversation. This
 * module therefore runs that job in the host plugin and says so plainly in the
 * README instead of pretending a child agent is doing it.
 *
 * @module dsh-wip-codegen-agent/project-index
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, watch } from 'node:fs'
import { readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis plugin name; also the patch row id. */
export const name = 'wip-codegen-project-index'

/**
 * `tools` is a hard dependency: this row's whole point is the `project_index`
 * tool, and a registration that silently no-ops is worse than a row that waits.
 *
 * Do NOT look `tools` up with `ctx.get('tools', false)` inside `apply()`: at
 * activation time the Service is often not on the context yet, the lookup
 * returns nothing, and the only retry used to hang off `agent/pre-step` — so a
 * profile that mounts the preset without ever running a step (exactly what the
 * runtime probe does) ends up with a perfect-looking composition, every row
 * ACTIVE, and no tool for the model. `verify-runtime` caught this.
 *
 * The object form `{ required, optional }` is NOT valid: cordis reads the keys
 * as Service *names*, so the plugin waits forever for services called
 * `required` and `optional` and sits PENDING. Only the array form is understood.
 *
 * `workingDirectory` stays optional and lazy — without it the root falls back to
 * `process.cwd()`, which is still useful.
 */
export const inject = ['tools']

/** Directory (relative to the project root) that holds every generated artefact. */
export const INDEX_DIR = '.dsh/index'

/**
 * Entry point of the index: project meta, the macro directory tree and the
 * shard manifest. Stays small (tens of KB) so reading it whole is always cheap.
 */
export const INDEX_FILE = 'master_index.json'

/** The master file's path, relative to the project root. */
export const INDEX_RELATIVE_PATH = `${INDEX_DIR}/${INDEX_FILE}`

/** Subdirectory holding one file per shard. */
export const SHARDS_DIR = 'shards'

/**
 * Ceiling for a single shard file.
 *
 * The spec says 1 MB; 800 KB leaves headroom for the few hundred methods a
 * project gains before the next rebuild would otherwise have to re-split.
 * A shard above the ceiling is split by path prefix, and — when one directory
 * cannot be split any further — by size.
 */
export const SHARD_MAX_BYTES = 800 * 1024

/**
 * The single-file index written by v2/v3. Detected and deleted on sight: it is
 * the 10 MB artefact this multi-file layout exists to replace.
 */
export const LEGACY_INDEX_FILE = 'project_index.json'

/**
 * Every file's `logic_details`, keyed by file path.
 *
 * Split out of the shards because "哪条业务规则在哪个文件里" is a question the
 * model asks on its own, without wanting any class or method around it.
 */
export const RULES_FILE = 'logic_rules.json'

/** `agent_rules_index`: the Agent's own rules, sliced per heading. */
export const AGENT_RULES_FILE = 'agent_rules.json'

/**
 * Sidecar holding per-file size/mtime/hash, used to decide what to re-parse.
 *
 * Deliberately *not* inside the index: it is bookkeeping, not project knowledge,
 * and keeping it separate means a rebuild that changes nothing produces no diff.
 */
export const CACHE_FILE = 'file-cache.json'

/**
 * Bumped when the extractor's output shape changes, so old caches are ignored.
 *
 * 2: annotation argument values, line numbers, imports, interface constants,
 *    enum values, constructors and cross-file relations joined the entry.
 * 3: the fourth block `agent_rules_index` — the Agent's own rules (spec body,
 *    AGENTS.md, plugin config, project docs) indexed with per-heading slices,
 *    so "规范里怎么写导出" is a query instead of a 45 KB file read.
 * 4: the single 10 MB file became a directory — `master_index.json` (meta +
 *    directory tree + shard manifest), `shards/*.json` (the per-file entries,
 *    split by business area and capped at SHARD_MAX_BYTES), plus
 *    `agent_rules.json` and `logic_rules.json`.
 */
export const INDEX_VERSION = 4

/** Listener lease. The spec's "有效期 30 分钟". */
export const LEASE_MS = 30 * 60 * 1000

/** Watch debounce: a Maven build touches hundreds of paths in a burst. */
export const DEBOUNCE_MS = 1200

/**
 * A file touched this recently is assumed to be mid-write.
 *
 * The spec's "冲突处理：文件正在被修改则跳过本次". Reading a half-written
 * Java file yields a half-parsed class, which is worse than a stale entry.
 */
export const SETTLE_MS = 1500

/** Files above this size are recorded in the directory index but not parsed. */
export const MAX_FILE_BYTES = 512 * 1024

/** Hard ceiling on the walk, so a runaway tree cannot wedge the listener. */
export const MAX_FILES = 20000

/** Directories that never hold hand-written source. */
export const SKIP_DIRS = new Set([
  'node_modules',
  'target',
  'build',
  'dist',
  'out',
  'bin',
  'obj',
  'coverage',
  'logs',
  'log',
  'tmp',
  'temp',
  'vendor',
  'generated',
  '.git',
  '.dsh',
  '.idea',
  '.vscode',
  '.gradle',
  '.mvn',
  '.settings',
  '.cache'
])

/** Extension → language label used in `directory_index[].children[].language`. */
const LANGUAGE_BY_EXT = new Map([
  ['.java', 'Java'],
  ['.kt', 'Kotlin'],
  ['.groovy', 'Groovy'],
  ['.gradle', 'Gradle'],
  ['.xml', 'XML'],
  ['.sql', 'SQL'],
  ['.yml', 'YAML'],
  ['.yaml', 'YAML'],
  ['.json', 'JSON'],
  ['.properties', 'Properties'],
  ['.md', 'Markdown'],
  ['.js', 'JavaScript'],
  ['.mjs', 'JavaScript'],
  ['.cjs', 'JavaScript'],
  ['.ts', 'TypeScript'],
  ['.vue', 'Vue'],
  ['.html', 'HTML'],
  ['.htm', 'HTML'],
  ['.css', 'CSS'],
  ['.scss', 'SCSS'],
  ['.less', 'LESS'],
  ['.sh', 'Shell'],
  ['.ps1', 'PowerShell'],
  ['.bat', 'Batch'],
  ['.cmd', 'Batch'],
  ['.py', 'Python'],
  ['.go', 'Go'],
  ['.rs', 'Rust'],
  ['.c', 'C'],
  ['.h', 'C'],
  ['.cpp', 'C++'],
  ['.cs', 'C#'],
  ['.php', 'PHP']
])

/** Per-file caps, so one pathological file cannot dominate the artefact. */
const MAX_CLASSES = 40
const MAX_FIELDS = 160
const MAX_METHODS = 200
const MAX_CONSTRUCTORS = 40
const MAX_IMPORTS = 80
const MAX_RELATIONS = 40
const MAX_DETAILS_PER_METHOD = 8
const MAX_DETAILS_PER_FILE = 60
const MAX_DEPENDENCIES = 8
const SUMMARY_MAX = 200
const LOGIC_MAX = 160
/** Constants carry the literal itself, so they get a longer leash than prose. */
const VALUE_MAX = 300
/** Per-section cap for `agent_rules_index`: a section is a slice, not a file. */
const RULE_SECTION_MAX = 400
/** Ceiling on sections per rules file, so one huge document cannot dominate. */
const MAX_RULE_SECTIONS = 120
/** Keywords per section, after de-duplication. */
const MAX_SECTION_KEYWORDS = 12
/** The only headings that start a section: `#`, `##`, `###`. */
const SECTION_RE = /^#{1,3}\s/

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

/** Normalise to forward slashes, drop a leading `./`, and trim trailing slashes. */
export function toPosix(value) {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
}

/** Directory portion of a relative file path; `.` for files at the root. */
export function dirOf(relPath) {
  const posix = toPosix(relPath)
  const cut = posix.lastIndexOf('/')
  return cut < 0 ? '.' : posix.slice(0, cut)
}

/**
 * Walk up from `start` looking for the repository root marker.
 *
 * The index lives at the project root, not at whatever directory the Agent
 * happens to be in. `.git` is the same marker `agent-instructions` uses to
 * decide where `AGENTS.md` stops, so both features agree on "project".
 *
 * @param {string} start - directory to start from.
 * @returns {string} the root, or `start` when no marker is found.
 */
export function findProjectRoot(start) {
  let current = start
  for (let depth = 0; depth < 64; depth += 1) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return start
}

/**
 * Absolute paths of every artefact.
 *
 * @param {string} root - project root.
 * @returns {{dir: string, master: string, shards: string, agentRules: string, logicRules: string, legacy: string, cache: string}} absolute paths.
 */
export function indexPaths(root) {
  const dir = join(root, ...INDEX_DIR.split('/'))
  return {
    dir,
    master: join(dir, INDEX_FILE),
    shards: join(dir, SHARDS_DIR),
    agentRules: join(dir, AGENT_RULES_FILE),
    logicRules: join(dir, RULES_FILE),
    legacy: join(dir, LEGACY_INDEX_FILE),
    cache: join(dir, CACHE_FILE)
  }
}

/**
 * Language label for a relative path.
 *
 * @param {string} relPath - path relative to the project root.
 * @returns {string} a label such as `Java`, or `Text` when unknown.
 */
export function languageOf(relPath) {
  return LANGUAGE_BY_EXT.get(extname(toPosix(relPath)).toLowerCase()) ?? 'Text'
}

// ---------------------------------------------------------------------------
// walking
// ---------------------------------------------------------------------------

/** Whether a path segment list should be skipped entirely. */
function isSkippedSegment(segment) {
  if (segment === '' || segment === '.') return false
  if (SKIP_DIRS.has(segment)) return true
  return segment.startsWith('.') && segment !== '.gitignore'
}

/**
 * Whether a path relative to the root should be ignored.
 *
 * @param {string} relPath - path relative to the project root.
 * @returns {boolean} true when the path is build output, VCS metadata, or hidden.
 */
export function shouldIgnorePath(relPath) {
  return toPosix(relPath)
    .split('/')
    .some((segment) => isSkippedSegment(segment))
}

/**
 * Collect every source file under `root`, relative and sorted.
 *
 * Symlinks are not followed: a linked `node_modules` would otherwise turn the
 * walk into a cycle, and the index only needs what lives in this checkout.
 *
 * @param {string} root - project root.
 * @param {{maxFiles?: number}} [options] - walk limits.
 * @returns {Promise<string[]>} relative paths using `/`.
 */
export async function walkSourceFiles(root, options = {}) {
  const maxFiles = options.maxFiles ?? MAX_FILES
  /** @type {string[]} */
  const files = []

  /** @param {string} directory @param {string} prefix */
  async function visit(directory, prefix) {
    if (files.length >= maxFiles) return
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return
      if (isSkippedSegment(entry.name)) continue
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        await visit(join(directory, entry.name), rel)
        continue
      }
      if (!entry.isFile()) continue
      files.push(rel)
    }
  }

  await visit(root, '')
  files.sort()
  return files
}

// ---------------------------------------------------------------------------
// text helpers
// ---------------------------------------------------------------------------

/** Collapse every whitespace run to one space. */
function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/** Collapse whitespace and cut to `max` characters. */
function truncate(text, max = SUMMARY_MAX) {
  const flat = collapse(text)
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/**
 * Whether a comment line is pure decoration.
 *
 * Banner comments are everywhere in this codebase
 * (`// ===== 任务安排 → 出勤记录映射 =====`), and the banner text itself is a
 * useful summary — the `=====` runs are not. A line whose only content is
 * punctuation carries nothing, so it is dropped instead of collapsed into the
 * summary.
 */
function isDecorationLine(line) {
  return line.replace(/[=\-*#/_~+<>|.\s]/g, '') === ''
}

/** Strip comment furniture (`/**`, `*`, `//`, `--`, `<!--`) from one block. */
function cleanComment(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((line) =>
      line
        .replace(/\/\*+/, ' ')
        .replace(/\*+\//, ' ')
        .replace(/<!--/, ' ')
        .replace(/-->/, ' ')
        .replace(/^\s*\*+/, ' ')
        .replace(/^\s*\/\/+/, ' ')
        .replace(/^\s*#+/, ' ')
        .replace(/^\s*--+/, ' ')
        .replace(/^[=\-*#_~+\s]+/, '')
        .replace(/[=\-*#_~+\s]+$/, '')
    )
    .filter((line) => !isDecorationLine(line))
  return collapse(lines.join(' '))
}

/**
 * The comment block directly above a declaration line.
 *
 * Annotation lines are skipped first: in this codebase the Javadoc sits above
 * `@RestController`, not directly above `public class`.
 *
 * @param {string[]} lines - file split on newlines.
 * @param {number} lineIndex - 0-based line of the declaration.
 * @returns {string} the comment text, or `''`.
 */
function commentAbove(lines, lineIndex) {
  let index = lineIndex - 1
  const skipAnnotations = () => {
    while (index >= 0 && lines[index].trim().startsWith('@')) index -= 1
  }
  skipAnnotations()
  while (index >= 0 && lines[index].trim() === '') {
    index -= 1
    skipAnnotations()
  }
  if (index < 0) return ''

  const line = lines[index].trim()
  if (line.endsWith('*/')) {
    const block = []
    while (index >= 0) {
      block.unshift(lines[index])
      if (lines[index].includes('/*')) break
      index -= 1
    }
    return cleanComment(block.join('\n'))
  }
  if (line.startsWith('//')) {
    const block = []
    while (index >= 0 && lines[index].trim().startsWith('//')) {
      block.unshift(lines[index])
      index -= 1
    }
    return cleanComment(block.join('\n'))
  }
  return ''
}

/** Line-start offsets, for turning a match index into a line number. */
function lineStarts(source) {
  const starts = [0]
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') starts.push(i + 1)
  }
  return starts
}

/** 0-based line containing `offset`. */
function lineAt(starts, offset) {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (starts[middle] <= offset) low = middle
    else high = middle - 1
  }
  return low
}

/** Index just past the string literal that starts at `start`. */
function skipString(source, start) {
  const quote = source[start]
  let index = start + 1
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === quote) return index + 1
    if (char === '\n') return index + 1
    index += 1
  }
  return source.length
}

/**
 * The `{ … }` block that follows `from`, with strings and comments ignored.
 *
 * @param {string} source - the whole file.
 * @param {number} from - offset to start searching at.
 * @returns {{start: number, end: number, body: string} | null} the block, or null.
 */
function scanBlock(source, from) {
  const open = source.indexOf('{', from)
  if (open < 0) return null
  let depth = 0
  let index = open
  while (index < source.length) {
    const char = source[index]
    if (char === '"' || char === "'") {
      index = skipString(source, index)
      continue
    }
    if (char === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index)
      index = newline < 0 ? source.length : newline + 1
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2)
      index = close < 0 ? source.length : close + 2
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return { start: open + 1, end: index, body: source.slice(open + 1, index) }
      }
    }
    index += 1
  }
  return { start: open + 1, end: source.length, body: source.slice(open + 1) }
}

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

/** Tokens that can never be part of a declared type. */
const JAVA_KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'new',
  'throw',
  'throws',
  'else',
  'do',
  'try',
  'finally',
  'synchronized',
  'assert',
  'case',
  'default',
  'super',
  'this',
  'instanceof',
  'yield',
  'await',
  'break',
  'continue'
])

/**
 * Modifiers that can be mistaken for a return type.
 *
 * `METHOD_RE` captures modifiers into group 1 and the type into group 2, but a
 * constructor has no return type at all: `public Foo(Bar bar)` matches with an
 * empty group 1 and `public` sitting in group 2, which would be recorded as a
 * method named `Foo` returning `public`. Rejecting a type made only of
 * modifiers drops those rows.
 */
const JAVA_MODIFIERS = new Set([
  'public',
  'protected',
  'private',
  'static',
  'final',
  'abstract',
  'synchronized',
  'native',
  'default',
  'strictfp',
  'transient',
  'volatile'
])

/** `@Foo` / `@Foo(...)` prefixes before a declaration. */
const ANNOTATION_PREFIX = String.raw`(?:@[\w.]+(?:\((?:[^()]|\([^()]*\))*\))?[ \t]*)*`

/** Class-like declaration header. */
const CLASS_RE = new RegExp(
  String.raw`^[ \t]*${ANNOTATION_PREFIX}` +
    String.raw`((?:(?:public|protected|private|static|final|abstract|sealed|strictfp)\s+)*)` +
    String.raw`(class|interface|enum|record)\s+(\w+)([^{;]*)\{`,
  'gm'
)

/**
 * Field declaration, modifiers mandatory so locals are not picked up.
 *
 * The initializer is captured (group 4) rather than skipped: a constant written
 * as a plain field (`static final String KEY = "wip:sync"`) carries its whole
 * meaning in that literal, and `=([^;]*)` stops before the terminating `;`.
 * The modifier group is captured (group 1) so that only `static final` fields
 * are reported as carrying a constant value.
 */
const FIELD_RE = new RegExp(
  String.raw`^[ \t]*${ANNOTATION_PREFIX}` +
    String.raw`((?:(?:private|protected|public|static|final|transient|volatile)\s+)+)` +
    String.raw`([\w$.<>\[\], \t?]+?)[ \t]+(\w+)\s*(?:=([^;]*))?;`,
  'gm'
)

/**
 * Method declaration; the type may not contain a Java keyword.
 *
 * The type is captured with `[ \t]` rather than `\s` on purpose. With `\s` the
 * lazy group happily swallowed a newline plus the next line's modifier, so
 * `public Foo(...)` parsed as a method named `Foo` returning `public`, and a
 * real method on the following line was captured as
 * `"\n    public Result<…>"`. Staying inside one line makes a constructor — no
 * return type, no space before `(` — simply not match.
 */
const METHOD_RE = new RegExp(
  String.raw`^[ \t]*${ANNOTATION_PREFIX}` +
    String.raw`((?:(?:public|protected|private|static|final|abstract|synchronized|native|default|strictfp)\s+)*)` +
    String.raw`([\w$.<>\[\], \t?]+?)[ \t]+([\w$]+)\s*\(((?:[^()]|\([^()]*\))*)\)`,
  'gm'
)

/** Annotation name + raw argument text, used for class annotations. */
const ANNOTATION_RE = /@([\w.]+)(?:\(((?:[^()]|\([^()]*\))*)\))?/g

/** `package a.b.c;` at file scope. */
const PACKAGE_RE = /^[ \t]*package\s+([\w$.]+)\s*;/m

/** `import a.b.C;` / `import static a.b.C.d;` at file scope. */
const IMPORT_RE = /^[ \t]*import\s+(?:static\s+)?([\w$.]+(?:\.\*)?)\s*;/gm

/**
 * Constructor declaration: modifiers, the type name, then a parameter list and
 * an opening brace.
 *
 * Kept apart from `METHOD_RE` rather than merged into it. `METHOD_RE` cannot
 * match a constructor at all (no return type), and a check locks that in, so
 * constructors get their own scan and their own array instead of being smuggled
 * into `methods` — `methods` must keep meaning "callable API".
 */
const CONSTRUCTOR_RE = new RegExp(
  String.raw`^[ \t]*${ANNOTATION_PREFIX}` +
    String.raw`((?:(?:public|protected|private)\s+)*)` +
    String.raw`([\w$]+)\s*\(((?:[^()]|\([^()]*\))*)\)\s*(?:throws[^{;]*)?\{`,
  'gm'
)

/**
 * Net parenthesis count of one line, ignoring string literals and line comments.
 *
 * Used to walk backwards over an annotation that spans several lines: a line
 * that closes more parentheses than it opens belongs to an annotation whose
 * opening `@Name(` is further up.
 *
 * @param {string} line - one source line.
 * @returns {number} `(` minus `)`.
 */
function parenDelta(line) {
  const text = line.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\/\/.*$/, '')
  let delta = 0
  for (const char of text) {
    if (char === '(') delta += 1
    else if (char === ')') delta -= 1
  }
  return delta
}

/**
 * Annotations attached to a declaration, with their argument text.
 *
 * The argument text is the point. `@RequestMapping("/taskArrangement")` reduced
 * to the bare name `RequestMapping` says nothing about the URL, and
 * `@TableField(value = "work_area")` reduced to `TableField` loses the very
 * column mapping an entity exists to express.
 *
 * Two places are read, because a declaration header reaches the caller in two
 * shapes. When the declaration regex matched on the declaration line itself the
 * annotations sit on the lines above, and the walk goes upwards. When it matched
 * on an annotation line — which happens as soon as one annotation wraps its
 * arguments across lines, since `ANNOTATION_PREFIX` spans newlines inside the
 * parentheses — the annotations are inside `header` instead. Both are read and
 * merged in source order.
 *
 * The upward walk keeps two kinds of line: one that starts with `@`, and one that
 * leaves the parenthesis balance negative, which is how the tail of a multi-line
 * annotation is recognised. A blank line or a comment ends it, so a declaration
 * with no annotations costs one comparison.
 *
 * @param {string[]} lines - file split on newlines.
 * @param {number} lineIndex - 0-based line the declaration regex matched on.
 * @param {string} [header] - the matched declaration header; its annotation
 *   prefix is read too, because that is where a same-line annotation lives.
 * @returns {{names: string[], args: Record<string, string>}} names in source
 *   order, and the raw argument text of every annotation that has any.
 */
function annotationsAbove(lines, lineIndex, header = '') {
  /** @type {string[]} */
  const collected = []
  let balance = 0
  for (let up = lineIndex - 1; up >= 0; up -= 1) {
    const line = lines[up]
    const trimmed = line.trim()
    if (trimmed === '') break
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) break
    const opens = trimmed.startsWith('@')
    // Keep a line when it opens an annotation, or when it closes one that is
    // still open above; anything else is the previous declaration.
    if (!opens && balance + parenDelta(line) >= 0) break
    collected.unshift(line)
    balance += parenDelta(line)
  }

  /** @type {string[]} */
  const texts = []
  if (collected.length > 0) texts.push(collected.join('\n'))
  if (header !== '') texts.push(annotationPrefix(header))

  /** @type {string[]} */
  const names = []
  /** @type {Record<string, string>} */
  const args = {}
  for (const text of texts) {
    for (const matched of text.matchAll(ANNOTATION_RE)) {
      const name = matched[1].includes('.') ? (matched[1].split('.').pop() ?? matched[1]) : matched[1]
      if (!names.includes(name)) names.push(name)
      const value = collapse(matched[2] ?? '')
      if (value !== '') args[name] = truncate(value, VALUE_MAX)
    }
  }
  return { names, args }
}

/**
 * The `description = "…"` text of a `@Schema`.
 *
 * This is the only Chinese wording many entity and Req fields ever get — the
 * team writes `@Schema(description = "工区")` instead of a Javadoc — so leaving
 * it out is why more than half the indexed fields had no comment at all.
 *
 * @param {Record<string, string>} args - annotation arguments.
 * @returns {string} the description, or ''.
 */
function schemaText(args) {
  const raw = args.Schema ?? ''
  if (raw === '') return ''
  const named = /\bdescription\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(raw)
  if (named !== null) return truncate(named[1], SUMMARY_MAX)
  const bare = /^"((?:[^"\\]|\\.)*)"$/.exec(raw.trim())
  return bare === null ? '' : truncate(bare[1], SUMMARY_MAX)
}

/**
 * The column a `@TableField` / `@TableId` binds the field to.
 *
 * `@TableField(exist = false)` has no column and yields ''.
 *
 * @param {Record<string, string>} args - annotation arguments.
 * @returns {string} the column name, or ''.
 */
function columnText(args) {
  for (const key of ['TableId', 'TableField']) {
    const raw = args[key]
    if (raw === undefined) continue
    const named = /\bvalue\s*=\s*"([^"]+)"/.exec(raw)
    if (named !== null) return named[1]
    const bare = /^"([^"]+)"$/.exec(raw.trim())
    if (bare !== null) return bare[1]
  }
  return ''
}

/**
 * Types that can never be a file in this project.
 *
 * Without this the relations list fills with `String`, `List` and `Long`, and
 * since it is capped, the handful of project classes that actually matter get
 * pushed out — measured on wip-srv, 71% of relations were JDK types.
 */
const JAVA_BUILTIN_TYPES = new Set([
  'String', 'CharSequence', 'Object', 'Number', 'Integer', 'Long', 'Short', 'Byte', 'Double', 'Float',
  'Boolean', 'Character', 'Void', 'BigDecimal', 'BigInteger', 'Math', 'System', 'Class', 'Thread',
  'Throwable', 'Exception', 'RuntimeException', 'Error', 'Iterable', 'Collection', 'List', 'Set', 'Map',
  'Queue', 'Deque', 'ArrayList', 'LinkedList', 'HashMap', 'LinkedHashMap', 'TreeMap', 'HashSet',
  'LinkedHashSet', 'TreeSet', 'Arrays', 'Collections', 'Objects', 'Optional', 'Stream', 'Collectors',
  'Comparator', 'Iterator', 'Date', 'Calendar', 'LocalDate', 'LocalDateTime', 'LocalTime', 'Instant',
  'Duration', 'Period', 'ZoneId', 'TimeZone', 'SimpleDateFormat', 'DateFormat', 'StringBuilder',
  'StringBuffer', 'Pattern', 'Matcher', 'Serializable', 'Cloneable', 'Comparable', 'Runnable',
  'Callable', 'Future', 'CompletableFuture', 'ExecutorService', 'ThreadPoolExecutor', 'InputStream',
  'OutputStream', 'Reader', 'Writer', 'File', 'Path', 'Files', 'URI', 'URL', 'UUID', 'Random',
  'AtomicInteger', 'AtomicLong', 'AtomicBoolean', 'AtomicReference', 'ConcurrentHashMap',
  'CopyOnWriteArrayList', 'CountDownLatch', 'Semaphore', 'Lock', 'ReentrantLock', 'TimeUnit',
  'Function', 'Supplier', 'Consumer', 'Predicate', 'BiFunction', 'UnaryOperator', 'T', 'E', 'K', 'V',
  'R', 'ID'
])

/** Capitalised type names mentioned by a type expression (`Map<String, Foo>` → Foo). */
function typeNames(type) {
  /** @type {string[]} */
  const names = []
  for (const matched of collapse(type).matchAll(/\b([A-Z][\w$]*)\b/g)) {
    const name = matched[1]
    if (JAVA_BUILTIN_TYPES.has(name)) continue
    if (!names.includes(name)) names.push(name)
  }
  return names
}

/** Record one outbound reference, first occurrence wins. */
function addRef(refs, seen, to, kind) {
  if (to === '') return
  const key = `${kind}:${to}`
  if (seen.has(key)) return
  seen.add(key)
  refs.push({ to, kind })
}

/**
 * 1-based line of a declaration's own line.
 *
 * A declaration regex starts at the first annotation, so the line it reports is
 * the annotation's. The offset that matters for "go look at this" is the name's.
 *
 * @param {number[]} starts - line start offsets.
 * @param {number} base - absolute offset of `raw[0]`.
 * @param {string} raw - the matched declaration header.
 * @param {string} name - the declared name.
 * @returns {number} 1-based line.
 */
function declarationLine(starts, base, raw, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let last = 0
  for (const matched of raw.matchAll(new RegExp(`\\b${escaped}\\b`, 'g'))) last = matched.index ?? 0
  return lineAt(starts, base + last) + 1
}

/**
 * The annotation prefix of a declaration header, or ''.
 *
 * Taken from the header rather than from the lines above, because a declaration
 * regex starts with `ANNOTATION_PREFIX` and therefore swallows every annotation
 * written on the same line as the declaration. `ANNOTATION_PREFIX` already
 * balances the parentheses, so `@PostMapping("/sync")` comes back whole — which
 * a search for the declared name could not do, since `sync` also occurs inside
 * that string literal.
 *
 * @param {string} header - matched declaration header.
 * @returns {string} the leading annotations with their arguments, or ''.
 */
function annotationPrefix(header) {
  const matched = new RegExp(`^[ \\t]*${ANNOTATION_PREFIX}`).exec(header)
  return matched === null ? '' : matched[0]
}

/**
 * Skip leading whitespace and comments.
 *
 * A member's statement text starts right after the previous `;` or `}`, so it
 * carries the blank lines and the Javadoc that precede the declaration. The
 * offset is needed because it becomes the line number.
 *
 * @param {string} text - statement text.
 * @returns {number} offset of the first real character, or `text.length`.
 */
function skipTrivia(text) {
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === ' ' || char === '\t' || char === '\r' || char === '\n') {
      index += 1
      continue
    }
    if (char === '/' && text[index + 1] === '/') {
      const newline = text.indexOf('\n', index)
      index = newline < 0 ? text.length : newline + 1
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2)
      index = close < 0 ? text.length : close + 2
      continue
    }
    break
  }
  return index
}

/** Strip the annotations that precede a member so the type can be read. */
function stripAnnotations(text) {
  let rest = text
  for (;;) {
    // `\s*` not `[ \t]*`: an annotation sits on its own line as often as not,
    // and leaving the newline behind makes the type pattern match nothing.
    const next = rest.replace(/^@[\w.]+(?:\((?:[^()]|\([^()]*\))*\))?\s*/, '')
    if (next === rest) return rest
    rest = next
  }
}

/**
 * Constants declared in an interface body.
 *
 * `FIELD_RE` demands an explicit modifier, which an interface constant never
 * has — `String KEY = "x";` inside an `interface` is implicitly
 * `public static final`. That is why a constants interface such as
 * `WipConstant` indexed with zero fields, losing every literal it exists to
 * hold.
 *
 * @param {string} body - text between the interface braces.
 * @param {number} base - absolute offset of `body[0]` in the file.
 * @returns {{name: string, type: string, value: string, offset: number}[]} the constants.
 */
function interfaceConstants(body, base) {
  /** @type {{name: string, type: string, value: string, offset: number}[]} */
  const constants = []
  for (const statement of topLevelStatements(body)) {
    const lead = skipTrivia(statement.text)
    const raw = stripAnnotations(statement.text.slice(lead))
    const matched = /^([\w$.<>\[\], \t?]+?)[ \t]+(\w+)\s*=\s*([\s\S]*)$/.exec(raw)
    if (matched === null) continue
    const type = collapse(matched[1])
    if (!isPlausibleType(type)) continue
    constants.push({
      name: matched[2],
      type,
      value: truncate(collapse(matched[3]), VALUE_MAX),
      offset: base + statement.offset + lead
    })
  }
  return constants
}

/**
 * Enum constants of an enum body, with their constructor arguments.
 *
 * `BusinessType.INSERT("新增")` is the whole point of that file: the value is
 * the label the UI shows. Indexing the enum without its constants left the
 * entry with nothing but a name.
 *
 * @param {string} body - text between the enum braces.
 * @param {number} base - absolute offset of `body[0]` in the file.
 * @returns {{name: string, args: string, offset: number}[]} the constants.
 */
function enumValues(body, base) {
  const cut = firstTopLevelSemicolon(body)
  const head = cut < 0 ? body : body.slice(0, cut)
  /** @type {{name: string, args: string, offset: number}[]} */
  const values = []
  for (const part of splitTopLevel(head, ',')) {
    const lead = skipTrivia(part.text)
    const raw = collapse(part.text.slice(lead))
    const name = /^([A-Za-z_$][\w$]*)/.exec(raw)?.[1] ?? ''
    if (name === '') continue
    let args = ''
    const open = raw.indexOf('(')
    if (open >= 0) {
      let depth = 0
      for (let index = open; index < raw.length; index += 1) {
        if (raw[index] === '(') depth += 1
        else if (raw[index] === ')') {
          depth -= 1
          if (depth === 0) {
            args = raw.slice(open + 1, index)
            break
          }
        }
      }
    }
    values.push({ name, args: truncate(collapse(args), VALUE_MAX), offset: base + part.offset + lead })
  }
  return values
}

/**
 * Depth-0 `;`-terminated statements inside a class body.
 *
 * A `}` that closes back to depth 0 also starts a new statement, so a method
 * body does not swallow the member declared after it. Only the interface /
 * enum member pass uses this; the field and method scans stay regex-driven.
 *
 * @param {string} body - text between the enclosing braces.
 * @returns {{text: string, offset: number}[]} statements, offsets relative to `body`.
 */
function topLevelStatements(body) {
  /** @type {{text: string, offset: number}[]} */
  const statements = []
  let depth = 0
  let start = 0
  let index = 0
  while (index < body.length) {
    const char = body[index]
    if (char === '"' || char === "'") {
      index = skipString(body, index)
      continue
    }
    if (char === '/' && body[index + 1] === '/') {
      const newline = body.indexOf('\n', index)
      index = newline < 0 ? body.length : newline + 1
      continue
    }
    if (char === '/' && body[index + 1] === '*') {
      const close = body.indexOf('*/', index + 2)
      index = close < 0 ? body.length : close + 2
      continue
    }
    if (char === '{' || char === '(' || char === '[') {
      depth += 1
      index += 1
      continue
    }
    if (char === '}' || char === ')' || char === ']') {
      depth = Math.max(0, depth - 1)
      if (char === '}' && depth === 0) start = index + 1
      index += 1
      continue
    }
    if (char === ';' && depth === 0) {
      statements.push({ text: body.slice(start, index), offset: start })
      start = index + 1
    }
    index += 1
  }
  return statements
}

/** Offset of the first `;` at nesting depth 0, or -1. */
function firstTopLevelSemicolon(body) {
  let depth = 0
  let index = 0
  while (index < body.length) {
    const char = body[index]
    if (char === '"' || char === "'") {
      index = skipString(body, index)
      continue
    }
    if (char === '/' && body[index + 1] === '/') {
      const newline = body.indexOf('\n', index)
      index = newline < 0 ? body.length : newline + 1
      continue
    }
    if (char === '/' && body[index + 1] === '*') {
      const close = body.indexOf('*/', index + 2)
      index = close < 0 ? body.length : close + 2
      continue
    }
    if (char === '{' || char === '(' || char === '[') depth += 1
    else if (char === '}' || char === ')' || char === ']') depth = Math.max(0, depth - 1)
    else if (char === ';' && depth === 0) return index
    index += 1
  }
  return -1
}

/**
 * Split on a separator that only counts at nesting depth 0.
 *
 * An enum constant list is comma-separated, but a constant may carry arguments
 * (`A(1, "x")`) or a body, so a plain `split(',')` cuts in the wrong place.
 *
 * @param {string} text - text to split.
 * @param {string} separator - single-character separator.
 * @returns {{text: string, offset: number}[]} the parts, offsets relative to `text`.
 */
function splitTopLevel(text, separator) {
  /** @type {{text: string, offset: number}[]} */
  const parts = []
  let depth = 0
  let start = 0
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '"' || char === "'") {
      index = skipString(text, index)
      continue
    }
    if (char === '/' && text[index + 1] === '/') {
      const newline = text.indexOf('\n', index)
      index = newline < 0 ? text.length : newline + 1
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2)
      index = close < 0 ? text.length : close + 2
      continue
    }
    if (char === '<' || char === '{' || char === '(' || char === '[') depth += 1
    else if (char === '>' || char === '}' || char === ')' || char === ']') depth = Math.max(0, depth - 1)
    else if (char === separator && depth === 0) {
      parts.push({ text: text.slice(start, index), offset: start })
      start = index + 1
    }
    index += 1
  }
  parts.push({ text: text.slice(start), offset: start })
  return parts
}

/**
 * Split a parameter list on top-level commas.
 *
 * @param {string} raw - text between the parentheses.
 * @returns {string[]} one `"类型 参数名"` string per parameter.
 */
export function parseParameters(raw) {
  const text = collapse(raw)
  if (text === '') return []

  /** @type {string[]} */
  const parts = []
  let depth = 0
  let buffer = ''
  for (const char of text) {
    if (char === '<') depth += 1
    else if (char === '>') depth = Math.max(0, depth - 1)
    if (char === ',' && depth === 0) {
      parts.push(buffer)
      buffer = ''
      continue
    }
    buffer += char
  }
  if (buffer.trim() !== '') parts.push(buffer)

  return parts.map((part) => {
    const cleaned = collapse(
      part
        .replace(/@[\w.]+(?:\((?:[^()]|\([^()]*\))*\))?/g, ' ')
        .replace(/\bfinal\s+/g, ' ')
    )
    const matched = /^(.*?)\s*([\w$]+)$/.exec(cleaned)
    if (!matched) return cleaned
    const type = collapse(matched[1])
    return type === '' ? matched[2] : `${type} ${matched[2]}`
  })
}

/** Whether a captured type is really a keyword-led expression. */
function isPlausibleType(type) {
  const tokens = collapse(type)
    .split(/[^\w$]+/)
    .filter((token) => token !== '')
  if (tokens.length === 0) return false
  return tokens.every((token) => !JAVA_KEYWORDS.has(token) && !JAVA_MODIFIERS.has(token))
}

/** `extends A` / `implements B, C` from a class header. */
function parseHeritage(header) {
  const flat = collapse(header)
  const extendsMatch = /\bextends\s+([\w$.<>,\s?]+?)(?=\bimplements\b|$)/.exec(flat)
  const implementsMatch = /\bimplements\s+([\w$.<>,\s?]+)$/.exec(flat)
  const split = (value) =>
    value === undefined
      ? []
      : value
          .split(',')
          .map((item) => collapse(item))
          .filter((item) => item !== '')
  return { extends: split(extendsMatch?.[1]), implements: split(implementsMatch?.[1]) }
}

/** First meaningful statement of a method body, preferring a `return`. */
function firstStatement(body) {
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line !== '' &&
        line !== '{' &&
        line !== '}' &&
        !line.startsWith('//') &&
        !line.startsWith('*') &&
        !line.startsWith('/*')
    )
  const isReturn = (line) => line.startsWith('return ') || line.startsWith('return;')
  // A line that ends mid-expression (`return new Foo() {`) describes an
  // anonymous class opener, not the method's work; prefer a statement that
  // closes on its own line before falling back to whatever came first.
  const returning = lines.find((line) => isReturn(line) && line.endsWith(';'))
  const complete = lines.find((line) => line.endsWith(';') && !line.startsWith('}'))
  const chosen = returning ?? complete ?? lines.find(isReturn) ?? lines[0] ?? ''
  return truncate(chosen.replace(/;$/, '').replace(/[\s{]+$/, ''), LOGIC_MAX)
}

/** Capitalised types and `*Mapper` / `*Service` style collaborators used in a body. */
function collectDependencies(body) {
  /** @type {string[]} */
  const found = []
  const seen = new Set()
  const push = (value) => {
    if (value === undefined || value === '') return
    if (seen.has(value)) return
    seen.add(value)
    found.push(value)
  }

  for (const matched of body.matchAll(/\b([A-Z][\w$]*)\s*(?:\.|::|<)/g)) push(matched[1])
  for (const matched of body.matchAll(/\b(\w*(?:Mapper|Service|Repository|Dao|Util|Helper))\b/g)) {
    push(matched[1])
  }
  return found.slice(0, MAX_DEPENDENCIES)
}

/**
 * `if (cond) { action }` pairs from a method body.
 *
 * Each rule carries the absolute 1-based line of its `if`, so a reader can jump
 * straight to the branch instead of grepping the file for the condition text.
 *
 * @param {string} body - the method body, as sliced out by `scanBlock`.
 * @param {string} methodName - owner of the rules.
 * @param {number} [bodyStart] - absolute offset of `body` in the file.
 * @param {number[]} [starts] - line starts of the whole file, from `lineStarts`.
 * @returns {{rule_name: string, description: string, line?: number}[]} the rules.
 */
function collectRules(body, methodName, bodyStart, starts) {
  /** @type {{rule_name: string, description: string, line?: number}[]} */
  const rules = []
  const lines = body.split('\n')
  const locatable = typeof bodyStart === 'number' && Array.isArray(starts)
  let offset = 0
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    const lineStart = offset
    // +1 for the '\n' that split() removed; CRLF sources keep the '\r' in raw,
    // which shifts nothing because it trails the line it belongs to.
    offset += raw.length + 1
    const line = raw.trim()
    const condition = /^(?:\}\s*)?if\s*\((.+)\)\s*\{?$/.exec(line)
    if (condition === null) continue
    let action = ''
    for (let next = index + 1; next < Math.min(index + 4, lines.length); next += 1) {
      const candidate = lines[next].trim()
      if (candidate === '' || candidate === '{' || candidate === '}') continue
      action = candidate.replace(/;$/, '')
      break
    }
    if (action === '') continue
    /** @type {{rule_name: string, description: string, line?: number}} */
    const rule = {
      rule_name: `${methodName} · 条件 ${rules.length + 1}`,
      description: truncate(`${collapse(condition[1])} → ${action}`, LOGIC_MAX)
    }
    if (locatable) {
      // Point at the `if` itself, not at the line's indentation: the regex
      // allows a leading `}`, so the keyword is not always the first token.
      const leading = raw.length - raw.trimStart().length
      const ifAt = raw.indexOf('if', leading)
      const column = ifAt < 0 ? leading : ifAt
      rule.line = lineAt(starts, bodyStart + lineStart + column) + 1
    }
    rules.push(rule)
    if (rules.length >= MAX_DETAILS_PER_METHOD) break
  }
  return rules
}

/**
 * The type part of one `"类型 参数名"` string.
 *
 * @param {string} parameter - as produced by `parseParameters`.
 * @returns {string} the type, or ''.
 */
function parameterType(parameter) {
  const cut = parameter.lastIndexOf(' ')
  return cut < 0 ? '' : parameter.slice(0, cut)
}

/**
 * Extract the `content_logic_index` entry for one Java file.
 *
 * @param {string} source - file text.
 * @param {string} relPath - path relative to the project root.
 * @returns {object} the entry.
 */
export function parseJavaSource(source, relPath) {
  const text = source.replace(/^\uFEFF/, '')
  const lines = text.split('\n')
  const starts = lineStarts(text)

  /** @type {string[]} */
  const imports = []
  for (const matched of text.matchAll(IMPORT_RE)) {
    if (imports.length >= MAX_IMPORTS) break
    imports.push(matched[1])
  }

  /** @type {object[]} */
  const classes = []
  /** @type {Set<string>} */
  const classNames = new Set()
  for (const matched of text.matchAll(CLASS_RE)) {
    if (classes.length >= MAX_CLASSES) break
    const header = matched[0]
    const kind = matched[2]
    const name = matched[3]
    const base = matched.index ?? 0
    const index = lineAt(starts, base)
    const heritage = parseHeritage(matched[4] ?? '')
    const { names, args } = annotationsAbove(lines, index, header)
    const doc = commentAbove(lines, index)
    classNames.add(name)

    /** @type {Record<string, unknown>} */
    const entry = {
      name,
      kind,
      extends: heritage.extends[0] ?? '',
      implements: heritage.implements,
      annotations: names,
      annotation_args: args,
      line: declarationLine(starts, base, header, name),
      summary:
        doc !== ''
          ? doc
          : truncate(
              [
                kind,
                name,
                heritage.extends.length > 0 ? `extends ${heritage.extends.join(', ')}` : '',
                heritage.implements.length > 0 ? `implements ${heritage.implements.join(', ')}` : ''
              ]
                .filter((part) => part !== '')
                .join(' ')
            )
    }

    // `header` ends with the class's own `{`, so the block scan starts there
    // rather than past it — otherwise it would take the first nested brace.
    const block = scanBlock(text, base + header.length - 1)
    if (block !== null && kind === 'interface') {
      const constants = interfaceConstants(block.body, block.start).map((constant) => {
        const lineIndex = lineAt(starts, constant.offset)
        return {
          name: constant.name,
          type: constant.type,
          value: constant.value,
          comment: commentAbove(lines, lineIndex),
          line: lineIndex + 1
        }
      })
      if (constants.length > 0) entry.constants = constants
    }
    if (block !== null && kind === 'enum') {
      const values = enumValues(block.body, block.start).map((value) => ({
        name: value.name,
        args: value.args,
        line: lineAt(starts, value.offset) + 1
      }))
      if (values.length > 0) entry.enum_values = values
    }
    classes.push(entry)
  }

  /** @type {object[]} */
  const fields = []
  for (const matched of text.matchAll(FIELD_RE)) {
    if (fields.length >= MAX_FIELDS) break
    const type = collapse(matched[2])
    if (!isPlausibleType(type)) continue
    const header = matched[0]
    const name = matched[3]
    const base = matched.index ?? 0
    const index = lineAt(starts, base)
    const { names, args } = annotationsAbove(lines, index, header)
    const doc = commentAbove(lines, index)
    // Only a `static final` field is a constant; a plain field's initializer is
    // just a default value and would only add noise.
    const constant = /\bstatic\b/.test(matched[1]) && /\bfinal\b/.test(matched[1])
    fields.push({
      name,
      type,
      comment: doc !== '' ? doc : schemaText(args),
      column: columnText(args),
      value: constant ? truncate(collapse(matched[4] ?? ''), VALUE_MAX) : '',
      annotations: names,
      annotation_args: args,
      line: declarationLine(starts, base, header, name)
    })
  }

  /** @type {object[]} */
  const constructors = []
  for (const matched of text.matchAll(CONSTRUCTOR_RE)) {
    if (constructors.length >= MAX_CONSTRUCTORS) break
    const header = matched[0]
    const name = matched[2]
    // Without a return type any `foo(…) {` looks like a constructor, so only the
    // names this file actually declares are accepted.
    if (!classNames.has(name)) continue
    const base = matched.index ?? 0
    const index = lineAt(starts, base)
    const { names, args } = annotationsAbove(lines, index, header)
    constructors.push({
      name,
      parameters: parseParameters(matched[3] ?? ''),
      annotations: names,
      annotation_args: args,
      line: declarationLine(starts, base, header, name)
    })
  }

  /** @type {object[]} */
  const methods = []
  /** @type {object[]} */
  const logicDetails = []
  for (const matched of text.matchAll(METHOD_RE)) {
    if (methods.length >= MAX_METHODS) break
    const type = collapse(matched[2])
    if (!isPlausibleType(type)) continue
    const header = matched[0]
    const name = matched[3]
    if (JAVA_KEYWORDS.has(name)) continue
    const base = matched.index ?? 0
    const offset = base + header.length
    const index = lineAt(starts, base)

    // A `;` before the next `{` means an abstract / interface method.
    const semi = text.indexOf(';', offset)
    const brace = text.indexOf('{', offset)
    const block = semi >= 0 && (brace < 0 || semi < brace) ? null : scanBlock(text, offset)

    const body = block?.body ?? ''
    const doc = commentAbove(lines, index)
    const dependencies = collectDependencies(body)
    const { names, args } = annotationsAbove(lines, index, header)
    methods.push({
      name,
      parameters: parseParameters(matched[4] ?? ''),
      return_type: type,
      logic_summary: doc !== '' ? doc : firstStatement(body),
      key_dependencies: dependencies,
      annotations: names,
      annotation_args: args,
      line: declarationLine(starts, base, header, name)
    })

    if (body !== '' && logicDetails.length < MAX_DETAILS_PER_FILE) {
      // block.start is the absolute offset of `body`, so every rule can carry
      // the line of its own `if` and be jumped to directly.
      logicDetails.push(...collectRules(body, name, block?.start, starts))
    }
  }

  /** @type {{to: string, kind: string}[]} */
  const relations = []
  /** @type {Set<string>} */
  const seen = new Set()
  for (const item of classes) {
    addRef(relations, seen, item.extends, 'extends')
    for (const target of item.implements) addRef(relations, seen, target, 'implements')
  }
  for (const field of fields) {
    for (const target of typeNames(field.type)) addRef(relations, seen, target, 'field')
  }
  for (const method of methods) {
    for (const target of typeNames(method.return_type)) addRef(relations, seen, target, 'return')
    for (const parameter of method.parameters) {
      for (const target of typeNames(parameterType(parameter))) addRef(relations, seen, target, 'parameter')
    }
  }

  return {
    package: PACKAGE_RE.exec(text)?.[1] ?? '',
    imports,
    classes,
    fields,
    constructors,
    methods,
    relations: relations.slice(0, MAX_RELATIONS),
    logic_details: logicDetails.slice(0, MAX_DETAILS_PER_FILE)
  }
}

// ---------------------------------------------------------------------------
// MyBatis XML
// ---------------------------------------------------------------------------

/**
 * `<select|insert|update|delete …>` inside a mapper file.
 *
 * The whole tag is captured, not just what precedes `id`: `resultType` and
 * `parameterType` are conventionally written after `id`, and a pattern that
 * stops at `id` silently loses them.
 */
const STATEMENT_RE = /<(select|insert|update|delete)\s+([^>]*?)\/?>/gi

/**
 * Extract the entry for a MyBatis mapper file.
 *
 * Statement ids are the project's real "core logic" for persistence: which
 * query backs which method. They are the reason a Mapper XML is worth indexing
 * at all, so each one becomes a `logic_details` rule.
 *
 * The namespace is kept as its own field, not just baked into a summary string:
 * it is the fully-qualified name of the Mapper interface, and it is the only
 * thing that ties the XML to the Java file that declares those statements.
 *
 * @param {string} source - file text.
 * @param {string} relPath - path relative to the project root.
 * @returns {object | null} the entry, or null when this is not a mapper.
 */
export function parseXmlMapper(source, relPath) {
  const text = source.replace(/^\uFEFF/, '')
  if (!/<mapper\b/i.test(text)) return null
  const namespace = /<mapper\b[^>]*namespace\s*=\s*"([^"]+)"/i.exec(text)?.[1] ?? ''
  const starts = lineStarts(text)

  /** @type {object[]} */
  const details = []
  for (const matched of text.matchAll(STATEMENT_RE)) {
    if (details.length >= MAX_DETAILS_PER_FILE) break
    const tag = matched[1].toLowerCase()
    const attributes = matched[2]
    const id = /\bid\s*=\s*"([^"]+)"/.exec(attributes)?.[1] ?? ''
    // Without an id there is nothing to call the statement, and MyBatis would
    // not load it either — `<selectKey>` and friends are skipped this way.
    if (id === '') continue
    const start = (matched.index ?? 0) + matched[0].length
    const close = text.indexOf('</', start)
    const sql = collapse(text.slice(start, close < 0 ? Math.min(start + 400, text.length) : close))
    details.push({
      rule_name: `${tag}:${id}`,
      description: truncate(`${namespace === '' ? '' : `${namespace.split('.').pop()}.`}${id} — ${sql}`, LOGIC_MAX),
      statement: tag,
      id,
      result_type: /\bresultType\s*=\s*"([^"]+)"/.exec(attributes)?.[1] ?? '',
      parameter_type: /\bparameterType\s*=\s*"([^"]+)"/.exec(attributes)?.[1] ?? '',
      line: lineAt(starts, matched.index ?? 0) + 1
    })
  }

  return {
    package: namespace,
    imports: [],
    classes:
      namespace === ''
        ? []
        : [
            {
              name: namespace.split('.').pop() ?? namespace,
              kind: 'mapper',
              extends: '',
              implements: [],
              annotations: ['MyBatisMapper'],
              annotation_args: { namespace },
              line: lineAt(starts, /<mapper\b/.exec(text)?.index ?? 0) + 1,
              summary: `MyBatis Mapper · namespace ${namespace}`
            }
          ],
    fields: [],
    constructors: [],
    methods: [],
    relations: [],
    logic_details: details
  }
}

/**
 * The `content_logic_index` entry for any file, or null when the file carries
 * no structure worth indexing.
 *
 * @param {string} source - file text.
 * @param {string} relPath - path relative to the project root.
 * @returns {object | null} the entry, or null.
 */
export function extractContentLogic(source, relPath) {
  const language = languageOf(relPath)
  if (language === 'Java') {
    const entry = parseJavaSource(source, relPath)
    // A file that only declares constants still carries its literals, and those
    // literals are often the whole point of the file (`WipConstant`), so a
    // non-empty `fields` keeps it in the index too.
    const empty =
      entry.classes.length === 0 &&
      entry.methods.length === 0 &&
      entry.constructors.length === 0 &&
      entry.fields.length === 0
    return empty ? null : entry
  }
  if (language === 'XML') return parseXmlMapper(source, relPath)
  return null
}

// ---------------------------------------------------------------------------
// summaries
// ---------------------------------------------------------------------------

/**
 * A structural one-liner for an undocumented Java declaration.
 *
 * @param {string[]} lines - file split on newlines.
 * @param {number} startIndex - line of the first declaration / annotation.
 * @returns {string} e.g. `interface AttendanceService`, or `''`.
 */
function javaHeaderSummary(lines, startIndex) {
  for (let index = startIndex; index < Math.min(startIndex + 20, lines.length); index += 1) {
    const line = lines[index].trim()
    const matched = /^(?:(?:public|protected|private|static|final|abstract|sealed|strictfp)\s+)*(class|interface|enum|record)\s+([\w$]+)([^{;]*)/.exec(line)
    if (matched === null) continue
    const heritage = parseHeritage(matched[3] ?? '')
    return [
      `${matched[1]} ${matched[2]}`,
      heritage.extends.length > 0 ? `extends ${heritage.extends.join(', ')}` : '',
      heritage.implements.length > 0 ? `implements ${heritage.implements.join(', ')}` : ''
    ]
      .filter((part) => part !== '')
      .join(' ')
  }
  return ''
}

/**
 * One-line summary for a file, used in `directory_index`.
 *
 * Prefers a leading comment block, then a `<mapper namespace>`, then the first
 * non-blank line. Purely structural: the listener has no model to ask.
 *
 * @param {string} source - file text.
 * @param {string} relPath - path relative to the project root.
 * @returns {string} at most `SUMMARY_MAX` characters.
 */
export function summarizeFile(source, relPath) {
  const text = source.replace(/^\uFEFF/, '')
  const language = languageOf(relPath)

  if (language === 'XML') {
    const namespace = /<mapper\b[^>]*namespace\s*=\s*"([^"]+)"/i.exec(text)?.[1]
    if (namespace !== undefined) return truncate(`MyBatis Mapper · ${namespace}`)
  }

  const lines = text.split('\n')
  if (language === 'Java') {
    const first = lines.findIndex((line) => /^[ \t]*@|^[ \t]*(?:public|protected|private|abstract|final)\b|^[ \t]*(?:class|interface|enum|record)\b/.test(line))
    if (first >= 0) {
      const doc = commentAbove(lines, first)
      if (doc !== '') return truncate(doc)
      // No Javadoc. Describe the declaration itself rather than falling through
      // to the first non-blank line, which for an undocumented interface is
      // `package com.demo.service;` — technically the first line, useless as a
      // summary.
      const header = javaHeaderSummary(lines, first)
      if (header !== '') return truncate(header)
    }
  }

  // A leading comment block, in whichever syntax the file uses.
  const head = []
  for (const line of lines.slice(0, 40)) {
    const trimmed = line.trim()
    if (trimmed === '') {
      if (head.length > 0) break
      continue
    }
    const isComment =
      trimmed.startsWith('//') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('--') ||
      trimmed.startsWith('<!--')
    if (!isComment) {
      if (head.length > 0) break
      return truncate(trimmed)
    }
    head.push(trimmed)
    if (trimmed.includes('*/') || trimmed.includes('-->')) break
  }
  if (head.length > 0) {
    const cleaned = cleanComment(head.join('\n'))
    if (cleaned !== '') return truncate(cleaned)
  }

  const firstContent = lines.map((line) => line.trim()).find((line) => line !== '')
  return truncate(firstContent ?? '')
}

/**
 * Structural summary for one directory.
 *
 * @param {string} relDir - directory path relative to the project root.
 * @param {object[]} children - its file entries.
 * @returns {string} the summary.
 */
export function summarizeDirectory(relDir, children) {
  const counts = new Map()
  for (const child of children) {
    counts.set(child.language, (counts.get(child.language) ?? 0) + 1)
  }
  const languages = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 4)
    .map(([language, count]) => `${language} ${count}`)
    .join('、')
  const label = relDir === '.' ? '项目根目录' : relDir
  return truncate(`${label}：${children.length} 个文件（${languages}）`)
}

// ---------------------------------------------------------------------------
// agent rules (the fourth block)
// ---------------------------------------------------------------------------
//
// The spec body, the AGENTS.md files and this plugin's own config are *rules*,
// and v2 of the index knew nothing about them: the model had to guess where the
// spec lived and re-read tens of KB of Markdown to answer "what does §十四 say
// about deleting a file". They are indexed here instead, split by heading, so a
// keyword query lands on the section that answers it.

/** This module's own directory, i.e. the plugin's install directory. */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * Absolute path of the spec body.
 *
 * Deliberately a path join rather than `specPath()` from `./index.js`: that
 * module imports this one, so importing it back would close a cycle. The
 * relative location is fixed by the package layout, and `verify.mjs` already
 * asserts `assets/wip-codegen/system-prompt.md` is present, so the join is safe.
 */
const SPEC_ABSOLUTE = join(PLUGIN_DIR, 'assets', 'wip-codegen', 'system-prompt.md')

/** This plugin's own configuration, indexed as `plugin-config`. */
const PLUGIN_CONFIG_FILES = ['package.json', 'cordis.patch.yml', 'persona-hot.js']

/**
 * Whether `absolute` sits under `root`.
 *
 * Compared case-insensitively on purpose: the path arrives from the working
 * directory service on Windows, where `C:\Foo` and `c:\foo` are one directory.
 *
 * @param {string} root - project root.
 * @param {string} absolute - candidate absolute path.
 * @returns {boolean} true when the path is inside the project.
 */
function isInsideRoot(root, absolute) {
  const base = toPosix(root).toLowerCase()
  const target = toPosix(absolute).toLowerCase()
  return target === base || target.startsWith(`${base}/`)
}

/**
 * The `§`-prefixed form of a chapter heading.
 *
 * The spec writes its chapters as `## 十四、强制交互流程：先确认，再落地`, while
 * every reference to one — and the model's own queries — says `§十四`. Storing
 * the `§` form is what makes `queryIndex(index, '§十四')` land at all.
 *
 * @param {string} title - heading text, `#` marks already stripped.
 * @returns {string} e.g. `§十四 强制交互流程：先确认，再落地`.
 */
function sectionTitle(title) {
  const matched = /^([一二三四五六七八九十百]+)、\s*(.*)$/.exec(title)
  if (matched === null) return title
  return `§${matched[1]} ${matched[2]}`.trim()
}

/**
 * The words worth matching a section by.
 *
 * Chinese runs and camelCase / UPPER_CASE identifiers only: those are what a
 * query is actually typed as (`导出`, `askUserQuestion`, `INDEX_VERSION`).
 * Chinese gets the first eight slots, so a section full of prose still reports
 * the identifiers it mentions.
 *
 * @param {string} text - section title plus body.
 * @returns {string[]} at most `MAX_SECTION_KEYWORDS` unique words.
 */
function sectionKeywords(text) {
  const flat = collapse(text)
  /** @type {string[]} */
  const words = []
  const seen = new Set()
  /** @param {string} word @returns {boolean} whether it was kept */
  const add = (word) => {
    if (word.length < 2 || seen.has(word) || words.length >= MAX_SECTION_KEYWORDS) return false
    seen.add(word)
    words.push(word)
    return true
  }
  let chinese = 0
  for (const matched of flat.matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
    if (chinese >= 8) break
    if (add(matched[0])) chinese += 1
  }
  for (const matched of flat.matchAll(/[A-Za-z][A-Za-z0-9]*(?:[A-Z][A-Za-z0-9]*)+/g)) add(matched[0])
  for (const matched of flat.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)) add(matched[0])
  return words
}

/**
 * Split Markdown into heading-delimited sections.
 *
 * Only `#`, `##` and `###` start a section: `####` is a detail *inside* one, and
 * splitting on it would shred the spec's tables into fragments. Text before the
 * first heading is dropped — it is a preamble, not a rule.
 *
 * @param {string} source - Markdown text.
 * @returns {{title: string, line: number, text: string, keywords: string[]}[]} sections.
 */
function splitMarkdownSections(source) {
  const lines = String(source ?? '').replace(/^\uFEFF/, '').split('\n')
  /** @type {{title: string, line: number, body: string[]}[]} */
  const raw = []
  /** @type {{title: string, line: number, body: string[]} | null} */
  let current = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (SECTION_RE.test(line)) {
      current = { title: sectionTitle(line.replace(/^#{1,3}\s+/, '').trim()), line: index + 1, body: [] }
      raw.push(current)
      continue
    }
    if (current !== null) current.body.push(line)
  }
  return raw.slice(0, MAX_RULE_SECTIONS).map((item) => {
    const text = truncate(item.body.join('\n'), RULE_SECTION_MAX)
    return { title: item.title, line: item.line, text, keywords: sectionKeywords(`${item.title} ${text}`) }
  })
}

/**
 * One-line summary for a rules file.
 *
 * Markdown is summarised by its first non-blank line with the `#` marks
 * stripped — `# DSH 创造模式 Agent 提示词…` is the title, not a comment — and
 * `package.json` by its own `name` + `description`, because its first line is
 * `{` and says nothing. Everything else falls back to `summarizeFile`, which
 * already understands leading comment blocks.
 *
 * @param {string} source - file text.
 * @param {string} relPath - path used for the language guess.
 * @returns {string} at most `SUMMARY_MAX` characters.
 */
function ruleSummary(source, relPath) {
  const text = source.replace(/^\uFEFF/, '')
  const language = languageOf(relPath)
  if (language === 'JSON') {
    try {
      const parsed = JSON.parse(text)
      const parts = [
        typeof parsed?.name === 'string' ? parsed.name : '',
        typeof parsed?.description === 'string' ? truncate(parsed.description, 160) : ''
      ].filter((part) => part !== '')
      if (parts.length > 0) return truncate(parts.join('：'))
    } catch {
      /* not JSON after all — fall through to the first line */
    }
  }
  if (language === 'Markdown') {
    const first = text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '')
    if (first !== undefined) return truncate(first.replace(/^#{1,6}\s*/, ''))
  }
  return summarizeFile(source, relPath)
}

/**
 * Markdown files under one directory, as paths relative to the project root.
 *
 * @param {string} directory - directory to walk.
 * @param {string} prefix - its path relative to the project root.
 * @param {string[]} out - collector, appended to.
 * @returns {Promise<void>} resolves when the walk is done.
 */
async function collectMarkdown(directory, prefix, out) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (isSkippedSegment(entry.name)) continue
    const rel = `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      await collectMarkdown(join(directory, entry.name), rel, out)
      continue
    }
    if (entry.isFile() && /\.md$/i.test(entry.name)) out.push(rel)
  }
}

/**
 * Every file the rules block covers.
 *
 * In order: the spec body, this plugin's config, the global `AGENTS.md`
 * (whichever of `DSH_HOME` / `DSH_AGENTS_HOME` exists), the `AGENTS.md` of each
 * directory from the project root up to the `.git` root, and the project's own
 * Markdown (`docs/**` plus the root's `*.md`).
 *
 * A missing file is skipped, never an error: a project without `AGENTS.md` and a
 * machine without `DSH_HOME` are both normal. The walk is separate from
 * `walkSourceFiles` on purpose — that one skips every dot-segment (`.dsh`) and
 * knows nothing about files outside the project, and both are exactly what this
 * block needs.
 *
 * @param {string} root - project root.
 * @returns {Promise<{key: string, absolute: string, kind: string, path: string, external: boolean}[]>} candidates.
 */
async function collectAgentRuleFiles(root) {
  /** @type {{key: string, absolute: string, kind: string, path: string, external: boolean}[]} */
  const files = []
  const seen = new Set()
  const base = toPosix(root)

  /**
   * @param {string} absolute - file on disk.
   * @param {string} kind - `spec` / `global-agents` / `project-agents` / `plugin-config` / `doc`.
   * @returns {void}
   */
  const add = (absolute, kind) => {
    if (typeof absolute !== 'string' || absolute === '' || !existsSync(absolute)) return
    const posix = toPosix(absolute)
    const external = !isInsideRoot(root, absolute)
    // External entries are keyed by their absolute path behind an `external:`
    // prefix: `AGENTS.md` exists both globally and per project, and a bare
    // relative key would make the two collide in `file-cache.json`.
    const path = external ? posix : posix.slice(base.length + 1)
    const key = external ? `external:${posix}` : path
    if (seen.has(key)) return
    seen.add(key)
    files.push({ key, absolute, kind, path, external })
  }

  add(SPEC_ABSOLUTE, 'spec')
  for (const name of PLUGIN_CONFIG_FILES) add(join(PLUGIN_DIR, name), 'plugin-config')

  for (const variable of ['DSH_HOME', 'DSH_AGENTS_HOME']) {
    const home = process.env[variable]
    if (typeof home === 'string' && home !== '') add(join(home, 'AGENTS.md'), 'global-agents')
  }

  // The project's own AGENTS.md, from the working root up to the repository
  // root. Today only the global one exists; the loop is what makes a future
  // per-repository file show up without touching this function again.
  const repositoryRoot = toPosix(findProjectRoot(root)).toLowerCase()
  let directory = root
  for (let depth = 0; depth < 64; depth += 1) {
    add(join(directory, 'AGENTS.md'), 'project-agents')
    if (toPosix(directory).toLowerCase() === repositoryRoot) break
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }

  /** @type {string[]} */
  const markdown = []
  await collectMarkdown(join(root, 'docs'), 'docs', markdown)
  for (const rel of markdown) add(join(root, ...rel.split('/')), 'doc')

  try {
    const top = await readdir(root, { withFileTypes: true })
    for (const entry of top) {
      if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue
      add(join(root, entry.name), 'doc')
    }
  } catch {
    /* an unreadable root is not a build failure */
  }
  return files
}

/**
 * Find a rules entry by path, exact or as a suffix, optionally narrowed to the
 * sections matching one word.
 *
 * @param {object} index - a built index.
 * @param {string} wanted - path as the caller typed it.
 * @param {string} [symbol] - section title, or a word appearing in one.
 * @returns {object|null} the entry, or null when no rules file matches.
 */
function readRuleEntry(index, wanted, symbol) {
  const rules = index.agent_rules_index ?? {}
  const keys = Object.keys(rules)
  const pathOf = (key) => toPosix(rules[key]?.path ?? '')
  const key =
    keys.find((candidate) => candidate === wanted) ??
    keys.find((candidate) => pathOf(candidate) === wanted) ??
    keys.find((candidate) => candidate.endsWith(`/${wanted}`) || pathOf(candidate).endsWith(`/${wanted}`)) ??
    keys.find((candidate) => pathOf(candidate).endsWith(wanted)) ??
    null
  if (key === null) return null
  const entry = rules[key]
  const needle = collapse(symbol ?? '').toLowerCase()
  if (needle === '') return entry
  const sections = (entry.sections ?? []).filter(
    (section) =>
      collapse(section.title).toLowerCase().includes(needle) ||
      collapse(section.text).toLowerCase().includes(needle) ||
      (section.keywords ?? []).some((word) => collapse(word).toLowerCase().includes(needle))
  )
  // A symbol that matches no section returns the whole file: an empty answer
  // reads as "this file says nothing about it", which is the worse lie.
  if (sections.length === 0) return entry
  return { ...entry, sections }
}

/** Chinese label for an `agent_rules_index` kind. */
function ruleKindLabel(kind) {
  if (kind === 'spec') return '规范正文'
  if (kind === 'global-agents') return '全局约定'
  if (kind === 'project-agents') return '项目约定'
  if (kind === 'plugin-config') return '插件配置'
  if (kind === 'doc') return '文档'
  return '规范'
}

/**
 * Render a rules entry's sections, for `formatRead`.
 *
 * @param {object} rule - an `agent_rules_index` entry.
 * @returns {string[]} lines, without the file header.
 */
function ruleSectionLines(rule) {
  const external = rule.external === true ? ' · 项目外' : ''
  const lines = [`规范类型：${ruleKindLabel(rule.kind)}${external} · ${rule.size} 字节`]
  const sections = rule.sections ?? []
  if (sections.length === 0) {
    lines.push('该文件没有分节（只有 Markdown 按标题切分）。')
    return lines
  }
  lines.push(`分节 ${sections.length} 个：`)
  for (const section of sections) {
    lines.push(`- ${section.title}（第 ${section.line} 行）`)
    if (section.text !== '') lines.push(`  ${section.text}`)
    if ((section.keywords ?? []).length > 0) lines.push(`  关键词：${section.keywords.join('、')}`)
  }
  return lines
}

/**
 * Count rules entries per kind, for the status line.
 *
 * @param {Record<string, object>} rules - the `agent_rules_index` block.
 * @returns {Record<string, number>} kind → count.
 */
function countRuleKinds(rules) {
  /** @type {Record<string, number>} */
  const counts = {}
  for (const entry of Object.values(rules)) {
    const kind = typeof entry?.kind === 'string' ? entry.kind : 'unknown'
    counts[kind] = (counts[kind] ?? 0) + 1
  }
  return counts
}

// ---------------------------------------------------------------------------
// building
// ---------------------------------------------------------------------------

/**
 * Join the entries to each other, once every file has been parsed.
 *
 * A single file cannot answer "who uses this", so the references collected
 * during parsing are resolved here against the whole project: a simple name
 * becomes a path, a MyBatis namespace becomes the Java interface that declares
 * those statements, and that interface gets a pointer back at its XML. What
 * comes out is the chain the model actually needs — Service → Mapper → XML —
 * without reading any of the three files.
 *
 * Resolution is by name, so it can only ever be a hint: two classes with the
 * same simple name in different packages resolve to whichever was indexed
 * first, and an import wins over that guess whenever the file has one.
 *
 * @param {Record<string, object>} contentLogic - entries keyed by relative path.
 */
export function buildRelations(contentLogic) {
  /** @type {Map<string, string>} fully-qualified name → path. */
  const byQualified = new Map()
  /** @type {Map<string, string>} simple name → path, first wins. */
  const bySimple = new Map()

  for (const [rel, entry] of Object.entries(contentLogic)) {
    for (const item of entry.classes ?? []) {
      if (typeof item.name !== 'string' || item.name === '') continue
      if (!bySimple.has(item.name)) bySimple.set(item.name, rel)
      const qualified = entry.package === '' ? item.name : `${entry.package}.${item.name}`
      if (!byQualified.has(qualified)) byQualified.set(qualified, rel)
    }
  }

  // Mapper XML → the interface it implements. The namespace is that interface's
  // fully-qualified name, which is the one hard link between the two files.
  for (const [rel, entry] of Object.entries(contentLogic)) {
    const namespace = typeof entry.package === 'string' ? entry.package : ''
    if (namespace === '' || !rel.toLowerCase().endsWith('.xml')) continue
    const target = byQualified.get(namespace)
    if (target === undefined || target === rel) continue
    entry.mapper_interface = target
    const java = contentLogic[target]
    if (java !== undefined) java.mapper_xml = rel
  }

  for (const entry of Object.values(contentLogic)) {
    const imports = Array.isArray(entry.imports) ? entry.imports : []
    const relations = Array.isArray(entry.relations) ? entry.relations : []
    for (const relation of relations) {
      // Entries reused from a previous build still carry the path they resolved
      // to last time; it is dropped first so a deleted file cannot leave a
      // pointer to itself behind.
      delete relation.path
      const qualified = imports.find((item) => item === relation.to || item.endsWith(`.${relation.to}`))
      const target = qualified === undefined ? bySimple.get(relation.to) : byQualified.get(qualified)
      if (target !== undefined) relation.path = target
    }
  }
}

// ---------------------------------------------------------------------------
// sharding: one 10 MB file became a directory
// ---------------------------------------------------------------------------
//
// A single index for a mid-sized Java project passes 10 MB, and no model should
// ever have to read that. The layout is now a lookup table plus shards:
//
//   .dsh/index/master_index.json   project_meta + the macro directory tree +
//                                  the shard manifest (~30 KB, always cheap)
//   .dsh/index/shards/*.json       the per-file entries, one shard per business
//                                  area, each capped at SHARD_MAX_BYTES
//   .dsh/index/logic_rules.json    every file's business rules, on their own
//   .dsh/index/agent_rules.json    the Agent's own rules, sliced per heading
//
// Reading is a three-step lookup: master for the shape, one shard for the file,
// then `read` with a line offset for the ~50 lines that matter. The in-memory
// shape is unchanged, so every reader below still sees one `index` object.

/**
 * Business area a file belongs to, which decides its shard.
 *
 * Order matters: `service/impl/` must be tested before `service/`, and
 * `domain/vo/req/` before `domain/vo/`.
 *
 * @param {string} relPath - path relative to the project root.
 * @returns {string} the group name.
 */
export function shardOf(relPath) {
  const path = toPosix(relPath)
  if (/\/domain\/entity\//.test(path)) return 'entity'
  if (/\/service\/impl\//.test(path)) return 'service_impl'
  if (/\/service\//.test(path)) return 'service'
  if (/\/controller\//.test(path)) return 'controller'
  if (/\/mapper\//.test(path) || /src\/main\/resources\/mapper\//.test(path)) return 'mapper'
  if (/\/domain\/vo\/req\//.test(path)) return 'req'
  if (/\/domain\/vo\/rep\//.test(path)) return 'rep'
  if (/\/domain\/vo\//.test(path)) return 'vo'
  if (/\/domain\/dto\//.test(path)) return 'dto'
  return 'other'
}

/**
 * Drop structurally empty values, keep meaningful falsy ones.
 *
 * `0`, `false` and `''` carry meaning (`is_delete: 0`, an empty comment that
 * says "no comment"), so only `null`, `undefined`, `[]` and `{}` go.
 */
function pruneValue(value) {
  if (value === null || value === undefined) return undefined
  if (Array.isArray(value)) {
    const kept = value.map(pruneValue).filter((item) => item !== undefined)
    return kept.length === 0 ? undefined : kept
  }
  if (typeof value === 'object') {
    const kept = {}
    for (const key of Object.keys(value)) {
      const pruned = pruneValue(value[key])
      if (pruned !== undefined) kept[key] = pruned
    }
    return Object.keys(kept).length === 0 ? undefined : kept
  }
  return value
}

/** One shard payload: entries under `files`, freshness evidence under `meta`. */
function shardPayload(records) {
  const files = {}
  const meta = {}
  for (const record of records) {
    meta[record.rel] = record.meta
    if (record.logic !== null) files[record.rel] = record.logic
  }
  return { files, meta }
}

function shardBytes(records) {
  return Buffer.byteLength(JSON.stringify(shardPayload(records)), 'utf8')
}

/**
 * Last-resort split: one directory that cannot be divided any further.
 *
 * Measured in *payload* bytes, not record bytes: a record's path appears twice
 * in the payload (once as a `files` key, once as a `meta` key), and a shard
 * measured on the single occurrence lands a few KB above the ceiling.
 */
function chunkRecords(records, limit) {
  const parts = []
  let current = []
  let currentBytes = 0
  for (const record of records) {
    const bytes = Buffer.byteLength(JSON.stringify(shardPayload([record])), 'utf8')
    if (currentBytes + bytes > limit && current.length > 0) {
      parts.push(current)
      current = []
      currentBytes = 0
    }
    current.push(record)
    currentBytes += bytes
  }
  if (current.length > 0) parts.push(current)
  return parts
}

/**
 * Split records until every part fits, by path prefix first.
 *
 * Prefix splitting keeps a shard answerable by name — `service_impl.wip-service`
 * reads as "the wip-service service implementations" — so the fallback to
 * size-based chunks is only reached for a single directory that is itself too
 * large (142 service impls under one package, for instance).
 */
function splitRecords(prefix, records, limit) {
  if (shardBytes(records) <= limit) return [{ prefix, records }]
  const groups = new Map()
  for (const record of records) {
    const rest = prefix === '' ? record.rel : record.rel.slice(prefix.length + 1)
    const cut = rest.indexOf('/')
    const segment = cut === -1 ? '(leaf)' : rest.slice(0, cut)
    if (!groups.has(segment)) groups.set(segment, [])
    groups.get(segment).push(record)
  }
  if (groups.size < 2) {
    return chunkRecords(records, limit).map((part, index) => ({
      prefix: prefix === '' ? `~${index + 1}` : `${prefix}~${index + 1}`,
      records: part
    }))
  }
  const parts = []
  for (const segment of [...groups.keys()].sort()) {
    const childPrefix =
      segment === '(leaf)' ? prefix : prefix === '' ? segment : `${prefix}/${segment}`
    parts.push(...splitRecords(childPrefix, groups.get(segment), limit))
  }
  return parts
}

/**
 * Lay the in-memory index out as a master file plus shards.
 *
 * @param {object} index - a built index.
 * @param {number} [limit] - shard ceiling in bytes.
 * @returns {{master: object, shards: object[], logicRules: object, agentRules: object}} the layout.
 */
export function buildShards(index, limit = SHARD_MAX_BYTES) {
  const logic = index.content_logic_index ?? {}
  const logicRules = {}
  const byGroup = new Map()

  for (const directory of index.directory_index ?? []) {
    for (const child of directory.children ?? []) {
      const entry = logic[child.path] ?? null
      let pruned = null
      if (entry !== null) {
        const copy = { ...entry }
        if (Array.isArray(copy.logic_details) && copy.logic_details.length > 0) {
          logicRules[child.path] = copy.logic_details
        }
        delete copy.logic_details
        pruned = pruneValue(copy) ?? {}
      }
      const group = shardOf(child.path)
      if (!byGroup.has(group)) byGroup.set(group, [])
      byGroup.get(group).push({
        rel: child.path,
        meta: pruneValue({ language: child.language, summary: child.summary, hash: child.hash }) ?? {},
        logic: pruned
      })
    }
  }

  const shards = []
  for (const group of [...byGroup.keys()].sort()) {
    for (const part of splitRecords('', byGroup.get(group), limit)) {
      const name = part.prefix === '' ? group : `${group}.${part.prefix.replace(/[/~]/g, '_')}`
      shards.push({
        group,
        name,
        file: `${SHARDS_DIR}/${name}.json`,
        prefix: part.prefix,
        count: part.records.length,
        payload: shardPayload(part.records)
      })
    }
  }

  const master = {
    index_version: INDEX_VERSION,
    project_meta: index.project_meta ?? {},
    // The macro tree only: no file lists, no hashes. The per-file facts live in
    // the shards, so this file stays readable in one gulp no matter the size of
    // the project.
    directory_index: (index.directory_index ?? []).map((directory) => ({
      path: directory.path,
      file_count: (directory.children ?? []).length,
      summary: directory.summary ?? ''
    })),
    shards: shards.map((shard) => ({
      file: shard.file,
      group: shard.group,
      files: shard.count,
      bytes: Buffer.byteLength(JSON.stringify(shard.payload), 'utf8')
    })),
    agent_rules: AGENT_RULES_FILE,
    logic_rules: RULES_FILE
  }

  return { master, shards, logicRules, agentRules: index.agent_rules_index ?? {} }
}

/**
 * Rebuild the single in-memory index from the split files.
 *
 * Returns the same shape the readers already expect, so `queryIndex`,
 * `readIndexEntry`, `checkEntry` and the formatters needed no change.
 *
 * @param {object} paths - from `indexPaths`.
 * @returns {Promise<object|null>} the index, or null when nothing is on disk.
 */
export async function loadIndexFiles(paths) {
  const master = await readJson(paths.master)
  if (master === null) return null
  if (master.index_version !== INDEX_VERSION) return null

  const directoryIndex = (master.directory_index ?? []).map((directory) => ({
    path: directory.path,
    type: 'directory',
    summary: directory.summary ?? '',
    children: []
  }))
  const byDirectory = new Map(directoryIndex.map((entry) => [entry.path, entry]))
  const contentLogic = {}

  for (const shard of master.shards ?? []) {
    const payload = await readJson(join(paths.dir, ...String(shard.file).split('/')))
    if (payload === null) continue
    for (const [rel, entry] of Object.entries(payload.files ?? {})) contentLogic[rel] = entry
    for (const [rel, meta] of Object.entries(payload.meta ?? {})) {
      const directory = byDirectory.get(dirOf(rel))
      if (directory === undefined) continue
      directory.children.push({ path: rel, type: 'file', ...meta })
    }
  }
  for (const directory of directoryIndex) {
    directory.children.sort((left, right) => left.path.localeCompare(right.path))
  }

  const logicRules = (await readJson(paths.logicRules)) ?? {}
  for (const [rel, details] of Object.entries(logicRules)) {
    if (contentLogic[rel] === undefined) contentLogic[rel] = {}
    contentLogic[rel].logic_details = details
  }

  const sortedLogic = {}
  for (const key of Object.keys(contentLogic).sort()) sortedLogic[key] = contentLogic[key]

  return {
    project_meta: master.project_meta ?? {},
    directory_index: directoryIndex,
    content_logic_index: sortedLogic,
    agent_rules_index: (await readJson(paths.agentRules)) ?? {}
  }
}

/**
 * Write the split layout, and remove shards the new layout no longer has.
 *
 * Shard files are written compactly: an indented 800 KB shard becomes 1.4 MB
 * and breaks the very ceiling the split exists to respect. The master file
 * stays indented — it is small, and humans read it.
 *
 * @param {object} paths - from `indexPaths`.
 * @param {object} index - the built index.
 * @returns {Promise<{shards: number, removed: number}>} what was written.
 */
export async function writeIndexFiles(paths, index) {
  const layout = buildShards(index)
  mkdirSync(paths.shards, { recursive: true })
  await writeJsonAtomic(paths.master, layout.master)
  await writeJsonAtomic(paths.logicRules, layout.logicRules)
  await writeJsonAtomic(paths.agentRules, layout.agentRules)

  const keep = new Set()
  for (const shard of layout.shards) {
    keep.add(`${shard.name}.json`)
    await writeJsonAtomic(join(paths.shards, `${shard.name}.json`), shard.payload, { compact: true })
  }
  let removed = 0
  let present = []
  try {
    present = await readdir(paths.shards)
  } catch {
    present = []
  }
  for (const entry of present) {
    if (!entry.endsWith('.json') || keep.has(entry)) continue
    try {
      rmSync(join(paths.shards, entry))
      removed += 1
    } catch {
      /* another process got there first */
    }
  }
  return { shards: layout.shards.length, removed }
}

/**
 * An index with no content, used when nothing has been built yet.
 *
 * @param {string} projectName - value for `project_meta.project_name`.
 * @returns {object} an empty but structurally valid index.
 */
export function emptyIndex(projectName) {
  return {
    project_meta: {
      project_name: projectName,
      last_updated: '',
      file_count: 0,
      global_summary: '索引尚未构建。'
    },
    directory_index: [],
    content_logic_index: {},
    agent_rules_index: {}
  }
}

/**
 * Build (or incrementally refresh) the index for a project root.
 *
 * Reuse rules, in order of cost:
 * - `size` + `mtimeMs` unchanged → reuse the cached entry, no read at all;
 * - changed timestamp but identical `sha256` → reuse the cached entry (a
 *   `git checkout` or a `touch` rewrites mtimes without changing content);
 * - otherwise re-parse just that file.
 *
 * Files touched within `SETTLE_MS` are skipped for this round and keep their
 * previous entry: the spec's conflict rule, and the difference between a
 * half-written class and a stale one.
 *
 * @param {object} options - build inputs.
 * @param {string} options.root - project root.
 * @param {object | null} [options.previous] - the index read from disk.
 * @param {object | null} [options.previousCache] - the sidecar read from disk.
 * @param {number} [options.now] - clock override, for tests.
 * @param {boolean} [options.full] - ignore previous artefacts entirely.
 * @returns {Promise<{index: object, cache: object, parsed: number, reused: number, skipped: number, files: number}>} the artefacts.
 */
export async function buildProjectIndex(options) {
  const { root } = options
  const now = options.now ?? Date.now()
  const previous = options.full === true ? null : (options.previous ?? null)
  const previousCache = options.full === true ? null : (options.previousCache ?? null)

  const usableCache = previousCache?.version === INDEX_VERSION ? previousCache : null
  const previousEntries = previous?.content_logic_index ?? {}
  const cacheEntries = usableCache?.entries ?? {}

  const files = await walkSourceFiles(root)
  /** @type {Record<string, object>} */
  const contentLogic = {}
  /** @type {Map<string, object[]>} */
  const buckets = new Map()
  /** @type {Record<string, object>} */
  const nextEntries = {}

  let parsed = 0
  let reused = 0
  let skipped = 0
  let settling = 0

  for (const rel of files) {
    const absolute = join(root, ...rel.split('/'))
    let info
    try {
      info = await stat(absolute)
    } catch {
      skipped += 1
      continue
    }
    if (!info.isFile()) {
      skipped += 1
      continue
    }

    const cached = cacheEntries[rel]
    const unchanged = cached !== undefined && cached.size === info.size && cached.mtimeMs === info.mtimeMs

    let summary = ''
    let hash = ''
    if (unchanged) {
      summary = cached.summary ?? ''
      hash = cached.hash ?? ''
      nextEntries[rel] = cached
      if (previousEntries[rel] !== undefined) contentLogic[rel] = previousEntries[rel]
      reused += 1
    } else if (cached !== undefined && now - info.mtimeMs < SETTLE_MS) {
      // Mid-write: keep the previous entry rather than parse a torn file.
      //
      // Only for files the cache already knows. A file with no cache entry is
      // new — a fresh checkout, a `git clone`, the first build of a repository
      // — and refusing those would leave the index empty precisely when it is
      // most useful. Parsing a half-written *new* file costs one bad entry that
      // the watcher replaces a debounce later; skipping every new file costs
      // the whole index.
      summary = cached.summary ?? ''
      hash = cached.hash ?? ''
      nextEntries[rel] = cached
      if (previousEntries[rel] !== undefined) contentLogic[rel] = previousEntries[rel]
      skipped += 1
      settling += 1
    } else {
      let source
      try {
        source = await readFile(absolute, 'utf8')
      } catch {
        skipped += 1
        continue
      }
      if (source.includes('\u0000')) {
        skipped += 1
        continue
      }
      hash = createHash('sha256').update(source).digest('hex')
      const hashMatches = cached !== undefined && cached.hash === hash
      if (hashMatches && previousEntries[rel] !== undefined) {
        contentLogic[rel] = previousEntries[rel]
        reused += 1
      } else if (hashMatches) {
        reused += 1
      } else {
        const entry = extractContentLogic(source, rel)
        if (entry !== null) contentLogic[rel] = entry
        parsed += 1
      }
      summary = info.size > MAX_FILE_BYTES ? `（超过 ${Math.round(MAX_FILE_BYTES / 1024)} KB，未解析）` : summarizeFile(source, rel)
      nextEntries[rel] = { size: info.size, mtimeMs: info.mtimeMs, hash, summary }
    }

    const directory = dirOf(rel)
    const bucket = buckets.get(directory)
    // The hash travels WITH the index, not only in the sidecar: it is the
    // freshness evidence the model needs. A lease can only say "built recently";
    // a hash says "this exact file still has these exact bytes", which is what
    // makes an entry safe to trust and safe to edit against without re-reading.
    const child = { path: rel, type: 'file', language: languageOf(rel), summary, hash }
    if (bucket === undefined) buckets.set(directory, [child])
    else bucket.push(child)
  }

  // -------------------------------------------------------------------------
  // the fourth block: the Agent's own rules
  // -------------------------------------------------------------------------
  //
  // Reuse works exactly like the source loop above — an unchanged size+mtime
  // reuses the previous entry (sections and all), and so does a changed mtime
  // with an identical sha256. The cache entry is written only when the source
  // loop has not already written one for the same key: a project doc is walked
  // by both, and letting the rules pass overwrite it would make
  // `directory_index` summaries flap between builds.
  /** @type {Record<string, object>} */
  const agentRules = {}
  const ruleFiles = await collectAgentRuleFiles(root)
  const previousRules = previous?.agent_rules_index ?? {}

  for (const rule of ruleFiles) {
    let info
    try {
      info = await stat(rule.absolute)
    } catch {
      skipped += 1
      continue
    }
    if (!info.isFile()) {
      skipped += 1
      continue
    }

    const cached = cacheEntries[rule.key]
    const previousRule = previousRules[rule.key]
    const unchanged = cached !== undefined && cached.size === info.size && cached.mtimeMs === info.mtimeMs
    if (unchanged && previousRule !== undefined) {
      agentRules[rule.key] = previousRule
      if (nextEntries[rule.key] === undefined) nextEntries[rule.key] = cached
      reused += 1
      continue
    }
    if (cached !== undefined && previousRule !== undefined && now - info.mtimeMs < SETTLE_MS) {
      agentRules[rule.key] = previousRule
      if (nextEntries[rule.key] === undefined) nextEntries[rule.key] = cached
      skipped += 1
      settling += 1
      continue
    }

    let source
    try {
      source = await readFile(rule.absolute, 'utf8')
    } catch {
      skipped += 1
      continue
    }
    const hash = createHash('sha256').update(source).digest('hex')
    if (previousRule !== undefined && previousRule.hash === hash) {
      agentRules[rule.key] = previousRule
      if (nextEntries[rule.key] === undefined) {
        nextEntries[rule.key] =
          cached ?? { size: info.size, mtimeMs: info.mtimeMs, hash, summary: previousRule.summary ?? '' }
      }
      reused += 1
      continue
    }

    const language = languageOf(rule.path)
    const summary = ruleSummary(source, rule.path)
    agentRules[rule.key] = {
      kind: rule.kind,
      path: rule.path,
      external: rule.external,
      language,
      size: info.size,
      hash,
      summary,
      sections: language === 'Markdown' ? splitMarkdownSections(source) : []
    }
    if (nextEntries[rule.key] === undefined) {
      nextEntries[rule.key] = { size: info.size, mtimeMs: info.mtimeMs, hash, summary }
    }
    parsed += 1
  }

  /** @type {Record<string, object>} */
  const sortedRules = {}
  for (const key of Object.keys(agentRules).sort()) sortedRules[key] = agentRules[key]

  const directoryIndex = [...buckets.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([path, children]) => ({
      path,
      type: 'directory',
      summary: summarizeDirectory(path, children),
      children: children.sort((left, right) => left.path.localeCompare(right.path))
    }))

  const sortedLogic = {}
  for (const key of Object.keys(contentLogic).sort()) sortedLogic[key] = contentLogic[key]
  buildRelations(sortedLogic)

  const languageTotals = new Map()
  for (const entry of directoryIndex) {
    for (const child of entry.children) {
      languageTotals.set(child.language, (languageTotals.get(child.language) ?? 0) + 1)
    }
  }
  const topLanguages = [...languageTotals.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .map(([language, count]) => `${language} ${count}`)
    .join('、')

  const projectName = basename(root)
  const fileCount = directoryIndex.reduce((total, entry) => total + entry.children.length, 0)

  const index = {
    project_meta: {
      project_name: projectName,
      last_updated: new Date(now).toISOString(),
      file_count: fileCount,
      global_summary: truncate(
        `${projectName}：${directoryIndex.length} 个目录、${fileCount} 个文件；语言分布 ${topLanguages}；` +
          `逻辑条目 ${Object.keys(sortedLogic).length} 个（Java/XML）；规范条目 ${Object.keys(sortedRules).length} 个。` +
          `索引 v${INDEX_VERSION}，由 dsh-wip-codegen-agent 的后台监听器生成。`,
        400
      )
    },
    directory_index: directoryIndex,
    content_logic_index: sortedLogic,
    agent_rules_index: sortedRules
  }

  return {
    index,
    cache: { version: INDEX_VERSION, root, updated: new Date(now).toISOString(), entries: nextEntries },
    parsed,
    reused,
    skipped,
    settling,
    files: fileCount
  }
}

// ---------------------------------------------------------------------------
// querying
// ---------------------------------------------------------------------------

/** Score a candidate against the needle; higher is better, 0 means no hit. */
function score(text, needle) {
  if (text === undefined || text === null) return 0
  const haystack = String(text).toLowerCase()
  if (haystack === needle) return 100
  const cut = haystack.lastIndexOf('/')
  const leaf = cut < 0 ? haystack : haystack.slice(cut + 1)
  if (leaf === needle) return 90
  if (leaf.startsWith(needle)) return 70
  if (haystack.includes(needle)) return 40
  return 0
}

/**
 * ` · 第 N 行` for a hit label, or '' when the entry predates line numbers.
 *
 * A hit without a line still costs a grep to act on, so every label that can
 * carry one does.
 *
 * @param {number|undefined} line - 1-based line from the entry.
 * @returns {string} the suffix.
 */
function atLine(line) {
  return typeof line === 'number' ? ` · 第 ${line} 行` : ''
}

/**
 * Search the index by keyword.
 *
 * @param {object} index - a built index.
 * @param {string} query - keyword, matched case-insensitively.
 * @param {number} [limit] - maximum hits.
 * @returns {{kind: string, path: string, label: string, detail: string}[]} hits, best first.
 */
export function queryIndex(index, query, limit = 20) {
  const needle = collapse(query).toLowerCase()
  if (needle === '' || index === null || index === undefined) return []

  /** @type {{score: number, hit: object}[]} */
  const hits = []

  for (const directory of index.directory_index ?? []) {
    const directoryScore = score(directory.path, needle)
    if (directoryScore > 0) {
      hits.push({
        score: directoryScore,
        hit: {
          kind: 'directory',
          path: directory.path,
          label: directory.path,
          detail: directory.summary ?? ''
        }
      })
    }
    for (const child of directory.children ?? []) {
      const fileScore = score(child.path, needle)
      if (fileScore > 0) {
        hits.push({
          score: fileScore,
          hit: { kind: 'file', path: child.path, label: child.path, detail: child.summary ?? '' }
        })
      }
    }
  }

  for (const [path, entry] of Object.entries(index.content_logic_index ?? {})) {
    // How well the file's own classes match. A method or a rule whose class
    // matches is relevant too: asking for "AttendanceController" should list
    // what that controller does, not just its own line. Inheriting half the
    // class score keeps those hits below anything that matched by name.
    let ownerScore = 0
    for (const item of entry.classes ?? []) {
      const itemScore = score(item.name, needle)
      if (itemScore === 0) continue
      ownerScore = Math.max(ownerScore, Math.floor(itemScore / 2))
      hits.push({
        score: itemScore,
        hit: {
          kind: 'class',
          path,
          label: `${path} · ${item.name}${atLine(item.line)}`,
          detail: truncate(
            [
              item.extends === '' ? '' : `extends ${item.extends}`,
              (item.implements ?? []).length > 0 ? `implements ${item.implements.join(', ')}` : '',
              item.summary ?? ''
            ]
              .filter((part) => part !== '')
              .join(' · ')
          )
        }
      })
    }
    for (const item of entry.methods ?? []) {
      const itemScore = Math.max(score(item.name, needle), ownerScore)
      if (itemScore > 0) {
        hits.push({
          score: itemScore,
          hit: {
            kind: 'method',
            path,
            label: `${path} · ${item.name}(${(item.parameters ?? []).join(', ')})${atLine(item.line)}`,
            detail: truncate(`${item.return_type ?? ''} · ${item.logic_summary ?? ''}`)
          }
        })
      }
    }

    // An endpoint is looked up by its URL, a column by its column name, and a
    // constant by its literal — none of which appear in a name. Matching the
    // argument text is what makes those searches land at all.
    for (const item of [...(entry.classes ?? []), ...(entry.methods ?? [])]) {
      const args = item.annotation_args ?? {}
      for (const [annotation, value] of Object.entries(args)) {
        const itemScore = score(value, needle)
        if (itemScore === 0) continue
        hits.push({
          score: itemScore,
          hit: {
            kind: 'annotation',
            path,
            label: `${path} · @${annotation}(${truncate(value, 80)})`,
            detail: truncate(`${item.name ?? ''}${atLine(item.line)}`)
          }
        })
      }
    }
    for (const item of entry.fields ?? []) {
      const itemScore = Math.max(score(item.name, needle), score(item.column, needle), score(item.value, needle))
      if (itemScore === 0) continue
      hits.push({
        score: itemScore,
        hit: {
          kind: item.value === '' ? 'field' : 'constant',
          path,
          label: `${path} · ${item.name}${atLine(item.line)}`,
          detail: truncate(
            [item.column === '' ? '' : `${item.type} · 列 ${item.column}`, item.value === '' ? item.comment : item.value]
              .filter((part) => part !== '' && part !== undefined)
              .join(' · ')
          )
        }
      })
    }
    for (const item of entry.constructors ?? []) {
      const itemScore = score(item.name, needle)
      if (itemScore === 0) continue
      hits.push({
        score: Math.floor(itemScore / 2),
        hit: {
          kind: 'constructor',
          path,
          label: `${path} · ${item.name}(${(item.parameters ?? []).join(', ')})${atLine(item.line)}`,
          detail: '构造器'
        }
      })
    }
    // Interface constants and enum constants live on their class, because they
    // belong to it: `WipConstant.WORK_AREA_SET` is one declaration, not a
    // free-floating field.
    for (const item of entry.classes ?? []) {
      for (const constant of item.constants ?? []) {
        const itemScore = Math.max(score(constant.name, needle), score(constant.value, needle))
        if (itemScore === 0) continue
        hits.push({
          score: itemScore,
          hit: {
            kind: 'constant',
            path,
            label: `${path} · ${item.name}.${constant.name}${atLine(constant.line)}`,
            detail: truncate(`${constant.type} = ${constant.value}`, 120)
          }
        })
      }
      for (const value of item.enum_values ?? []) {
        const itemScore = Math.max(score(value.name, needle), score(value.args, needle))
        if (itemScore === 0) continue
        hits.push({
          score: itemScore,
          hit: {
            kind: 'constant',
            path,
            label: `${path} · ${item.name}.${value.name}${atLine(value.line)}`,
            detail: truncate(value.args === '' ? '枚举常量' : `枚举常量(${value.args})`, 120)
          }
        })
      }
    }
    for (const item of entry.logic_details ?? []) {
      const itemScore = Math.max(score(item.rule_name, needle), score(item.description, needle) > 0 ? 30 : 0, ownerScore)
      if (itemScore > 0) {
        hits.push({
          score: itemScore,
          hit: {
            kind: 'rule',
            path,
            label: `${path} · ${item.rule_name}${atLine(item.line)}`,
            detail: item.description ?? ''
          }
        })
      }
    }
  }

  // The Agent's own rules. A section is scored separately from its file: asking
  // for `导出` should land on §13.2, not merely on "the spec".
  for (const rule of Object.values(index.agent_rules_index ?? {})) {
    const pathScore = score(rule.path, needle)
    if (pathScore > 0) {
      hits.push({
        score: pathScore,
        hit: {
          kind: 'rule',
          path: rule.path,
          label: `${rule.path} · ${ruleKindLabel(rule.kind)}`,
          detail: truncate(rule.summary ?? '')
        }
      })
    }
    for (const section of rule.sections ?? []) {
      const titleScore = score(section.title, needle)
      const keywordHit = (section.keywords ?? []).some((word) => collapse(word).toLowerCase().includes(needle))
      const textHit = collapse(section.text).toLowerCase().includes(needle)
      const sectionScore = Math.max(titleScore, keywordHit ? 60 : 0, textHit ? 35 : 0)
      if (sectionScore === 0) continue
      hits.push({
        score: sectionScore,
        hit: {
          kind: 'rule-section',
          path: rule.path,
          label: `${rule.path} · ${section.title}${atLine(section.line)}`,
          detail: truncate(section.text)
        }
      })
    }
  }

  hits.sort((left, right) => right.score - left.score || left.hit.path.localeCompare(right.hit.path))
  return hits.slice(0, Math.max(1, limit)).map((entry) => entry.hit)
}

/**
 * Read one file's structured entry, optionally narrowed to one symbol.
 *
 * @param {object} index - a built index.
 * @param {string} relPath - path relative to the project root, exact or as a suffix.
 * @param {string} [symbol] - class or method name to narrow to.
 * @returns {{path: string, directory: string|null, file: object|null, logic: object|null}|null} the entry.
 */
export function readIndexEntry(index, relPath, symbol) {
  if (index === null || index === undefined) return null
  const wanted = toPosix(relPath)
  if (wanted === '') return null

  const logic = index.content_logic_index ?? {}
  const keys = Object.keys(logic)
  const key =
    keys.find((candidate) => candidate === wanted) ??
    keys.find((candidate) => candidate.endsWith(`/${wanted}`)) ??
    keys.find((candidate) => candidate.endsWith(wanted)) ??
    null

  if (key === null) {
    // Not a source file — but it may still be a rules entry (the spec, an
    // AGENTS.md, a doc). Those carry `sections` instead of classes and methods.
    const rule = readRuleEntry(index, wanted, symbol)
    if (rule !== null) {
      return {
        path: rule.path,
        directory: null,
        file: { path: rule.path, type: 'file', language: rule.language, summary: rule.summary, hash: rule.hash },
        logic: null,
        rule
      }
    }
  }

  const directory = (index.directory_index ?? []).find((entry) =>
    (entry.children ?? []).some((child) => child.path === (key ?? wanted))
  )
  const file = directory?.children.find((child) => child.path === (key ?? wanted)) ?? null
  let entry = key === null ? null : logic[key]

  const needle = collapse(symbol ?? '').toLowerCase()
  if (entry !== null && needle !== '') {
    const classHit = (entry.classes ?? []).some((item) => collapse(item.name).toLowerCase().includes(needle))
    if (!classHit) {
      // Spread, not a fresh object: package / imports / relations / constructors
      // describe the file, not the symbol, and dropping them here is what made
      // a narrowed read lose the very context it was asked for.
      entry = {
        ...entry,
        // A constant or enum value is named by the symbol too — `WORK_AREA_SET`
        // is what the caller typed, and the class holding it must survive the
        // filter even though the class name does not contain it.
        classes: (entry.classes ?? [])
          .map((item) => {
            const constants = (item.constants ?? []).filter((constant) =>
              collapse(constant.name).toLowerCase().includes(needle)
            )
            const enumValues = (item.enum_values ?? []).filter((value) =>
              collapse(value.name).toLowerCase().includes(needle)
            )
            const nameHit = collapse(item.name).toLowerCase().includes(needle)
            if (!nameHit && constants.length === 0 && enumValues.length === 0) return null
            return nameHit ? item : { ...item, constants, enum_values: enumValues }
          })
          .filter((item) => item !== null),
        fields: (entry.fields ?? []).filter((item) => collapse(item.name).toLowerCase().includes(needle)),
        methods: (entry.methods ?? []).filter((item) => collapse(item.name).toLowerCase().includes(needle)),
        constructors: (entry.constructors ?? []).filter((item) => collapse(item.name).toLowerCase().includes(needle)),
        logic_details: (entry.logic_details ?? []).filter(
          (item) =>
            collapse(item.rule_name).toLowerCase().includes(needle) ||
            collapse(item.description).toLowerCase().includes(needle)
        )
      }
    }
  }

  return {
    path: key ?? wanted,
    directory: directory?.path ?? null,
    file,
    logic: entry
  }
}

/**
 * Compare one entry's recorded sha256 against the file on disk.
 *
 * The lease says when the index was built; this says whether the entry still
 * describes the bytes that are there now. Only the second question licenses
 * trusting an entry (or editing against it) without reading the source.
 *
 * @param {object} index - a built index.
 * @param {string} root - project root.
 * @param {string} relPath - path relative to the root, exact or as a suffix.
 * @param {(path: string) => Promise<string>} readText - reads a file, or rejects.
 * @returns {Promise<object|null>} the comparison, or null when not indexed.
 */
export async function checkEntry(index, root, relPath, readText) {
  const entry = readIndexEntry(index, relPath)
  if (entry === null) return null
  if (entry.file === null) return null

  const indexedHash = typeof entry.file.hash === 'string' ? entry.file.hash : ''
  // A rules entry may live outside the project (the spec body, the global
  // AGENTS.md), in which case `path` is already absolute and must not be joined.
  const target = entry.rule?.external === true ? entry.path : join(root, ...entry.path.split('/'))
  let currentHash = ''
  try {
    const source = await readText(target)
    currentHash = createHash('sha256').update(source).digest('hex')
  } catch {
    currentHash = ''
  }
  return {
    path: entry.path,
    indexedHash,
    currentHash,
    same: indexedHash !== '' && indexedHash === currentHash
  }
}

// ---------------------------------------------------------------------------
// rendering (tool output)
// ---------------------------------------------------------------------------

/** Format a duration in milliseconds as a short human string. */
function ageOf(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '未知'
  const minutes = Math.floor(milliseconds / 60000)
  if (minutes < 1) return '不到 1 分钟'
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时`
  return `${Math.floor(hours / 24)} 天`
}

/**
 * Render the `status` action.
 *
 * @param {object} state - service status.
 * @returns {string} text for the model.
 */
export function formatStatus(state) {
  const lines = []
  const meta = state.meta ?? null
  lines.push(`索引：${state.exists ? '已就绪' : '不存在'}（${state.indexPath}）`)
  if (meta !== null) {
    lines.push(
      `项目：${meta.project_name} · ${meta.file_count} 个文件 · ${(state.directoryCount ?? 0)} 个目录 · ` +
        `${(state.logicCount ?? 0)} 个逻辑条目`
    )
    if (meta.last_updated !== '') {
      const updated = Date.parse(meta.last_updated)
      lines.push(
        `更新时间：${meta.last_updated}（${Number.isNaN(updated) ? '未知' : `${ageOf(state.now - updated)}前`}）`
      )
    }
  }
  const ruleKinds = state.ruleKinds ?? {}
  lines.push(
    `规范条目 ${state.ruleCount ?? 0} 个（规范正文 ${ruleKinds.spec ?? 0} / 全局约定 ${ruleKinds['global-agents'] ?? 0} / ` +
      `项目约定 ${ruleKinds['project-agents'] ?? 0} / 插件配置 ${ruleKinds['plugin-config'] ?? 0} / 文档 ${ruleKinds.doc ?? 0}）`
  )
  if ((state.shardCount ?? 0) > 0) {
    lines.push(
      `分片：${state.shardCount} 个，合计 ${Math.round((state.shardBytes ?? 0) / 1024)} KB（每片上限 800 KB）`
    )
  }
  const listener =
    state.state === 'building'
      ? '构建中'
      : state.expiresAt > state.now
        ? `就绪，租约剩余 ${ageOf(state.expiresAt - state.now)}`
        : '未启动或租约已过期（下次会话步骤会自动重建）'
  lines.push(`监听器：${listener}`)
  if (state.lastError !== null && state.lastError !== undefined) {
    lines.push(`最近一次构建失败：${state.lastError}`)
  }
  lines.push(
    '用法：action=query 按关键词检索（规范条目也在内，如「导出」「确认流程」「wbs_num」）；' +
      'action=read 读单个文件的结构，path=system-prompt.md 可按节读规范（可加 symbol 收窄到一节）。'
  )
  return lines.join('\n')
}

/**
 * Render the `query` action.
 *
 * @param {object[]} hits - from `queryIndex`.
 * @param {string} query - the keyword.
 * @returns {string} text for the model.
 */
export function formatQuery(hits, query) {
  if (hits.length === 0) {
    return `索引中没有命中「${query}」的条目。\n` +
      '可以换更短的关键词，或改用 grep/glob 直接检索；若怀疑索引过期，先 action=status 看一眼。'
  }
  const lines = [`索引命中 ${hits.length} 条（关键词「${query}」）：`]
  for (const hit of hits) {
    lines.push(`- [${hit.kind}] ${hit.label}`)
    if (hit.detail !== '') lines.push(`  ${hit.detail}`)
  }
  lines.push('需要细节时用 action=read path=<上面的文件路径> 读结构化条目，不必打开源码。')
  return lines.join('\n')
}

/**
 * Render the `read` action.
 *
 * @param {object|null} entry - from `readIndexEntry`.
 * @param {string} relPath - the requested path.
 * @returns {string} text for the model.
 */
export function formatRead(entry, relPath) {
  if (entry === null || entry === undefined) {
    return (
      `索引里没有「${relPath}」。\n` +
      '先用 action=query 找一个文件路径；Java 与 MyBatis XML 在 content_logic_index 里，' +
      'Agent 规范 / AGENTS.md / 插件配置 / docs 文档在 agent_rules_index 里（如 path=system-prompt.md）。'
    )
  }
  if (entry.file === null && entry.logic === null && entry.directory === null) {
    // Not a logic file and not in directory_index either: either the path is
    // wrong or the file appeared after the last build.
    return (
      `索引里没有「${relPath}」。\n` +
      '可能路径不对，也可能是上次构建之后新增的文件（监听器会在下一次增量时收录）。' +
      '先用 action=query 搜关键词确认路径，或直接用 read 打开。'
    )
  }
  const lines = [`文件：${entry.path}`]
  if (entry.directory !== null) lines.push(`所在目录：${entry.directory}`)
  if (entry.file !== null) {
    lines.push(`语言：${entry.file.language} · 摘要：${entry.file.summary}`)
    // The hash belongs next to the content it vouches for. Making the model call
    // `verify` as a separate step means it reads the logic first and decides
    // afterwards; showing both at once is what lets one call end the question.
    const hash = typeof entry.file.hash === 'string' ? entry.file.hash : ''
    if (hash !== '') {
      lines.push(`sha256：${hash}`)
      lines.push('可信度：用 action=verify 与磁盘比对；一致就可以直接照着上面的结构改，不必先全量读源码，不一致必须先自己读这个文件。')
    }
  }

  if (entry.rule !== undefined && entry.rule !== null) {
    lines.push(...ruleSectionLines(entry.rule))
    return lines.join('\n')
  }

  const logic = entry.logic
  if (logic === null) {
    lines.push('该文件没有结构化逻辑条目（索引只解析 Java 与 MyBatis XML）。')
    return lines.join('\n')
  }

  if (logic.package !== undefined && logic.package !== '') lines.push(`包：${logic.package}`)
  if (logic.mapper_xml !== undefined) lines.push(`Mapper XML：${logic.mapper_xml}`)
  if (logic.mapper_interface !== undefined) lines.push(`Mapper 接口：${logic.mapper_interface}`)

  for (const item of logic.classes ?? []) {
    const heritage = [
      item.extends === '' ? '' : `extends ${item.extends}`,
      (item.implements ?? []).length > 0 ? `implements ${item.implements.join(', ')}` : ''
    ]
      .filter((part) => part !== '')
      .join(' ')
    // The argument text is rendered inline, the way it is written in the source:
    // `@RequestMapping("/taskArrangement")` is the fact, `@RequestMapping` is not.
    const annotations = (item.annotations ?? [])
      .map((name) => {
        const value = item.annotation_args?.[name]
        return value === undefined ? `@${name}` : `@${name}(${value})`
      })
      .join(' ')
    const line = item.line === undefined ? '' : ` · 第 ${item.line} 行`
    lines.push(`${kindLabel(item.kind)} ${item.name}${line}`)
    if (heritage !== '' || annotations !== '') {
      lines.push(`  ${[heritage, annotations].filter((part) => part !== '').join(' ')}`)
    }
    if (item.summary !== '') lines.push(`  ${item.summary}`)
    if ((item.constants ?? []).length > 0) {
      lines.push(`  常量 ${item.constants.length} 个：`)
      for (const constant of item.constants) {
        const comment = constant.comment === '' ? '' : ` — ${constant.comment}`
        lines.push(`  - ${constant.name}: ${constant.type} = ${constant.value}${comment}（第 ${constant.line} 行）`)
      }
    }
    if ((item.enum_values ?? []).length > 0) {
      lines.push(`  枚举值 ${item.enum_values.length} 个：`)
      for (const value of item.enum_values) {
        const args = value.args === '' ? '' : `(${value.args})`
        lines.push(`  - ${value.name}${args}（第 ${value.line} 行）`)
      }
    }
  }
  if ((logic.fields ?? []).length > 0) {
    lines.push(`字段 ${logic.fields.length} 个：`)
    for (const item of logic.fields) {
      const parts = []
      if (item.column !== undefined && item.column !== '') parts.push(`列 ${item.column}`)
      if (item.value !== undefined && item.value !== '') parts.push(`= ${item.value}`)
      if (item.comment !== '' && item.comment !== undefined) parts.push(item.comment)
      const tail = parts.length === 0 ? '' : ` — ${parts.join(' · ')}`
      const line = item.line === undefined ? '' : `（第 ${item.line} 行）`
      lines.push(`- ${item.name}: ${item.type}${line}${tail}`)
    }
  }
  if ((logic.constructors ?? []).length > 0) {
    lines.push(`构造器 ${logic.constructors.length} 个：`)
    for (const item of logic.constructors) {
      const line = item.line === undefined ? '' : `（第 ${item.line} 行）`
      lines.push(`- ${item.name}(${(item.parameters ?? []).join(', ')})${line}`)
    }
  }
  if ((logic.methods ?? []).length > 0) {
    lines.push(`方法 ${logic.methods.length} 个：`)
    for (const item of logic.methods) {
      const annotations = (item.annotations ?? [])
        .map((name) => {
          const value = item.annotation_args?.[name]
          return value === undefined ? `@${name}` : `@${name}(${value})`
        })
        .join(' ')
      const line = item.line === undefined ? '' : ` · 第 ${item.line} 行`
      lines.push(`- ${item.name}(${(item.parameters ?? []).join(', ')}) → ${item.return_type}${line}`)
      if (annotations !== '') lines.push(`  ${annotations}`)
      if (item.logic_summary !== '') lines.push(`  ${item.logic_summary}`)
      if ((item.key_dependencies ?? []).length > 0) {
        lines.push(`  依赖：${item.key_dependencies.join('、')}`)
      }
    }
  }
  if ((logic.logic_details ?? []).length > 0) {
    lines.push(`业务规则 ${logic.logic_details.length} 条：`)
    for (const item of logic.logic_details) {
      const line = item.line === undefined ? '' : `（第 ${item.line} 行）`
      const result = item.result_type === undefined || item.result_type === '' ? '' : ` → ${item.result_type}`
      lines.push(`- ${item.rule_name}${result}${line}：${item.description}`)
    }
  }
  if ((logic.relations ?? []).length > 0) {
    lines.push(`引用 ${logic.relations.length} 条（本项目内可定位的标了路径）：`)
    for (const relation of logic.relations) {
      const target = relation.path === undefined ? '' : ` → ${relation.path}`
      lines.push(`- ${relation.kind} ${relation.to}${target}`)
    }
  }
  if ((logic.imports ?? []).length > 0) {
    lines.push(`import ${logic.imports.length} 条：${logic.imports.join('、')}`)
  }
  return lines.join('\n')
}

/** Chinese label for a class-like declaration kind. */
function kindLabel(kind) {
  if (kind === 'interface') return '接口'
  if (kind === 'enum') return '枚举'
  if (kind === 'record') return '记录'
  if (kind === 'mapper') return 'Mapper'
  return '类'
}

/**
 * Render the `verify` action: is the entry still describing the file on disk?
 *
 * This is the freshness proof the model actually needs. `last_updated` says when
 * the *index* was built, which is a different question — an index built one
 * second ago can still describe an older file if that file changed and the
 * watcher has not fired yet. Comparing the sha256 recorded in the index against
 * the file on disk answers the question that matters: can this entry be trusted
 * without opening the source?
 *
 * @param {object|null} check - from `checkEntry`.
 * @param {string} relPath - the requested path.
 * @returns {string} text for the model.
 */
export function formatVerify(check, relPath) {
  if (check === null || check === undefined) {
    return (
      `索引里没有「${relPath}」，无从比对。\n` +
      '先用 action=query 找一个文件路径；索引只收录 Java 与 MyBatis XML 的结构化条目。'
    )
  }
  if (check.indexedHash === '') {
    return (
      `「${check.path}」在索引里，但没有记录 hash（多半是旧版索引建的条目）。\n` +
      '用 action=build 重建一次就会补上；在那之前按不可信处理，改源码前自己 read 一遍。'
    )
  }
  if (check.currentHash === '') {
    return (
      `「${check.path}」在索引里有条目，但磁盘上读不到这个文件（已删除或改名）。\n` +
      '说明索引落后于工作区：用 action=build 重建。'
    )
  }
  if (check.same) {
    return (
      `「${check.path}」未改动，索引条目可信。\n` +
      `sha256：${check.indexedHash}\n` +
      '结论：可以直接用索引里的类/字段/方法/规则回答，也可以基于它改源码——hash 一致就说明索引描述的就是当前这份文件，不必先全量读一遍；只读要改的那几行。'
    )
  }
  return (
    `「${check.path}」已改动，索引条目过期。\n` +
    `索引记录：${check.indexedHash}\n` +
    `磁盘现状：${check.currentHash}\n` +
    '结论：这一条的摘要、方法、规则都不能直接采信。改源码前必须自己读这个文件；' +
    '同时说明监听器会在下一次增量时更新它（也可 action=build 立即重建）。'
  )
}

// ---------------------------------------------------------------------------
// the background listener
// ---------------------------------------------------------------------------

/** Read and parse a JSON artefact, or return null. */
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Write a file atomically: a reader never sees a half-written index.
 *
 * `compact` drops the indentation. A shard is capped at 800 KB as a data
 * structure; indenting it would push the file past 1.4 MB and defeat the
 * ceiling the sharding exists to enforce.
 */
async function writeJsonAtomic(path, value, options = {}) {
  const temporary = `${path}.tmp`
  const body = options.compact === true ? JSON.stringify(value) : JSON.stringify(value, null, 2)
  await writeFile(temporary, `${body}\n`, 'utf8')
  await rename(temporary, path)
}

/**
 * The listener: owns the index lifecycle for one project root.
 *
 * States are `idle` and `building`. `ensure()` is the lease check the spec asks
 * for — it starts a build only when the lease has expired, and never awaits it,
 * so a session step is never delayed by indexing.
 *
 * @param {object} options - service inputs.
 * @param {string} options.root - project root.
 * @param {(message: string) => void} [options.warn] - diagnostic sink.
 * @param {(message: string) => void} [options.log] - info sink.
 * @param {() => number} [options.now] - clock override, for tests.
 * @returns {object} the service.
 */
export function createProjectIndexService(options) {
  const { root } = options
  const warn = options.warn ?? (() => {})
  const log = options.log ?? (() => {})
  const now = options.now ?? (() => Date.now())
  const paths = indexPaths(root)

  let state = 'idle'
  let expiresAt = 0
  let lastBuildAt = 0
  /** @type {string | null} */
  let lastError = null
  /** @type {Promise<unknown> | null} */
  let building = null
  /** @type {object | null} */
  let cachedIndex = null
  let started = false
  let disposed = false
  /** @type {ReturnType<typeof setTimeout> | null} */
  let debounceTimer = null
  /** @type {ReturnType<typeof setTimeout> | null} */
  let followUpTimer = null
  /** @type {ReturnType<typeof setInterval> | null} */
  let intervalTimer = null
  /** @type {{close: () => void} | null} */
  let watcher = null
  let watcherActive = false

  async function loadIndex() {
    if (cachedIndex !== null) return cachedIndex
    cachedIndex = await loadIndexFiles(paths)
    return cachedIndex
  }

  /** Full or incremental rebuild; concurrent callers share one build. */
  function rebuild(reason, full = false) {
    if (disposed) return Promise.resolve(null)
    if (building !== null) return building
    state = 'building'
    building = (async () => {
      const startedAt = now()
      try {
        const previous = await loadIndex()
        const previousCache = await readJson(paths.cache)
        const result = await buildProjectIndex({
          root,
          previous: full ? null : previous,
          previousCache: full ? null : previousCache,
          now: startedAt,
          full
        })
        mkdirSync(paths.dir, { recursive: true })
        // A pre-split index is a single 10 MB file that no longer matches the
        // layout; it would be dead weight next to the shards, so it goes.
        if (existsSync(paths.legacy)) {
          try {
            rmSync(paths.legacy)
            log('project-index: 已删除旧版单文件索引 project_index.json')
          } catch (error) {
            warn(`project-index: 旧版单文件索引删除失败（${error?.message ?? error}）`)
          }
        }
        const layout = await writeIndexFiles(paths, result.index)
        await writeJsonAtomic(paths.cache, result.cache)
        cachedIndex = result.index
        lastBuildAt = now()
        expiresAt = lastBuildAt + LEASE_MS
        lastError = null
        log(
          `project-index: ${reason} 构建完成 · ${result.files} 个文件（重解析 ${result.parsed}，复用 ${result.reused}，跳过 ${result.skipped}）· ${layout.shards} 个分片`
        )
        // A file that changed within SETTLE_MS of this build was skipped as
        // mid-write, and no further watch event is coming for it — the burst
        // already happened. Without a follow-up the index would stay stale for
        // a whole lease, so re-check once the file has settled.
        if (result.settling > 0) scheduleFollowUp()
        return result
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        warn(`project-index: ${reason} 构建失败（${lastError}）`)
        return null
      } finally {
        state = 'idle'
        building = null
      }
    })()
    return building
  }

  /** Start a build only when the lease has expired. Never awaited by callers. */
  function ensure(reason) {
    if (disposed) return
    if (state === 'building') return
    if (expiresAt > now()) return
    void rebuild(reason)
  }

  /** Watch the tree; a burst of events collapses into one debounced refresh. */
  function startWatcher() {
    if (watcher !== null || disposed) return
    try {
      watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
        if (disposed) return
        if (typeof filename === 'string' && filename !== '' && shouldIgnorePath(filename)) return
        schedule()
      })
      watcher.on?.('error', (error) => {
        watcherActive = false
        warn(`project-index: 目录监视中断（${error?.message ?? error}），改为每 30 分钟检查一次`)
      })
      watcherActive = true
    } catch (error) {
      watcherActive = false
      warn(`project-index: 无法监视项目目录（${error?.message ?? error}），改为每 30 分钟检查一次`)
    }
  }

  function schedule() {
    if (debounceTimer !== null) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void rebuild('文件变化')
    }, DEBOUNCE_MS)
    debounceTimer.unref?.()
  }

  /**
   * One re-check after files that were still settling.
   *
   * Deliberately calls `rebuild` rather than `ensure`: the lease was just
   * renewed by the build that reported the settling files, so `ensure` would
   * decline. The delay is the settle window plus a margin, which is enough for
   * an editor's write to finish. It cannot loop — a file skipped twice is
   * older than `SETTLE_MS` by the second pass.
   */
  function scheduleFollowUp() {
    if (followUpTimer !== null) return
    followUpTimer = setTimeout(() => {
      followUpTimer = null
      void rebuild('补建')
    }, SETTLE_MS + DEBOUNCE_MS)
    followUpTimer.unref?.()
  }

  /** Idempotent: called on every step, does work once. */
  function start() {
    if (started || disposed) return
    started = true
    startWatcher()
    intervalTimer = setInterval(() => ensure('租约到期'), LEASE_MS)
    intervalTimer.unref?.()
  }

  async function status() {
    const index = await loadIndex()
    const meta = index?.project_meta ?? null
    const master = await readJson(paths.master)
    return {
      root,
      indexPath: paths.master,
      exists: index !== null,
      state,
      now: now(),
      expiresAt,
      lastBuildAt,
      lastError,
      meta,
      shardCount: (master?.shards ?? []).length,
      shardBytes: (master?.shards ?? []).reduce((sum, shard) => sum + (shard.bytes ?? 0), 0),
      directoryCount: index?.directory_index?.length ?? 0,
      logicCount: Object.keys(index?.content_logic_index ?? {}).length,
      ruleCount: Object.keys(index?.agent_rules_index ?? {}).length,
      ruleKinds: countRuleKinds(index?.agent_rules_index ?? {}),
      watcherActive
    }
  }

  function dispose() {
    disposed = true
    if (debounceTimer !== null) clearTimeout(debounceTimer)
    if (intervalTimer !== null) clearInterval(intervalTimer)
    if (followUpTimer !== null) clearTimeout(followUpTimer)
    debounceTimer = null
    intervalTimer = null
    followUpTimer = null
    try {
      watcher?.close()
    } catch {
      /* already closed */
    }
    watcher = null
  }

  return {
    root,
    paths,
    start,
    ensure,
    rebuild,
    status,
    loadIndex,
    dispose,
    get leaseExpiresAt() {
      return expiresAt
    },
    get state() {
      return state
    }
  }
}

// ---------------------------------------------------------------------------
// the tool
// ---------------------------------------------------------------------------

/** Tool description shown to the model. */
const TOOL_DESCRIPTION =
  '读取当前项目的复合索引（.dsh/index/ 下的 master_index.json + shards/ 分片 + logic_rules.json + agent_rules.json），' +
  '在不动源码的前提下看清项目结构与业务逻辑。' +
  '索引按业务域拆成多个文件，每个分片不超过 800 KB，所以任何一次读取都不会把整个项目塞进上下文。' +
  '索引由后台监听器维护，每 30 分钟或检测到文件变化时增量更新；每个文件条目都带该文件的 sha256。' +
  '信任规则按 hash 判断，不按时间判断：action=verify 比对索引里的 hash 与磁盘现状——' +
  'hash 一致说明索引描述的就是当前这份文件，可以直接用它的类/字段/方法/规则回答，也可以直接基于它改源码，不必先全量读一遍；' +
  'hash 不一致说明这一条已过期，改源码前必须自己读该文件。' +
  'action=status 先看索引是否就绪（含分片数与总字节）；action=query 按关键词（文件路径/类名/方法名/业务规则/接口 URL/表列名/常量值）检索；' +
  'action=read 读某个文件的结构化条目（类、字段、方法、构造器、常量与枚举值、注解参数、行号、引用关系、业务规则），' +
  '可用 symbol 收窄到单个类或方法；' +
  'action=verify 校验某个文件的条目是否仍然可信（改源码之前做这一步）；action=build 强制全量重建（通常不必手动调用）。' +
  '索引的第四块 agent_rules_index（落在 agent_rules.json）收录了 Agent 规范正文（§一～§十七）、AGENTS.md 全局/项目约定、插件配置与 docs 文档：' +
  'action=query 用关键词（如「导出」「确认流程」「wbs_num」）可直接命中规范条目，' +
  'action=read path=system-prompt.md 可按节读规范，action=verify 对它同样比对 sha256；' +
  '本工具不会等待构建完成：索引缺失时它直接说明现状，此时改用 grep/glob/read 回答当前问题，' +
  '并告诉用户「已触发后台索引构建，当前我先基于原生检索为您解答」。'

/** Parameter schema. */
const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['status', 'query', 'read', 'verify', 'build'],
      description:
        'status 看索引状态；query 按关键词检索；read 读单个文件的结构；verify 校验条目是否仍可信（改源码前用）；build 强制全量重建。'
    },
    query: {
      type: 'string',
      description: 'action=query 时的关键词，大小写不敏感。'
    },
    path: {
      type: 'string',
      description:
        'action=read 或 action=verify 时的文件路径，相对项目根，可只写路径后缀；' +
        '规范条目也可用（如 system-prompt.md、AGENTS.md）。'
    },
    symbol: {
      type: 'string',
      description: 'action=read 时可选，类名或方法名；对规范条目则按节标题（或节内出现的词）收窄。'
    },
    limit: {
      type: 'integer',
      description: 'action=query 时最多返回多少条，默认 20，上限 50。'
    }
  },
  required: ['action'],
  additionalProperties: false
}

/** Output schema: one text block, because every action is prose for the model. */
const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: '渲染好的纯文本结果。' }
  },
  required: ['text'],
  additionalProperties: false
}

/**
 * Build the `project_index` tool definition.
 *
 * @param {object} options - wiring.
 * @param {(exec: object) => Promise<{root: string, service: object}>} options.resolve - per-Agent service lookup.
 * @param {(message: string) => void} [options.warn] - diagnostic sink.
 * @returns {object} a `ToolDefinition`.
 */
export function createProjectIndexTool(options) {
  const { resolve } = options
  const warn = options.warn ?? (() => {})

  return {
    name: 'project_index',
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
    timeoutMs: 120000,
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render(_args, value) {
        const text = typeof value?.text === 'string' ? value.text : String(value ?? '')
        return [{ type: 'text', text }]
      }
    },
    async execute(args, exec) {
      const action = typeof args?.action === 'string' ? args.action : 'status'
      const { root, service } = await resolve(exec)
      const limit = Math.min(50, Math.max(1, Number.isInteger(args?.limit) ? args.limit : 20))

      if (action === 'build') {
        const result = await service.rebuild('手动', true)
        if (result === null) {
          return {
            text: `全量重建失败：${(await service.status()).lastError ?? '未知原因'}。先用 grep/glob 继续当前问题。`
          }
        }
        const state = await service.status()
        return {
          text:
            `已全量重建索引：${result.files} 个文件（重解析 ${result.parsed}，复用 ${result.reused}，跳过 ${result.skipped}）。\n` +
            `路径：${state.indexPath}`
        }
      }

      if (action === 'query') {
        const index = await service.loadIndex()
        if (index === null) {
          service.ensure('工具查询')
          return {
            text:
              '索引尚未生成，已在后台开始构建（不阻塞本次回答）。' +
              '现在请直接用 grep/glob/read 解决当前问题，并告知用户「已触发后台索引构建，当前我先基于原生检索为您解答」。'
          }
        }
        return { text: formatQuery(queryIndex(index, args?.query ?? '', limit), String(args?.query ?? '')) }
      }

      if (action === 'read') {
        const index = await service.loadIndex()
        const relPath = typeof args?.path === 'string' ? args.path : ''
        if (index === null) {
          service.ensure('工具读取')
          return {
            text:
              '索引尚未生成，已在后台开始构建（不阻塞本次回答）。' +
              '现在请直接用 read 打开该文件，并告知用户「已触发后台索引构建，当前我先基于原生检索为您解答」。'
          }
        }
        return { text: formatRead(readIndexEntry(index, relPath, args?.symbol), relPath) }
      }

      if (action === 'verify') {
        const index = await service.loadIndex()
        const relPath = typeof args?.path === 'string' ? args.path : ''
        if (relPath === '') {
          return { text: 'action=verify 需要 path：要给哪个文件做校验。' }
        }
        if (index === null) {
          service.ensure('工具校验')
          return {
            text:
              '索引尚未生成，没有可比对的条目，已在后台开始构建（不阻塞本次回答）。' +
              '现在按不可信处理：改源码前自己 read 一遍该文件。'
          }
        }
        const check = await checkEntry(index, root, relPath, (path) => readFile(path, 'utf8'))
        return { text: formatVerify(check, relPath) }
      }

      if (action !== 'status') {
        warn(`project-index: 未知 action「${action}」`)
      }
      service.ensure('工具状态')
      return { text: formatStatus(await service.status()) }
    }
  }
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

/**
 * Mount the index listener and its tool.
 *
 * Nothing here runs a model and nothing posts into the conversation. The only
 * agent-facing surface is the `project_index` tool; the listener is driven by
 * `agent/pre-step` (the first step of a session starts it) and by the file
 * watcher.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning plugin context.
 * @returns {void}
 */
export function apply(ctx) {
  const warn = (message) => ctx.logger?.warn?.(message)
  const log = (message) => ctx.logger?.info?.(message)

  /** @type {Map<string, ReturnType<typeof createProjectIndexService>>} */
  const services = new Map()
  let disposed = false
  /** @type {(() => void) | null} */
  let unregister = null

  function optional(name) {
    try {
      return ctx.get?.(name, false) ?? null
    } catch {
      return null
    }
  }

  /** Project root for one Agent: its working directory, resolved to the repo root. */
  async function resolveRoot(agent, signal) {
    const workingDirectory = optional('workingDirectory')
    if (workingDirectory !== null && agent !== undefined && agent !== null) {
      try {
        const directory = await workingDirectory.ensure(agent, signal)
        if (typeof directory === 'string' && directory !== '') return findProjectRoot(directory)
      } catch (error) {
        warn(`project-index: 取工作目录失败（${error?.message ?? error}），改用进程目录`)
      }
    }
    return findProjectRoot(process.cwd())
  }

  function serviceFor(root) {
    let service = services.get(root)
    if (service === undefined) {
      service = createProjectIndexService({ root, warn, log })
      services.set(root, service)
      if (!disposed) service.start()
    }
    return service
  }

  async function resolveService(exec) {
    const root = await resolveRoot(exec?.agent, exec?.signal)
    return { root, service: serviceFor(root) }
  }

  function tryRegister() {
    if (disposed || unregister !== null) return
    // `tools` is a declared dependency, so it is on the context here.
    const tools = optional('tools')
    if (tools === null || typeof tools.register !== 'function') {
      warn('project-index: 宿主未提供 tools 服务，project_index 工具未注册')
      return
    }
    try {
      unregister = tools.register(createProjectIndexTool({ resolve: resolveService, warn }))
      log('project-index: 已注册 project_index 工具')
    } catch (error) {
      warn(`project-index: 注册 project_index 工具失败（${error?.message ?? error}）`)
    }
  }

  tryRegister()

  // The spec's "首次接收用户提问后后台静默启动". `next()` is returned
  // synchronously so a step is never delayed by indexing.
  ctx.on('agent/pre-step', (payload, next) => {
    if (!disposed) {
      if (unregister === null) tryRegister()
      const agent = payload?.agent
      if (agent !== undefined && agent !== null) {
        void (async () => {
          try {
            const root = await resolveRoot(agent, payload?.signal)
            const service = serviceFor(root)
            service.ensure('会话步骤')
          } catch (error) {
            warn(`project-index: 启动监听器失败（${error?.message ?? error}）`)
          }
        })()
      }
    }
    return next()
  })

  ctx.effect(() => () => {
    disposed = true
    const release = unregister
    unregister = null
    if (typeof release === 'function') {
      try {
        release()
      } catch {
        /* already gone */
      }
    }
    for (const service of services.values()) service.dispose()
    services.clear()
  })
}
