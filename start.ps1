[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"
$Host.UI.RawUI.WindowTitle = "네이버 뉴스 클리퍼"

function Write-Step($step, $msg) { Write-Host "`n[$step/6] $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Fail($msg) { Write-Host "  [!] $msg" -ForegroundColor Yellow }
function Write-Err($msg) { Write-Host "  [!] $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "============================================================" -ForegroundColor White
Write-Host "  네이버 뉴스 클리퍼 - 원클릭 설치 및 실행" -ForegroundColor White
Write-Host "============================================================" -ForegroundColor White

# ==============================================================
# 1. 환경 체크
# ==============================================================
Write-Step 1 "환경 체크 중..."

# Git
$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) {
    Write-Err "Git이 설치되어 있지 않습니다."
    Write-Host "  https://git-scm.com/download/win 에서 설치하세요."
    $ans = Read-Host "  다운로드 페이지 열기? (Y/N)"
    if ($ans -eq "Y") { Start-Process "https://git-scm.com/download/win" }
    Write-Host "  Git 설치 후 다시 실행하세요."
    return
}
$gitVer = (git --version) -replace "git version ", ""
Write-Ok "Git $gitVer"

# Node.js
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Err "Node.js가 설치되어 있지 않습니다."

    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        Write-Host "  winget으로 Node.js 설치 시도 중..."
        winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -eq 0) {
            Write-Ok "설치 완료! 이 창을 닫고 다시 실행하세요."
            return
        }
    }

    Write-Host "  https://nodejs.org 에서 LTS 버전을 설치하세요."
    $ans = Read-Host "  다운로드 페이지 열기? (Y/N)"
    if ($ans -eq "Y") { Start-Process "https://nodejs.org" }
    return
}
Write-Ok "Node.js $(node --version)"

# npm
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) {
    Write-Err "npm을 찾을 수 없습니다. Node.js를 재설치하세요."
    return
}
Write-Ok "npm $(npm --version)"

# ==============================================================
# 2. 프로젝트 폴더
# ==============================================================
Write-Step 2 "프로젝트 폴더 확인..."

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectDir

if (-not (Test-Path ".git")) {
    Write-Err "Git 저장소가 아닙니다. start.bat 위치를 확인하세요."
    return
}
Write-Ok $projectDir

# ==============================================================
# 3. Git Pull
# ==============================================================
Write-Step 3 "최신 코드 가져오는 중..."

try {
    $branch = (git rev-parse --abbrev-ref HEAD 2>$null).Trim()
    git pull origin $branch 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Ok "브랜치: $branch"
    } else {
        Write-Fail "git pull 실패 - 로컬 코드로 계속합니다."
    }
} catch {
    Write-Fail "git pull 실패 - 로컬 코드로 계속합니다."
}

# ==============================================================
# 4. .env 환경변수
# ==============================================================
Write-Step 4 "환경변수 확인..."

if (-not (Test-Path ".env")) {
    Write-Host ""
    Write-Host "  .env 파일이 없습니다. 설정을 시작합니다." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  필요한 API 키:"
    Write-Host "    - Anthropic API Key (필수): https://console.anthropic.com"
    Write-Host "    - 네이버 API (권장): https://developers.naver.com/apps"
    Write-Host ""

    $apiKey = Read-Host "  Anthropic API Key (sk-ant-...)"
    if ([string]::IsNullOrWhiteSpace($apiKey)) {
        Write-Fail "미입력. .env.example을 복사합니다."
        if (Test-Path ".env.example") { Copy-Item ".env.example" ".env" }
    } else {
        $model = Read-Host "  Claude 모델 (Enter=claude-sonnet-4-20250514)"
        if ([string]::IsNullOrWhiteSpace($model)) { $model = "claude-sonnet-4-20250514" }

        $naverId = Read-Host "  네이버 Client ID (없으면 Enter)"
        $naverSec = Read-Host "  네이버 Client Secret (없으면 Enter)"

        @"
ANTHROPIC_API_KEY=$apiKey
CLAUDE_MODEL=$model
NAVER_CLIENT_ID=$naverId
NAVER_CLIENT_SECRET=$naverSec
"@ | Set-Content -Path ".env" -Encoding UTF8

        Write-Ok ".env 생성 완료"
    }
} else {
    $envContent = Get-Content ".env" -Raw
    if ($envContent -match "your-api-key-here") {
        Write-Fail "ANTHROPIC_API_KEY가 기본값입니다. .env 파일을 수정하세요."
    } else {
        Write-Ok ".env 확인 완료"
    }
}

# ==============================================================
# 5. 패키지 설치
# ==============================================================
Write-Step 5 "패키지 설치..."

if (-not (Test-Path "node_modules")) {
    Write-Host "  npm install 중 (최초 1회, 시간이 좀 걸립니다)..."
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Err "npm install 실패"
        return
    }
} else {
    npm install --prefer-offline 2>$null | Out-Null
}
Write-Ok "패키지 준비 완료"

# Chromium
Write-Host "  Chromium 확인 중..."
$chromeOk = $false

$pwDir = "$env:LOCALAPPDATA\ms-playwright"
if (Test-Path $pwDir) {
    $chromiumDirs = Get-ChildItem $pwDir -Directory -Filter "chromium-*" -ErrorAction SilentlyContinue
    foreach ($d in $chromiumDirs) {
        if (Test-Path "$($d.FullName)\chrome-win\chrome.exe") { $chromeOk = $true; break }
    }
}

if (-not $chromeOk) {
    $chromePaths = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )
    foreach ($p in $chromePaths) {
        if (Test-Path $p) { $chromeOk = $true; break }
    }
}

if (-not $chromeOk) {
    Write-Host "  Chromium 설치 중..."
    npx playwright install chromium
} else {
    Write-Ok "Chrome/Chromium 준비 완료"
}

# ==============================================================
# 6. 서버 실행
# ==============================================================
Write-Step 6 "서버 시작!"

Write-Host ""
Write-Host "============================================================" -ForegroundColor White
Write-Host "  http://localhost:3000 이 브라우저에서 열립니다." -ForegroundColor White
Write-Host "  종료: Ctrl+C 또는 이 창 닫기" -ForegroundColor White
Write-Host "============================================================" -ForegroundColor White
Write-Host ""

$ErrorActionPreference = "Continue"
npx tsx src/index.ts
