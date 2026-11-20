import type { EngineInterface, Register } from 'claude-code'
import {
  BLUE, CYAN, GRAY, GREEN, MUTED, ICON_BOLT, ICON_FOLDER,
  bar5, barColor, effortColor, gitParts, layoutFooter, normalizeModel, parseOptions, pickEffort,
  type Part,
} from './footer-format'
import { createGitState, refreshGit } from './git-state'

// Git state is refreshed on events, not on a timer:
// - after each tool call and at the end of a turn (force): Claude's own commits,
//   checkouts and edits show up straight away;
// - on each render (throttled to 3 s): changes made in another terminal show up
//   as soon as the person types.
// The refresh is not awaited: the render draws the last value, and a change
// redraws through `ui.render` invalidation.

// A settings or env read that fails (an aborted render, a denied read) counts
// as "not set", so the next source in the effort order still applies.
async function readOrUndefined<T>(read: () => Promise<T>): Promise<T | undefined> {
  try { return await read() } catch { return undefined }
}

/** What a classic hook event says about effort. */
type EffortEvent = { effort?: { level?: unknown } }

/** The latest effort level a hook event carried; one per register call. */
type EffortMemo = { level: string }

// Effort is only carried by hook events inside a turn; remember the latest.
function noteEffort(memo: EffortMemo, $: Pick<EngineInterface, 'ui'>, e: EffortEvent) {
  const level = e.effort?.level
  if (typeof level === 'string' && level !== memo.level) {
    memo.level = level
    $.ui.invalidate('ui.render')
  }
}

export const register: Register = (on, options) => {
  const opts = parseOptions(options)
  const gitState = createGitState({ now: Date.now })

  const hookEffort: EffortMemo = { level: '' }

  on('classic.PostToolUse', async ($, e, next) => { noteEffort(hookEffort, $, e); void refreshGit(gitState, $, true); return next(e) })
  on('classic.Stop', async ($, e, next) => { noteEffort(hookEffort, $, e); void refreshGit(gitState, $, true); return next(e) })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const { Box, Text } = $.ui.resolve(e)
    void refreshGit(gitState, $)

    const modelRaw: string = await $.session.model()
    const u = await $.session.usage()
    const dir = (await $.session.cwd()).split(/[\\/]/).filter(Boolean).pop() ?? '?'
    // The settings are read only when no hook event has carried a level. Each
    // read stands alone: one that fails leaves its source unset, and the rest
    // still count.
    const [envLevel, modelSettings, effortLevel, alwaysThinkingEnabled] = hookEffort.level
      ? [undefined, undefined, undefined, undefined]
      : await Promise.all([
          readOrUndefined(() => $.env.get('CLAUDE_CODE_EFFORT_LEVEL')),
          readOrUndefined(() => $.settings.read({ key: 'modelSettings' })),
          readOrUndefined(() => $.settings.read({ key: 'effortLevel' })),
          readOrUndefined(() => $.settings.read({ key: 'alwaysThinkingEnabled' })),
        ])
    const eff = pickEffort({ hookLevel: hookEffort.level, envLevel, modelSettings, model: modelRaw, effortLevel, alwaysThinkingEnabled })
    const model = modelRaw ? normalizeModel(modelRaw) : ''
    const ctx = Math.floor(u.context.percent ?? 0)
    const fiveRaw = u.rateLimits.find((r) => r.kind === 'five_hour')
    const five = fiveRaw ? Math.floor(fiveRaw.percentUsed) : null

    // left: folder [ | git ]
    const git = gitState.current()
    const gp = git ? gitParts(git) : null
    // right: [model ·] [effort | ] ctx | 5h
    const usage: Part[] = []
    if (eff) usage.push({ color: effortColor(eff), text: `${ICON_BOLT} ${eff}` })
    usage.push({ color: barColor(ctx, CYAN), text: `ctx ${bar5(ctx)} ${ctx}%` })
    if (five !== null) usage.push({ color: barColor(five, GREEN), text: `5h ${bar5(five)} ${five}%` })

    const columns = opts.columns ?? e.viewport?.columns ?? 80
    const folderText = `${ICON_FOLDER} ${dir}`
    const { showModel, pad } = layoutFooter({
      folderText, gitText: gp?.text ?? null, model, usage, columns, rightMargin: opts.rightMargin,
    })

    const sep = <Text color={GRAY}> | </Text>
    const dot = <Text color={GRAY}> · </Text>
    const rightNodes: ReturnType<typeof Text>[] = []
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
