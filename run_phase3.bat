@echo off
setlocal
cd /d "C:\Users\GYao\Desktop\gyao_voltera\Data Driven Decision System (DDDs)\Phase3\prod"

set TS=%DATE:~-4%%DATE:~4,2%%DATE:~7,2%_%TIME:~0,2%%TIME:~3,2%%TIME:~6,2%
set TS=%TS: =0%

"C:\Users\GYao\Desktop\gyao_voltera\Data Driven Decision System (DDDs)\Phase3\prod\venv\Scripts\python.exe" run_if_inputs_changed.py >> "logs\taskscheduler_guard_%TS%.log" 2>&1
endlocal
