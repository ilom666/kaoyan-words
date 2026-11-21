# DeepSeek API 接入说明

本项目「AI 阅读理解」功能用 DeepSeek 生成一篇由已学单词组成的英文短文、逐段中文翻译和阅读理解题。接入无需任何前端依赖，全部通过本机 `server.py` 代理完成。

> **重要**：API Key 属于个人凭据，本仓库不含也不接受任何真实 Key。请勿把 Key 提交到 Git、写进词库或贴到公开 issue 中。

## 一、申请 API Key

1. 打开 [DeepSeek 开放平台](https://platform.deepseek.com/) 注册并登录。
2. 在「API Keys」页面创建 Key，创建后立即复制保存（页面通常只完整显示一次）。
3. 确认账户有可用余额；新用户一般有少量赠送额度。生成一篇文章会消耗数千 token，按 DeepSeek 官方计价。

## 二、配置 Key（二选一）

### 方式 1：环境变量（推荐，不落盘）

启动服务前在当前终端设置：

```bash
# macOS / Linux
DEEPSEEK_API_KEY=你的Key python3 server.py

# Windows CMD
set DEEPSEEK_API_KEY=你的Key && python server.py

# Windows PowerShell
$env:DEEPSEEK_API_KEY="你的Key"; python server.py
```

双击 `start.*` 启动脚本的场景，可先在系统设置里添加同名环境变量，或改用方式 2。

### 方式 2：界面输入（仅存本机浏览器）

进入「小游戏 → AI 阅读理解 → DeepSeek API Key（可选）」，展开后填入 Key。勾选「记住到本机浏览器」会把它存在该浏览器的 `localStorage`（键名 `shuacidan_ai_key`），下次自动带出；不勾选则只在本次页面会话使用。

两种方式都可以：界面填写的 Key 优先于环境变量。Key 随请求体发到本机 `server.py`，**只用于向 DeepSeek 发起一次请求，不写入词库或任何本地文件，也不会随仓库上传**。

## 三、可选环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 空 | API Key；为空时必须在界面填写，否则生成会报「未配置」 |
| `DEEPSEEK_MODEL` | `deepseek-chat` | 使用的模型 |
| `DEEPSEEK_API_BASE` | `https://api.deepseek.com/chat/completions` | 接口地址；如需走自建代理可改这里 |
| `DEEPSEEK_TIMEOUT` | `90` | 单次请求超时秒数 |

## 四、调用链

```text
用户点「✨ 生成阅读」
  → app/reading.js 收集主题/长度/题数 + 已学单词(最多 300 个) + Key
  → POST /api/ai/reading  (本机 server.py)
  → server.py 组装 system/user prompt，附 Authorization: Bearer <Key>
  → https://api.deepseek.com/chat/completions  (response_format=json_object)
  → 解析返回 JSON，校验并规范化为 paragraphs / questions
  → 前端渲染文章、逐段翻译、题目，并自动保存到本机 localStorage
```

- 服务端接口：`POST /api/ai/reading`，请求体字段：`topic`、`length`（`short|medium|long`）、`questionCount`（1~5）、`words`（`[{word, meaning}]`）、`apiKey`（可选）。
- 提示词要求模型输出严格 JSON：`title`、`paragraphs`（每段 `en`/`zh` 一一对应）、`article`、`translation`、`used_words`、`questions`（含 `question`、`question_zh`、`options`、`answer`、`explain`）。
- 若模型只返回旧的 `article`/`translation` 而没有 `paragraphs`，服务端会按空行自动拆分回退，保证前端逐段对照仍可用。

## 五、费用与隐私

- 生成一篇约消耗数千 token，按 DeepSeek 官方计费，请自行关注余额。
- 发给模型的只有你选范围内的**已学单词列表**（单词 + 简短释义）和你填的主题，不含学习进度、收藏或其他个人信息。
- Key 不经浏览器直连 DeepSeek（避免 CORS，也避免前端暴露），统一由本机服务端代理转发。

## 六、常见问题

| 现象 | 原因与处理 |
|---|---|
| 提示「未配置 DeepSeek API Key」 | 环境变量没设、界面也没填；二选一配置后重试 |
| 提示「API Key 无效或已过期」 | Key 复制不完整或已被删除，去平台重新创建 |
| 提示「请求过于频繁或账户余额不足」 | 检查平台余额与限流策略，稍后再试 |
| 提示「无法连接 DeepSeek」 | 检查本机网络；如公司网络受限，可用 `DEEPSEEK_API_BASE` 指向可用代理 |
| 提示「请求 DeepSeek 超时」 | 调大 `DEEPSEEK_TIMEOUT`，或缩短文章长度后重试 |
| 提示「AI 返回内容格式异常」 | 模型偶发未按要求输出 JSON，点「再试一次」即可 |
| 想换模型 | 设置 `DEEPSEEK_MODEL`，例如 `deepseek-reasoner`（注意费用与耗时不同） |
