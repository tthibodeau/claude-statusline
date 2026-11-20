import { expect, test } from 'claude-code/testing'
import {
  CORAL, GREEN, LTCYAN, RED, YELLOW, ICON_BRANCH, ICON_CLEAN,
  bar5, barColor, effortColor, gitParts, modelEffort, normalizeModel, parseGit,
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
