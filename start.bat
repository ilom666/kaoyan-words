@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 刷单词

set "PYEXE="
where python >nul 2>nul && set "PYEXE=python"
if not defined PYEXE where py >nul 2>nul && set "PYEXE=py"

if not defined PYEXE (
  echo 未检测到 Python，正在下载官方安装包（Python 3.15.2，仅需一次）...
  set "INST=%TEMP%\python-3.15.2-amd64.exe"
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/3.15.2/python-3.15.2-amd64.exe' -OutFile '%INST%'"
  if not exist "%INST%" (
    echo 下载失败，请检查网络，或手动安装 Python 3: https://www.python.org/downloads/windows/
    pause
    exit /b 1
  )
  echo 正在静默安装到当前用户（无需管理员），请稍候...
  "%INST%" /quiet InstallAllUsers=0 PrependPath=1 Include_test=0
  del "%INST%" >nul 2>nul
  set "PYEXE=%LocalAppData%\Programs\Python\Python315\python.exe"
  if not exist "%PYEXE%" (
    echo 自动安装后仍未找到 python.exe，请手动安装: https://www.python.org/downloads/windows/
    pause
    exit /b 1
  )
)

echo 正在启动服务...
start "" http://localhost:8765
"%PYEXE%" server.py 8765
pause
