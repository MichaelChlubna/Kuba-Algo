@echo off
rem BTCUSDT footprint - launcher menu (double-click)
setlocal EnableDelayedExpansion
set prazdne=0
cd /d "%~dp0viewer"
where python >nul 2>nul || (echo Python neni v PATH. Nainstaluj Python 3.11+ a spust znovu. & pause & exit /b 1)

:menu
cls
echo ==========================================
echo   BTCUSDT perp - footprint
echo ==========================================
echo   1  Spustit viewer (http://localhost:8000)
echo   2  Aktualizovat data (stahnout + build do vcerejska)
echo   3  Validace (klines + znamy pripad A/B)
echo   4  Testy (pytest)
echo   5  Instalace knihoven (pip)
echo   0  Konec
echo.
set "volba="
set /p volba="Volba (1-5, 0 = konec): "
rem empty input never launches anything; repeated empty input (e.g. closed stdin) ends the menu
if "%volba%"=="" (
  set /a prazdne+=1
  if !prazdne! geq 3 exit /b 0
  goto menu
)
set prazdne=0
if "%volba%"=="1" goto viewer
if "%volba%"=="2" goto update
if "%volba%"=="3" goto validate
if "%volba%"=="4" goto tests
if "%volba%"=="5" goto install
if "%volba%"=="0" exit /b 0
goto menu

:viewer
rem never loop back after launching the viewer (prevents repeated browser launches)
call "%~dp0viewer.bat"
exit /b 0

:update
python -m fp download --end yesterday
python -m fp build --end yesterday
echo.
pause
goto menu

:validate
python -m fp validate
echo.
pause
goto menu

:tests
python -m pytest -q
echo.
pause
goto menu

:install
python -m pip install polars pyarrow pyyaml requests fastapi uvicorn pytest
echo.
pause
goto menu
