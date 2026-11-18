#!/usr/bin/env python3
"""刷单词 Web 应用服务器（零依赖，Python 标准库实现）
用法: python3 server.py [端口]   默认 8765
接口:
  GET  /api/words   读取词库 data/words.json
  POST /api/save    批量保存词条修改  body: {"changes":[{"id":1,"patch":{...}}]}
  POST /api/add     新增词条          body: {词条对象}
  POST /api/delete  删除词条          body: {"id": 3}
  POST /api/reset   恢复上次备份
"""
import json, os, re, shutil, sys
import urllib.request, urllib.parse
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.join(ROOT, 'app')
DATA_FILE = os.path.join(ROOT, 'data', 'words.json')
BACKUP_FILE = os.path.join(ROOT, 'data', 'words.backup.json')
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765


def load_data():
    with open(DATA_FILE, encoding='utf-8') as f:
        return json.load(f)


def save_data(data):
    os.makedirs(os.path.dirname(DATA_FILE), exist_ok=True)
    if os.path.exists(DATA_FILE):
        shutil.copy2(DATA_FILE, BACKUP_FILE)
    tmp = DATA_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, DATA_FILE)


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


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=APP_DIR, **kwargs)

    def log_message(self, fmt, *args):
        pass  # 静默日志

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

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
            self._json({'ok': True, 'words': os.path.exists(DATA_FILE)})
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
        try:
            data = load_data()
            words = data.get('words', [])
            if path == '/api/save':
                changes = self._body().get('changes', [])
                idx = {w['id']: w for w in words}
                for ch in changes:
                    wid, patch = ch.get('id'), ch.get('patch', {})
                    if wid in idx:
                        for k, v in patch.items():
                            if k == 'id':
                                continue
                            idx[wid][k] = v
                save_data(data)
                self._json({'ok': True, 'saved': len(changes)})
            elif path == '/api/add':
                w = self._body()
                after = w.get('after')  # 插入到该 id 之后(保持排序)
                w = {k: w.get(k, '') for k in
                     ('word', 'phonetic', 'phonetic_uk', 'meaning', 'hints', 'example_en', 'example_zh',
                      'derivatives', 'synonyms', 'phrases', 'compare', 'notes', 'unit', 'lesson', 'part')}
                w['hints'] = w.get('hints') or []
                w['derivatives'] = w.get('derivatives') or []
                w['phrases'] = w.get('phrases') or []
                w['notes'] = w.get('notes') or []
                new_id = max((x['id'] for x in words), default=0) + 1
                w['id'] = new_id
                if after:
                    pos = next((i for i, x in enumerate(words) if x['id'] == after), None)
                    if pos is not None:
                        words.insert(pos + 1, w)
                    else:
                        words.append(w)
                else:
                    words.append(w)
                save_data(data)
                self._json({'ok': True, 'id': new_id})
            elif path == '/api/swap':
                body = self._body()
                a, b = body.get('idA'), body.get('idB')
                ia = next((i for i, x in enumerate(words) if x['id'] == a), None)
                ib = next((i for i, x in enumerate(words) if x['id'] == b), None)
                if ia is None or ib is None or ia == ib:
                    self._json({'ok': False, 'error': '词条不存在或相同'}, 400)
                else:
                    words[ia], words[ib] = words[ib], words[ia]
                    save_data(data)
                    self._json({'ok': True})
            elif path == '/api/delete':
                wid = self._body().get('id')
                data['words'] = [w for w in words if w['id'] != wid]
                save_data(data)
                self._json({'ok': True})
            elif path == '/api/reset':
                if os.path.exists(BACKUP_FILE):
                    shutil.copy2(BACKUP_FILE, DATA_FILE)
                    self._json({'ok': True})
                else:
                    self._json({'ok': False, 'error': '无备份'}, 400)
            else:
                self._json({'error': 'unknown endpoint'}, 404)
        except Exception as e:
            self._json({'error': str(e)}, 500)


if __name__ == '__main__':
    if not os.path.exists(DATA_FILE):
        os.makedirs(os.path.dirname(DATA_FILE), exist_ok=True)
        with open(DATA_FILE, 'w', encoding='utf-8') as f:
            json.dump({'source': '', 'words': []}, f)
    srv = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print(f'✓ 刷单词服务已启动: http://localhost:{PORT}')
    print('  按 Ctrl+C 停止')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止')
