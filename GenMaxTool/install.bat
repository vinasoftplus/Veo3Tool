@echo off
echo ========================================
echo  GenMax Login Tool - Cai dat
echo ========================================
echo.
python --version
if errorlevel 1 (
    echo LỖI: Chua cai Python. Tai tai https://python.org
    pause
    exit /b 1
)
echo.
echo Cai dat thu vien...
pip install requests cloakbrowser
echo.
echo Hoan tat! Chay: python genmax_login.py
pause
