@echo off
echo Fixing Windows Time Sync...
echo.

sc query w32time
echo.

net start w32time
echo.

w32tm /resync
echo.

w32tm /query /status
echo.

echo Done.
pause
