@echo off
chcp 65001 >nul
title Reports (Chain + Viewer 3200)

cd /d "%~dp0"
echo [INFO] Reports System Starting...

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

:: Kill existing port 3200
echo [CHECK] Port 3200...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3200 " ^| findstr "LISTENING" 2^>nul') do (
    echo [WARN] Port 3200 in use by PID %%p - killing...
    taskkill /f /pid %%p >nul 2>&1
    timeout /t 2 /nobreak >nul
)

:: Kill existing Chain
taskkill /fi "windowtitle eq Reports Chain" /f >nul 2>&1

:: Process 1: Chain (collector + classifier)
echo [CHAIN] Starting pipeline (collector + classifier)...
start "Reports Chain" /min cmd /c "node report-chain.js"

:: Process 2: Viewer (Express)
set RESTART_COUNT=0

:RESTART_LOOP
set /a RESTART_COUNT+=1

echo.
echo ============================================================
echo   Reports System (Port 3200)  [restart #%RESTART_COUNT%]
echo   Time : %DATE% %TIME%
echo   URL  : http://localhost:3200
echo ============================================================
echo.

:: 브라우저 자동 실행
start http://localhost:3200

node report-server-viewer.js

set EXIT_CODE=%ERRORLEVEL%
echo.
echo [EXIT] Viewer stopped (code: %EXIT_CODE%) %DATE% %TIME%

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
echo Viewer stopped. Note: Chain process may still be running in background.
echo To stop chain: taskkill /fi "windowtitle eq Reports Chain" /f
pause
