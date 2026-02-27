@echo off
chcp 65001 >nul
title DART Monitor v3.4

cd /d "%~dp0"
echo [INFO] Working directory: %CD%

:: Check Node.js
node --version >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install from https://nodejs.org
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo [INFO] Node.js %%v

:: Auto install node_modules if missing
if not exist "node_modules\" (
  echo [INSTALL] Running npm install...
  npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
  echo [DONE] npm install complete.
)

:: Kill any process using port 3000
echo [CHECK] Checking port 3000...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3000 " ^| findstr "LISTENING" 2^>nul') do (
  echo [WARN] Port 3000 in use by PID %%p - killing...
  taskkill /f /pid %%p >nul 2>&1
  timeout /t 2 /nobreak >nul
)

:: Check cloudflared service
echo [CHECK] Checking cloudflared tunnel...
sc query cloudflared >nul 2>&1
if errorlevel 1 (
  echo [WARN] cloudflared not registered. Run cloudflared_setup.bat as Administrator once.
) else (
  for /f "tokens=4" %%s in ('sc query cloudflared ^| findstr STATE') do (
    if "%%s" == "RUNNING" (
      echo [OK] cloudflared tunnel running.
    ) else (
      net start cloudflared >nul 2>&1
      echo [OK] cloudflared started.
    )
  )
)

:: Create folders
if not exist "data\" mkdir data
if not exist "logs\" mkdir logs

:: Auto-restart loop
set RESTART_COUNT=0

:RESTART_LOOP
set /a RESTART_COUNT+=1
set LOGFILE=logs\server_%DATE:~0,4%%DATE:~5,2%%DATE:~8,2%.log

echo.
echo ============================================================
echo   DART Monitor  (restart count: %RESTART_COUNT%)
echo   Time : %DATE% %TIME%
echo   URL  : http://localhost:3000
echo   Log  : %LOGFILE%
echo ============================================================
echo.

:: Open browser 3 sec after first start only
if %RESTART_COUNT% == 1 (
  start /b cmd /c "timeout /t 5 /nobreak >nul && start http://localhost:3000"
  start /b cmd /c "timeout /t 10 /nobreak >nul && start https://dartmonitor.com"
)

:: Run server via separate PS1 file (avoids long command line issues)
powershell -ExecutionPolicy Bypass -File "%~dp0run_server.ps1" -LogFile "%LOGFILE%"

set EXIT_CODE=%ERRORLEVEL%
echo.
echo [EXIT] Server stopped (code: %EXIT_CODE%) at %DATE% %TIME%

if "%EXIT_CODE%" == "0" (
  echo [STOP] Clean exit - not restarting.
  goto :END
)

echo [RESTART] Crash detected. Restarting in 5 seconds...
echo          (Press Ctrl+C to cancel)
timeout /t 5 /nobreak

goto :RESTART_LOOP

:END
echo.
echo Server fully stopped.
pause
