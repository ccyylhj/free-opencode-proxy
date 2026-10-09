@echo off
node "%~dp0oc-api-proxy.mjs" %*
if errorlevel 1 pause
