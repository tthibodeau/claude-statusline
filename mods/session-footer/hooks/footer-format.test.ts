import { expect, test } from 'claude-code/testing'
import {
  CORAL, GREEN, LTCYAN, RED, YELLOW, ICON_BRANCH, ICON_CLEAN, ICON_FOLDER,
  bar5, barColor, effortColor, gitParts, layoutFooter, modelEffort, normalizeModel, parseGit, parseOptions, pickEffort,
  type EffortSources,
  type Part,
} from './footer-format'

const status = (...lines: string[]) => lines.join('\n') + '\n'

test('normalizeModel turns ids and display names into short names', async () => {
  expect(normalizeModel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(normalizeModel('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5-1M')
  expect(normalizeModel('claude-opus-4-1-20250805')).toBe('Opus 4.1')
  expect(normalizeModel('claude-sonnet-5')).toBe('Sonnet 5')
  expect(normalizeModel('Opus 4.7 (1M context)')).toBe('Opus 4.7-1M')
  expect(normalizeModel('Opus 5.5 (beta)')).toBe('Opus 5.5')
  expect(normalizeModel('Opus 5.5')).toBe('Opus 5.5')
})

test('modelEffort matches a modelSettings id key to the session model in any form', async () => {
  const modelSettings = {
    'claude-sonnet-5': { effortLevel: 'medium' },
    'claude-opus-5-5': { effortLevel: 'high' },
    'claude-sonnet-5-5': { effortLevel: 'low' },
  }
  for (const model of ['claude-opus-5-5', 'claude-opus-5-5[1m]', 'Opus 5.5', 'Opus 5.5 (1M context)']) {
    expect(modelEffort(modelSettings, model)).toBe('high')
  }
  expect(modelEffort(modelSettings, 'claude-sonnet-5')).toBe('medium')
  expect(modelEffort(modelSettings, 'Sonnet 5.5')).toBe('low')
  expect(modelEffort(modelSettings, 'claude-haiku-5-5')).toBeUndefined()
  expect(modelEffort(undefined, 'claude-opus-5-5')).toBeUndefined()
  expect(modelEffort(modelSettings, '')).toBeUndefined()
})

test('parseGit keeps slashes in branch names', async () => {
  const g = parseGit(status('# branch.oid 00aa75f0c2068fb2', '# branch.head feature/footer-fix'), '')
  expect(g?.branch).toBe('feature/footer-fix')
})

test('parseGit shows the short oid for a detached HEAD', async () => {
  const g = parseGit(status('# branch.oid 00aa75f0c2068fb2', '# branch.head (detached)'), '')
  expect(g?.branch).toBe('00aa75f')
})

test('parseGit counts ahead, behind, staged, working, untracked and stash', async () => {
  const g = parseGit(
    status(
      '# branch.oid abc',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 M. N... 100644 100644 100644 a b staged.ts',
      '1 .M N... 100644 100644 100644 a b working.ts',
      '1 MM N... 100644 100644 100644 a b both.ts',
      '2 R. N... 100644 100644 100644 a b R100 new.ts\told.ts',
      'u UU N... 100644 100644 100644 100644 a b c conflict.ts',
      '? untracked.ts',
      '? other.ts',
    ),
    'stash@{0}: WIP\nstash@{1}: WIP\n',
  )
  expect(g).toEqual({ branch: 'main', ahead: 2, behind: 1, staged: 3, working: 3, untracked: 2, stash: 2 })
})

test('parseGit gives null outside a branch', async () => {
  expect(parseGit('', '')).toBeNull()
})

test('gitParts colors and marks the branch by its state', async () => {
  const clean = { branch: 'main', ahead: 0, behind: 0, working: 0, staged: 0, untracked: 0, stash: 0 }
  expect(gitParts(clean)).toEqual({ color: GREEN, text: `${ICON_BRANCH} main ${ICON_CLEAN}` })
  expect(gitParts({ ...clean, working: 1 }).color).toBe(YELLOW)
  expect(gitParts({ ...clean, ahead: 1 }).color).toBe(LTCYAN)
  expect(gitParts({ ...clean, ahead: 1, behind: 1 }).color).toBe(CORAL)
  expect(gitParts({ ...clean, untracked: 2 }).text).toContain('?2')
})

test('bar5 fills one cell per 20 percent', async () => {
  expect(bar5(0)).toBe('◻◻◻◻◻')
  expect(bar5(19)).toBe('◻◻◻◻◻')
  expect(bar5(40)).toBe('◼◼◻◻◻')
  expect(bar5(100)).toBe('◼◼◼◼◼')
})

test('barColor warns at 50, 75 and 90 percent', async () => {
  expect(barColor(49, GREEN)).toBe(GREEN)
  expect(barColor(50, GREEN)).toBe(YELLOW)
  expect(barColor(75, GREEN)).toBe(CORAL)
  expect(barColor(90, GREEN)).toBe(RED)
})

test('effortColor gives xhigh the same color as high', async () => {
  expect(effortColor('xhigh')).toBe(effortColor('high'))
})

test('parseOptions falls back to a right margin of 3 when the value is not a number', async () => {
  expect(parseOptions(undefined)).toEqual({ rightMargin: 3, columns: null })
  expect(parseOptions({}).rightMargin).toBe(3)
  expect(parseOptions({ rightMargin: 'abc' }).rightMargin).toBe(3)
  expect(parseOptions({ rightMargin: '0' }).rightMargin).toBe(0)
  expect(parseOptions({ rightMargin: '-2' }).rightMargin).toBe(0)
  expect(parseOptions({ rightMargin: 5 }).rightMargin).toBe(5)
})

test('parseOptions reads columns 0, negative or not a number as detect', async () => {
  expect(parseOptions({ columns: '0' }).columns).toBeNull()
  expect(parseOptions({ columns: '-5' }).columns).toBeNull()
  expect(parseOptions({ columns: 'wide' }).columns).toBeNull()
  expect(parseOptions({ columns: '120' }).columns).toBe(120)
  expect(parseOptions({ columns: '99.7' }).columns).toBe(99)
})

const usage: Part[] = [
  { color: GREEN, text: 'ctx ◻◻◻◻◻ 9%' },
  { color: GREEN, text: '5h ◻◻◻◻◻ 13%' },
]
const folderText = `${ICON_FOLDER} claude-statusline`

test('layoutFooter hides the model when model plus usage is wider than half the row', async () => {
  const at = (columns: number) => layoutFooter({ folderText, gitText: null, model: 'Opus 5.5', usage, columns, rightMargin: 3 })
  expect(at(60).showModel).toBe(false)
  expect(at(100).showModel).toBe(true)
})

test('layoutFooter shows the model when it fits half the row exactly', async () => {
  const one: Part[] = [{ color: GREEN, text: 'u'.repeat(9) }]
  const at = (model: string) => layoutFooter({ folderText, gitText: null, model, usage: one, columns: 43, rightMargin: 3 })
  expect(at('m'.repeat(8)).showModel).toBe(true)
  expect(at('m'.repeat(9)).showModel).toBe(false)
  expect(at('').showModel).toBe(false)
})

test('layoutFooter pads the row out to the columns less the right margin', async () => {
  // 97 columns: folder 19, model 8 + 3, usage 12 + 3 + 12
  expect(layoutFooter({ folderText, gitText: null, model: 'Opus 5.5', usage, columns: 100, rightMargin: 3 }).pad).toBe(40)
  // the git part adds its separator and text: 3 + 8
  expect(layoutFooter({ folderText, gitText: `${ICON_BRANCH} main ${ICON_CLEAN}`, model: 'Opus 5.5', usage, columns: 100, rightMargin: 3 }).pad).toBe(29)
  // a wider margin takes the same columns off the pad
  expect(layoutFooter({ folderText, gitText: null, model: 'Opus 5.5', usage, columns: 100, rightMargin: 13 }).pad).toBe(30)
})

test('layoutFooter never pads below 1 and lays out at least 20 columns', async () => {
  const narrow = layoutFooter({ folderText, gitText: null, model: 'Opus 5.5', usage, columns: 10, rightMargin: 3 })
  expect(narrow).toEqual({ showModel: false, pad: 1 })
  const tiny = layoutFooter({ folderText: 'x', gitText: null, model: '', usage: [{ color: GREEN, text: 'y' }], columns: 5, rightMargin: 3 })
  expect(tiny.pad).toBe(18)
})

const noEffort: EffortSources = {
  hookLevel: '', envLevel: undefined, modelSettings: undefined, model: 'claude-opus-5-5',
  effortLevel: undefined, alwaysThinkingEnabled: undefined,
}
const opusHigh = { 'claude-opus-5-5': { effortLevel: 'high' } }

test('pickEffort follows the live hook value, then thinking off, env, modelSettings, effortLevel', async () => {
  const pick = (s: Partial<EffortSources>) => pickEffort({ ...noEffort, ...s })
  expect(pick({})).toBe('')
  expect(pick({ effortLevel: 'low' })).toBe('low')
  expect(pick({ effortLevel: 'low', modelSettings: opusHigh })).toBe('high')
  expect(pick({ effortLevel: 'low', modelSettings: opusHigh, envLevel: 'medium' })).toBe('medium')
  expect(pick({ effortLevel: 'low', envLevel: 'medium', alwaysThinkingEnabled: false })).toBe('off')
  expect(pick({ envLevel: 'medium', alwaysThinkingEnabled: false, hookLevel: 'max' })).toBe('max')
})

test('pickEffort ignores env auto and unset, and settings that are not strings', async () => {
  const pick = (s: Partial<EffortSources>) => pickEffort({ ...noEffort, ...s })
  expect(pick({ envLevel: 'auto', effortLevel: 'low' })).toBe('low')
  expect(pick({ envLevel: 'unset', effortLevel: 'low' })).toBe('low')
  expect(pick({ envLevel: '', effortLevel: 'low' })).toBe('low')
  expect(pick({ effortLevel: 3 })).toBe('')
  expect(pick({ alwaysThinkingEnabled: true, effortLevel: 'low' })).toBe('low')
})

test('pickEffort uses the sources that were read when another read failed', async () => {
  // A failed read reaches pickEffort as undefined.
  expect(pickEffort({ ...noEffort, modelSettings: undefined, envLevel: 'xhigh' })).toBe('xhigh')
  expect(pickEffort({ ...noEffort, envLevel: undefined, modelSettings: opusHigh })).toBe('high')
})
