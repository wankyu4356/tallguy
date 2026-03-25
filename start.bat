@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion

title 네이버 뉴스 클리퍼 - 원클릭 실행

echo.
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo   네이버 뉴스 클리퍼 - 원클릭 설치 및 실행
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.

:: ============================================================
:: 1. 환경 체크
:: ============================================================

echo [1/6] 환경 체크 중...
echo.

:: --- Git 체크 ---
where git >nul 2>&1
if %errorlevel% neq 0 (
    echo   [!] Git이 설치되어 있지 않습니다.
    echo.
    echo   Git 설치 방법:
    echo     1) https://git-scm.com/download/win 에서 다운로드
    echo     2) 설치 후 이 파일을 다시 실행하세요
    echo.
    echo   자동으로 다운로드 페이지를 열까요? (Y/N)
    set /p INSTALL_GIT="> "
    if /i "!INSTALL_GIT!"=="Y" (
        start https://git-scm.com/download/win
    )
    echo.
    echo   Git 설치 후 이 파일을 다시 실행하세요.
    goto :end
) else (
    for /f "tokens=3" %%v in ('git --version') do set GIT_VER=%%v
    echo   [OK] Git !GIT_VER!
)

:: --- Node.js 체크 ---
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo   [!] Node.js가 설치되어 있지 않습니다.
    echo.
    echo   자동 설치를 시도합니다...
    echo.

    :: winget으로 시도
    where winget >nul 2>&1
    if !errorlevel! equ 0 (
        echo   winget으로 Node.js LTS 설치 중...
        winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
        if !errorlevel! equ 0 (
            echo.
            echo   [OK] Node.js 설치 완료!
            echo   [!] 환경변수 반영을 위해 이 창을 닫고 다시 실행하세요.
            goto :end
        )
    )

    :: winget 실패 시 수동 안내
    echo   자동 설치에 실패했습니다.
    echo.
    echo   Node.js 수동 설치 방법:
    echo     1) https://nodejs.org 에서 LTS 버전 다운로드
    echo     2) 설치 후 이 파일을 다시 실행하세요
    echo.
    echo   다운로드 페이지를 열까요? (Y/N)
    set /p INSTALL_NODE="> "
    if /i "!INSTALL_NODE!"=="Y" (
        start https://nodejs.org
    )
    goto :end
) else (
    for /f "tokens=1" %%v in ('node --version') do set NODE_VER=%%v
    echo   [OK] Node.js !NODE_VER!
)

:: --- npm 체크 ---
where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo   [!] npm을 찾을 수 없습니다. Node.js를 재설치하세요.
    goto :end
) else (
    for /f "tokens=1" %%v in ('npm --version') do set NPM_VER=%%v
    echo   [OK] npm !NPM_VER!
)

echo.

:: ============================================================
:: 2. 프로젝트 디렉토리 이동
:: ============================================================

echo [2/6] 프로젝트 폴더 확인 중...

:: 배치 파일이 있는 디렉토리로 이동
cd /d "%~dp0"

:: Git 저장소인지 확인
if not exist ".git" (
    echo   [!] 이 폴더는 Git 저장소가 아닙니다.
    echo   start.bat 파일이 프로젝트 루트에 있는지 확인하세요.
    goto :end
)
echo   [OK] 프로젝트 폴더: %cd%
echo.

:: ============================================================
:: 3. 최신 코드 Pull
:: ============================================================

echo [3/6] 최신 코드 가져오는 중...

git pull origin main 2>nul
if %errorlevel% neq 0 (
    :: main 브랜치가 아닐 수 있으므로 현재 브랜치에서 pull
    for /f "tokens=*" %%b in ('git rev-parse --abbrev-ref HEAD') do set BRANCH=%%b
    git pull origin !BRANCH! 2>nul
    if !errorlevel! neq 0 (
        echo   [!] git pull 실패 - 네트워크를 확인하세요. 로컬 코드로 계속합니다.
    ) else (
        echo   [OK] 최신 코드 (브랜치: !BRANCH!)
    )
) else (
    echo   [OK] 최신 코드 (브랜치: main)
)
echo.

:: ============================================================
:: 4. 환경변수 (.env) 체크
:: ============================================================

echo [4/6] 환경변수 설정 확인 중...

