@echo off
title OSVIA Business Care
cd /d "%~dp0"

set "MESH=%~dp0meshcentral"
if not exist "%MESH%\node_modules\meshcentral\meshcentral.js" set "MESH=%~dp0..\osvia-meshcentral"

echo Starting MeshCentral...
if exist "%MESH%\node_modules\meshcentral\meshcentral.js" (
  start "OSVIA MeshCentral" /MIN cmd /c "cd /d "%MESH%" && node node_modules\meshcentral"
) else (
  echo MeshCentral was not found. Run npm install inside the meshcentral folder.
)

timeout /t 4 /nobreak >nul

if exist "%MESH%\agents\meshagent64-OSVIATechnologies.exe" (
  echo Starting the MeshAgent on this PC...
  start "" /MIN "%MESH%\agents\meshagent64-OSVIATechnologies.exe" run --agentName=OSVIA-HOME-SERVER
)

echo Opening the portal...
start "" "http://127.0.0.1:3080"

node --experimental-sqlite --no-warnings=ExperimentalWarning server\index.js
