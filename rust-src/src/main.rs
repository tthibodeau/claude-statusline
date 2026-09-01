//! Claude Code statusline — native Windows fast-path.
//!
//! Drop-in replacement for `statusline.sh`. Reads Claude Code's JSON payload
//! from stdin, walks `.git/` in-process via libgit2, and prints a
//! p10k-rainbow-style single-line statusline to stdout.
//!
//! Why native: on Windows, spawning `bash.exe` alone costs ~160 ms cold, and
//! bash has to fork jq and git on top of that. A single ~1 MB native binary
//! starts in ~15 ms; libgit2 status runs in ~10–30 ms. End-to-end target
//! under 100 ms per render, comfortably below the ~2–3 s the pre-fix bash
//! script was hitting when four sessions rendered concurrently.
//!
//! Output must match `statusline.sh` byte-for-byte — colors, icons, layout,
//! and the "drop model when it wouldn't fit" behaviour — so the two paths
//! stay interchangeable across platforms.

use std::io::{Read, Write};
use serde_json::Value;
use git2::{BranchType, Repository, StatusOptions, StatusShow};

// --- p10k rainbow palette (matches statusline.sh) ---
const BLUE:   &str = "\x1b[38;2;52;101;164m";
const GREEN:  &str = "\x1b[38;2;78;154;6m";
const YELLOW: &str = "\x1b[38;2;196;160;0m";
const CORAL:  &str = "\x1b[38;2;242;109;80m";
const LTCYAN: &str = "\x1b[38;2;137;209;220m";
const PURPLE: &str = "\x1b[38;2;176;122;161m"; // #b07aa1 — max effort (distinct from high/xhigh's green)
const CYAN:   &str = "\x1b[38;2;118;183;178m";
const RED:    &str = "\x1b[38;2;204;0;0m";     // actual problems (rate limit critical, etc)
const GRAY:   &str = "\x1b[38;2;211;215;207m";
const MUTED:  &str = "\x1b[38;2;136;138;133m";
// "off" and "low" are a choice, not a problem — a quiet two-step gray ramp
// instead of alarm colors. Both explicit RGB (not ANSI dim/faint, which just
// fades the terminal's own default foreground to an unknowable shade — can't
// put "low" a controlled couple-shades above "off" without that).
const EFFORT_OFF: &str = "\x1b[38;2;85;87;83m"; // #555753 — thinking off (Tango Aluminium 5)
                                                 // "low" reuses MUTED (#888a85, Aluminium 4) — one shade lighter
const DIM:    &str = "\x1b[2m";
const RESET:  &str = "\x1b[0m";

// SEP is " | " with GRAY colour on the bar. SEP_W is its visible width (3).
const SEP_W: usize = 3;

// --- Nerd Font glyphs (1 monospace column each) ---
const ICON_FOLDER:    &str = "\u{f07c}";
const ICON_BRANCH:    &str = "\u{f126}";
const ICON_MODIFIED:  &str = "\u{f044}";
const ICON_STAGED:    &str = "\u{f046}";
const ICON_STASH:     &str = "\u{eb4b}";
const ICON_UNTRACKED: &str = "?";
const ICON_AHEAD:     &str = "\u{21e1}";
const ICON_BEHIND:    &str = "\u{21e3}";
const ICON_CLEAN:     &str = "\u{2714}";
const ICON_BOLT:      &str = "\u{f0e7}";

// --- Shared 5-cell usage bar (filled / empty square, 20% per cell) ---
// Used for ctx % and the 5h rate limit so both read as the same kind of
// meter instead of two different visual languages.
const BAR_FILLED: &str = "\u{25fc}";
const BAR_EMPTY:  &str = "\u{25fb}";

