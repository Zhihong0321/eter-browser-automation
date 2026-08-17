@echo off
REM ETER BROWSER launcher -- port 12780 only. Kills whatever holds 12780 first.
title ETER BROWSER :12780

set "ETER_BROWSER_PORT=12780"
set "APP=E:\000\001-browser-use-v2"

echo [1/3] freeing port 12780 ...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:":12780 .*LISTENING"') do (
  echo       killing PID %%P
  taskkill /f /pid %%P >nul 2>&1
)

echo [2/3] port check ...
netstat -ano | findstr /r /c:":12780 .*LISTENING" >nul && (
  echo       ERROR: 12780 still held. Not starting on any other port.
  pause
  exit /b 1
)
echo       12780 free

echo [3/3] starting eter-browser on 12780 ...
cd /d "%APP%"
node dist\cli.js ui --port 12780
pause
