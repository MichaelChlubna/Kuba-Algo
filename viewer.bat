@echo off
rem Start the footprint web app and open it in the browser (double-click)
rem Docker Desktop: docker compose (web + daily data update). Without Docker: local Python server.
setlocal
cd /d "%~dp0"
netstat -ano | findstr /r /c:":8000 .*LISTENING" >nul
if not errorlevel 1 (
  echo Aplikace uz bezi, oteviram prohlizec...
  start "" http://localhost:8000
  exit /b 0
)
where docker >nul 2>nul
if not errorlevel 1 (
  docker compose up -d --build web updater || (echo Docker compose selhal. Bezi Docker Desktop? & pause & exit /b 1)
  timeout /t 3 /nobreak >nul
  start "" http://localhost:8000
  echo Aplikace bezi na http://localhost:8000  (zastaveni: start.bat, volba 6)
  timeout /t 5 >nul
  exit /b 0
)
where python >nul 2>nul || (echo Neni Docker ani Python. Nainstaluj Docker Desktop nebo Python 3.12+. & pause & exit /b 1)
if not exist "%~dp0frontend\dist\index.html" (
  where npm >nul 2>nul || (echo Frontend neni sestaveny a chybi Node.js. Nainstaluj Node 22+ nebo Docker Desktop. & pause & exit /b 1)
  pushd "%~dp0frontend" & call npm ci & call npm run build & popd
)
cd /d "%~dp0backend"
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:8000"
echo Aplikace bezi na http://localhost:8000  (ukonceni: Ctrl+C nebo zavrit okno)
python -m fp serve
