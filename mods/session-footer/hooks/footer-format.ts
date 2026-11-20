// Pure parsing and formatting for the session-footer mod: no `$`, no I/O.
// Kept apart from register.tsx so it can be tested with plain calls.

// --- palette: same as the Rust statusline ---
export const BLUE = '#3465a4', GREEN = '#4e9a06', YELLOW = '#c4a000', CORAL = '#f26d50'
export const LTCYAN = '#89d1dc', PURPLE = '#b07aa1', CYAN = '#76b7b2', RED = '#cc0000'
export const GRAY = '#d3d7cf', MUTED = '#888a85', EFFORT_OFF = '#555753'

export const ICON_FOLDER = '\u{f07c}', ICON_BRANCH = '\u{f126}', ICON_MODIFIED = '\u{f044}'
export const ICON_STAGED = '\u{f046}', ICON_STASH = '\u{eb4b}', ICON_BOLT = '\u{f0e7}'
export const ICON_AHEAD = '\u{21e1}', ICON_BEHIND = '\u{21e3}', ICON_CLEAN = '\u{2714}'

export type Git = { branch: string; ahead: number; behind: number; working: number; staged: number; untracked: number; stash: number }
export type Part = { color: string; text: string }

export const bar5 = (p: number) => {
  let s = ''
  for (let i = 0; i < 5; i++) s += p >= (i + 1) * 20 ? '◼' : '◻'
  return s
}

export const barColor = (p: number, base: string) => (p >= 90 ? RED : p >= 75 ? CORAL : p >= 50 ? YELLOW : base)

export const effortColor = (l: string) =>
  l === 'max' ? PURPLE : l === 'high' || l === 'xhigh' ? GREEN : l === 'medium' ? YELLOW : l === 'low' ? MUTED : l === 'off' ? EFFORT_OFF : MUTED

// "Opus 4.7 (1M context)" -> "Opus 4.7-1M"; "X (Y)" -> "X"
export function normalizeModel(raw: string): string {
  // API id -> display name: "claude-sonnet-5-5[1m]" -> "Sonnet 5.5-1M", "claude-opus-4-1-20250805" -> "Opus 4.1"
  const id = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[(\w+)\])?$/.exec(raw.trim())
  if (id) {
    const name = (id[1] ?? '').charAt(0).toUpperCase() + (id[1] ?? '').slice(1)
    const ver = id[3] ? `${id[2]}.${id[3]}` : (id[2] ?? '')
    return `${name} ${ver}${id[4] ? `-${id[4].toUpperCase()}` : ''}`
  }
  const t = raw.trimEnd()
  const m = /^(.*\S) \(([^()]*)\)$/.exec(t)
  if (!m) return raw
  const head = m[1] ?? ''
  const inner = m[2] ?? ''
  return inner.endsWith(' context') ? `${head}-${inner.slice(0, -' context'.length)}` : head
}

// `modelSettings` is keyed by model id ("claude-opus-5-5"), and its effortLevel
// overrides the global one. The session model may come back as an id (maybe
// with "[1m]") or a display name ("Opus 5.5 (1M context)"), so compare both
// sides by display name without the context suffix.
export function modelEffort(settings: unknown, modelRaw: string): string | undefined {
  if (!settings || typeof settings !== 'object' || !modelRaw) return undefined
  const base = (s: string) => normalizeModel(s).replace(/-\w+$/, '').toLowerCase()
  const want = base(modelRaw)
  for (const [key, v] of Object.entries(settings as Record<string, unknown>)) {
    const lvl = (v as { effortLevel?: unknown } | null)?.effortLevel
    if (typeof lvl === 'string' && base(key) === want) return lvl
  }
  return undefined
}

export function parseGit(porcelain: string, stashOut: string): Git | null {
  const g: Git = { branch: '', ahead: 0, behind: 0, working: 0, staged: 0, untracked: 0, stash: 0 }
  let oid = ''
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('# branch.oid ')) oid = line.slice(13).trim()
    else if (line.startsWith('# branch.head ')) g.branch = line.slice(14).trim()
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line)
      if (m) { g.ahead = Number(m[1]); g.behind = Number(m[2]) }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const x = line[2], y = line[3]
      if (x !== '.') g.staged++
      if (y !== '.') g.working++
    } else if (line.startsWith('? ')) g.untracked++
    else if (line.startsWith('u ')) g.working++
  }
  if (g.branch === '(detached)') g.branch = oid.slice(0, 7)
  if (!g.branch) return null
  g.stash = stashOut.split('\n').filter(Boolean).length
  return g
}

