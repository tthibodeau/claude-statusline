#Requires -Version 5.1
<#
.SYNOPSIS
    Self-contained installer for the Claude Code statusline on Windows.

.DESCRIPTION
    Fetch and run:
      irm https://raw.githubusercontent.com/tthibodeau/claude-statusline/main/install.ps1 | iex

    Steps, in order:

    1. Verify prerequisites - PowerShell 5.1+ (declared above), winget on PATH,
       and %USERPROFILE% resolves (i.e. a real interactive account).
    2. Ensure a Rust toolchain is available (installs via winget if missing).
    3. Ensure the MSVC C++ Build Tools are available (vendored libgit2 needs
       a linker; installs via winget if missing - this step is the slow one,
       a large download on a machine that doesn't already have it).
    4. Download the statusline's Cargo.toml + src/main.rs from the shared
       rust-src/ directory in this repo and build them locally in release
       mode.
    5. Deploy the compiled binary to ~/.claude/claude-statusline.exe.
    6. Ensure a Nerd Font is installed. Any Nerd Font works; the check looks
       for "Nerd" or "NF" in the font file names under %SystemRoot%\Fonts
       and %LOCALAPPDATA%\Microsoft\Windows\Fonts. If none is found, install
       DEVCOM.JetBrainsMonoNerdFont via winget (the only Nerd Font currently
       shipped through winget).
    7. Sweep any legacy bash statusline files from a prior install
       (statusline.sh, subagent-statusline.sh).
    8. Write statusLine into ~/.claude/settings.json; unset any existing
       subagentStatusLine so Claude Code falls back to its built-in
       "name . description . token count" default. Every other setting is
       preserved.
    9. Post-install smoke test - feed the deployed binary a fixture JSON and
       confirm it emits a non-empty line.

.NOTES
    Run once on any new machine. Restart Claude Code after running.

    macOS/Linux use install.sh instead, which builds the same
    Rust source from the same shared rust-src/ directory.
#>

$ErrorActionPreference = 'Stop'

$repoRawBase = 'https://raw.githubusercontent.com/tthibodeau/claude-statusline/main'
$claudeDir = Join-Path $env:USERPROFILE '.claude'

# =====================================================================
# 1. Prerequisites
# =====================================================================
if (-not $env:USERPROFILE) {
    Write-Error 'USERPROFILE is not set - nowhere to install to.'
    exit 1
}
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Error @'
winget is not on PATH. This installer uses it to install the Rust toolchain,
the MSVC Build Tools, and a Nerd Font. Install App Installer from the
Microsoft Store, sign in, then re-run.
'@
    exit 1
}
Write-Host "[ok] PowerShell $($PSVersionTable.PSVersion), winget available" -ForegroundColor Green

# =====================================================================
# 2. Ensure a Rust toolchain is available
# =====================================================================
$cargoCmd = Get-Command cargo -ErrorAction SilentlyContinue
$cargoExe = $null
if ($cargoCmd) {
    $cargoExe = $cargoCmd.Source
} else {
    $fallback = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
    if (Test-Path $fallback) { $cargoExe = $fallback }
}

if ($cargoExe) {
    Write-Host "[ok] cargo already installed ($cargoExe)" -ForegroundColor Green
} else {
    Write-Host "[..] Installing Rust toolchain via winget..." -ForegroundColor Cyan
    winget install --id Rustlang.Rustup --accept-source-agreements --accept-package-agreements --silent
    if ($LASTEXITCODE -ne 0) {
        Write-Error "winget install of Rustlang.Rustup failed (exit $LASTEXITCODE)."
        exit 1
    }
    $cargoExe = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
    if (-not (Test-Path $cargoExe)) {
        Write-Error "cargo.exe not found at $cargoExe after installing rustup."
        exit 1
    }
    Write-Host "[ok] Rust toolchain installed" -ForegroundColor Green
}
$cargoBin = Split-Path $cargoExe -Parent
$env:Path = "$cargoBin;$env:Path"

