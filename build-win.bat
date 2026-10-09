@echo off
REM Build Windows single-file exe (no Node/npm needed at runtime).
REM Requires: Node.js + opencode installed on the BUILD machine only.
setlocal
cd /d "%~dp0"
if not exist dist mkdir dist

echo [1/4] bundling with esbuild...
call npx -y esbuild oc-api-proxy.mjs --bundle --platform=node --format=cjs --outfile=dist/bundle.cjs
if errorlevel 1 exit /b 1

echo [2/4] generating SEA blob...
call node --experimental-sea-config sea-config.json
if errorlevel 1 exit /b 1

echo [3/4] copying node.exe...
for /f "delims=" %%N in ('where node') do set NODE_EXE=%%N & goto :copied
:copied
copy /y "%NODE_EXE%" "dist\oc-api-proxy.exe" >nul
if errorlevel 1 exit /b 1

echo [4/4] injecting blob...
for /f %%F in ('node scripts\get-fuse.cjs') do set FUSE=%%F
if not defined FUSE exit /b 1
call npx -y postject "dist\oc-api-proxy.exe" NODE_SEA_BLOB "dist\sea-prep.blob" --sentinel-fuse %FUSE%
if errorlevel 1 exit /b 1

echo.
echo DONE: dist\oc-api-proxy.exe
endlocal
