@echo off
setlocal
node "%~dp0scripts\one-install.js" %*
exit /b %ERRORLEVEL%
