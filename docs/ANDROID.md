# 在安卓手机上使用刷单词

本应用是 Python 标准库写的本地 Web 服务，没有安卓原生客户端。在安卓手机上通过 **Termux**（安卓上的 Linux 终端环境）手动运行即可，无需安装 APK 或额外脚本。

## 1. 安装 Termux

从 **F-Droid** 安装 Termux：https://f-droid.org/packages/com.termux/

> 不要装 Play 商店版本（已停止维护，包内组件过旧，可能无法安装 Python）。

## 2. 准备 Python 环境

打开 Termux，依次执行（`pkg` 提示时输入 `y`）：

```bash
pkg update -y
pkg install -y python git curl
python3 --version
```

最后一条能输出版本号（如 `Python 3.11.x`）即表示就绪。

## 3. 获取项目文件

**方式 A：从 GitHub 克隆（推荐，需联网）**

```bash
cd $HOME
git clone https://github.com/ilom666/kaoyan-words.git
cd kaoyan-words
```

**方式 B：手动复制到手机**

把整个项目文件夹（从电脑拷贝，或用网盘/数据线传输）放到手机内部存储，例如 `Download/kaoyan-words`。然后让 Termux 访问手机存储：

```bash
termux-setup-storage      # 首次会弹权限请求，点允许
cd ~/storage/downloads/kaoyan-words
```

## 4. 首次初始化词库

仓库里只带纯净词库 `data/words.db`（不含个人进度）。第一次启动时服务端会自动从它生成一份本地运行库 `data/app.db`。这一步无需手动操作，直接按第 5 步启动即可。

## 5. 启动服务

在项目目录执行：

```bash
python3 server.py
```

看到如下输出即启动成功：

```text
✓ 刷单词服务已启动: http://localhost:8765
  按 Ctrl+C 停止
```

> 如需换端口：`python3 server.py 9999`。

## 6. 在手机上打开应用

用手机浏览器访问：

```text
http://127.0.0.1:8765
```

Termux 与浏览器同属一个网络命名空间，`127.0.0.1` 可直接访问。之后就可以像在电脑上一样刷词、编辑词库、统计等。

**停止服务**：回到 Termux 按 `Ctrl+C`，或另开一个 Termux 会话执行 `pkill -f "server.py"`。

## 7. 保持后台运行（可选）

默认情况下关掉 Termux 窗口服务就停了。想让服务在后台常驻，可用 Termux 的会话/后台功能，或安装 `Termux:Boot` 实现开机自启：

- 安装 Termux:Boot：https://f-droid.org/packages/com.termux.boot/
- 创建自启配置：

```bash
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/start-words <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
cd $HOME/kaoyan-words
python3 server.py
EOF
chmod +x ~/.termux/boot/start-words
```

重启手机后会自动启动服务。若不需要，删除 `~/.termux/boot/start-words` 即可。

> Android 的省电策略可能杀掉后台进程。若锁屏后服务停止，在系统设置里把 Termux 加入「电池优化白名单」，并在 Termux 里执行 `termux-wake-lock` 持有唤醒锁。

## 8. 更新词库与保存数据

- **词库改动**（编辑/新增/删除词条）保存在 `data/app.db`，这是私人运行库，不会上传。
- **学习进度、收藏、设置、小游戏记录、阅读文章**同样只存在本地 `data/app.db`。
- 更新仓库代码：`git pull`。
- 若要提交词库改动到 GitHub，先在 Termux 里导出纯净词库再提交（个人状态不会被上传）：

```bash
cd ~/kaoyan-words
python3 export_db.py
git add data/words.db
git commit -m "更新词库"
git push
```

> `git push` 需要配置账号与凭据。若只是本机使用，不必执行。

## 9. 常见问题

| 现象 | 原因与处理 |
|---|---|
| `python3: not found` | 未安装 Python，执行 `pkg install -y python`。 |
| `http://127.0.0.1:8765` 打不开 | 服务未启动或端口被占用；看 Termux 输出，或改端口 `python3 server.py 9999` 后访问对应端口。 |
| 打不开 GitHub / `git clone` 失败 | 网络问题或仓库地址变更；可改用第 3 节「方式 B」手动复制项目。 |
| 其他设备无法用手机 IP 访问 | 服务默认只监听 `127.0.0.1`（仅本机可访问），这是设计如此；如需局域网共享需自行修改 `server.py` 的监听地址。 |
| 锁屏后服务停止 | 电池优化；加白名单并执行 `termux-wake-lock`。 |
| 启动报数据库错误 | 删除 `data/app.db` 后重启，会从 `data/words.db` 重新生成（注意：个人进度会丢失，先确认无需保留）。 |
