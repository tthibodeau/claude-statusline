// The effort level the last hook event carried, and when to forget it.
// One memo is made per register call.
//
// These are top-level functions, not methods, because the hooks loader lets
// `$` be passed only to a function declared at the top of a file of the mod.

import type { EngineInterface } from 'claude-code'

/** The latest effort level a hook event carried; '' when none, or forgotten. */
export type EffortMemo = { level: string }

/** What a classic hook event says about effort. */
export type EffortEvent = { effort?: { level?: unknown } }

/** The part of `$` the memo uses. */
export type EffortEngine = Pick<EngineInterface, 'ui'>

export function createEffortMemo(): EffortMemo {
  return { level: '' }
}

/**
 * Remembers the level a hook event (PostToolUse, Stop) carried: the effort the
 * turn actually ran at. Redraws when it changed.
 */
export function noteEffort(memo: EffortMemo, $: EffortEngine, e: EffortEvent): void {
  const level = e.effort?.level
  if (typeof level === 'string' && level !== memo.level) {
    memo.level = level
    $.ui.invalidate('ui.render')
  }
}

/**
 * Called after each settings read. Claude Code saves an effort change
 * (/effort, the /model picker) to settings, then reads the settings again
 * itself, as the engine. On that read, forget the remembered level and redraw,
 * so the footer shows the new level from settings now instead of at the next
 * tool call.
 *
 * Only the engine's own read means the settings changed. The footer reads
 * settings on every draw, and redrawing on those reads would loop.
 */
export function settingsRead(memo: EffortMemo, $: EffortEngine, origin: { plugin: string }): void {
  if (origin.plugin !== 'engine') return
  memo.level = ''
  $.ui.invalidate('ui.render')
}
