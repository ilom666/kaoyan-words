#!/usr/bin/env python3
"""刷单词 Web 应用服务器（零依赖，Python 标准库实现）
用法: python3 server.py [端口]   默认 8765；WORDS_HOST 可覆盖监听地址（默认 0.0.0.0，允许同一 WiFi 的设备访问）
接口:
  存储: SQLite data/app.db（本地运行库，词库 + 个人状态，不入库）；data/words.db 为随仓库发布的纯净词库（仅词库）
  GET  /api/words   读取词库
  GET  /api/state   读取应用状态(进度/收藏/设置/游戏记录/文章)
  POST /api/state   保存应用状态  body: 状态对象(与现有合并)
  POST /api/save    批量保存词条修改  body: {"changes":[{"id":1,"patch":{...}}]}
  POST /api/add     新增词条          body: {词条对象}
  POST /api/reorder 重排同一课内的词内序号 body: {"ids":[该课全部词条ID的新顺序]}
  POST /api/delete  删除词条          body: {"id": 3}
  POST /api/reset   从纯净词库 data/words.db 恢复初始词库（不影响个人进度）
  POST /api/ai/reading  用已学单词生成阅读理解(DeepSeek 代理)
                     body: {"topic","length","questionCount","words":[...],"apiKey"}
  GET  /api/export.xlsx 导出词库为 Excel(.xlsx)
  POST /api/import.xlsx 从 Excel(.xlsx) 导入/更新词库 (body: 原始 xlsx 字节)
"""
import json, os, re, shutil, sys, urllib.error, io, zipfile, sqlite3
import xml.etree.ElementTree as ET
import urllib.request, urllib.parse
import socket
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.join(ROOT, 'app')
DATA_DIR = os.path.join(ROOT, 'data')
SEED_DB = os.path.join(DATA_DIR, 'words.db')           # 仓库分发的纯净词库(仅词库, 无个人状态)
DB_FILE = os.path.join(DATA_DIR, 'app.db')             # 本地运行库: 词库 + 个人状态(不入库)
EXPORT_FILE = os.path.join(DATA_DIR, 'words.export.json')  # JSON 导出用(按需生成)
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
# DeepSeek 配置：密钥只从环境变量或单次请求体读取，不写入任何文件
DEEPSEEK_URL = os.environ.get('DEEPSEEK_API_BASE', 'https://api.deepseek.com/chat/completions')
DEEPSEEK_MODEL = os.environ.get('DEEPSEEK_MODEL', 'deepseek-chat')
DEEPSEEK_TIMEOUT = 90
MAX_AI_WORDS = 300


def db_conn():
    os.makedirs(DATA_DIR, exist_ok=True)
    con = sqlite3.connect(DB_FILE)
    con.row_factory = sqlite3.Row
    return con


# 词库结构化列: (字段名, SQL 类型) —— 数组字段用 JSON 文本列保存
WORD_COLUMNS = [
    ('id', 'INTEGER'), ('seq', 'INTEGER'), ('word', 'TEXT'), ('phonetic', 'TEXT'), ('phonetic_uk', 'TEXT'),
    ('meaning', 'TEXT'), ('hints', 'TEXT'), ('example_en', 'TEXT'), ('example_zh', 'TEXT'),
    ('derivatives', 'TEXT'), ('synonyms', 'TEXT'), ('phrases', 'TEXT'), ('compare', 'TEXT'),
    ('notes', 'TEXT'), ('no', 'TEXT'), ('group', 'TEXT'), ('related', 'TEXT'),
    ('page', 'INTEGER'), ('unit', 'INTEGER'), ('lesson', 'INTEGER'), ('part', 'BLOB'),
    ('part_title', 'TEXT'), ('suspect', 'TEXT'), ('phonetic_src', 'TEXT'), ('meaning_src', 'TEXT'),
]
WORD_FIELDS = [c[0] for c in WORD_COLUMNS]
JSON_FIELDS = {'hints', 'derivatives', 'phrases', 'notes', 'related'}
WORD_COLS_SQL = ', '.join(f'"{name}" {typ}' for name, typ in WORD_COLUMNS)
WORD_INSERT = f"INSERT OR REPLACE INTO words ({', '.join(chr(34)+f+chr(34) for f in WORD_FIELDS)}) VALUES ({', '.join('?' for _ in WORD_FIELDS)})"


def word_to_row(w):
    """词条 dict -> 结构化列值元组（尽量保真原始类型）"""
    vals = []
    for name in WORD_FIELDS:
        v = w.get(name)
        if name in JSON_FIELDS:
            # 数组列: 列表存 JSON 文本; None 保留 NULL
            v = json.dumps(v, ensure_ascii=False) if isinstance(v, list) else v
        elif name in ('id', 'seq'):
            v = int(v) if v not in (None, '') else 0
        elif name in ('page', 'unit', 'lesson') and v not in (None, ''):
            try:
                v = int(v)
            except (TypeError, ValueError):
                pass
        # 文本/数值/BLOB 列原样写入（含 None -> NULL）
        vals.append(v)
    return tuple(vals)


