#!/usr/bin/env bash
#
# Self-contained installer for the Claude Code statusline on Linux/macOS.
# Downloads and builds the native Rust binary — same one Windows uses, no
# bash/jq statusline fallback.
#
# Fetch and run:
#   curl -fsSL https://raw.githubusercontent.com/tthibodeau/claude-statusline/main/macos-linux/install.sh | bash
#
# - Installs a Rust toolchain via rustup if cargo is missing.
# - Downloads the statusline's Cargo.toml + src/main.rs from this repo and
#   builds them locally in release mode.
# - Deploys the compiled binary to ~/.claude/claude-statusline.
# - Sweeps legacy files from prior installs (statusline.sh,
#   subagent-statusline.sh).
# - Writes statusLine into ~/.claude/settings.json; unsets any existing
#   subagentStatusLine so Claude Code falls back to its built-in
#   "name . description . token count" default row rendering. Every other
#   setting is preserved.
# - Warns when no Nerd Font is installed.
#
# Windows uses windows/install.ps1 instead — see that file.
#
# Run once on any new machine. Restart Claude Code after running.

set -euo pipefail

REPO_RAW_BASE="https://raw.githubusercontent.com/tthibodeau/claude-statusline/main"
CLAUDE_DIR="$HOME/.claude"
SETTINGS_PATH="$CLAUDE_DIR/settings.json"
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT

# --- 1. Ensure a Rust toolchain is available ---
if command -v cargo &>/dev/null; then
	echo "[ok] cargo already installed"
else
	echo "[..] Installing Rust toolchain via rustup..."
	curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
	# shellcheck disable=SC1091
	source "$HOME/.cargo/env"
	echo "[ok] Rust toolchain installed"
fi

# --- 2. Ensure a C compiler is available (vendored libgit2 needs one) ---
if ! command -v cc &>/dev/null && ! command -v gcc &>/dev/null && ! command -v clang &>/dev/null; then
	echo "[..] No C compiler found — required to build vendored libgit2."
	if [[ "$(uname -s)" == "Darwin" ]]; then
		echo "     Installing Xcode Command Line Tools (a GUI prompt may appear)..."
		xcode-select --install || true
		echo "     Re-run this installer once the Command Line Tools finish installing."
		exit 1
	elif command -v apt-get &>/dev/null; then
		sudo apt-get install -y build-essential
	elif command -v dnf &>/dev/null; then
		sudo dnf groupinstall -y "Development Tools"
	elif command -v pacman &>/dev/null; then
		sudo pacman -S --needed --noconfirm base-devel
	else
		echo "[!!] Could not install a C compiler automatically — install one manually and re-run." >&2
		exit 1
	fi
fi
echo "[ok] C compiler available"

# --- 3. Download the Rust source and build it ---
mkdir -p "$BUILD_DIR/src"

curl -fsSL "$REPO_RAW_BASE/rust-src/Cargo.toml" -o "$BUILD_DIR/Cargo.toml"
curl -fsSL "$REPO_RAW_BASE/rust-src/src/main.rs" -o "$BUILD_DIR/src/main.rs"

echo "[..] Building claude-statusline (release, first build may take a minute)..."
( cd "$BUILD_DIR" && cargo build --release --quiet )
echo "[ok] Build complete"

# --- 4. Deploy the compiled binary ---
mkdir -p "$CLAUDE_DIR"
install -m 0755 "$BUILD_DIR/target/release/claude-statusline" "$CLAUDE_DIR/claude-statusline"
echo "[ok] Wrote $CLAUDE_DIR/claude-statusline"

# --- 5. Sweep legacy files from prior installs ---
for stale in \
	"$CLAUDE_DIR/statusline.sh" \
	"$CLAUDE_DIR/subagent-statusline.sh"; do
	if [ -e "$stale" ]; then
		rm -f "$stale"
		echo "[ok] Removed stale $stale"
	fi
done

# --- 6. Ensure jq is available for editing settings.json (install-time only) ---
if command -v jq &>/dev/null; then
	echo "[ok] jq already installed"
