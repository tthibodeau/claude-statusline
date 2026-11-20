import type { Register } from 'claude-code'
import {
  BLUE, CYAN, GRAY, GREEN, MUTED, ICON_BOLT, ICON_FOLDER,
  bar5, barColor, effortColor, gitParts, layoutFooter, modelEffort, normalizeModel, parseGit, parseOptions,
  type Git, type Part,
} from './footer-format'

let effort = ''
let git: Git | null = null
let gitAt = 0
let gitBusy = false
let gitPending = false

// Git state is refreshed on events, not on a timer:
// - after each tool call and at the end of a turn (force): Claude's own commits,
//   checkouts and edits show up straight away;
// - on each render (throttled to 3 s): changes made in another terminal show up
//   as soon as the person types.
// A forced refresh that arrives while a run is in flight is queued, not dropped.
async function refreshGit($: any, force = false) {
  if (gitBusy) { if (force) gitPending = true; return }
  if (!force && Date.now() - gitAt < 3000) return
  gitBusy = true
  let next: Git | null = git
  let ok = false
  try {
    const st = await $.process.run(['git', '--no-optional-locks', 'status', '--porcelain=v2', '--branch'])
    const sl = await $.process.run(['git', '--no-optional-locks', 'stash', 'list'])
    next = st.exitCode === 0 ? parseGit(st.stdout, sl.exitCode === 0 ? sl.stdout : '') : null
    ok = true
  } catch {
    // A render's run is aborted by the next render (each keystroke). That says
    // nothing about the repo: keep the last value and leave gitAt alone so the
    // next refresh runs straight away.
  }
  gitBusy = false
  if (ok) {
    gitAt = Date.now()
    if (JSON.stringify(next) !== JSON.stringify(git)) {
      git = next
      $.ui.invalidate('ui.render')
    }
  }
  if (gitPending) {
    gitPending = false
    await refreshGit($, true)
  }
}

// Effort is only carried by hook events inside a turn; remember the latest.
function noteEffort($: any, e: any) {
  const l = e?.effort?.level
  if (typeof l === 'string' && l !== effort) { effort = l; $.ui.invalidate('ui.render') }
}

export const register: Register = (on, options) => {
  const opts = parseOptions(options)

  on('classic.PostToolUse', async ($, e, next) => { noteEffort($, e); void refreshGit($, true); return next(e) })
  on('classic.Stop', async ($, e, next) => { noteEffort($, e); void refreshGit($, true); return next(e) })

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
        const perModel = modelEffort(await $.settings.read({ key: 'modelSettings' }), modelRaw)
        if (perModel) eff = perModel
        const env = await $.env.get('CLAUDE_CODE_EFFORT_LEVEL')
        if (env && env !== 'auto' && env !== 'unset') eff = env
        const thinking = await $.settings.read({ key: 'alwaysThinkingEnabled' })
        if (thinking === false) eff = 'off'
      } catch {}
    }
    const model = modelRaw ? normalizeModel(modelRaw) : ''
    const ctx = Math.floor(u.context.percent ?? 0)
    const fiveRaw = u.rateLimits.find((r: any) => r.kind === 'five_hour')
    const five = fiveRaw ? Math.floor(fiveRaw.percentUsed) : null

    // left: folder [ | git ]
    const gp = git ? gitParts(git) : null
    // right: [model ·] [effort | ] ctx | 5h
    const usage: Part[] = []
    if (eff) usage.push({ color: effortColor(eff), text: `${ICON_BOLT} ${eff}` })
    usage.push({ color: barColor(ctx, CYAN), text: `ctx ${bar5(ctx)} ${ctx}%` })
    if (five !== null) usage.push({ color: barColor(five, GREEN), text: `5h ${bar5(five)} ${five}%` })

    const columns: number = opts.columns ?? (e as any).viewport?.columns ?? (e as any).props?.columns ?? 80
    const folderText = `${ICON_FOLDER} ${dir}`
    const { showModel, pad } = layoutFooter({
      folderText, gitText: gp?.text ?? null, model, usage, columns, rightMargin: opts.rightMargin,
    })

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
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={BLUE}>{folderText}</Text>
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