def row_to_word(r):
    """结构化行 -> 词条 dict，还原数组与原始类型语义"""
    w = {}
    for name in WORD_FIELDS:
        v = r[name]
        if name in JSON_FIELDS:
            if v is None:
                w[name] = None
            else:
                try:
                    w[name] = json.loads(v)
                except (ValueError, TypeError):
                    w[name] = []
        else:
            w[name] = v
    return w


GROUP_ORDER = ['A–C', 'D–F', 'G–J', 'K–O', 'P–S', 'T–Z', '其他']


def letter_group(c):
    c = (c or 'a')[0].lower()
    if not ('a' <= c <= 'z'):
        return '其他'
    if c <= 'c':
        return 'A–C'
    if c <= 'f':
        return 'D–F'
    if c <= 'j':
        return 'G–J'
    if c <= 'o':
        return 'K–O'
    if c <= 's':
        return 'P–S'
    return 'T–Z'


def lesson_key(w):
    part = str(w.get('part') or '1')
    if part == '3':
        return '3.' + letter_group(w.get('word'))
    return f'{part}.{w.get("lesson") or 0}'


def lesson_sort_key(w):
    part = str(w.get('part') or '1')
    try:
        pnum = int(float(part))
    except (TypeError, ValueError):
        pnum = 1
    seq = w.get('seq') or 0
    wid = w.get('id') or 0
    if pnum == 3:
        group = lesson_key(w).split('.', 1)[1]
        gi = GROUP_ORDER.index(group) if group in GROUP_ORDER else len(GROUP_ORDER)
        return (3, gi, seq, wid)
    try:
        lesson = float(w.get('lesson') or 0)
    except (TypeError, ValueError):
        lesson = 0
    return (pnum, lesson, seq, wid)


def rows_in_lesson(con, key):
    return [r for r in (dict(x) for x in con.execute('SELECT * FROM words'))
            if lesson_key(r) == key]


def renumber_seq(con, key=None):
    """按当前顺序重写课内序号，key=None 时重排全部课程。"""
    rows = rows_in_lesson(con, key) if key else [dict(r) for r in con.execute('SELECT * FROM words')]
    groups = {}
    for r in rows:
        groups.setdefault(lesson_key(r), []).append(r)
    for items in groups.values():
        items.sort(key=lambda x: (x.get('seq') or 0, x.get('id') or 0))
        for i, item in enumerate(items, 1):
            if item.get('seq') != i:
                con.execute('UPDATE words SET seq=? WHERE id=?', (i, item['id']))


def init_db():
    """建结构化表；首次运行时从纯净词库 words.db 导入。"""
    with db_conn() as con:
        con.execute('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)')
        con.execute(f'CREATE TABLE IF NOT EXISTS words ({WORD_COLS_SQL})')
        con.execute('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)')
        # 旧版兼容: words 表仍是 (id,data) 两列 -> 迁移到结构化
        cols = [r['name'] for r in con.execute('PRAGMA table_info(words)')]
        if cols == ['id', 'data']:
            old = [(r['id'], json.loads(r['data'])) for r in con.execute('SELECT id,data FROM words')]
            con.execute('DROP TABLE words')
            con.execute(f'CREATE TABLE words ({WORD_COLS_SQL})')
            con.executemany(WORD_INSERT, [word_to_row(dict(w, id=i)) for i, w in old])
        elif not con.execute('SELECT COUNT(*) FROM words').fetchone()[0] and os.path.exists(SEED_DB):
            with sqlite3.connect(SEED_DB) as seed:
                seed.row_factory = sqlite3.Row
                con.executemany(WORD_INSERT, [word_to_row(dict(r)) for r in seed.execute('SELECT * FROM words') if r['id']])
                src = seed.execute("SELECT value FROM meta WHERE key='source'").fetchone()
                con.execute('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', ('source', src['value'] if src else ''))
        if 'seq' not in [r['name'] for r in con.execute('PRAGMA table_info(words)')]:
            con.execute('ALTER TABLE words ADD COLUMN seq INTEGER NOT NULL DEFAULT 0')
        renumber_seq(con)
        con.execute('INSERT OR IGNORE INTO state(id,data) VALUES(1,?)', ('{}',))


def load_data():
    with db_conn() as con:
        words = [row_to_word(r) for r in con.execute('SELECT * FROM words')]
        src = con.execute("SELECT value FROM meta WHERE key='source'").fetchone()
    words.sort(key=lesson_sort_key)
    return {'source': src['value'] if src else '', 'words': words}


