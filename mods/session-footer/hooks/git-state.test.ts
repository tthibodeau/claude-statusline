import { expect, test } from 'claude-code/testing'
import type { ProcessRunResult } from 'claude-code'
import { createGitState, GIT_TTL_MS, refreshGit, type GitEngine } from './git-state'

const porcelain = (branch: string) =>
  `# branch.oid 00aa75f0c2068fb2b22773d905f8df8458fb85a5\n# branch.head ${branch}\n`

const result = (exitCode: number, stdout: string): ProcessRunResult =>
  ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

// A fake `$` for the git state. `repo.branch` is what `git status` reports,
// `repo.statusExit` its exit code, `repo.fail` makes the run throw as an
// aborted run does, and `repo.hold` keeps each status run pending until
// `release()` is called.
function fakeRepo() {
  const repo = {
    branch: 'main',
    statusExit: 0,
    stashOut: '',
    fail: false,
    hold: false,
    statusRuns: 0,
    invalidations: 0,
    held: [] as (() => void)[],
    release() { const h = repo.held; repo.held = []; h.forEach((go) => go()) },
  }
  const $: GitEngine = {
    process: {
      run: async (argv) => {
        if (argv.includes('stash')) return result(0, repo.stashOut)
        repo.statusRuns++
        if (repo.hold) await new Promise<void>((go) => repo.held.push(go))
        if (repo.fail) throw new Error('aborted')
        return result(repo.statusExit, porcelain(repo.branch))
      },
    },
    ui: { invalidate: () => { repo.invalidations++ } },
  }
  return { repo, $ }
}

function fakeClock(start = 1_000_000) {
  const clock = { at: start, now: () => clock.at }
  return clock
}

test('the first refresh reads git, shows the branch and invalidates the footer', async () => {
  const { repo, $ } = fakeRepo()
  const git = createGitState({ now: fakeClock().now })
  expect(git.current()).toBeNull()

  expect(await refreshGit(git, $)).toBe(true)

  expect(git.current()?.branch).toBe('main')
  expect(repo.invalidations).toBe(1)
})

test('the first refresh runs even when the clock starts at 0', async () => {
  const { $ } = fakeRepo()
  const git = createGitState({ now: fakeClock(0).now })

  expect(await refreshGit(git, $)).toBe(true)
})

test('a refresh that is not forced waits out the 3 s throttle', async () => {
  const { repo, $ } = fakeRepo()
  const clock = fakeClock()
  const git = createGitState({ now: clock.now })
  await refreshGit(git, $)

  clock.at += GIT_TTL_MS - 1
  await refreshGit(git, $)
  expect(repo.statusRuns).toBe(1)

  clock.at += 1
  repo.branch = 'next'
  expect(await refreshGit(git, $)).toBe(true)
  expect(repo.statusRuns).toBe(2)
  expect(git.current()?.branch).toBe('next')
})

test('a forced refresh reads git inside the throttle', async () => {
  const { repo, $ } = fakeRepo()
  const git = createGitState({ now: fakeClock().now })
  await refreshGit(git, $)

  repo.branch = 'release/1.0'
  expect(await refreshGit(git, $, true)).toBe(true)
  expect(git.current()?.branch).toBe('release/1.0')
})

test('a read that gives the same value does not invalidate', async () => {
  const { repo, $ } = fakeRepo()
  const git = createGitState({ now: fakeClock().now })
  await refreshGit(git, $)

  expect(await refreshGit(git, $, true)).toBe(false)
  expect(repo.statusRuns).toBe(2)
  expect(repo.invalidations).toBe(1)
})

test('an aborted run keeps the last value and does not count as a read', async () => {
  const { repo, $ } = fakeRepo()
  const git = createGitState({ now: fakeClock().now })
  await refreshGit(git, $)
  const before = git.current()

  repo.fail = true
  expect(await refreshGit(git, $, true)).toBe(false)
  expect(git.current()).toEqual(before)

  // The throttle still counts from the last good read, not from the abort.
  repo.fail = false
  repo.branch = 'after-abort'
  expect(await refreshGit(git, $)).toBe(false)
  expect(await refreshGit(git, $, true)).toBe(true)
  expect(git.current()?.branch).toBe('after-abort')
})

test('an aborted first run leaves the throttle open', async () => {
  const { repo, $ } = fakeRepo()
  const git = createGitState({ now: fakeClock().now })
  repo.fail = true
  await refreshGit(git, $)
  expect(git.current()).toBeNull()

  repo.fail = false
  expect(await refreshGit(git, $)).toBe(true)
  expect(repo.statusRuns).toBe(2)
})

test('a forced refresh during a read is queued and runs when the read ends', async () => {
  const { repo, $ } = fakeRepo()
  const git = createGitState({ now: fakeClock().now })
  repo.hold = true
  const first = refreshGit(git, $)

  repo.branch = 'moved'
  expect(await refreshGit(git, $, true)).toBe(false)
  expect(repo.statusRuns).toBe(1)

  repo.hold = false
  repo.release()
  expect(await first).toBe(true)
  expect(repo.statusRuns).toBe(2)
  expect(git.current()?.branch).toBe('moved')
})

test('a refresh that is not forced during a read is dropped', async () => {
  const { repo, $ } = fakeRepo()
  const git = createGitState({ now: fakeClock().now })
  repo.hold = true
  const first = refreshGit(git, $)

  expect(await refreshGit(git, $)).toBe(false)
  repo.hold = false
  repo.release()
  await first

  expect(repo.statusRuns).toBe(1)
})

test('git status failing outside a repo shows no git part', async () => {
  const { repo, $ } = fakeRepo()
  const git = createGitState({ now: fakeClock().now })
  await refreshGit(git, $)

  repo.statusExit = 128
  expect(await refreshGit(git, $, true)).toBe(true)
  expect(git.current()).toBeNull()
})

test('the stash count comes from git stash list', async () => {
  const { repo, $ } = fakeRepo()
  repo.stashOut = 'stash@{0}: WIP\nstash@{1}: WIP\n'
  const git = createGitState({ now: fakeClock().now })
  await refreshGit(git, $)

  expect(git.current()?.stash).toBe(2)
})

test('two git states do not share a value', async () => {
  const a = fakeRepo()
  const b = fakeRepo()
  b.repo.branch = 'other'
  const clock = fakeClock()
  const first = createGitState({ now: clock.now })
  const second = createGitState({ now: clock.now })

  await refreshGit(first, a.$)
  expect(second.current()).toBeNull()
  await refreshGit(second, b.$)

  expect(first.current()?.branch).toBe('main')
  expect(second.current()?.branch).toBe('other')
})
