const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const rateLimitWindow = 60_000;
const rateLimitMax = 5;
const requestLog = new Map();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

function normalizeBaseUrl(url) {
  if (!url) return '';
  const withProtocol = /^https?:\/\//.test(url) ? url : `https://${url}`;
  const clean = withProtocol.replace(/\s+/g, '').replace(/\/$/, '');
  return clean.endsWith('/v1') ? clean : `${clean}/v1`;
}

function checkRateLimit(key) {
  if (!key) return { allowed: true };
  const now = Date.now();
  const history = requestLog.get(key) || [];
  const fresh = history.filter(ts => now - ts < rateLimitWindow);
  if (fresh.length >= rateLimitMax) {
    const waitMs = rateLimitWindow - (now - fresh[0]);
    requestLog.set(key, fresh);
    return { allowed: false, retryAfter: waitMs };
  }
  fresh.push(now);
  requestLog.set(key, fresh);
  return { allowed: true };
}

app.post('/api/models', async (req, res) => {
  const apiKey = req.get('x-api-key') || req.body.apiKey;
  const baseUrl = normalizeBaseUrl(req.body.baseUrl);
  if (!apiKey || !baseUrl) return res.status(400).json({ message: '缺少 baseUrl 或 API Key' });

  const rate = checkRateLimit(apiKey);
  if (!rate.allowed) {
    return res.status(429).json({ message: '请求过于频繁', retryAfter: rate.retryAfter });
  }

  try {
    const upstream = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!upstream.ok) {
      const text = await upstream.text();
      return res.status(upstream.status).json({ message: text || `上游错误 ${upstream.status}` });
    }
    const data = await upstream.json();
    res.json(data);
  } catch (error) {
    console.error('models error', error);
    res.status(502).json({ message: '获取模型失败，请检查站点或 Key。' });
  }
});

app.post('/api/rewrite', async (req, res) => {
  const apiKey = req.get('x-api-key') || req.body.apiKey;
  const baseUrl = normalizeBaseUrl(req.body.baseUrl);
  const { model, prompt, content } = req.body;

  if (!apiKey || !baseUrl || !model || !content) {
    return res.status(400).json({ message: '缺少必要参数' });
  }

  const rate = checkRateLimit(apiKey);
  if (!rate.allowed) {
    return res.status(429).json({ message: '请求过于频繁', retryAfter: rate.retryAfter });
  }

  const messages = [
    { role: 'system', content: prompt },
    { role: 'user', content: `请改写以下内容，保持原有标题不变：\n${content}` }
  ];

  try {
    const upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model, messages, temperature: 0.7 })
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      return res.status(upstream.status).json({ message: text || `上游错误 ${upstream.status}` });
    }
    const data = await upstream.json();
    const choice = data.choices?.[0]?.message?.content;
    res.json({ rewritten: choice || content });
  } catch (error) {
    console.error('rewrite error', error);
    res.status(502).json({ message: '改写失败，请稍后重试。' });
  }
});

const rootDir = path.resolve(__dirname, '..');
app.use(express.static(rootDir));
app.get('*', (req, res) => {
  res.sendFile(path.join(rootDir, 'index.html'));
});

const port = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(port, () => {
    console.log(`AI 重写代理已启动，http://localhost:${port}`);
  });
}

module.exports = app;
