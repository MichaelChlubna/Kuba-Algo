@echo off
rem Start the footprint viewer and open it in the browser (double-click)
setlocal
cd /d "%~dp0viewer"
netstat -ano | findstr /r /c:":8000 .*LISTENING" >nul
if not errorlevel 1 (
  echo Viewer uz bezi, oteviram prohlizec...
  start "" http://localhost:8000
  exit /b 0
)
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:8000"
echo Viewer bezi na http://localhost:8000  (ukonceni: Ctrl+C nebo zavrit okno)
python -m fp serve