def save_data(data):
    with db_conn() as con:
        con.execute('DELETE FROM words')
        con.executemany(WORD_INSERT, [word_to_row(w) for w in data.get('words', []) if w.get('id')])
        con.execute('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', ('source', data.get('source', '')))
        renumber_seq(con)


def load_state():
    with db_conn() as con:
        row = con.execute('SELECT data FROM state WHERE id=1').fetchone()
    try:
        return json.loads(row['data']) if row else {}
    except (ValueError, TypeError):
        return {}


def save_state(obj):
    with db_conn() as con:
        con.execute('UPDATE state SET data=? WHERE id=1', (json.dumps(obj, ensure_ascii=False),))


def youdao_lookup(word):
    """查询有道词典: 美音/英音 IPA + 中文释义(供前端代理与批量脚本复用)"""
    word = (word or '').strip()
    if not word:
        return {'ok': False, 'error': 'empty word'}
    url = 'https://dict.youdao.com/jsonapi?q=' + urllib.parse.quote(word)
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    d = json.load(urllib.request.urlopen(req, timeout=8))
    us = uk = ''
    senses = []
    for src in ((d.get('ec') or {}), (d.get('simple') or {})):
        for x in (src.get('word') or []):
            if not isinstance(x, dict):
                continue
            us = us or (x.get('usphone') or '').strip()
            uk = uk or (x.get('ukphone') or '').strip()
            for t in (x.get('trs') or []):
                if 'tran' in t:
                    senses.append(f"{t.get('pos', '')} {t['tran']}".strip())
                elif 'tr' in t:
                    for tr in t['tr']:
                        i = tr.get('l', {}).get('i')
                        if isinstance(i, list):
                            senses += [z for z in i if isinstance(z, str)]
                        elif isinstance(i, str):
                            senses.append(i)
        if us or uk:
            break
    meaning = ' '.join(s.strip() for s in senses if s and s.strip())
    meaning = re.sub(r'【名】.*$', '', meaning).strip(' ；;，,')
    meaning = re.sub(r'\s{2,}', ' ', meaning)
    return {
        'ok': bool(us or uk or meaning),
        'word': word,
        'us': '/' + us + '/' if us else '',
        'uk': '/' + uk + '/' if uk else '',
        'meaning': meaning[:220],
    }


def _ai_error(e):
    """把 DeepSeek/网络异常转成对用户友好的中文提示"""
    if isinstance(e, urllib.error.HTTPError):
        detail = ''
        try:
            d = json.loads(e.read().decode('utf-8'))
            detail = str((d.get('error') or {}).get('message') or '').strip()[:180]
        except Exception:
            pass
        if e.code in (401, 403):
            return 'DeepSeek API Key 无效或已过期，请检查后重试。'
        if e.code == 429:
            return '请求过于频繁或账户余额不足，请稍后再试。' + ('（' + detail + '）' if detail else '')
        return f'DeepSeek 返回错误 {e.code}。' + ('（' + detail + '）' if detail else '')
    if isinstance(e, TimeoutError):
        return '请求 DeepSeek 超时，请稍后重试。'
    if isinstance(e, urllib.error.URLError):
        return '无法连接 DeepSeek，请检查本机网络。' + (str(getattr(e, 'reason', ''))[:120])
    return '生成失败：' + str(e)[:200]