/// Two parallel strings: `text` is what gets printed (with ANSI escapes);
/// `plain` is the same content minus the escapes, used only to measure
/// visible width via `chars().count()`. This mirrors the `_plain` tracking
/// pattern in statusline.sh — measure once as you build, never strip-and-scan.
#[derive(Default)]
struct Seg {
    text: String,
    plain: String,
}
impl Seg {
    fn width(&self) -> usize { self.plain.chars().count() }
    fn is_empty(&self) -> bool { self.text.is_empty() }
    fn push_sep(&mut self) {
        self.text.push_str(" ");
        self.text.push_str(GRAY);
        self.text.push('|');
        self.text.push_str(RESET);
        self.text.push(' ');
        self.plain.push_str(" | ");
    }
    /// Lighter joiner for the model/effort pair (both describe LLM config,
    /// vs the heavy pipe used between unrelated categories like usage stats).
    /// Same visible width as push_sep so fit-check math is unaffected.
    fn push_dot_sep(&mut self) {
        self.text.push_str(" ");
        self.text.push_str(GRAY);
        self.text.push('·');
        self.text.push_str(RESET);
        self.text.push(' ');
        self.plain.push_str(" · ");
    }
    fn push_colored(&mut self, color: &str, glyphs: &str) {
        self.text.push_str(color);
        self.text.push_str(glyphs);
        self.text.push_str(RESET);
        self.plain.push_str(glyphs);
    }
    fn append_right(&mut self, color: &str, glyphs: &str) {
        if !self.is_empty() { self.push_sep(); }
        self.push_colored(color, glyphs);
    }
}

struct GitInfo {
    branch: String,
    ahead: usize,
    behind: usize,
    working: usize,
    staged: usize,
    untracked: usize,
    stash: usize,
}

/// Best-effort git snapshot. Returns None if `cwd` isn't in a repo; a
/// missing upstream or unreachable stash reflog degrades that field to 0
/// rather than failing the whole segment.
fn gather_git(cwd: &str) -> Option<GitInfo> {
    let mut repo = Repository::discover(cwd).ok()?;

    // Every immutable borrow is scoped to a block so the Reference / Branch /
    // Statuses objects drop before we hit stash_foreach, which needs `&mut repo`.

    // Branch (or 7-char SHA for detached HEAD).
    let branch = {
        let head = repo.head().ok()?;
        let raw = if head.is_branch() {
            head.shorthand().unwrap_or("").to_string()
        } else {
            head.target()
                .map(|oid| oid.to_string().chars().take(7).collect())
                .unwrap_or_default()
        };
        // strip any refs/heads/ prefix that shorthand missed
        raw.rsplit('/').next().unwrap_or("").to_string()
    };

    // Ahead / behind vs upstream (missing upstream → 0,0).
    let (ahead, behind) = {
        let (mut a, mut b) = (0usize, 0usize);
        if let Ok(local_branch) = repo.find_branch(&branch, BranchType::Local) {
            if let Ok(upstream) = local_branch.upstream() {
                if let (Some(local_oid), Some(up_oid)) =
                    (local_branch.get().target(), upstream.get().target())
                {
                    if let Ok((ax, bx)) = repo.graph_ahead_behind(local_oid, up_oid) {
                        a = ax;
                        b = bx;
                    }
                }
            }
        }
        (a, b)
    };

    // Working / staged / untracked counts.
    let (working, staged, untracked) = {
        let (mut w, mut s, mut u) = (0usize, 0usize, 0usize);
        let mut opts = StatusOptions::new();
        opts.include_untracked(true)
            .recurse_untracked_dirs(false)
            .show(StatusShow::IndexAndWorkdir);
        if let Ok(statuses) = repo.statuses(Some(&mut opts)) {
            for st in statuses.iter() {
                let f = st.status();
                if f.is_index_new()      | f.is_index_modified() |
                   f.is_index_deleted()  | f.is_index_renamed()  |
                   f.is_index_typechange()
                { s += 1; }
                if f.is_wt_modified()  | f.is_wt_deleted() |
                   f.is_wt_typechange() | f.is_wt_renamed()
                { w += 1; }
                if f.is_wt_new() { u += 1; }
            }
        }
        (w, s, u)
    };

    // Stash count — stash_foreach needs &mut self, so we run it last.
    let mut stash = 0usize;
    let _ = repo.stash_foreach(|_, _, _| { stash += 1; true });

    Some(GitInfo { branch, ahead, behind, working, staged, untracked, stash })
}