# =====================================================================
# 3. Ensure the MSVC C++ Build Tools are available
# =====================================================================
$vswherePath = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$hasVCTools = $false
if (Test-Path $vswherePath) {
    $vcInstall = & $vswherePath -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($vcInstall) { $hasVCTools = $true }
}

if ($hasVCTools) {
    Write-Host "[ok] MSVC C++ Build Tools already installed" -ForegroundColor Green
} else {
    Write-Host "[..] Installing MSVC C++ Build Tools via winget (large download, first time only)..." -ForegroundColor Cyan
    winget install --id Microsoft.VisualStudio.2022.BuildTools --accept-source-agreements --accept-package-agreements --silent --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
    if ($LASTEXITCODE -ne 0) {
        Write-Error "winget install of the MSVC Build Tools failed (exit $LASTEXITCODE). A linker is required to build claude-statusline."
        exit 1
    }
    Write-Host "[ok] MSVC C++ Build Tools installed" -ForegroundColor Green
}

# =====================================================================
# 4. Download the Rust source and build it
# =====================================================================
$buildDir = Join-Path $env:TEMP ("claude-statusline-build-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $buildDir 'src') -Force | Out-Null

try {
    Invoke-WebRequest -Uri "$repoRawBase/rust-src/Cargo.toml" -OutFile (Join-Path $buildDir 'Cargo.toml') -UseBasicParsing
    Invoke-WebRequest -Uri "$repoRawBase/rust-src/src/main.rs" -OutFile (Join-Path $buildDir 'src\main.rs') -UseBasicParsing

    Write-Host "[..] Building claude-statusline (release, first build may take a minute)..." -ForegroundColor Cyan
    Push-Location $buildDir
    try {
        & $cargoExe build --release --quiet
        if ($LASTEXITCODE -ne 0) {
            Write-Error "cargo build failed (exit $LASTEXITCODE)."
            exit 1
        }
    } finally {
        Pop-Location
    }
    Write-Host "[ok] Build complete" -ForegroundColor Green

    # =====================================================================
    # 5. Deploy the compiled binary
    # =====================================================================
    if (-not (Test-Path $claudeDir)) {
        New-Item -ItemType Directory -Path $claudeDir -Force | Out-Null
    }
    $exeDest = Join-Path $claudeDir 'claude-statusline.exe'
    $builtExe = Join-Path $buildDir 'target\release\claude-statusline.exe'
    Copy-Item $builtExe $exeDest -Force
    $sizeKb = [Math]::Round((Get-Item $exeDest).Length / 1KB, 1)
    Write-Host "[ok] Wrote $exeDest  ($sizeKb KB, ~40-50 ms/render)" -ForegroundColor Green
} finally {
    Remove-Item $buildDir -Recurse -Force -ErrorAction SilentlyContinue
}

# =====================================================================
# 6. Nerd Font (install one if none found)
# =====================================================================
$fontDirs = @("$env:SystemRoot\Fonts", "$env:LOCALAPPDATA\Microsoft\Windows\Fonts")
# The pattern below matches actual Nerd Font naming conventions and skips
# false positives like INFROMAN.TTF (which contains "NF" inside "INFROMAN"):
#   MesloLGMNerdFontMono-Regular.ttf   <- "NerdFont"
#   MesloLGM_Regular_Nerd_Font.ttf     <- "Nerd_Font"
#   FiraCode-Regular_NF.ttf            <- "_NF" then a boundary char
#   JetBrainsMono-NF-Regular.ttf       <- "-NF-"
$nerdFonts = foreach ($dir in $fontDirs) {
    Get-ChildItem $dir -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match 'Nerd[ _]?Font|[_-]NF[-_.]' }
}
if ($nerdFonts) {
    Write-Host "[ok] Nerd Font already installed ($($nerdFonts[0].Name))" -ForegroundColor Green
} else {
    Write-Host "[..] No Nerd Font found - installing JetBrainsMono Nerd Font via winget..." -ForegroundColor Cyan
    winget install --id DEVCOM.JetBrainsMonoNerdFont --accept-source-agreements --accept-package-agreements --silent
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[!!] winget install returned $LASTEXITCODE - the Nerd Font install did not complete." -ForegroundColor Yellow
        Write-Host "     Statusline glyphs will show as boxes until a Nerd Font is installed manually." -ForegroundColor Yellow
        Write-Host "     https://www.nerdfonts.com/font-downloads" -ForegroundColor Yellow
    } else {
        Write-Host "[ok] JetBrainsMono Nerd Font installed" -ForegroundColor Green
        Write-Host "     Change your terminal font to 'JetBrainsMono Nerd Font' in your terminal settings for the glyphs to render." -ForegroundColor DarkGray
    }
}