def deepseek_reading(body):
    """用已学单词让 DeepSeek 生成一篇阅读理解，返回结构化 JSON。"""
    api_key = str(body.get('apiKey') or '').strip() or os.environ.get('DEEPSEEK_API_KEY', '').strip()
    if not api_key:
        return {'ok': False, 'error': '未配置 DeepSeek API Key。可在下方「DeepSeek API Key」处填写，或在启动服务前设置环境变量 DEEPSEEK_API_KEY。'}

    topic = str(body.get('topic') or '').strip()[:120] or '校园生活'
    word_count = {'short': 150, 'medium': 220, 'long': 320}.get(body.get('length'), 220)
    try:
        q_count = min(max(int(body.get('questionCount') or 3), 1), 5)
    except (TypeError, ValueError):
        q_count = 3
    raw_words = body.get('words')
    words = []
    if isinstance(raw_words, list):
        for w in raw_words[:MAX_AI_WORDS]:
            if isinstance(w, dict):
                spelling = str(w.get('word') or '').strip()
                if spelling:
                    words.append({'word': spelling[:60], 'meaning': str(w.get('meaning') or '').strip()[:40]})
    if len(words) < 5:
        return {'ok': False, 'error': '已学单词太少（至少需要 5 个），先去刷几个词再来生成吧。'}

    vocab = '\n'.join(f"- {w['word']}: {w['meaning'] or '（无释义）'}" for w in words)
    system = (
        '你是一位考研英语教师。请写一篇英文阅读理解，并据此出题。'
        '只输出一个 JSON 对象，不要 Markdown 代码块，不要任何额外说明。'
        'JSON 结构：{"title":"英文标题",'
        '"paragraphs":[{"en":"英文段落原文","zh":"该段中文翻译"}],'
        '"article":"英文正文（各段原文按顺序合并）","translation":"中文全文翻译（各段翻译按顺序合并）",'
        '"used_words":["文章中实际出现的已学单词"],"questions":[{"question":"英文题干",'
        '"question_zh":"中文题干","options":["A. ...","B. ...","C. ...","D. ..."],'
        '"answer":0,"explain":"中文解析"}]}。'
        f'要求：正文约 {word_count} 词，分成 3~6 个自然段，难度贴近考研英语；主题为「{topic}」；'
        'paragraphs 里每个 en/zh 必须一一对应，zh 是该段 en 的准确中文翻译，不要漏段；'
        'article 与 paragraphs 的 en 保持一致，translation 与 paragraphs 的 zh 保持一致；'
        '尽量自然地使用下面「已学单词表」中的单词（至少 12 个），可按需使用其时态/单复数等变形，不要生硬堆砌；'
        f'出 {q_count} 道四选一理解题，answer 为正确选项在 options 中的下标（0~3）；'
        'used_words 只列正文里真正用到的词表单词（小写原形）；translation、question_zh 与 explain 用中文。'
    )
    user = '已学单词表：\n' + vocab + '\n\n请按上述 JSON 结构输出。'
    payload = {
        'model': DEEPSEEK_MODEL,
        'messages': [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': user},
        ],
        'response_format': {'type': 'json_object'},
        'temperature': 0.85,
        'max_tokens': 3200,
    }
    req = urllib.request.Request(
        DEEPSEEK_URL,
        data=json.dumps(payload, ensure_ascii=False).encode('utf-8'),
        headers={
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + api_key,
            'User-Agent': 'shuacidan-local/1.0',
        },
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=DEEPSEEK_TIMEOUT) as resp:
            result = json.loads(resp.read().decode('utf-8'))
        choices = result.get('choices') or [{}]
        msg = choices[0].get('message') or {}
        content = str(msg.get('content') or '').strip()
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError, IndexError, TypeError) as e:
        return {'ok': False, 'error': _ai_error(e)}
    if content.startswith('```'):
        content = re.sub(r'^```(?:json)?\s*', '', content)
        content = re.sub(r'\s*```$', '', content)
    try:
        data = json.loads(content)
    except ValueError:
        return {'ok': False, 'error': 'AI 返回内容格式异常，请再试一次。'}

    questions = []
    for q in (data.get('questions') or [])[:q_count]:
        if not isinstance(q, dict):
            continue
        opts = [str(x).strip() for x in (q.get('options') or []) if str(x).strip()][:4]
        if len(opts) < 2:
            continue
        try:
            ans = int(q.get('answer', 0))
        except (TypeError, ValueError):
            ans = 0
        if ans < 0 or ans >= len(opts):
            ans = 0
        questions.append({
            'question': str(q.get('question') or '').strip()[:300],
            'question_zh': str(q.get('question_zh') or '').strip()[:300],
            'options': opts,
            'answer': ans,
            'explain': str(q.get('explain') or '').strip()[:600],
        })
    article = str(data.get('article') or '').strip()
    translation = str(data.get('translation') or '').strip()
    if not article or not questions:
        return {'ok': False, 'error': 'AI 返回内容不完整，请重试一次。'}

    paras = []
    raw_paras = data.get('paragraphs')
    if isinstance(raw_paras, list):
        for p in raw_paras:
            if not isinstance(p, dict):
                continue
            en = str(p.get('en') or '').strip()
            if en:
                paras.append({'en': en, 'zh': str(p.get('zh') or '').strip()})
    if not paras:
        ens = [b.strip() for b in re.split(r'\n\s*\n', article) if b.strip()]
        zhs = [b.strip() for b in re.split(r'\n\s*\n', translation) if b.strip()]
        paras = [{'en': en, 'zh': zhs[i] if i < len(zhs) else ''} for i, en in enumerate(ens)]

    used = []
    for w in (data.get('used_words') or []):
        s = str(w).strip().lower()[:60]
        if s and s not in used:
            used.append(s)
    return {
        'ok': True,
        'title': str(data.get('title') or '阅读理解').strip()[:120],
        'article': article,
        'translation': translation,
        'paragraphs': paras,
        'used_words': used[:40],
        'questions': questions,
        'vocab_size': len(words),
    }


