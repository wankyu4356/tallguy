@echo off
cd /d "%~dp0"
cmd /k "chcp 65001 >nul 2>&1 & call run.cmd"
