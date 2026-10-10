@echo off
title OSVIA Business Care
cd /d "%~dp0"

echo Starting MeshCentral...
start "OSVIA MeshCentral" /MIN cmd /c "cd /d C:\Users\JOSCOM\Desktop\osvia-meshcentral && node node_modules\meshcentral"

timeout /t 4 /nobreak >nul

echo Starting the MeshAgent on this PC...
start "" /MIN "C:\Users\JOSCOM\Desktop\osvia-meshcentral\agents\meshagent64-OSVIATechnologies.exe" run --agentName=OSVIA-HOME-SERVER

echo Opening the portal...
start "" "http://127.0.0.1:3080/#/remote"

node --experimental-sqlite --no-warnings=ExperimentalWarning server\index.js
