import { expect, test } from 'claude-code/testing'
import { createEffortMemo, noteEffort, settingsRead, type EffortEngine } from './effort-memo'

// A fake `$` that counts redraws.
function fakeUi() {
  const redraws: string[] = []
  const $ = { ui: { invalidate: (name: string) => { redraws.push(name) } } } as unknown as EffortEngine
  return { $, redraws }
}

test('noteEffort remembers a new level and redraws once', async () => {
  const memo = createEffortMemo()
  const { $, redraws } = fakeUi()

  noteEffort(memo, $, { effort: { level: 'high' } })
  noteEffort(memo, $, { effort: { level: 'high' } })

  expect(memo.level).toBe('high')
  expect(redraws).toEqual(['ui.render'])
})

test('noteEffort ignores an event with no level', async () => {
  const memo = createEffortMemo()
  const { $, redraws } = fakeUi()

  noteEffort(memo, $, {})
  noteEffort(memo, $, { effort: { level: 3 } })

  expect(memo.level).toBe('')
  expect(redraws).toEqual([])
})

test("the engine's settings read forgets the remembered level and redraws", async () => {
  const memo = createEffortMemo()
  const { $, redraws } = fakeUi()
  noteEffort(memo, $, { effort: { level: 'high' } })
  redraws.length = 0

  settingsRead(memo, $, { plugin: 'engine' })

  expect(memo.level).toBe('')
  expect(redraws).toEqual(['ui.render'])
})

test("the engine's settings read redraws even with no remembered level", async () => {
  const memo = createEffortMemo()
  const { $, redraws } = fakeUi()

  settingsRead(memo, $, { plugin: 'engine' })

  expect(redraws).toEqual(['ui.render'])
})

test("the footer's own settings read changes nothing, so drawing cannot loop", async () => {
  const memo = createEffortMemo()
  const { $, redraws } = fakeUi()
  noteEffort(memo, $, { effort: { level: 'high' } })
  redraws.length = 0

  settingsRead(memo, $, { plugin: 'session-footer' })

  expect(memo.level).toBe('high')
  expect(redraws).toEqual([])
})
