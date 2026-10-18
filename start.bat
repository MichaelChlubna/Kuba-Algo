@echo off
rem BTCUSDT footprint - launcher menu (double-click)
setlocal EnableDelayedExpansion
set prazdne=0
cd /d "%~dp0"
set docker=0
where docker >nul 2>nul && set docker=1

:menu
cls
echo ==========================================
echo   BTCUSDT perp - footprint (web)
echo ==========================================
echo   1  Spustit aplikaci (http://localhost:8000)
echo   2  Aktualizovat data (poslednich 30 dni do vcerejska)
echo   3  Ukazkova data (bez internetu, jen do prazdne slozky)
echo   4  Testy (pytest + vitest)
echo   5  Instalace knihoven (pip + npm)
echo   6  Zastavit aplikaci (docker)
echo   0  Konec
if "%docker%"=="1" (echo   rezim: Docker) else (echo   rezim: lokalni Python)
echo.
set "volba="
set /p volba="Volba (1-6, 0 = konec): "
rem empty input never launches anything; repeated empty input (e.g. closed stdin) ends the menu
if "%volba%"=="" (
  set /a prazdne+=1
  if !prazdne! geq 3 exit /b 0
  goto menu
)
set prazdne=0
if "%volba%"=="1" goto viewer
if "%volba%"=="2" goto update
if "%volba%"=="3" goto sample
if "%volba%"=="4" goto tests
if "%volba%"=="5" goto install
if "%volba%"=="6" goto stop
if "%volba%"=="0" exit /b 0
goto menu

:viewer
rem never loop back after launching the app (prevents repeated browser launches)
call "%~dp0viewer.bat"
exit /b 0

:update
if "%docker%"=="1" (docker compose run --rm updater update) else (pushd backend & python -m fp update & popd)
echo.
pause
goto menu

:sample
if "%docker%"=="1" (docker compose run --rm init) else (pushd backend & python -m fp sample & popd)
echo.
pause
goto menu

:tests
pushd backend & python -m pytest -q & popd
pushd frontend & call npm test & popd
echo.
pause
goto menu

:install
python -m pip install -r backend\requirements.txt -r backend\requirements-dev.txt
pushd frontend & call npm ci & popd
echo.
pause
goto menu

:stop
docker compose down
echo.
pause
goto menu
