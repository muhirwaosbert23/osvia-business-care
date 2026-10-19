@echo off
cd /d "%~dp0"
if not exist node_modules\meshcentral\meshcentral.js (
  echo Install MeshCentral first: npm install
  exit /b 1
)
if not exist meshcentral-data\config.json (
  mkdir meshcentral-data
  copy /Y config.example.json meshcentral-data\config.json
)
echo Starting OSVIA MeshCentral on https://127.0.0.1:4430
node node_modules\meshcentral
