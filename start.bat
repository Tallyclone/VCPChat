@echo off
chcp 65001 >nul

REM ========================================
REM  VCPChat 启动脚本 (Python 3.13 环境)
REM ========================================

REM 设置 UTF-8 编码环境变量
set "PYTHONIOENCODING=utf-8"
set "PYTHONUTF8=1"
set "PYTHONLEGACYWINDOWSSTDIO=utf-8"

echo ========================================
echo   启动 VCP Chat Desktop
echo ========================================
echo.
echo 使用 Python 版本:
python --version
echo.
echo 启动中...
echo ========================================
echo.


npm start
