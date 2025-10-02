@echo off
chcp 65001 >nul

REM ========================================
REM  VCPChat 启动脚本 (Python 3.13 环境)
REM ========================================

REM 设置 UTF-8 编码环境变量
set "PYTHONIOENCODING=utf-8"
set "PYTHONUTF8=1"
set "PYTHONLEGACYWINDOWSSTDIO=utf-8"

REM 设置 Python 3.13 路径
set "PYTHON313_PATH=C:\Users\30861\AppData\Local\Programs\Python\Python313"
set "PYTHON313_SCRIPTS=%PYTHON313_PATH%\Scripts"

REM 将 Python 3.13 添加到 PATH 最前面（仅对本次启动有效）
set "PATH=%PYTHON313_PATH%;%PYTHON313_SCRIPTS%;%PATH%"

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