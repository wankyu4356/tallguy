<# :
@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { iex (Get-Content '%~f0' -Raw -Encoding UTF8) } catch { Write-Host $_.Exception.Message -ForegroundColor Red }"
echo.
pause
exit /b
#>

# === Naver News Clipper - One-Click Setup ===
# ErrorActionPreference is intentionally left at "Continue" (default)
# to prevent git/npm stderr from killing the script.

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Host.UI.RawUI.WindowTitle = "Naver News Clipper"

$REPO_URL = "https://github.com/wankyu4356/tallguy.git"
$FOLDER_NAME = "tallguy"
$BRANCH = "claude/naver-news-clipper-nzP8W"

function Write-Step($step, $total, $msg) { Write-Host "`n[$step/$total] $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Fail($msg) { Write-Host "  [!] $msg" -ForegroundColor Yellow }
function Write-Err($msg) { Write-Host "  [X] $msg" -ForegroundColor Red }

# Helper: run external command, suppress stderr noise, return exit code
function Invoke-Cmd {
    param([string]$cmd)
    $output = cmd /c "$cmd 2>&1"
    return $LASTEXITCODE
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor White
Write-Host "  Naver News Clipper - One-Click Setup" -ForegroundColor White
Write-Host "============================================================" -ForegroundColor White

# ==============================================================
# 1. Check Git
# ==============================================================
Write-Step 1 7 "Checking Git..."

$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) {
    Write-Err "Git not found."
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        Write-Host "  Installing Git via winget..."
        winget install Git.Git --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -eq 0) {
            Write-Ok "Git installed! Close this window and run again."
            return
        }
    }
    Write-Host "  https://git-scm.com/download/win"
    $ans = Read-Host "  Open download page? (Y/N)"
    if ($ans -eq "Y") { Start-Process "https://git-scm.com/download/win" }
    return
}
$gitVer = (cmd /c "git --version 2>&1") -replace "git version ", ""
Write-Ok "Git $gitVer"

# ==============================================================
# 2. Check Node.js
# ==============================================================
Write-Step 2 7 "Checking Node.js..."

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Err "Node.js not found."
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        Write-Host "  Installing Node.js via winget..."
        winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -eq 0) {
            Write-Ok "Node.js installed! Close this window and run again."
            return
        }
    }
    Write-Host "  https://nodejs.org"
    $ans = Read-Host "  Open download page? (Y/N)"
    if ($ans -eq "Y") { Start-Process "https://nodejs.org" }
    return
}
$nodeVer = (cmd /c "node --version 2>&1")
Write-Ok "Node.js $nodeVer"

$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) { Write-Err "npm not found. Reinstall Node.js."; return }
$npmVer = (cmd /c "npm --version 2>&1")
Write-Ok "npm $npmVer"

# ==============================================================
# 3. Clone or update repo
# ==============================================================
Write-Step 3 7 "Setting up project..."

$startDir = (Get-Location).Path

# Case A: start.bat is inside the project root
if (Test-Path "package.json") {
    Write-Ok "Already in project: $startDir"
}
# Case B: subfolder exists from previous clone
elseif (Test-Path "$FOLDER_NAME\package.json") {
    Set-Location $FOLDER_NAME
    Write-Ok "Found project: $(Get-Location)"
}
# Case C: .git exists but wrong branch (no package.json)
elseif (Test-Path ".git") {
    Write-Host "  Switching to branch $BRANCH..."
    cmd /c "git fetch origin $BRANCH 2>&1" | Out-Null
    cmd /c "git checkout $BRANCH 2>&1" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        cmd /c "git checkout -b $BRANCH origin/$BRANCH 2>&1" | Out-Null
    }
    cmd /c "git pull origin $BRANCH 2>&1" | Out-Null
    if (Test-Path "package.json") { Write-Ok "Branch: $BRANCH" }
    else { Write-Err "package.json not found after checkout."; return }
}
elseif (Test-Path "$FOLDER_NAME\.git") {
    Set-Location $FOLDER_NAME
    Write-Host "  Switching to branch $BRANCH..."
    cmd /c "git fetch origin $BRANCH 2>&1" | Out-Null
    cmd /c "git checkout $BRANCH 2>&1" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        cmd /c "git checkout -b $BRANCH origin/$BRANCH 2>&1" | Out-Null
    }
    cmd /c "git pull origin $BRANCH 2>&1" | Out-Null
    if (Test-Path "package.json") { Write-Ok "Branch: $BRANCH" }
    else { Write-Err "package.json not found after checkout."; return }
}
# Case D: fresh clone
else {
    Write-Host "  Cloning repository..."
    cmd /c "git clone --branch $BRANCH $REPO_URL 2>&1" | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
    if (-not (Test-Path "$FOLDER_NAME\package.json")) {
        Write-Err "Clone failed. Check your network."
        return
    }
    Set-Location $FOLDER_NAME
    Write-Ok "Cloned to: $(Get-Location)"
}