# =====================================================================
# 7. Sweep legacy files from prior installs
# =====================================================================
$legacyPatterns = @(
    'statusline.sh',
    'subagent-statusline.sh'
)
foreach ($name in $legacyPatterns) {
    $stale = Join-Path $claudeDir $name
    if (Test-Path $stale) {
        Remove-Item $stale -Force
        Write-Host "[ok] Removed stale $stale" -ForegroundColor Green
    }
}

# =====================================================================
# 8. Update settings.json - set statusLine, unset subagentStatusLine
# =====================================================================
$settingsPath = Join-Path $claudeDir 'settings.json'

if (Test-Path $settingsPath) {
    try {
        $settings = Get-Content $settingsPath -Raw | ConvertFrom-Json
    } catch {
        Write-Error "settings.json is not valid JSON - refusing to overwrite. Fix or delete $settingsPath, then re-run."
        exit 1
    }
} else {
    $settings = [PSCustomObject]@{}
}

$statusLineValue = [PSCustomObject]@{
    type    = 'command'
    command = '~/.claude/claude-statusline.exe'
}
if ($settings.PSObject.Properties['statusLine']) {
    $settings.statusLine = $statusLineValue
} else {
    $settings | Add-Member -NotePropertyName 'statusLine' -NotePropertyValue $statusLineValue
}

# Unset subagentStatusLine so Claude Code falls back to its built-in
# "name . description . token count" default row rendering.
if ($settings.PSObject.Properties['subagentStatusLine']) {
    $settings.PSObject.Properties.Remove('subagentStatusLine')
    Write-Host "[ok] Removed subagentStatusLine (Claude Code's default row rendering takes over)" -ForegroundColor Green
}

# Save as UTF-8 with BOM, per this repo's PowerShell file convention.
$settingsJson = $settings | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText($settingsPath, $settingsJson, [System.Text.UTF8Encoding]::new($true))
Write-Host "[ok] Updated $settingsPath  (statusLine -> ~/.claude/claude-statusline.exe)" -ForegroundColor Green

# =====================================================================
# 9. Post-install smoke test
# =====================================================================
Write-Host "[..] Smoke test..." -ForegroundColor Cyan
$fixture = '{"cwd":"' + ($env:USERPROFILE -replace '\\','/') + '","model":{"display_name":"Opus"},"effort":{"level":"xhigh"},"context_window":{"used_percentage":42}}'
$env:COLUMNS = '120'
$out = $fixture | & $exeDest
if ([string]::IsNullOrWhiteSpace($out)) {
    Write-Error "Smoke test failed: $exeDest produced no output."
    exit 1
}
Write-Host "[ok] Smoke test passed  ($($out.Length) bytes emitted)" -ForegroundColor Green

# =====================================================================
# Done
# =====================================================================
Write-Host ''
Write-Host 'Restart Claude Code to see the statusline.' -ForegroundColor Cyan
Write-Host 'Shows: directory | branch | model . effort | ctx meter | 5h meter' -ForegroundColor DarkGray
