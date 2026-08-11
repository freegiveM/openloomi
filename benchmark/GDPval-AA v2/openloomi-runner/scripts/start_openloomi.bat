@echo off
setlocal
set "IS_TAURI=true"
set "NODE_OPTIONS=--max-old-space-size=16384 --require ./scripts/patch-http-timeout.cjs"
set "PORT=3515"
cd /d D:\openloomi3\openloomi\apps\web
call "D:\openloomi3\openloomi\node_modules\.bin\next.cmd" dev --turbo > "D:\openloomi3\openloomi\openloomi_dev.log" 2>&1
endlocal