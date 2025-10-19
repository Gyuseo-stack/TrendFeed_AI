const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

function loadEnvFile() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) {
      return;
    }

    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.trim().startsWith('#')) {
        continue;
      }
      const idx = line.indexOf('=');
      if (idx === -1) {
        continue;
      }
      const key = line.slice(0, idx).trim();
      if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) {
        continue;
      }
      const value = line.slice(idx + 1).trim();
      process.env[key] = value;
    }
  } catch (err) {
    console.warn('Failed to load .env file:', err.message);
  }
}

loadEnvFile();

const PORT = parseInt(process.env.PORT || '8787', 10);
const WORKFLOW_ID = process.env.WORKFLOW_ID || 'wf_68f08454146481909e81ff2f3bee5c37034ad87c959917ee';
const WORKFLOW_VERSION = process.env.WORKFLOW_VERSION ? Number(process.env.WORKFLOW_VERSION) : undefined;
const CACHE_TTL_SECONDS = Math.max(1, parseInt(process.env.CACHE_TTL_SECONDS || '600', 10));
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const TIMEOUT_MS = 60_000;
const MAX_BODY_SIZE = 32 * 1024; // 32 KiB

const publicDir = path.join(__dirname, 'public');
const cache = new Map();

const DOMAIN_PROMPTS = {
  general: '일반',
  healthcare: '헬스케어 / 바이오',
  finance: '금융 / 투자',
  retail: '리테일 / 이커머스',
  education: '교육 / 에듀테크',
  mobility: '모빌리티',
  manufacturing: '제조 / 로보틱스',
  security: '보안 / 프라이버시',
  media: '미디어 / 엔터테인먼트',
  public: '정부 / 정책'
};

function sanitizeInput(value = '', maxLength = 200) {
  return String(value)
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLength);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

function serveStatic(req, res) {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  let pathname = parsedUrl.pathname;
  if (pathname === '/') {
    pathname = '/index.html';
  }

  const filePath = path.normalize(path.join(publicDir, pathname));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      notFound(res);
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = getContentType(ext);
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
}

function getContentType(ext) {
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.svg':
      return 'image/svg+xml; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      body += chunk;
    });

    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function extractReportText(responseBody) {
  if (!responseBody) {
    return '';
  }

  if (typeof responseBody === 'string') {
    return responseBody;
  }

  if (typeof responseBody.output_text === 'string') {
    return responseBody.output_text;
  }

  if (Array.isArray(responseBody.output)) {
    for (const entry of responseBody.output) {
      if (entry && Array.isArray(entry.content)) {
        for (const item of entry.content) {
          if (item && typeof item.text === 'string' && item.type === 'output_text') {
            return item.text;
          }
          if (item && typeof item.text === 'string') {
            return item.text;
          }
        }
      }
    }
  }

  if (responseBody.result && typeof responseBody.result === 'string') {
    return responseBody.result;
  }

  if (responseBody.message && typeof responseBody.message === 'string') {
    return responseBody.message;
  }

  return JSON.stringify(responseBody);
}

