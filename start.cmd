@echo off
cd /d "%~dp0"
node --experimental-sqlite server\index.js
