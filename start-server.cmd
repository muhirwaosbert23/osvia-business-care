@echo off
title OSVIA Business Care
cd /d "%~dp0"
set "MESH=%~dp0..\osvia-meshcentral"

echo Starting MeshCentral...
if exist "%MESH%\node_modules\meshcentral\meshcentral.js" (
  start "OSVIA MeshCentral" /MIN cmd /c "cd /d "%MESH%" && node node_modules\meshcentral"
) else (
  echo MeshCentral was not found next to this folder: %MESH%
)

timeout /t 4 /nobreak >nul

if exist "%MESH%\agents\meshagent64-OSVIATechnologies.exe" (
  echo Starting the MeshAgent...
  start "" /MIN "%MESH%\agents\meshagent64-OSVIATechnologies.exe" run --agentName=OSVIA-HOME-SERVER
)

echo Starting the portal...
node --experimental-sqlite --no-warnings=ExperimentalWarning server\index.js