async function fetchTrendReport({ inputText }) {
  if (!OPENAI_API_KEY) {
    const error = new Error('OpenAI API key is not configured');
    error.statusCode = 503;
    throw error;
  }

  const payload = {
    workflow_id: WORKFLOW_ID,
    input: { input_as_text: inputText },
    response_format: { type: 'text' }
  };

  if (Number.isFinite(WORKFLOW_VERSION)) {
    payload.version = WORKFLOW_VERSION;
  }

  const requestBody = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const req = https.request(
      'https://api.openai.com/v1/responses',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody)
        },
        signal: controller.signal
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          clearTimeout(timeout);
          if (res.statusCode && res.statusCode >= 400) {
            const err = new Error(`OpenAI API error (${res.statusCode})`);
            err.statusCode = res.statusCode;
            err.details = data;
            reject(err);
            return;
          }
          try {
            const parsed = data ? JSON.parse(data) : {};
            resolve(parsed);
          } catch (err) {
            reject(err);
          }
        });
      }
    );

    req.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    req.write(requestBody);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'POST' && parsedUrl.pathname === '/api/trends') {
      const started = Date.now();
      let bodyRaw;
      try {
        bodyRaw = await readRequestBody(req);
      } catch (err) {
        sendJson(res, 413, { ok: false, status: 413, message: 'Request body too large' });
        return;
      }

      let body;
      try {
        body = bodyRaw ? JSON.parse(bodyRaw) : {};
      } catch (err) {
        sendJson(res, 400, { ok: false, status: 400, message: 'Invalid JSON body' });
        return;
      }

      const rawDomain = sanitizeInput(body.domain, 200);
      const domain = rawDomain || '';
      let queryWindow = 10;
      if (body.query_window_days !== undefined) {
        const parsedWindow = parseInt(body.query_window_days, 10);
        if (Number.isNaN(parsedWindow)) {
          sendJson(res, 400, { ok: false, status: 400, message: 'query_window_days must be a number' });
          return;
        }
        queryWindow = parsedWindow;
      }
      if (queryWindow < 1 || queryWindow > 30) {
        sendJson(res, 400, { ok: false, status: 400, message: 'query_window_days must be between 1 and 30' });
        return;
      }

      const providedInput = typeof body.input_as_text === 'string' ? sanitizeInput(body.input_as_text, 500) : '';
      if (providedInput && (providedInput.length < 1 || providedInput.length > 500)) {
        sendJson(res, 400, { ok: false, status: 400, message: 'input_as_text must be between 1 and 500 characters' });
        return;
      }

      const resolvedDomain = domain || '일반';
      const promptDomainKey = typeof resolvedDomain === 'string' ? resolvedDomain.toLowerCase() : '';
      const promptDomain = DOMAIN_PROMPTS[promptDomainKey] || resolvedDomain;
      const finalInput = providedInput || `오늘 ${promptDomain} 도메인 기준으로 AI 트렌드 리포트 만들어줘 (최근 ${queryWindow}일 데이터 중심)`;

      const cacheKey = `${resolvedDomain}|${queryWindow}`;
      const now = Date.now();
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        sendJson(res, 200, {
          ok: true,
          domain: resolvedDomain,
          query_window_days: queryWindow,
          report_text: cached.report,
          meta: {
            workflow_id: WORKFLOW_ID,
            version: Number.isFinite(WORKFLOW_VERSION) ? WORKFLOW_VERSION : undefined,
            cached: true,
            ts: new Date().toISOString(),
            latency_ms: Date.now() - started
          }
        });
        return;
      }

      let responseData;
      try {
        responseData = await fetchTrendReport({ inputText: finalInput });
      } catch (err) {
        const status = err && err.statusCode ? err.statusCode : 502;
        const message = err && err.message ? err.message : 'Failed to fetch report';
        sendJson(res, status, { ok: false, status, message });
        return;
      }

      const reportText = extractReportText(responseData);
      cache.set(cacheKey, {
        report: reportText,
        expiresAt: now + CACHE_TTL_SECONDS * 1000
      });

      sendJson(res, 200, {
        ok: true,
        domain: resolvedDomain,
        query_window_days: queryWindow,
        report_text: reportText,
        meta: {
          workflow_id: WORKFLOW_ID,
          version: Number.isFinite(WORKFLOW_VERSION) ? WORKFLOW_VERSION : undefined,
          cached: false,
          ts: new Date().toISOString(),
          latency_ms: Date.now() - started
        }
      });
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res);
      return;
    }

    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
  } catch (err) {
    console.error('Unhandled error', err);
    sendJson(res, 500, { ok: false, status: 500, message: 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`TrendFeed prototype server listening on http://localhost:${PORT}`);
});
