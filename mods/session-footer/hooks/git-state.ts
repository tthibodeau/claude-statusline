// The git state the footer shows, and when to read it again.
// One is made per register call, so each registration starts with no state.
//
// `refreshGit` is a function, not a method on the state, because the hooks
// loader lets `$` be passed only to a function declared at the top of a file of
// the mod's own; `state.refresh($)` does not load.

import type { EngineInterface } from 'claude-code'
import { parseGit, type Git } from './footer-format'

/** The part of `$` a refresh uses. */
export type GitEngine = {
  process: Pick<EngineInterface['process'], 'run'>
  ui: Pick<EngineInterface['ui'], 'invalidate'>
}

export type GitStateOptions = {
  /** The current time in milliseconds since the epoch; register.tsx passes `Date.now`. */
  now: () => number
  /** How long a read stays fresh for a refresh that is not forced. */
  ttlMs?: number
}

export type GitState = {
  /** The last value a read finished with; null outside a repo or before the first read. */
  current(): Git | null
}

export const GIT_TTL_MS = 3000

const STATUS_ARGV = ['git', '--no-optional-locks', 'status', '--porcelain=v2', '--branch'] as const
const STASH_ARGV = ['git', '--no-optional-locks', 'stash', 'list'] as const

type GitStateRecord = {
  readonly now: () => number
  readonly ttlMs: number
  shown: Git | null
  lastReadAt: number | null
  reading: boolean
  forcedRefreshQueued: boolean
}

// Only this module reads or writes a state's record.
const records = new WeakMap<GitState, GitStateRecord>()

export function createGitState({ now, ttlMs = GIT_TTL_MS }: GitStateOptions): GitState {
  const record: GitStateRecord = { now, ttlMs, shown: null, lastReadAt: null, reading: false, forcedRefreshQueued: false }
  const state: GitState = { current: () => record.shown }
  records.set(state, record)
  return state
}

/**
 * Reads git again unless a read is running or, when not forced, the last read
 * is younger than `ttlMs`. A forced refresh that arrives while a read is
 * running is queued and runs when that read ends. Resolves true when the shown
 * value changed; it then also invalidates `ui.render`.
 */
export async function refreshGit(state: GitState, $: GitEngine, force = false): Promise<boolean> {
  const s = records.get(state)
  if (!s) throw new Error('refreshGit: state was not made by createGitState')
  if (s.reading) {
    if (force) s.forcedRefreshQueued = true
    return false
  }
  if (!force && s.lastReadAt !== null && s.now() - s.lastReadAt < s.ttlMs) return false
  s.reading = true
  let read: { value: Git | null } | null = null
  try {
    const status = await $.process.run(STATUS_ARGV)
    const stash = await $.process.run(STASH_ARGV)
    read = { value: status.exitCode === 0 ? parseGit(status.stdout, stash.exitCode === 0 ? stash.stdout : '') : null }
  } catch {
    // A render's run is aborted by the next render (each keystroke). That says
    // nothing about the repo: keep the last value and leave lastReadAt alone so
    // the next refresh runs straight away.
  }
  s.reading = false
  let changed = false
  if (read) {
    s.lastReadAt = s.now()
    if (JSON.stringify(read.value) !== JSON.stringify(s.shown)) {
      s.shown = read.value
      changed = true
      $.ui.invalidate('ui.render')
    }
  }
  if (s.forcedRefreshQueued) {
    s.forcedRefreshQueued = false
    changed = (await refreshGit(state, $, true)) || changed
  }
  return changed
}
