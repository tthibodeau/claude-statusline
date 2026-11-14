import type { Register } from 'claude-code'

// --- palette: same as the Rust statusline ---
const BLUE = '#3465a4', GREEN = '#4e9a06', YELLOW = '#c4a000', CORAL = '#f26d50'
const LTCYAN = '#89d1dc', PURPLE = '#b07aa1', CYAN = '#76b7b2', RED = '#cc0000'
const GRAY = '#d3d7cf', MUTED = '#888a85', EFFORT_OFF = '#555753'

const ICON_FOLDER = '\u{f07c}', ICON_BRANCH = '\u{f126}', ICON_MODIFIED = '\u{f044}'
const ICON_STAGED = '\u{f046}', ICON_STASH = '\u{eb4b}', ICON_BOLT = '\u{f0e7}'
const ICON_AHEAD = '\u{21e1}', ICON_BEHIND = '\u{21e3}', ICON_CLEAN = '\u{2714}'

type Git = { branch: string; ahead: number; behind: number; working: number; staged: number; untracked: number; stash: number }
type Part = { color: string; text: string }

const bar5 = (p: number) => {
  let s = ''
  for (let i = 0; i < 5; i++) s += p >= (i + 1) * 20 ? '◼' : '◻'
  return s
}

const barColor = (p: number, base: string) => (p >= 90 ? RED : p >= 75 ? CORAL : p >= 50 ? YELLOW : base)

const effortColor = (l: string) =>
  l === 'max' ? PURPLE : l === 'high' || l === 'xhigh' ? GREEN : l === 'medium' ? YELLOW : l === 'low' ? MUTED : l === 'off' ? EFFORT_OFF : MUTED

// "Opus 4.7 (1M context)" -> "Opus 4.7-1M"; "X (Y)" -> "X"
function normalizeModel(raw: string): string {
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

function parseGit(porcelain: string, stashOut: string): Git | null {
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
  g.branch = g.branch.split('/').pop() ?? g.branch
  g.stash = stashOut.split('\n').filter(Boolean).length
  return g
}

function gitParts(g: Git): Part {
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

let effort = ''
let git: Git | null = null
let gitAt = 0
let gitBusy = false

async function refreshGit($: any) {
  if (gitBusy || Date.now() - gitAt < 3000) return
  gitBusy = true
  let changed = false
  try {
    const st = await $.process.run(['git', '--no-optional-locks', 'status', '--porcelain=v2', '--branch'])
    const sl = await $.process.run(['git', '--no-optional-locks', 'stash', 'list'])
    const next = st.exitCode === 0 ? parseGit(st.stdout, sl.exitCode === 0 ? sl.stdout : '') : null
    changed = JSON.stringify(next) !== JSON.stringify(git)
    git = next
  } catch {
    changed = git !== null
    git = null
  }
  gitAt = Date.now()
  gitBusy = false
  if (changed) $.ui.invalidate('ui.render')
}

// Effort is only carried by hook events inside a turn; remember the latest.
function noteEffort($: any, e: any) {
  const l = e?.effort?.level
  if (typeof l === 'string' && l !== effort) { effort = l; $.ui.invalidate('ui.render') }
}

export const register: Register = (on, options) => {
  const margin = Math.max(0, parseInt(String((options as Record<string, unknown>)?.rightMargin ?? '3'), 10) || 0)

  on('classic.PostToolUse', async ($, e, next) => { noteEffort($, e); return next(e) })
  on('classic.Stop', async ($, e, next) => { noteEffort($, e); return next(e) })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const { Box, Text } = $.ui.resolve(e)
    void refreshGit($)

    const modelRaw: string = await $.session.model()
    const u = await $.session.usage()
    const dir = (await $.session.cwd()).split(/[\\/]/).filter(Boolean).pop() ?? '?'
    let eff = effort
    if (!eff) {
      try {
        const lvl = await $.settings.read({ key: 'effortLevel' })
        if (typeof lvl === 'string') eff = lvl
        const thinking = await $.settings.read({ key: 'alwaysThinkingEnabled' })
        if (thinking === false) eff = 'off'
      } catch {}
    }
    const model = modelRaw ? normalizeModel(modelRaw) : ''
    const ctx = Math.floor(u.context.percent ?? 0)
    const fiveRaw = u.rateLimits.find((r: any) => r.kind === 'five_hour')
    const five = fiveRaw ? Math.floor(fiveRaw.percentUsed) : null

    // left: folder [ | git ]
    const left: Part[] = [{ color: BLUE, text: `${ICON_FOLDER} ${dir}` }]
    const gp = git ? gitParts(git) : null
    // right: [model ·] [effort | ] ctx | 5h
    const usage: Part[] = []
    if (eff) usage.push({ color: effortColor(eff), text: `${ICON_BOLT} ${eff}` })
    usage.push({ color: barColor(ctx, CYAN), text: `ctx ${bar5(ctx)} ${ctx}%` })
    if (five !== null) usage.push({ color: barColor(five, GREEN), text: `5h ${bar5(five)} ${five}%` })

    const override = Math.floor(Number((options as Record<string, unknown>)?.columns) || 0)
    const cols: number = override > 0 ? override : (e as any).viewport?.columns ?? (e as any).props?.columns ?? 80
    const budget = Math.max(20, cols - margin)
    const w = (ps: Part[], sepW: number) => ps.reduce((n, p) => n + [...p.text].length, 0) + sepW * Math.max(0, ps.length - 1)
    const usageW = w(usage, 3)
    const modelW = model ? [...model].length + 3 : 0
    const sideW = Math.floor(budget * 0.5)
    const showModel = model !== '' && usageW + modelW <= sideW

    const sep = <Text color={GRAY}> | </Text>
    const dot = <Text color={GRAY}> · </Text>
    const rightNodes: any[] = []
    if (showModel) {
      rightNodes.push(<Text key="model" color={MUTED}>{model}</Text>)
      rightNodes.push(dot)
    }
    usage.forEach((p, i) => {
      if (i > 0) rightNodes.push(sep)
      rightNodes.push(<Text key={`u${i}`} color={p.color}>{p.text}</Text>)
    })
    const leftLen = [...`${ICON_FOLDER} ${dir}`].length + (gp ? 3 + [...gp.text].length : 0)
    const rightLen = (showModel ? modelW : 0) + usageW
    const pad = Math.max(1, budget - leftLen - rightLen)

    return (
      <Box flexDirection="column">
        <Box>
          <Text color={BLUE}>{`${ICON_FOLDER} ${dir}`}</Text>
          {gp ? sep : null}
          {gp ? <Text color={gp.color}>{gp.text}</Text> : null}
          <Text>{' '.repeat(pad)}</Text>
          {rightNodes}
        </Box>
        {await next(e)}
      </Box>
    )
  })
}
