# session-footer

A Claude Code mod (not a `statusLine` command) that draws a footer in the hint row under the prompt: folder and git state on the left; model, thinking effort, context and 5h usage on the right.

Install it from inside Claude Code:

```
/plugin install session-footer --marketplace tthibodeau/claude-statusline
```

## How it works

- **Git state** comes from `git status --porcelain=v2 --branch` and `git stash list` through `$.process.run`. It refreshes on events, not on a timer:
  - after each tool call (`classic.PostToolUse`) and at the end of each turn (`classic.Stop`), straight away, so Claude's own commits and checkouts show at once;
  - on each render of the footer, at most every 3 seconds, so changes made in another terminal show as soon as you type.

  A refresh that arrives while one is running is queued, not dropped. A refresh that gets aborted (each keystroke aborts the previous render's run) keeps the last value instead of blanking the branch.
- **Branch names** are shown in full, slashes included (`feature/foo`). When the row is too narrow, the model name is hidden first; if the branch name still doesn't fit, it's shortened in the middle with `…` (`feature/ABC-1234-sess…ter-git-state-refresh`), never below 12 characters, so the row stays on one line.
- **Effort** shows the level the last turn ran at, from the `PostToolUse` and `Stop` events. Otherwise it follows Claude Code's order: `CLAUDE_CODE_EFFORT_LEVEL` (unless `auto` or `unset`), then `modelSettings` for the current model, then `effortLevel`. `alwaysThinkingEnabled: false` shows `off`. When you change effort (`/effort`, the `/model` picker), Claude Code saves it to settings and reads them again; the footer hears that read, drops the last turn's level and redraws with the new one straight away.
- **Model** ids are shown as display names (`claude-opus-5-5` as `Opus 5.5`).

## Settings (config menu)

- `rightMargin` (default `3`): columns kept free at the right edge. `2` clips the usage group; the engine indents the row about 2 columns.
- `columns` (default `0`): override the detected terminal width.

## Development

Run `claude --plugin-dir <this folder>`. The mod reloads when a turn that edited it ends. If you still have a `statusLine` entry in `~/.claude/settings.json`, you'll see both rows.

Run the tests with `claude plugin test <this folder>`. `hooks/footer-format.test.ts` covers the pure parsing, layout, option and effort rules in `hooks/footer-format.ts`. `hooks/effort-memo.test.ts` covers remembering a turn's effort and forgetting it when the engine reads changed settings. `hooks/git-state.test.ts` drives `hooks/git-state.ts` (the 3 s throttle, the queued forced refresh, keeping the last value on an abort) with a fake `$` and a fake clock. `hooks/register.test.tsx` mounts the footer against a fake engine and covers full branch names, the refresh after a tool call, keeping the branch when a git run is aborted, and the effort order.

Check it with `claude plugin validate <this folder>` and type-check with `tsc -p <this folder>` once the engine has written `.claude-plugin/types/`.

## Known limits

- The row is padded with spaces to the measured width, so a resize redraws it, but exactness depends on the engine's width reporting (about 2 cells of gap remain).
- An effort change that Claude Code does not save to settings (`--effort` at startup) shows at the next tool call or turn end.
- A git change made in another terminal while you don't touch the session shows when you next type.
