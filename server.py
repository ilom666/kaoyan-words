#!/usr/bin/env python3
"""刷单词 Web 应用服务器（零依赖，Python 标准库实现）
用法: python3 server.py [端口]   默认 8765
接口:
  GET  /api/words   读取词库 data/words.json
  POST /api/save    批量保存词条修改  body: {"changes":[{"id":1,"patch":{...}}]}
  POST /api/add     新增词条          body: {词条对象}
  POST /api/delete  删除词条          body: {"id": 3}
  POST /api/reset   恢复上次备份
  POST /api/ai/reading  用已学单词生成阅读理解(DeepSeek 代理)
                     body: {"topic","length","questionCount","words":[...],"apiKey"}
"""
import json, os, re, shutil, sys, urllib.error
import urllib.request, urllib.parse
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.join(ROOT, 'app')
DATA_FILE = os.path.join(ROOT, 'data', 'words.json')
BACKUP_FILE = os.path.join(ROOT, 'data', 'words.backup.json')
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
# DeepSeek 配置：密钥只从环境变量或单次请求体读取，不写入任何文件
DEEPSEEK_URL = os.environ.get('DEEPSEEK_API_BASE', 'https://api.deepseek.com/chat/completions')
DEEPSEEK_MODEL = os.environ.get('DEEPSEEK_MODEL', 'deepseek-chat')
DEEPSEEK_TIMEOUT = 90
MAX_AI_WORDS = 300


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
        if path == '/api/ai/reading':
            try:
                self._json(deepseek_reading(self._body()))
            except Exception as e:
                self._json({'ok': False, 'error': str(e)[:200]}, 500)
            return
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
