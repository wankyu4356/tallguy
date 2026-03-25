@echo off
setlocal enabledelayedexpansion

title 네이버 뉴스 클리퍼

echo.
echo ============================================================
echo   네이버 뉴스 클리퍼 - 원클릭 설치 및 실행
echo ============================================================
echo.

:: ============================================================
:: 1. 환경 체크
:: ============================================================

echo [1/6] 환경 체크 중...
echo.

:: --- Git ---
where git >nul 2>&1
if %errorlevel% neq 0 (
    echo   [!] Git이 설치되어 있지 않습니다.
    echo   https://git-scm.com/download/win 에서 설치하세요.
    echo.
    set /p OPEN_GIT="  다운로드 페이지 열기 (Y/N): "
    if /i "!OPEN_GIT!"=="Y" start "" "https://git-scm.com/download/win"
    echo   Git 설치 후 다시 실행하세요.
    goto :done
) else (
    for /f "tokens=3" %%v in ('git --version') do echo   [OK] Git %%v
)

:: --- Node.js ---
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo   [!] Node.js가 설치되어 있지 않습니다.
    echo.

    where winget >nul 2>&1
    if !errorlevel! equ 0 (
        echo   winget으로 Node.js 설치 시도 중...
        winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
        if !errorlevel! equ 0 (
            echo   [OK] 설치 완료! 이 창을 닫고 다시 실행하세요.
            goto :done
        )
    )

    echo   https://nodejs.org 에서 LTS 버전을 설치하세요.
    set /p OPEN_NODE="  다운로드 페이지 열기 (Y/N): "
    if /i "!OPEN_NODE!"=="Y" start "" "https://nodejs.org"
    goto :done
) else (
    for /f "tokens=1" %%v in ('node --version') do echo   [OK] Node.js %%v
)

:: --- npm ---
where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo   [!] npm을 찾을 수 없습니다. Node.js를 재설치하세요.
    goto :done
) else (
    for /f "tokens=1" %%v in ('npm --version') do echo   [OK] npm %%v
)

echo.

:: ============================================================
:: 2. 프로젝트 폴더
:: ============================================================

echo [2/6] 프로젝트 폴더 확인...

if not exist ".git" (
    echo   [!] Git 저장소가 아닙니다. start.bat 위치를 확인하세요.
    goto :done
)
echo   [OK] %cd%
echo.

:: ============================================================
:: 3. Git Pull
:: ============================================================

echo [3/6] 최신 코드 가져오는 중...

for /f "tokens=*" %%b in ('git rev-parse --abbrev-ref HEAD') do set "BRANCH=%%b"
git pull origin !BRANCH! 2>nul
if !errorlevel! neq 0 (
    echo   [!] git pull 실패 - 로컬 코드로 계속합니다.
) else (
    echo   [OK] 브랜치: !BRANCH!
)
echo.

:: ============================================================
:: 4. .env 환경변수
:: ============================================================

echo [4/6] 환경변수 확인...

if not exist ".env" (
    echo.
    echo   .env 파일이 없습니다. 설정을 시작합니다.
    echo.
    echo   필요한 API 키:
    echo     - Anthropic API Key (필수): https://console.anthropic.com
    echo     - 네이버 API (권장): https://developers.naver.com/apps
    echo.

    set /p ANT_KEY="  Anthropic API Key: "
    if "!ANT_KEY!"=="" (
        echo   [!] 미입력. .env.example을 복사합니다. 직접 편집하세요.
        if exist ".env.example" copy .env.example .env >nul
        goto :env_ok
    )

    set "MDL=claude-sonnet-4-20250514"
    set /p MDL_IN="  Claude 모델 (Enter=기본값): "
    if not "!MDL_IN!"=="" set "MDL=!MDL_IN!"

    set "NID="
    set "NSEC="
    set /p NID="  네이버 Client ID (없으면 Enter): "
    set /p NSEC="  네이버 Client Secret (없으면 Enter): "

    > .env (
        echo ANTHROPIC_API_KEY=!ANT_KEY!
        echo CLAUDE_MODEL=!MDL!
        echo NAVER_CLIENT_ID=!NID!
        echo NAVER_CLIENT_SECRET=!NSEC!
    )
    echo   [OK] .env 생성 완료
) else (
    echo   [OK] .env 확인 완료
)

:env_ok
echo.

:: ============================================================
:: 5. 패키지 설치
:: ============================================================

echo [5/6] 패키지 설치...

if not exist "node_modules" (
    echo   npm install 중 (최초 1회)...
    call npm install
    if !errorlevel! neq 0 (
        echo   [!] npm install 실패
        goto :done
    )
) else (
    call npm install --prefer-offline >nul 2>&1
)
echo   [OK] 패키지 준비 완료

:: Chromium
echo   Chromium 확인 중...
set "CHROME_OK=0"

set "PW_DIR=%LOCALAPPDATA%\ms-playwright"
if exist "!PW_DIR!" (
    for /d %%d in ("!PW_DIR!\chromium-*") do (
        if exist "%%d\chrome-win\chrome.exe" set "CHROME_OK=1"
    )
)
if "!CHROME_OK!"=="0" (
    if exist "%PROGRAMFILES%\Google\Chrome\Application\chrome.exe" set "CHROME_OK=1"
)
if "!CHROME_OK!"=="0" (
    if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME_OK=1"
)

if "!CHROME_OK!"=="0" (
    echo   Chromium 설치 중...
    call npx playwright install chromium
) else (
    echo   [OK] Chrome/Chromium 준비 완료
)
echo.

:: ============================================================
:: 6. 서버 실행
:: ============================================================

echo [6/6] 서버 시작!
echo.
echo ============================================================
echo   http://localhost:3000 이 브라우저에서 열립니다.
echo   종료: Ctrl+C 또는 이 창 닫기
echo ============================================================
echo.

call npx tsx src/index.ts

:done
echo.
echo 아무 키나 누르면 종료합니다...
pause >nul
endlocal
