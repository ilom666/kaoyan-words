#!/bin/bash
# 通用 Linux 启动脚本：检测 python3，没有就按发行版自动安装，然后启动服务
cd "$(dirname "$0")"

PY=python3

if ! command -v "$PY" >/dev/null 2>&1; then
  echo "未检测到 Python 3，正在尝试自动安装（需要 sudo 管理员权限）..."
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update && sudo apt-get install -y python3
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y python3
  elif command -v yum >/dev/null 2>&1; then
    sudo yum install -y python3
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -S --noconfirm python
  elif command -v apk >/dev/null 2>&1; then
    sudo apk add python3
  elif command -v zypper >/dev/null 2>&1; then
    sudo zypper install -y python3
  else
    echo "未识别的发行版，请自行安装 Python 3: https://www.python.org/downloads/"
    read -r -p "按回车键退出..."; exit 1
  fi
fi

if ! command -v "$PY" >/dev/null 2>&1; then
  echo "Python 3 安装失败，请手动安装后重试: https://www.python.org/downloads/"
  read -r -p "按回车键退出..."; exit 1
fi

echo "使用 $($PY --version 2>&1) 启动服务..."
(sleep 1 && (command -v open >/dev/null 2>&1 && open "http://localhost:8765" || xdg-open "http://localhost:8765")) >/dev/null 2>&1 &
"$PY" server.py 8765