/// Collapse " (X context)" to "-X" and drop plain " (X)" suffixes — matches
/// the two-step `sed`/`bash-regex` chain in statusline.sh on names like
/// `"Opus 4.7 (1M context)"` → `"Opus 4.7-1M"`.
fn normalize_model(raw: &str) -> String {
    // Look for a trailing "(<...>)" (optionally with trailing whitespace)
    let trimmed = raw.trim_end();
    if let Some(open) = trimmed.rfind('(') {
        if trimmed.ends_with(')') && open > 0 && trimmed.as_bytes()[open - 1] == b' ' {
            let inner = &trimmed[open + 1 .. trimmed.len() - 1];
            let head = trimmed[..open - 1].to_string();
            if let Some(stripped) = inner.strip_suffix(" context") {
                return format!("{head}-{stripped}");
            }
            return head;
        }
    }
    raw.to_string()
}

/// 5-cell filled/empty bar, 20% per cell — shared by ctx % and 5h so both
/// meters read as the same visual language.
fn build_bar5(pct: u32) -> String {
    let mut bar = String::with_capacity(5 * 3);
    for i in 0..5u32 {
        bar.push_str(if pct >= (i + 1) * 20 { BAR_FILLED } else { BAR_EMPTY });
    }
    bar
}

fn effort_color(effort: &str) -> &'static str {
    match effort {
        "max"            => PURPLE,
        "high" | "xhigh" => GREEN,
        "medium"         => YELLOW,
        "low"            => MUTED,
        "off"            => EFFORT_OFF,
        _                => DIM,
    }
}