# ===== Excel(.xlsx) 导入导出 —— 仅用标准库 zipfile + XML =====
# 模板表头: (显示名, 数据字段, 类型)
XLSX_COLUMNS = [
    ('ID', 'id', 'id'),
    ('单词', 'word', 'str'),
    ('美音音标', 'phonetic', 'str'),
    ('英音音标', 'phonetic_uk', 'str'),
    ('释义', 'meaning', 'str'),
    ('记忆提示', 'hints', 'hints'),
    ('英文例句', 'example_en', 'str'),
    ('中文例句', 'example_zh', 'str'),
    ('派生词', 'derivatives', 'list'),
    ('同义词', 'synonyms', 'str'),
    ('短语', 'phrases', 'list'),
    ('形近对比', 'compare', 'str'),
    ('备注', 'notes', 'list'),
    ('编号', 'no', 'str'),
    ('分组', 'group', 'str'),
    ('相关词', 'related', 'list'),
    ('页码', 'page', 'num'),
    ('Unit', 'unit', 'num'),
    ('Lesson', 'lesson', 'num'),
    ('Part', 'part', 'num'),
    ('Part标题', 'part_title', 'str'),
    ('疑似标记', 'suspect', 'str'),
]
XLSX_HEADERS = [c[0] for c in XLSX_COLUMNS]
NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
HINT_TYPES = ('谐音', '联想', '词根词缀', '形近对照', '记忆', '助记')


def _col_name(n):
    s = ''
    n += 1
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def _col_index(ref):
    m = re.match(r'([A-Z]+)', ref or '')
    if not m:
        return -1
    n = 0
    for ch in m.group(1):
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def _xml_escape(s):
    return (str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;'))


def _hints_to_cell(v):
    parts = []
    for h in (v if isinstance(v, list) else []):
        if isinstance(h, dict):
            t, x = str(h.get('type') or '').strip(), str(h.get('text') or '').strip()
            parts.append((t + '：' + x) if t else x)
        else:
            parts.append(str(h).strip())
    return '；'.join(p for p in parts if p)


def _list_to_cell(v):
    if not isinstance(v, list):
        return '' if v in (None, '') else str(v)
    return '；'.join(str(x).strip() for x in v if str(x).strip())


def build_xlsx(rows):
    """rows: 二维字符串数组，第一行为表头。返回 xlsx 字节。"""
    sheet_rows = []
    for ri, row in enumerate(rows, 1):
        cells = []
        for ci, val in enumerate(row):
            ref = _col_name(ci) + str(ri)
            cells.append(f'<c r="{ref}" t="inlineStr"><is><t xml:space="preserve">{_xml_escape(val)}</t></is></c>')
        sheet_rows.append(f'<row r="{ri}">{"".join(cells)}</row>')
    sheet = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
             f'<worksheet xmlns="{NS_MAIN}"><sheetData>{"".join(sheet_rows)}</sheetData></worksheet>')
    ct = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
          '<Default Extension="xml" ContentType="application/xml"/>'
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
          '</Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            '</Relationships>')
    wb = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          f'<workbook xmlns="{NS_MAIN}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
          '<sheets><sheet name="词库" sheetId="1" r:id="rId1"/></sheets></workbook>')
    wb_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
               '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
               '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
               '</Relationships>')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', ct)
        z.writestr('_rels/.rels', rels)
        z.writestr('xl/workbook.xml', wb)
        z.writestr('xl/_rels/workbook.xml.rels', wb_rels)
        z.writestr('xl/worksheets/sheet1.xml', sheet)
    return buf.getvalue()


def parse_xlsx(raw):
    """读取 xlsx 第一张工作表，返回二维字符串数组。"""
    z = zipfile.ZipFile(io.BytesIO(raw))
    names = z.namelist()
    shared = []
    if 'xl/sharedStrings.xml' in names:
        root = ET.fromstring(z.read('xl/sharedStrings.xml'))
        for si in root.findall(f'{{{NS_MAIN}}}si'):
            shared.append(''.join(t.text or '' for t in si.iter(f'{{{NS_MAIN}}}t')))
    sheet_name = next((n for n in names if re.match(r'xl/worksheets/sheet\d+\.xml$', n)), None)
    if not sheet_name:
        raise ValueError('Excel 中未找到工作表')
    root = ET.fromstring(z.read(sheet_name))
    rows = []
    for row in root.iter(f'{{{NS_MAIN}}}row'):
        cells, maxi = {}, -1
        for c in row.findall(f'{{{NS_MAIN}}}c'):
            idx = _col_index(c.get('r') or '')
            if idx < 0:
                continue
            t = c.get('t')
            val = ''
            if t == 'inlineStr':
                is_el = c.find(f'{{{NS_MAIN}}}is')
                if is_el is not None:
                    val = ''.join(x.text or '' for x in is_el.iter(f'{{{NS_MAIN}}}t'))
            else:
                v = c.find(f'{{{NS_MAIN}}}v')
                if v is not None:
                    val = v.text or ''
                    if t == 's':
                        try:
                            val = shared[int(val)]
                        except (ValueError, IndexError):
                            pass
            cells[idx] = val
            maxi = max(maxi, idx)
        rows.append([cells.get(i, '') for i in range(maxi + 1)])
    return rows