# Always try to pull latest
Write-Host "  Pulling latest..."
cmd /c "git pull origin $BRANCH 2>&1" | Out-Null
if ($LASTEXITCODE -eq 0) { Write-Ok "Up to date" }
else { Write-Fail "Pull failed - using local code." }

# Copy start.bat into project for convenience
$srcBat = Join-Path $startDir "start.bat"
$dstBat = Join-Path (Get-Location).Path "start.bat"
if ((Test-Path $srcBat) -and ($srcBat -ne $dstBat)) {
    Copy-Item $srcBat $dstBat -Force
}

# ==============================================================
# 4. .env setup
# ==============================================================
Write-Step 4 7 "Checking .env..."

if (-not (Test-Path ".env")) {
    Write-Host ""
    Write-Host "  .env file not found. Let's set it up." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Required API keys:"
    Write-Host "    - Anthropic API Key (required): https://console.anthropic.com"
    Write-Host "    - Naver API (recommended):      https://developers.naver.com/apps"
    Write-Host ""

    $apiKey = Read-Host "  Anthropic API Key (sk-ant-...)"
    if ([string]::IsNullOrWhiteSpace($apiKey)) {
        Write-Fail "Skipped. Copying .env.example instead."
        if (Test-Path ".env.example") { Copy-Item ".env.example" ".env" }
    } else {
        $model = Read-Host "  Claude model (Enter = claude-sonnet-4-20250514)"
        if ([string]::IsNullOrWhiteSpace($model)) { $model = "claude-sonnet-4-20250514" }

        $naverId = Read-Host "  Naver Client ID (Enter to skip)"
        $naverSec = Read-Host "  Naver Client Secret (Enter to skip)"

        @"
ANTHROPIC_API_KEY=$apiKey
CLAUDE_MODEL=$model
NAVER_CLIENT_ID=$naverId
NAVER_CLIENT_SECRET=$naverSec
"@ | Set-Content -Path ".env" -Encoding UTF8

        Write-Ok ".env created"
    }
} else {
    $envContent = Get-Content ".env" -Raw
    if ($envContent -match "your-api-key-here") {
        Write-Fail "ANTHROPIC_API_KEY is placeholder. Edit .env file."
    } else {
        Write-Ok ".env OK"
    }
}

# ==============================================================
# 5. Install packages
# ==============================================================
Write-Step 5 7 "Installing packages..."

if (-not (Test-Path "node_modules")) {
    Write-Host "  Running npm install (first time, may take a while)..."
    cmd /c "npm install 2>&1" | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
    if (-not (Test-Path "node_modules")) { Write-Err "npm install failed"; return }
} else {
    cmd /c "npm install --prefer-offline 2>&1" | Out-Null
}
Write-Ok "Packages ready"

# ==============================================================
# 6. Chromium
# ==============================================================
Write-Step 6 7 "Checking Chromium..."

$chromeOk = $false

$pwDir = "$env:LOCALAPPDATA\ms-playwright"
if (Test-Path $pwDir) {
    $chromiumDirs = Get-ChildItem $pwDir -Directory -Filter "chromium-*" -ErrorAction SilentlyContinue
    foreach ($d in $chromiumDirs) {
        if (Test-Path "$($d.FullName)\chrome-win\chrome.exe") { $chromeOk = $true; break }
    }
}

if (-not $chromeOk) {
    @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    ) | ForEach-Object { if (Test-Path $_) { $chromeOk = $true } }
}

if (-not $chromeOk) {
    Write-Host "  Installing Chromium..."
    cmd /c "npx playwright install chromium 2>&1" | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
} else {
    Write-Ok "Chrome/Chromium ready"
}

# ==============================================================
# 7. Start server
# ==============================================================
Write-Step 7 7 "Starting server!"

Write-Host ""
Write-Host "============================================================" -ForegroundColor White
Write-Host "  http://localhost:3000" -ForegroundColor White
Write-Host "  Press Ctrl+C or close this window to stop." -ForegroundColor White
Write-Host "============================================================" -ForegroundColor White
Write-Host ""

# Use Start-Process to open browser after a delay
Start-Job -ScriptBlock { Start-Sleep 3; Start-Process "http://localhost:3000" } | Out-Null

cmd /c "npx tsx src/index.ts 2>&1"