/// Color by % *used* (not remaining) — same thresholds as the context bar,
/// just parameterized by which color means "plenty of room left".
fn bar_color(pct: u32, base: &'static str) -> &'static str {
    match pct {
        90..=u32::MAX => RED,
        75..=89       => CORAL,
        50..=74       => YELLOW,
        _             => base,
    }
}

fn main() {
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    let json: Value = serde_json::from_str(&input).unwrap_or(Value::Null);

    let cwd_raw = json.get("project_dir").and_then(Value::as_str)
        .or_else(|| json.get("cwd").and_then(Value::as_str))
        .unwrap_or("");
    if cwd_raw.is_empty() {
        println!("?");
        return;
    }
    let cwd = cwd_raw.replace('\\', "/");
    let display = cwd.rsplit('/').find(|s| !s.is_empty()).unwrap_or("?");

    // --- LEFT: folder [ | git] ---
    let mut left = Seg::default();
    left.push_colored(BLUE, &format!("{ICON_FOLDER} {display}"));

    if let Some(g) = gather_git(&cwd) {
        if !g.branch.is_empty() {
            let mut dirty = String::new();
            if g.working   > 0 { dirty.push_str(&format!(" {ICON_MODIFIED} {}",  g.working)); }
            if g.staged    > 0 { dirty.push_str(&format!(" {ICON_STAGED} {}",   g.staged)); }
            if g.untracked > 0 { dirty.push_str(&format!(" {ICON_UNTRACKED}{}", g.untracked)); }
            if g.stash     > 0 { dirty.push_str(&format!(" {ICON_STASH} {}",    g.stash)); }

            let mut remote = String::new();
            if g.ahead  > 0 { remote.push_str(&format!(" {ICON_AHEAD}{}",  g.ahead)); }
            if g.behind > 0 { remote.push_str(&format!(" {ICON_BEHIND}{}", g.behind)); }

            let color = if g.ahead > 0 && g.behind > 0 { CORAL }
                        else if !dirty.is_empty()      { YELLOW }
                        else if g.ahead > 0            { LTCYAN }
                        else                           { GREEN };

            let clean_suffix = if dirty.is_empty() && remote.is_empty()
                { format!(" {ICON_CLEAN}") } else { String::new() };

            let seg = format!("{ICON_BRANCH} {}{remote}{dirty}{clean_suffix}", g.branch);
            left.push_sep();
            left.push_colored(color, &seg);
        }
    }

    // --- Extract right-side inputs ---
    let model_raw = json.pointer("/model/display_name").and_then(Value::as_str)
        .or_else(|| json.pointer("/model/id").and_then(Value::as_str))
        .unwrap_or("");
    let model = if model_raw.is_empty() { String::new() } else { normalize_model(model_raw) };

    let effort = if json.pointer("/thinking/enabled").and_then(Value::as_bool) == Some(false) {
        "off".to_string()
    } else {
        json.pointer("/effort/level").and_then(Value::as_str).unwrap_or("").to_string()
    };

    let ctx = json.pointer("/context_window").and_then(|cw| {
        cw.get("used_percentage").and_then(Value::as_f64).map(|f| f.floor() as u32).or(Some(0))
    });

    // The 7-day figure is dropped: it doesn't change moment-to-moment the way
    // the 5h window does, and `/usage` already covers it in full.
    let five_used = json.pointer("/rate_limits/five_hour/used_percentage")
        .and_then(Value::as_f64).map(|f| f.floor() as u32);

    // --- RIGHT: [effort] [ctx %] [5h %] (model prepended later, droppable) ---
    let mut right = Seg::default();

    if !effort.is_empty() {
        right.append_right(effort_color(&effort), &format!("{ICON_BOLT} {}", effort));
    }
    if let Some(c) = ctx {
        let seg = format!("ctx {} {c}%", build_bar5(c));
        right.append_right(bar_color(c, CYAN), &seg);
    }
    if let Some(f) = five_used {
        let seg = format!("5h {} {f}%", build_bar5(f));
        right.append_right(bar_color(f, GREEN), &seg);
    }

    // --- Layout: try to prepend model; drop if it wouldn't fit ---
    // Claude Code's docs say $COLUMNS is the terminal width, but the
    // statusline row apparently doesn't get ALL of it — a notification /
    // indicator area on the right is reserved without being subtracted
    // from $COLUMNS, and padding straight to $COLUMNS gets the tail
    // truncated with a "…". CLAUDE_STATUSLINE_MARGIN lets us subtract a
    // fixed number of columns as a safety margin without recompiling; the
    // default of 4 is chosen empirically to leave room for that indicator.
    let raw_cols: usize = std::env::var("COLUMNS").ok()
        .and_then(|s| s.parse().ok())
        .filter(|c: &usize| *c > 0)
        .unwrap_or(80);
    let margin: usize = std::env::var("CLAUDE_STATUSLINE_MARGIN").ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(4);
    let cols: usize = raw_cols.saturating_sub(margin).max(20);

    if !model.is_empty() {
        let model_w = model.chars().count();
        let need = left.width() + SEP_W + model_w
                 + if right.is_empty() { 0 } else { SEP_W } + right.width() + 1;
        if need <= cols {
            let mut new_right = Seg::default();
            new_right.push_colored(MUTED, &model);
            if !right.is_empty() {
                new_right.push_dot_sep();
                new_right.text.push_str(&right.text);
                new_right.plain.push_str(&right.plain);
            }
            right = new_right;
        }
    }

    let pad = cols.saturating_sub(left.width() + right.width()).max(1);
    let padding: String = std::iter::repeat(' ').take(pad).collect();

    // Single write — Windows console cost adds up per WriteConsole call.
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{}{}{}", left.text, padding, right.text);
}
