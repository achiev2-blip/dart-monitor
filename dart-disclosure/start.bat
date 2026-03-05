@echo off
chcp 65001 >nul
title Disclosure (Chain + Viewer 3100)

cd /d "%~dp0"
echo [INFO] Disclosure System Starting...

:: Check Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found
    pause
    exit /b 1
)

:: Auto install
if not exist "node_modules\" (
    echo [INSTALL] Running npm install...
    npm install
)

:: Kill existing port 3100
echo [CHECK] Port 3100...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3100 " ^| findstr "LISTENING" 2^>nul') do (
    echo [WARN] Port 3100 in use by PID %%p - killing...
    taskkill /f /pid %%p >nul 2>&1
    timeout /t 2 /nobreak >nul
)

:: Process 1: Chain (collector + classifier) — 24시간 가동
echo [CHAIN] Starting pipeline (collector + classifier)...
start "Disclosure Chain" /min cmd /c "node disclosure-chain.js"

:: Process 2: Viewer (Express)
set RESTART_COUNT=0

:RESTART_LOOP
set /a RESTART_COUNT+=1

:: 첫 시작 시 브라우저 자동 열기
if %RESTART_COUNT% == 1 (
    start /b cmd /c "timeout /t 5 /nobreak >nul && start http://localhost:3100"
)

echo.
echo ============================================================
echo   Disclosure Viewer (Port 3100)  [restart #%RESTART_COUNT%]
echo   Time: %DATE% %TIME%
echo   URL : http://localhost:3100
echo ============================================================
echo.

node disclosure-server-viewer.js

set EXIT_CODE=%ERRORLEVEL%
echo.
echo [EXIT] Server stopped (code: %EXIT_CODE%) %DATE% %TIME%

if "%EXIT_CODE%" == "0" (
    echo [STOP] Clean exit - not restarting.
    goto :END
)

echo [RESTART] Crash detected - restarting in 5 seconds...
echo          Press Ctrl+C to cancel
timeout /t 5 /nobreak
goto :RESTART_LOOP

:END
echo.
echo Server fully stopped.
pause
