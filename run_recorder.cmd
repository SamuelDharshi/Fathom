@echo off
rem Restarts the recorder if it ever exits. Each restart is recorded as a gap.
cd /d %~dp0
:loop
python -m fathom.recorder >> data\recorder.log 2>&1
timeout /t 3 /nobreak >nul
goto loop