def xlsx_export_rows(data):
    rows = [XLSX_HEADERS[:]]
    for w in data.get('words', []):
        row = []
        for _name, key, kind in XLSX_COLUMNS:
            v = w.get(key, '')
            if kind == 'hints':
                v = _hints_to_cell(v)
            elif kind == 'list':
                v = _list_to_cell(v)
            row.append('' if v is None else str(v))
        rows.append(row)
    return rows


def xlsx_template_rows():
    example = ['（留空则新增）', 'example', '/ˈɪɡzɑːmpl/', '/ˈeɡzɑːmpl/', 'n. 例子；实例',
               '谐音：例句；联想：ex+ample', 'This is an example.', '这是一个例子。',
               'examples；exemplify', 'instance', 'for example；set an example', 'ex- 向外',
               '示例备注', '001', '示例分组', '相关词一；相关词二', '12', '1', '1', '1', '示例', '']
    return [XLSX_HEADERS[:], example]


def _cell_to_num(s):
    s = str(s or '').strip()
    if not s:
        return ''
    return int(s) if re.fullmatch(r'-?\d+', s) else s


def _cell_to_hints(s):
    out = []
    for seg in re.split(r'[；;\n]+', str(s or '')):
        seg = seg.strip()
        if not seg:
            continue
        t, x = '记忆', seg
        m = re.split(r'[:：]\s*', seg, 1)
        if len(m) == 2 and m[0].strip() in HINT_TYPES:
            t, x = m[0].strip(), m[1].strip()
        if x:
            out.append({'type': t, 'text': x})
    return out


def _cell_to_list(s):
    return [x.strip() for x in re.split(r'[；;\n]+', str(s or '')) if x.strip()]


