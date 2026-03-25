<# :
@echo off & cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "iex (Get-Content '%~f0' -Raw -Encoding UTF8)"
pause & exit /b
#>

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"
$Host.UI.RawUI.WindowTitle = "Naver News Clipper"

$REPO_URL = "https://github.com/wankyu4356/tallguy.git"
$FOLDER_NAME = "tallguy"

function Write-Step($step, $total, $msg) { Write-Host "`n[$step/$total] $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Fail($msg) { Write-Host "  [!] $msg" -ForegroundColor Yellow }
function Write-Err($msg) { Write-Host "  [X] $msg" -ForegroundColor Red }

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
Write-Ok "Git $((git --version) -replace 'git version ','')"

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
Write-Ok "Node.js $(node --version)"

$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) { Write-Err "npm not found. Reinstall Node.js."; return }
Write-Ok "npm $(npm --version)"

# ==============================================================
# 3. Clone or update repo
# ==============================================================
Write-Step 3 7 "Setting up project..."

$startDir = Get-Location

# Case A: already inside the project (start.bat is in repo root)
if (Test-Path ".git") {
    Write-Ok "Already in project: $(Get-Location)"
    $inProject = $true
}
# Case B: subfolder exists
elseif (Test-Path "$FOLDER_NAME\.git") {
    Set-Location $FOLDER_NAME
    Write-Ok "Found project: $(Get-Location)"
    $inProject = $true
}
# Case C: fresh clone needed
else {
    $inProject = $false
}

if ($inProject) {
    Write-Host "  Pulling latest code..."
    try {
        $branch = (git rev-parse --abbrev-ref HEAD 2>$null).Trim()
        git pull origin $branch 2>$null
        if ($LASTEXITCODE -eq 0) { Write-Ok "Branch: $branch (updated)" }
        else { Write-Fail "git pull failed - continuing with local code." }
    } catch {
        Write-Fail "git pull failed - continuing with local code."
    }
} else {
    Write-Host "  Cloning $REPO_URL ..."
    git clone $REPO_URL
    if ($LASTEXITCODE -ne 0) {
        Write-Err "git clone failed. Check your network connection."
        return
    }
    Set-Location $FOLDER_NAME
    Write-Ok "Cloned to: $(Get-Location)"

    # Copy start.bat into the cloned repo for next time
    $srcBat = Join-Path $startDir "start.bat"
    $dstBat = Join-Path (Get-Location) "start.bat"
    if ((Test-Path $srcBat) -and ($srcBat -ne $dstBat)) {
        Copy-Item $srcBat $dstBat -Force
    }
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
    npm install
    if ($LASTEXITCODE -ne 0) { Write-Err "npm install failed"; return }
} else {
    npm install --prefer-offline 2>$null | Out-Null
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
    npx playwright install chromium
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

$ErrorActionPreference = "Continue"
npx tsx src/index.ts
