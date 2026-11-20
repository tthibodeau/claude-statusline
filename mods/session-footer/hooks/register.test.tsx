import { expect, test } from 'claude-code/testing'

// The footer as Claude Code asks for it: the PromptHint row under the prompt.
const FOOTER = {
  plugin: 'session-footer',
  surface: 'terminal',
  component: 'PromptHint',
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
} as const

const porcelain = (branch: string) =>
  `# branch.oid 00aa75f0c2068fb2b22773d905f8df8458fb85a5\n# branch.head ${branch}\n`

type Engine = { branch: string; fail: boolean; gitRuns: number }

// Each hook here stands for the engine: it answers the mod's `$` calls.
// `engine.branch` is what `git status` reports; `engine.fail` makes the run
// throw, as an aborted `$.process.run` does.
// `world.settingsFail` makes every settings read throw; `world.env` answers env.get.
type World = { settings?: Record<string, unknown>; settingsFail?: boolean; env?: Record<string, string> }
function fakeEngine(on: any, world: World = {}): Engine {
  const { settings = {}, settingsFail = false, env = {} } = world
  const engine: Engine = { branch: 'main', fail: false, gitRuns: 0 }
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: '/work/claude-statusline' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { percent: 9 }, rateLimits: [{ kind: 'five_hour', percentUsed: 13 }] },
  }))
  on('settings.read', () => {
    if (settingsFail) throw new Error('settings unreadable')
    return { value: settings }
  })
  on('env.get', (_: unknown, e: { name: string }) => ({ value: env[e.name] }))
  on('classic.Stop', () => ({}))
  on('classic.PostToolUse', () => ({}))
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    if (e.argv.includes('stash')) return { value: { exitCode: 0, stdout: '', stderr: '' } }
    engine.gitRuns++
    if (engine.fail) throw new Error('aborted')
    return { value: { exitCode: 0, stdout: porcelain(engine.branch), stderr: '' } }
  })
  return engine
}

// Raises the end of a turn, which refreshes git past the 3 s throttle.
const endTurn = ($: any) => $.classic.Stop({ stop_hook_active: false })
const afterToolCall = ($: any) =>
  $.classic.PostToolUse({ tool_name: 'Bash', tool_input: { command: 'git checkout -b x' }, tool_response: {} })

const branchText = async (ui: any) => (await ui.find({ type: 'Text', text: /\u{f126}/u }))?.text

test('effort follows modelSettings for the current model over effortLevel', async ($, on) => {
  fakeEngine(on, { settings: { effortLevel: 'xhigh', modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } } })
  const ui = await $.ui.mount(FOOTER)

  expect((await ui.find({ type: 'Text', text: /\u{f0e7}/u }))?.text).toBe('\u{f0e7} high')
  await ui.unmount()
})

const effortText = async (ui: any) => (await ui.find({ type: 'Text', text: /\u{f0e7}/u }))?.text

// The forgetting on a settings change is covered in effort-memo.test.ts: the
// test kit's engine `$` has no settings noun to raise the engine's own read.
test('the effort a turn ran at shows over the saved setting', async ($, on) => {
  fakeEngine(on, { settings: { modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } } })
  const ui = await $.ui.mount(FOOTER)
  expect(await effortText(ui)).toBe('\u{f0e7} high')

  await $.classic.Stop({ stop_hook_active: false, effort: { level: 'max' } })

  expect(await effortText(ui)).toBe('\u{f0e7} max')
  await ui.unmount()
})

test('a failed settings read still shows the effort from CLAUDE_CODE_EFFORT_LEVEL', async ($, on) => {
  fakeEngine(on, { settingsFail: true, env: { CLAUDE_CODE_EFFORT_LEVEL: 'medium' } })
  const ui = await $.ui.mount(FOOTER)

  expect((await ui.find({ type: 'Text', text: /\u{f0e7}/u }))?.text).toBe('\u{f0e7} medium')
  await ui.unmount()
})

test('a branch name with a slash is shown in full', { options: { columns: '120' } }, async ($, on) => {
  const engine = fakeEngine(on)
  engine.branch = 'feature/footer-fix'
  const ui = await $.ui.mount(FOOTER)
  await endTurn($)

  expect(await branchText(ui)).toContain('feature/footer-fix')
  await ui.unmount()
})

test('a branch name too long for the row is shortened in the middle', { options: { columns: '100' } }, async ($, on) => {
  const engine = fakeEngine(on)
  engine.branch = 'feature/ABC-1234-session-footer-git-state-refresh'
  const ui = await $.ui.mount(FOOTER)
  await endTurn($)

  const text = await branchText(ui)
  expect(text?.startsWith('\u{f126} feature/ABC-1234-')).toBe(true)
  expect(text).toContain('…')
  expect(text?.endsWith('state-refresh \u{2714}')).toBe(true)
  await ui.unmount()
})

test('a tool call refreshes git straight away, inside the 3 s throttle', async ($, on) => {
  const engine = fakeEngine(on)
  const ui = await $.ui.mount(FOOTER)
  await endTurn($)
  expect(await branchText(ui)).toContain('main')

  engine.branch = 'release/1.0'
  await afterToolCall($)

  expect(await branchText(ui)).toContain('release/1.0')
  await ui.unmount()
})

test('an aborted git run keeps the last branch instead of blanking it', async ($, on) => {
  const engine = fakeEngine(on)
  const ui = await $.ui.mount(FOOTER)
  await endTurn($)
  expect(await branchText(ui)).toContain('main')

  engine.fail = true
  const before = engine.gitRuns
  await afterToolCall($)

  expect(engine.gitRuns).toBeGreaterThan(before)
  expect(await branchText(ui)).toContain('main')
  await ui.unmount()
})