def import_xlsx(raw):
    rows = parse_xlsx(raw)
    if not rows:
        return {'ok': False, 'error': 'Excel 内容为空'}
    header = [str(x).strip() for x in rows[0]]
    if '单词' not in header:
        return {'ok': False, 'error': '表头缺少「单词」列，请先用「导出 Excel」下载模板'}
    idx = {h: i for i, h in enumerate(header)}
    data = load_data()
    words = data.get('words', [])
    by_id = {w.get('id'): w for w in words}
    by_word = {str(w.get('word') or '').strip().lower(): w for w in words}
    updated = added = skipped = 0
    next_id = max((w.get('id') or 0) for w in words) if words else 0
    for r in rows[1:]:
        cells = {h: (r[idx[h]] if idx[h] < len(r) else '') for h in header}
        word = str(cells.get('单词') or '').strip()
        if not word:
            skipped += 1
            continue
        wid = str(cells.get('ID') or '').strip()
        target = None
        if wid:
            try:
                target = by_id.get(int(float(wid)))
            except (ValueError, TypeError):
                target = None
        if target is None:
            target = by_word.get(word.lower())
        patch = {'word': word}
        for name, key, kind in XLSX_COLUMNS:
            if key in ('id', 'word'):
                continue
            rawv = str(cells.get(name) or '').strip()
            if not rawv:
                continue  # 留空 => 保持原值
            if kind == 'hints':
                patch[key] = _cell_to_hints(rawv)
            elif kind == 'list':
                patch[key] = _cell_to_list(rawv)
            elif kind in ('num',):
                patch[key] = _cell_to_num(rawv)
            else:
                patch[key] = rawv
        if target is not None:
            for k, v in patch.items():
                target[k] = v
            updated += 1
        else:
            next_id += 1
            nw = {'id': next_id}
            for _name, key, _kind in XLSX_COLUMNS:
                if key != 'id':
                    nw.setdefault(key, '')
            nw.update(patch)
            words.append(nw)
            by_word[word.lower()] = nw
            by_id[next_id] = nw
            added += 1
    save_data(data)
    return {'ok': True, 'updated': updated, 'added': added, 'skipped': skipped, 'total': len(words)}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=APP_DIR, **kwargs)

    def log_message(self, fmt, *args):
        pass  # 静默日志

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def _binary(self, body, content_type, filename=None):
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        if filename:
            self.send_header('Content-Disposition', f'attachment; filename="{filename}"')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n:
            return json.loads(self.rfile.read(n).decode('utf-8'))
        return {}

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/api/words':
            try:
                self._json(load_data())
            except Exception as e:
                self._json({'error': str(e)}, 500)
            return
        if path == '/api/status':
            with db_conn() as con:
                n = con.execute('SELECT COUNT(*) FROM words').fetchone()[0]
            self._json({'ok': True, 'words': n > 0, 'storage': 'sqlite'})
            return
        if path == '/api/state':
            try:
                self._json(load_state())
            except Exception as e:
                self._json({'error': str(e)}, 500)
            return
        if path == '/api/export.xlsx':
            try:
                qs = parse_qs(urlparse(self.path).query)
                rows = xlsx_template_rows() if qs.get('template') else xlsx_export_rows(load_data())
                name = 'words_template.xlsx' if qs.get('template') else 'words_' + __import__('datetime').date.today().isoformat() + '.xlsx'
                self._binary(build_xlsx(rows),
                             'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name)
            except Exception as e:
                self._json({'error': str(e)}, 500)
            return
        if path == '/api/youdao':
            q = parse_qs(urlparse(self.path).query).get('q', [''])[0]
            try:
                self._json(youdao_lookup(q))
            except Exception as e:
                self._json({'ok': False, 'error': str(e)}, 500)
            return
        if path == '/':
            self.path = '/index.html'
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path == '/api/state':
            try:
                incoming = self._body()
                cur = load_state()
                cur.update(incoming)  # 局部合并, 未提交的键保持原值
                save_state(cur)
                self._json({'ok': True})
            except Exception as e:
                self._json({'ok': False, 'error': str(e)[:200]}, 500)
            return
        if path == '/api/import.xlsx':
            try:
                n = int(self.headers.get('Content-Length') or 0)
                raw = self.rfile.read(n) if n else b''
                self._json(import_xlsx(raw))
            except Exception as e:
                self._json({'ok': False, 'error': str(e)[:200]}, 500)
            return
        if path == '/api/ai/reading':
            try:
                self._json(deepseek_reading(self._body()))
            except Exception as e:
                self._json({'ok': False, 'error': str(e)[:200]}, 500)
            return
        try:
            if path == '/api/save':
                changes = self._body().get('changes', [])
                with db_conn() as con:
                    affected = set()
                    for ch in changes:
                        wid, patch = ch.get('id'), ch.get('patch', {})
                        patch = {k: v for k, v in patch.items()
                                 if k in WORD_FIELDS and k not in ('id', 'seq')}
                        if not patch or wid is None:
                            continue
                        old = con.execute('SELECT * FROM words WHERE id=?', (wid,)).fetchone()
                        if old:
                            old = dict(old)
                            old_key = lesson_key(old)
                            merged = dict(old)
                            merged.update(patch)
                            new_key = lesson_key(merged)
                            if new_key != old_key:
                                group = rows_in_lesson(con, new_key)
                                patch['seq'] = max((x.get('seq') or 0) for x in group) + 1 if group else 1
                                affected.update((old_key, new_key))
                        sets = ', '.join(f'"{k}"=?' for k in patch)
                        vals = []
                        for k in patch:
                            v = patch[k]
                            if k in JSON_FIELDS:
                                v = json.dumps(v if isinstance(v, list) else [], ensure_ascii=False)
                            vals.append(v)
                        con.execute(f'UPDATE words SET {sets} WHERE id=?', vals + [wid])
                    for key in affected:
                        renumber_seq(con, key)
                self._json({'ok': True, 'saved': len(changes)})
            elif path == '/api/add':
                w = self._body()
                after = w.get('after')
                with db_conn() as con:
                    new_id = con.execute('SELECT COALESCE(MAX(id),0)+1 FROM words').fetchone()[0]
                    new_row = dict(zip(WORD_FIELDS, word_to_row(dict(w, id=new_id, seq=0))))
                    key = lesson_key(new_row)
                    group = rows_in_lesson(con, key)
                    group.sort(key=lambda x: (x.get('seq') or 0, x.get('id') or 0))
                    insert_at = len(group)
                    if after:
                        try:
                            after_id = int(after)
                            pos = next((i for i, x in enumerate(group) if x['id'] == after_id), None)
                            if pos is not None:
                                insert_at = pos + 1
                        except (TypeError, ValueError):
                            pass
                    group.insert(insert_at, new_row)
                    cols = ', '.join(chr(34) + k + chr(34) + '=?' for k in WORD_FIELDS if k != 'id')
                    for i, row in enumerate(group, 1):
                        row['seq'] = i
                        vals = dict(zip(WORD_FIELDS, word_to_row(row)))
                        if row['id'] == new_id:
                            con.execute(WORD_INSERT, tuple(vals[k] for k in WORD_FIELDS))
                        else:
                            con.execute(f'UPDATE words SET {cols} WHERE id=?',
                                        [vals[k] for k in WORD_FIELDS if k != 'id'] + [row['id']])
                self._json({'ok': True, 'id': new_id, 'seq': insert_at + 1})
            elif path == '/api/reorder':
                ids = self._body().get('ids')
                if not isinstance(ids, list) or not ids or len(ids) != len(set(ids)):
                    self._json({'ok': False, 'error': '顺序参数无效'}, 400)
                else:
                    try:
                        ids = [int(x) for x in ids]
                    except (TypeError, ValueError):
                        self._json({'ok': False, 'error': '顺序参数无效'}, 400)
                        return
                    with db_conn() as con:
                        marks = ', '.join('?' for _ in ids)
                        rows = [dict(r) for r in con.execute(f'SELECT * FROM words WHERE id IN ({marks})', ids)]
                        if len(rows) != len(ids):
                            self._json({'ok': False, 'error': '词条不存在'}, 400)
                            return
                        keys = {lesson_key(r) for r in rows}
                        if len(keys) != 1:
                            self._json({'ok': False, 'error': '只能调整同一课内的顺序'}, 400)
                            return
                        key = next(iter(keys))
                        if len(rows) != len(rows_in_lesson(con, key)):
                            self._json({'ok': False, 'error': '顺序需包含该课全部词条'}, 400)
                            return
                        for i, wid in enumerate(ids, 1):
                            con.execute('UPDATE words SET seq=? WHERE id=?', (i, wid))
                    self._json({'ok': True})
            elif path == '/api/swap':
                body = self._body()
                a, b = body.get('idA'), body.get('idB')
                if a is None or b is None or a == b:
                    self._json({'ok': False, 'error': '词条不存在或相同'}, 400)
                else:
                    with db_conn() as con:
                        ra = con.execute('SELECT * FROM words WHERE id=?', (a,)).fetchone()
                        rb = con.execute('SELECT * FROM words WHERE id=?', (b,)).fetchone()
                        if not ra or not rb:
                            self._json({'ok': False, 'error': '词条不存在'}, 400)
                            return
                        ra, rb = dict(ra), dict(rb)
                        if lesson_key(ra) != lesson_key(rb):
                            self._json({'ok': False, 'error': '只能交换同一课内的词条'}, 400)
                        else:
                            con.execute('UPDATE words SET seq=? WHERE id=?', (rb['seq'], a))
                            con.execute('UPDATE words SET seq=? WHERE id=?', (ra['seq'], b))
                    self._json({'ok': True})
            elif path == '/api/delete':
                wid = self._body().get('id')
                with db_conn() as con:
                    old = con.execute('SELECT * FROM words WHERE id=?', (wid,)).fetchone()
                    old = dict(old) if old else None
                    key = lesson_key(old) if old else None
                    con.execute('DELETE FROM words WHERE id=?', (wid,))
                    if key:
                        renumber_seq(con, key)
                self._json({'ok': True})
            elif path == '/api/reset':
                # 从纯净词库恢复初始词库（不触碰个人进度/收藏/设置）
                if os.path.exists(SEED_DB):
                    with sqlite3.connect(SEED_DB) as seed:
                        seed.row_factory = sqlite3.Row
                        words = [row_to_word(r) for r in seed.execute('SELECT * FROM words')]
                        src = seed.execute("SELECT value FROM meta WHERE key='source'").fetchone()
                    save_data({'source': src['value'] if src else '', 'words': words})
                    self._json({'ok': True})
                else:
                    self._json({'ok': False, 'error': '无纯净词库文件 data/words.db'}, 400)
            else:
                self._json({'error': 'unknown endpoint'}, 404)
        except Exception as e:
            self._json({'error': str(e)}, 500)


class QuietThreadingHTTPServer(ThreadingHTTPServer):
    """客户端提前断开连接（刷新、关闭标签页、取消请求等）属正常现象，不再打印堆栈。"""
    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)):
            return
        super().handle_error(request, client_address)


def lan_ip():
    """取一个可用于局域网访问的本机 IPv4 地址（不依赖第三方库）。"""
    s = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('10.255.255.255', 1))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        if s:
            s.close()


if __name__ == '__main__':
    init_db()
    HOST = os.environ.get('WORDS_HOST', '0.0.0.0')
    srv = QuietThreadingHTTPServer((HOST, PORT), Handler)
    print(f'✓ 刷单词服务已启动: http://localhost:{PORT}')
    if HOST in ('0.0.0.0', ''):
        ip = lan_ip()
        if ip:
            print(f'  同一 WiFi 下可用: http://{ip}:{PORT}')
    print('  按 Ctrl+C 停止')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止')
