#!/bin/bash
# 双击启动刷单词应用 (macOS)
# 逻辑：检测 python3，没有就下载 Python 官方安装包自动安装，然后启动服务
cd "$(dirname "$0")"

PY=python3
VER=3.15.2
PKG="$HOME/Downloads/python-$VER-macos11.pkg"

lan_tip() {
  local ip
  ip=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
  if [ -n "$ip" ]; then
    echo "同一 WiFi 下可用: http://$ip:8765"
  fi
}

if ! command -v "$PY" >/dev/null 2>&1; then
  echo "未检测到 Python 3，正在下载官方安装包（Python $VER）..."
  echo "下载地址: https://www.python.org/ftp/python/$VER/python-$VER-macos11.pkg"
  if curl -fL --retry 2 --progress-bar -o "$PKG" "https://www.python.org/ftp/python/$VER/python-$VER-macos11.pkg"; then
    echo "正在安装，请在提示时输入电脑开机密码..."
    if sudo installer -pkg "$PKG" -target /; then
      echo "Python 安装完成。"
    else
      echo "自动安装失败，请手动安装 Python 3: https://www.python.org/downloads/macos/"
      rm -f "$PKG"; read -r -p "按回车键退出..."; exit 1
    fi
    rm -f "$PKG"
  else
    echo "下载失败，请检查网络，或手动安装 Python 3: https://www.python.org/downloads/macos/"
    read -r -p "按回车键退出..."; exit 1
  fi
  # python.org 的 macOS 安装包会把 python3 链接到 /usr/local/bin
  if [ -x /usr/local/bin/python3 ]; then PY=/usr/local/bin/python3; fi
fi

if ! command -v "$PY" >/dev/null 2>&1 && [ ! -x "$PY" ]; then
  echo "Python 3 仍不可用，请手动安装后重试。"
  read -r -p "按回车键退出..."; exit 1
fi

# 8765 已有服务运行时不重复启动，避免残留多余端口进程
if curl -fsS -m 2 http://127.0.0.1:8765/api/status >/dev/null 2>&1; then
  echo "服务已在 8765 端口运行，直接打开浏览器（若页面显示旧 404，请按 Cmd+R 刷新）。"
  lan_tip
  open "http://localhost:8765"
  exit 0
fi

echo "使用 $($PY --version 2>&1) 启动服务..."
lan_tip
(sleep 1 && open "http://localhost:8765") &
"$PY" server.py 8765
