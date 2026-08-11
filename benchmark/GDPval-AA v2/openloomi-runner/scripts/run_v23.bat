@echo off
REM Runner v23 — with recursiveSignature fix that excludes the SSE debug
REM log from idle-detection (so the loop can ever reach the 300s timeout).
setlocal
set "LOG=D:\openloomi3\openloomi\benchmark\GDPval-AA v2\openloomi-runner\results\full_v23.log"
echo v23 start %DATE% %TIME% > "%LOG%"
set "OPENLOOMI_API_URL=http://127.0.0.1:3515"
set "PYTHONUNBUFFERED=1"
set "OPENLOOMI_DEBUG_SSE=1"
cd /d D:\openloomi3\openloomi
call "D:\openloomi3\openloomi\node_modules\.bin\tsx.cmd" "D:\openloomi3\openloomi\benchmark\GDPval-AA v2\openloomi-runner\src\index.ts" --dataset "D:\openloomi3\openloomi\benchmark\GDPval-AA v2\dataset\gdpval_gold.jsonl" --output "D:\openloomi3\openloomi\benchmark\GDPval-AA v2\openloomi-runner\results\gdpval_aa_v2_run.json" --reference-index "D:\openloomi3\openloomi\benchmark\GDPval-AA v2\dataset\reference_files\reference_files_index.json" --provider claude --model MiniMax-M3-highspeed --permission-mode bypassPermissions --timeout-ms 1800000 --retry-zero-deliverables >> "%LOG%" 2>&1
echo v23 exit %DATE% %TIME% >> "%LOG%"
endlocal