// --- plugin options (plugin.json userConfig) ---

export const DEFAULT_RIGHT_MARGIN = 3

export type FooterOptions = {
  /** Columns kept free at the right edge of the row. */
  rightMargin: number
  /** Width to lay the row out in; null means use the measured width. */
  columns: number | null
}

// Parsed once per register call. A rightMargin that is not a number falls back
// to the documented default of 3; a negative one is 0. A columns of 0, below 0
// or not a number means "detect".
export function parseOptions(options: Readonly<Record<string, unknown>> | undefined): FooterOptions {
  const margin = parseInt(String(options?.rightMargin ?? DEFAULT_RIGHT_MARGIN), 10)
  const columns = Math.floor(Number(options?.columns) || 0)
  return {
    rightMargin: Number.isNaN(margin) ? DEFAULT_RIGHT_MARGIN : Math.max(0, margin),
    columns: columns > 0 ? columns : null,
  }
}

// --- row layout ---

/** Width of the " | " and " · " separators. */
export const SEPARATOR_WIDTH = 3
/** The row is never laid out narrower than this. */
export const MIN_ROW_WIDTH = 20
/** The right group (model and usage) shows the model only within this share of the row. */
export const RIGHT_GROUP_SHARE = 0.5

export type FooterLayoutInput = {
  /** The folder part on the left, as drawn. */
  folderText: string
  /** The git part on the left, or null when there is none. */
  gitText: string | null
  /** The short model name, or '' when unknown. */
  model: string
  /** The usage parts on the right (effort, ctx, 5h), drawn with separators. */
  usage: readonly Part[]
  columns: number
  rightMargin: number
}

export type FooterLayout = {
  /** Whether the model name fits in front of the usage group. */
  showModel: boolean
  /** Spaces between the left and right groups; at least 1. */
  pad: number
}

// Widths count code points, not terminal cells.
const textWidth = (s: string) => [...s].length

export function layoutFooter(input: FooterLayoutInput): FooterLayout {
  const rowWidth = Math.max(MIN_ROW_WIDTH, input.columns - input.rightMargin)
  const usageWidth = input.usage.reduce((n, p) => n + textWidth(p.text), 0)
    + SEPARATOR_WIDTH * Math.max(0, input.usage.length - 1)
  const modelWidth = input.model ? textWidth(input.model) + SEPARATOR_WIDTH : 0
  const showModel = input.model !== '' && usageWidth + modelWidth <= Math.floor(rowWidth * RIGHT_GROUP_SHARE)
  const leftWidth = textWidth(input.folderText) + (input.gitText ? SEPARATOR_WIDTH + textWidth(input.gitText) : 0)
  const rightWidth = (showModel ? modelWidth : 0) + usageWidth
  return { showModel, pad: Math.max(1, rowWidth - leftWidth - rightWidth) }
}

export function gitParts(g: Git): Part {
  let dirty = ''
  if (g.working) dirty += ` ${ICON_MODIFIED} ${g.working}`
  if (g.staged) dirty += ` ${ICON_STAGED} ${g.staged}`
  if (g.untracked) dirty += ` ?${g.untracked}`
  if (g.stash) dirty += ` ${ICON_STASH} ${g.stash}`
  let remote = ''
  if (g.ahead) remote += ` ${ICON_AHEAD}${g.ahead}`
  if (g.behind) remote += ` ${ICON_BEHIND}${g.behind}`
  const color = g.ahead && g.behind ? CORAL : dirty ? YELLOW : g.ahead ? LTCYAN : GREEN
  const clean = !dirty && !remote ? ` ${ICON_CLEAN}` : ''
  return { color, text: `${ICON_BRANCH} ${g.branch}${remote}${dirty}${clean}` }
}
