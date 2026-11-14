# session-footer

A Claude Code **mod** (not a `statusLine` command) that draws the same info as the Rust statusline in the hint row under the prompt: folder and git state on the left; model, thinking effort, context and 5h usage on the right.

It is a port of `rust-src/` using the mod API: git state comes from `git status --porcelain=v2` via `$.process.run` (cached 3s), the model id is converted to a display name, and effort is read from `effortLevel` in settings (live per-turn effort is only delivered to hook events that other plugins can pre-empt, so it is not relied on).

## Install (development)

Copy this folder to a mods folder Claude Code watches, e.g. `~/.claude/dev-mods/<anything>/session-footer/`, or run `claude --plugin-dir <this folder>`. Accept the "Turn on mods" prompt if asked. Remove the `statusLine` entry from `~/.claude/settings.json` if you do not want both.

## Uninstall

Delete the folder.

## Settings (config menu)

- `rightMargin` (default `3`): columns kept free at the right edge. `2` clips the usage group; the engine indents the row ~2 columns.
- `columns` (default `0`): override the detected terminal width.

## Known limits

- The row is padded with spaces to the measured width, so a resize redraws it but exactness depends on the engine's width reporting (about 2 cells of gap remain).
- Effort does not follow mid-session changes that are not saved to settings.
