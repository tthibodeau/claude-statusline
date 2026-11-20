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
