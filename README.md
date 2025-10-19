# TrendFeed AI – Domain AI Trend Report Prototype

This prototype pairs a minimal Node.js backend with a static single-page frontend to fetch the latest "오늘의 AI 트렌드 리포트" for a chosen domain using the OpenAI Responses API and an existing Agent Builder workflow.

## Features
- **Domain targeting**: choose from predefined verticals or provide a custom domain string.
- **Query window control**: set a 1–30 day lookback window that becomes part of the workflow prompt.
- **Auto refresh & copy**: refresh manually or every five minutes, and copy the rendered report in one click.
- **Server-side caching**: in-memory caching avoids duplicate API calls during the configured TTL.
- **Secure backend**: no third-party packages, sanitized inputs, 60s request timeout, and never exposes the API key to the browser.

## Prerequisites
- Node.js 18 or newer.
- An OpenAI API key with access to the Agent Builder workflow `wf_68f08454146481909e81ff2f3bee5c37034ad87c959917ee`.

## Setup
1. Copy the environment template and edit it with your credentials:
   ```bash
   cp .env.example .env
   # Edit .env and fill in OPENAI_API_KEY, optionally WORKFLOW_VERSION, etc.
   ```
2. Install dependencies – there are none beyond Node.js built-ins.

## Running the server
```bash
node server.js
```
The server listens on `PORT` (default `8787`) and serves the static UI at `http://localhost:8787/`.

## API usage
The backend exposes a single endpoint:

```
POST /api/trends
Content-Type: application/json
```

Request body schema:
```json
{
  "domain": "mobility",
  "query_window_days": 10,
  "input_as_text": "오늘 모빌리티 도메인 기준으로 AI 트렌드 리포트 만들어줘"
}
```
All fields are optional. When `input_as_text` is omitted, the server constructs
`"오늘 {domain|일반} 도메인 기준으로 AI 트렌드 리포트 만들어줘 (최근 {days}일 데이터 중심)"` before calling the workflow.

Example request via `curl`:
```bash
curl -X POST http://localhost:8787/api/trends \
  -H "Content-Type: application/json" \
  -d '{"domain":"mobility","query_window_days":10}'
```

### Successful response
```json
{
  "ok": true,
  "domain": "mobility",
  "query_window_days": 10,
  "report_text": "# Today’s AI Trend Report...",
  "meta": {
    "workflow_id": "wf_68f08454146481909e81ff2f3bee5c37034ad87c959917ee",
    "version": 1,
    "cached": false,
    "ts": "2024-05-12T12:34:56.789Z",
    "latency_ms": 4123
  }
}
```

On errors the server returns an object like:
```json
{
  "ok": false,
  "status": 502,
  "message": "Failed to fetch report"
}
```

## Frontend workflow
1. Select a domain or provide a custom label.
2. (Optional) Adjust the query window and/or provide a custom instruction.
3. Click **리포트 생성** to fetch the report.
4. Enable auto-refresh to re-run the same request every five minutes.
5. Use **복사하기** to copy the current report to your clipboard.

## Notes
- The cache TTL defaults to 600 seconds and can be changed via `CACHE_TTL_SECONDS`.
- Input validation strips HTML tags and limits sizes (domain ≤ 200 chars, custom prompt ≤ 500 chars).
- The OpenAI API request is aborted after 60 seconds to avoid hanging sockets.