else
	echo "[..] Installing jq (used only to edit settings.json during install)..."
	if command -v brew &>/dev/null; then
		brew install jq
	elif command -v apt-get &>/dev/null; then
		sudo apt-get install -y jq
	elif command -v dnf &>/dev/null; then
		sudo dnf install -y jq
	elif command -v pacman &>/dev/null; then
		sudo pacman -S --needed --noconfirm jq
	else
		echo "[!!] Could not install jq — install it manually" >&2
		exit 1
	fi
	echo "[ok] jq installed"
fi

# --- 7. Update settings.json — set statusLine, unset subagentStatusLine ---
if [ -f "$SETTINGS_PATH" ]; then
	if ! jq empty "$SETTINGS_PATH" 2>/dev/null; then
		echo "[!!] $SETTINGS_PATH is not valid JSON — fix or delete, then re-run." >&2
		exit 1
	fi
	tmp=$(mktemp)
	jq '.statusLine = {"type": "command", "command": "~/.claude/claude-statusline"}
	    | del(.subagentStatusLine)' "$SETTINGS_PATH" > "$tmp"
	mv "$tmp" "$SETTINGS_PATH"
else
	cat > "$SETTINGS_PATH" << 'EOF'
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/claude-statusline"
  }
}
EOF
fi
echo "[ok] Updated $SETTINGS_PATH"

# --- 8. Check for a Nerd Font ---
# Match actual Nerd Font naming ("NerdFont", "Nerd Font", "Nerd_Font",
# "_NF-", "-NF."), not any file that just happens to contain "NF"
# somewhere in its name (INFROMAN.TTF, MYRIADPRONFONT.OTF, etc).
NERD_REGEX='Nerd[ _]?Font|[_-]NF[-_.]'

nerd_font_found=false
if command -v fc-list &>/dev/null && fc-list 2>/dev/null | grep -Eq "$NERD_REGEX"; then
	nerd_font_found=true
fi

if [ "$nerd_font_found" = false ]; then
	if [ -n "${WSL_DISTRO_NAME:-}" ]; then
		# WSL renders in a Windows terminal — the font must be on the Windows side
		font_dirs=(/mnt/c/Windows/Fonts /mnt/c/Users/*/AppData/Local/Microsoft/Windows/Fonts)
	else
		font_dirs=("$HOME/Library/Fonts" /Library/Fonts "$HOME/.local/share/fonts" "$HOME/.fonts" /usr/share/fonts /usr/local/share/fonts)
	fi
	for dir in "${font_dirs[@]}"; do
		if [ -d "$dir" ] && find "$dir" -type f 2>/dev/null | grep -Eq "$NERD_REGEX"; then
			nerd_font_found=true
			break
		fi
	done
fi

if [ "$nerd_font_found" = true ]; then
	echo "[ok] Nerd Font detected"
else
	echo "[!!] No Nerd Font detected — the statusline uses glyphs that need a font with Nerd Font support to render properly."
	if command -v brew &>/dev/null; then
		echo "     Install one via Homebrew, e.g.: brew install --cask font-meslo-lg-nerd-font"
	else
		echo "     Install one (e.g. Meslo) from https://www.nerdfonts.com/font-downloads"
	fi
	echo "     After installing, change your terminal settings to use the new font."
fi

# --- 9. Smoke test ---
echo "[..] Smoke test..."
fixture='{"cwd":"'"$HOME"'","model":{"display_name":"Opus"},"effort":{"level":"xhigh"},"context_window":{"used_percentage":42}}'
out=$(COLUMNS=120 printf '%s' "$fixture" | "$CLAUDE_DIR/claude-statusline")
if [ -z "$out" ]; then
	echo "[!!] Smoke test failed: $CLAUDE_DIR/claude-statusline produced no output." >&2
	exit 1
fi
echo "[ok] Smoke test passed"

# --- Done ---
echo ""
echo "Restart Claude Code to see the statusline."
echo "Shows: directory | branch | model . effort | ctx meter | 5h meter"
