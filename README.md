# claude-statusline

A fast, native statusline for [Claude Code](https://claude.com/claude-code), written in Rust. Powerlevel10k-rainbow-style single line: current directory, git branch/status, model, thinking effort, context usage, and 5-hour rate limit — all rendered by one small binary in well under 100ms per render, no bash/jq fork chain.

```
📁 folder-name  🌿 main ✅ | Opus-1M · ⚡ xhigh | ctx ◼◼◻◻◻ 42% | 5h ◼◻◻◻◻ 12%
```

(The actual statusline uses Nerd Font icons, not emoji — this is just a readable stand-in for anyone viewing this README without one installed.)

## Install

**Windows** (PowerShell):

```powershell
irm https://raw.githubusercontent.com/tthibodeau/claude-statusline/main/windows/install.ps1 | iex
```

**macOS / Linux / WSL** (bash):

```bash
curl -fsSL https://raw.githubusercontent.com/tthibodeau/claude-statusline/main/macos-linux/install.sh | bash
```

Both installers build the binary from source on the machine they run on — nothing prebuilt is committed to this repo. Restart Claude Code after installing.

## What each installer does

1. Installs a Rust toolchain (via `rustup`) if `cargo` isn't already present.
2. Installs a C compiler / linker if missing — Xcode Command Line Tools on macOS, `build-essential`/`Development Tools`/`base-devel` on Linux, the MSVC C++ Build Tools on Windows (vendored libgit2 needs one to compile).
3. Downloads `rust-src/Cargo.toml` and `rust-src/src/main.rs` from this repo and runs `cargo build --release`.
4. Deploys the compiled binary to `~/.claude/claude-statusline` (`.exe` on Windows).
5. Installs a Nerd Font if none is detected (the statusline uses Nerd Font glyphs for icons).
6. Removes any stale files from a prior bash-based statusline install.
7. Points `statusLine` in `~/.claude/settings.json` at the new binary and clears any `subagentStatusLine` override, so Claude Code falls back to its built-in subagent row rendering. Every other setting is left untouched.
8. Runs a smoke test — feeds the binary a fixture JSON payload and checks it prints a non-empty line.

## Repo layout

```
rust-src/            shared Rust source, built by both installers
  Cargo.toml
  src/main.rs
windows/
  install.ps1
macos-linux/
  install.sh          also covers Linux and WSL
```

## Requirements

- Windows 10/11 with `winget` (used to install Rust and the MSVC Build Tools if missing).
- macOS/Linux/WSL with `bash`, `curl`, and a working package manager (`brew`, `apt-get`, `dnf`, or `pacman`) for the C toolchain and `jq`.
- A Nerd Font in your terminal, so the glyphs render correctly — the installer will install one for you if none is found.

## Notes

- `CLAUDE_STATUSLINE_MARGIN` (default `4`) can be set as an environment variable to adjust how many columns of right-side margin the layout reserves.
- The 7-day rate limit figure is intentionally omitted — `/usage` already covers it, and it doesn't change moment-to-moment the way the 5-hour window does.
- First build compiles vendored libgit2 from source, so expect it to take roughly a minute the first time; subsequent reinstalls after a `main.rs` change on this repo will be similarly quick since there's no incremental cache carried between runs.
