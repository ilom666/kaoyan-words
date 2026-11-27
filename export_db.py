#!/usr/bin/env python3
"""从本地运行库 data/app.db 导出纯净词库 data/words.db。

纯净词库只含 words（词库）与 meta（来源）表，state 置空，
不含学习进度、收藏、设置、游戏记录、阅读文章等个人状态，可安全提交到仓库。

用法: python3 export_db.py [输出文件]   默认输出 data/words.db
"""
import os
import sqlite3
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, 'data')
SRC = os.path.join(DATA_DIR, 'app.db')
DST = os.path.join(DATA_DIR, 'words.db')
TABLES = ('words', 'meta')


def export(src_path, dst_path):
    if not os.path.exists(src_path):
        raise SystemExit(f'找不到本地运行库: {src_path}')
    src = sqlite3.connect(src_path)
    tmp = dst_path + '.tmp'
    if os.path.exists(tmp):
        os.remove(tmp)
    dst = sqlite3.connect(tmp)
    try:
        src.execute('BEGIN')
        ddl = dict(src.execute("SELECT name, sql FROM sqlite_master WHERE type='table'").fetchall())
        for name in TABLES:
            if name not in ddl:
                if name == 'words':
                    raise SystemExit('源库缺少 words 表，无法导出')
                continue
            dst.execute(ddl[name])
            cols = [r[1] for r in src.execute(f'PRAGMA table_info("{name}")')]
            colsql = ', '.join(f'"{c}"' for c in cols)
            marks = ', '.join('?' for _ in cols)
            rows = src.execute(f'SELECT {colsql} FROM "{name}"').fetchall()
            if rows:
                dst.executemany(f'INSERT INTO "{name}" ({colsql}) VALUES ({marks})', rows)
        # 固定的空状态：clone 后首次启动即为零进度
        dst.execute('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)')
        dst.execute("INSERT INTO state(id, data) VALUES(1, '{}')")
        dst.commit()
        count = dst.execute('SELECT COUNT(*) FROM words').fetchone()[0]
        tables = [r[0] for r in dst.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    finally:
        dst.close()
        src.close()
    os.replace(tmp, dst_path)
    return count, tables


def main():
    dst = sys.argv[1] if len(sys.argv) > 1 else DST
    count, tables = export(SRC, dst)
    print(f'✓ 已导出纯净词库: {dst}')
    print(f'  词数: {count}；包含表: {", ".join(tables)}')
    print('  不含学习进度 / 收藏 / 设置 / 游戏记录 / 阅读文章，可安全入库。')


if __name__ == '__main__':
    main()