if not exist ".env" (
    echo.
    echo   ============================================================
    echo   .env 파일이 없습니다. 초기 설정을 진행합니다.
    echo   ============================================================
    echo.
    echo   아래 API 키를 준비하세요:
    echo.
    echo   1) Anthropic Claude API Key (필수)
    echo      - https://console.anthropic.com 에서 발급
    echo.
    echo   2) 네이버 Open API (권장 - 더 정확한 검색)
    echo      - https://developers.naver.com/apps 에서 애플리케이션 등록
    echo      - 사용 API: "검색" 선택
    echo      - Client ID / Client Secret 발급
    echo.

    :: Anthropic API Key
    set /p ANT_KEY="  Anthropic API Key (sk-ant-...): "
    if "!ANT_KEY!"=="" (
        echo   [!] API Key가 입력되지 않았습니다.
        echo   .env.example 파일을 .env로 복사 후 직접 수정하세요.
        copy .env.example .env >nul 2>&1
        goto :env_done
    )

    :: Claude Model
    set CLAUDE_MDL=claude-sonnet-4-20250514
    set /p CLAUDE_MDL_INPUT="  Claude 모델 (Enter=claude-sonnet-4-20250514): "
    if not "!CLAUDE_MDL_INPUT!"=="" set CLAUDE_MDL=!CLAUDE_MDL_INPUT!

    :: Naver API
    set /p NAVER_ID="  네이버 Client ID (없으면 Enter): "
    set /p NAVER_SEC="  네이버 Client Secret (없으면 Enter): "

    :: .env 파일 생성
    (
        echo ANTHROPIC_API_KEY=!ANT_KEY!
        echo CLAUDE_MODEL=!CLAUDE_MDL!
        echo NAVER_CLIENT_ID=!NAVER_ID!
        echo NAVER_CLIENT_SECRET=!NAVER_SEC!
    ) > .env

    echo.
    echo   [OK] .env 파일 생성 완료!
) else (
    :: .env 존재 — 필수 키 확인
    findstr /C:"ANTHROPIC_API_KEY=" .env >nul 2>&1
    if !errorlevel! neq 0 (
        echo   [!] ANTHROPIC_API_KEY가 .env에 없습니다. .env 파일을 확인하세요.
    ) else (
        :: 값이 비어있거나 placeholder인지 체크
        findstr /C:"ANTHROPIC_API_KEY=your-api-key-here" .env >nul 2>&1
        if !errorlevel! equ 0 (
            echo   [!] ANTHROPIC_API_KEY가 아직 기본값입니다. .env 파일을 수정하세요.
        ) else (
            echo   [OK] .env 파일 확인 완료
        )
    )
)

:env_done
echo.

:: ============================================================
:: 5. npm 의존성 설치
:: ============================================================

echo [5/6] 패키지 설치 중...

if not exist "node_modules" (
    echo   npm install 실행 중 (최초 1회, 시간이 좀 걸립니다)...
    call npm install
    if !errorlevel! neq 0 (
        echo   [!] npm install 실패. 오류 메시지를 확인하세요.
        goto :end
    )
    echo   [OK] 패키지 설치 완료
) else (
    :: package.json이 node_modules보다 새로우면 재설치
    call npm install --prefer-offline 2>nul
    echo   [OK] 패키지 확인 완료
)

:: --- Playwright Chromium 체크 ---
echo.
echo   Playwright Chromium 확인 중...
set "PW_CACHE=%LOCALAPPDATA%\ms-playwright"
set CHROMIUM_FOUND=0

if exist "!PW_CACHE!" (
    for /d %%d in ("!PW_CACHE!\chromium-*") do (
        if exist "%%d\chrome-win\chrome.exe" set CHROMIUM_FOUND=1
    )
)

if !CHROMIUM_FOUND! equ 0 (
    :: 시스템 Chrome도 체크
    if exist "%PROGRAMFILES%\Google\Chrome\Application\chrome.exe" (
        echo   [OK] 시스템 Chrome 감지 - Playwright Chromium 설치 생략
        set CHROMIUM_FOUND=1
    )
    if exist "%PROGRAMFILES(X86)%\Google\Chrome\Application\chrome.exe" (
        echo   [OK] 시스템 Chrome 감지 - Playwright Chromium 설치 생략
        set CHROMIUM_FOUND=1
    )
    if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" (
        echo   [OK] 시스템 Chrome 감지 - Playwright Chromium 설치 생략
        set CHROMIUM_FOUND=1
    )
)

if !CHROMIUM_FOUND! equ 0 (
    echo   Playwright Chromium 설치 중 (더벨 등 JS 사이트 기사 추출에 필요)...
    call npx playwright install chromium 2>nul
    if !errorlevel! equ 0 (
        echo   [OK] Chromium 설치 완료
    ) else (
        echo   [!] Chromium 설치 실패 - 더벨 기사는 요약만 표시됩니다.
    )
) else (
    if !CHROMIUM_FOUND! equ 1 (
        echo   [OK] Chromium 준비 완료
    )
)

echo.

:: ============================================================
:: 6. 서버 실행
:: ============================================================

echo [6/6] 서버 시작 중...
echo.
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo   잠시 후 브라우저에서 http://localhost:3000 이 열립니다.
echo   이 창을 닫으면 서버가 종료됩니다.
echo   종료하려면 Ctrl+C를 누르세요.
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.

call npx tsx src/index.ts

:end
echo.
echo 아무 키나 누르면 종료합니다...
pause >nul
endlocal
