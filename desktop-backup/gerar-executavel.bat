@echo off
cd /d "%~dp0"
py -m pip install -r requirements.txt pyinstaller
if errorlevel 1 pause & exit /b 1
py -m PyInstaller --noconfirm --clean --onefile --windowed --name Consulta_Backups_SANEAR app.py
if errorlevel 1 pause & exit /b 1
echo.
echo Executavel criado em: dist\Consulta_Backups_SANEAR.exe
pause
