/**
 * server.js
 * Express + Socket.IO server for the WhatsApp module.
 *
 * API Endpoints (all under /api/*):
 *
 *   GET    /api/status           — Connection status + QR code (JSON)
 *   POST   /api/send             — Send a text message        { to, body }
 *   POST   /api/send-media       — Send a media file          { to, filePath, caption }
 *   GET    /api/chats            — List recent chats           ?limit=20
 *   GET    /api/chats/:chatId/msgs — Message history           ?limit=50
 *   POST   /api/logout           — Disconnect WhatsApp
 *   POST   /api/webhook          — Register a webhook URL     { url }
 *   DELETE /api/webhook/:url     — Remove a webhook URL
 *   GET    /api/webhooks         — List registered webhooks
 *   GET    /api/docs             — API documentation page (HTML)
 *
 * Socket.IO events:
 *   status    — Real-time status updates (QR code, connection changes)
 *   message   — Incoming messages pushed live
 *   qr_update — QR code refreshes
 *
 * Authentication:
 *   Set API_KEY env var to require X-API-Key header on all /api/* calls.
 *   When API_KEY is not set, the API is open (only recommended for local/dev use).
 *
 * Webhooks:
 *   Register a URL via POST /api/webhook { url: "https://yourapp.com/hook" }.
 *   Incoming messages are forwarded as POST with:
 *     { event: "message", timestamp: ..., data: { id, from, body, ... } }
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const WhatsAppClient = require('./whatsapp-client');

// ── Config ──────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';   // empty = no auth required

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});
const whatsapp = new WhatsAppClient();

// ── Middleware ───────────────────────────────────────────────────

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS — allow any origin (any app can integrate)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// API Key authentication (for /api/* routes)
app.use('/api', (req, res, next) => {
  // Skip auth for docs page
  if (req.path === '/docs') return next();

  if (API_KEY) {
    const provided = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
    if (!provided || provided !== API_KEY) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized. Provide X-API-Key header or ?api_key= query param.',
      });
    }
  }
  next();
});

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// ── Socket.IO — Real-time status to all connected clients ─────

io.on('connection', (socket) => {
  console.log(`[socket] Browser connected: ${socket.id}`);
  socket.emit('status', whatsapp.getStatus());

  socket.on('disconnect', () => {
    console.log(`[socket] Browser disconnected: ${socket.id}`);
  });
});

// ── WhatsApp Client Callbacks ──────────────────────────────────

whatsapp.onStatusChange = (status) => {
  io.emit('status', status);
  if (status.qrCode) {
    io.emit('qr_update', status.qrCode);
  }
};

whatsapp.onMessage = (msg) => {
  io.emit('message', msg);
};

// ── Frontend ───────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── REST API Routes ────────────────────────────────────────────

/** GET /api/status — connection status + QR code */
app.get('/api/status', (req, res) => {
  res.json({ success: true, data: whatsapp.getStatus() });
});

/** POST /api/send — send a text message */
app.post('/api/send', async (req, res) => {
  try {
    const { to, body } = req.body;
    if (!to || !body) {
      return res.status(400).json({ success: false, error: 'Missing required fields: to, body' });
    }
    const result = await whatsapp.sendMessage(to, body);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/send-media — send a media message */
app.post('/api/send-media', async (req, res) => {
  try {
    const { to, filePath, caption } = req.body;
    if (!to || !filePath) {
      return res.status(400).json({ success: false, error: 'Missing required fields: to, filePath' });
    }
    const result = await whatsapp.sendMedia(to, filePath, { caption });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/chats — list recent chats */
app.get('/api/chats', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const chats = await whatsapp.getChats(limit);
    res.json({ success: true, data: chats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/chats/:chatId/msgs — message history */
app.get('/api/chats/:chatId/msgs', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const msgs = await whatsapp.getMessages(req.params.chatId, limit);
    res.json({ success: true, data: msgs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/logout — disconnect WhatsApp */
app.post('/api/logout', async (req, res) => {
  try {
    await whatsapp.logout();
    res.json({ success: true, data: { message: 'Disconnected successfully.' } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Webhook Management ─────────────────────────────────────────

/** POST /api/webhook — register a webhook URL */
app.post('/api/webhook', (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ success: false, error: 'Missing required field: url' });
    }
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return res.status(400).json({ success: false, error: 'Invalid URL. Must start with http:// or https://' });
    }
    const webhooks = whatsapp.addWebhook(url);
    res.json({ success: true, data: { webhooks, message: 'Webhook registered.' } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/webhooks — list all registered webhooks */
app.get('/api/webhooks', (req, res) => {
  res.json({ success: true, data: { webhooks: whatsapp.getWebhooks() } });
});

/** DELETE /api/webhook/:url — remove a webhook URL */
app.delete('/api/webhook/:url', (req, res) => {
  try {
    const url = decodeURIComponent(req.params.url);
    const webhooks = whatsapp.removeWebhook(url);
    res.json({ success: true, data: { webhooks, message: 'Webhook removed.' } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── API Docs ───────────────────────────────────────────────────

app.get('/api/docs', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const authNote = API_KEY
    ? `All API calls require the header \`X-API-Key: ${API_KEY.substring(0, 4)}...\``
    : 'No API key set. API is open (set API_KEY env var for production).';

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>WhatsApp Module — API Docs</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f0f2f5;
      color: #333;
      line-height: 1.6;
    }
    .header {
      background: linear-gradient(135deg, #25d366, #128c7e);
      color: #fff;
      padding: 30px 40px;
    }
    .header h1 { font-size: 28px; }
    .header p { opacity: 0.9; margin-top: 6px; font-size: 15px; }
    .container { max-width: 960px; margin: 0 auto; padding: 30px 20px; }
    .section { background: #fff; border-radius: 8px; padding: 24px; margin-bottom: 24px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
    .section h2 { font-size: 18px; margin-bottom: 16px; color: #128c7e; border-bottom: 2px solid #25d366; padding-bottom: 6px; }
    .endpoint { border-left: 3px solid #25d366; padding: 12px 16px; margin: 16px 0; background: #fafafa; border-radius: 0 6px 6px 0; }
    .endpoint .method { display: inline-block; font-weight: 700; font-size: 13px; padding: 2px 8px; border-radius: 3px; color: #fff; margin-right: 8px; }
    .method-get { background: #2196f3; }
    .method-post { background: #4caf50; }
    .method-delete { background: #f44336; }
    .endpoint .path { font-family: monospace; font-size: 14px; font-weight: 600; }
    .endpoint .desc { margin-top: 6px; font-size: 14px; color: #555; }
    .endpoint pre { background: #1e1e1e; color: #d4d4d4; padding: 12px; border-radius: 6px; margin-top: 8px; font-size: 13px; overflow-x: auto; }
    .endpoint code { font-size: 13px; }
    .badge { display: inline-block; background: #e8f5e9; color: #2e7d32; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; }
    .auth-note { background: #fff3e0; border-left: 4px solid #ff9800; padding: 12px 16px; border-radius: 4px; font-size: 14px; color: #555; }
    .curl-box { margin-top: 8px; }
    .curl-box .label { font-size: 11px; font-weight: 600; color: #888; text-transform: uppercase; margin-bottom: 4px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    td, th { padding: 8px 12px; text-align: left; border-bottom: 1px solid #e0e0e0; }
    th { font-weight: 600; color: #555; }
  </style>
</head>
<body>
  <div class="header">
    <h1>WhatsApp Module API</h1>
    <p>Send and receive WhatsApp messages from any app via simple HTTP calls</p>
  </div>

  <div class="container">

    <div class="auth-note">${authNote}</div>

    <!-- Authentication -->
    <div class="section">
      <h2>Authentication</h2>
      <p style="font-size:14px;color:#555;">
        Set the <code>API_KEY</code> environment variable when starting the server to require authentication.
        When set, include the key in every API request:
      </p>
      <pre style="background:#1e1e1e;color:#d4d4d4;padding:12px;border-radius:6px;margin-top:10px;font-size:13px;">Header: X-API-Key: your-api-key
# or
Query:  ?api_key=your-api-key</pre>
    </div>

    <!-- Endpoints -->
    <div class="section">
      <h2>Endpoints</h2>

      <div class="endpoint">
        <span class="method method-get">GET</span><span class="path">/api/status</span>
        <div class="desc">Get connection status and QR code (when not yet connected)</div>
        <div class="curl-box"><div class="label">Example</div>
        <pre>curl ${baseUrl}/api/status</pre></div>
        <div class="curl-box"><div class="label">Response</div>
        <pre>{
  "success": true,
  "data": {
    "status": "qr_ready",
    "isReady": false,
    "qrCode": "data:image/png;base64,...",
    "lastError": null
  }
}</pre></div>
      </div>

      <div class="endpoint">
        <span class="method method-post">POST</span><span class="path">/api/send</span>
        <div class="desc">Send a text message to a phone number or chat ID</div>
        <div class="curl-box"><div class="label">Example</div>
        <pre>curl -X POST ${baseUrl}/api/send \\
  -H "Content-Type: application/json" \\
  -d '{"to": "919876543210", "body": "Hello from the API!"}'</pre></div>
      </div>

      <div class="endpoint">
        <span class="method method-post">POST</span><span class="path">/api/send-media</span>
        <div class="desc">Send an image, document, or audio file</div>
        <div class="curl-box"><div class="label">Example</div>
        <pre>curl -X POST ${baseUrl}/api/send-media \\
  -H "Content-Type: application/json" \\
  -d '{"to": "919876543210", "filePath": "/path/to/image.jpg", "caption": "Check this out"}'</pre></div>
      </div>

      <div class="endpoint">
        <span class="method method-get">GET</span><span class="path">/api/chats?limit=20</span>
        <div class="desc">List recent WhatsApp conversations</div>
        <div class="curl-box"><div class="label">Response</div>
        <pre>{
  "success": true,
  "data": [
    { "id": "919876543210@c.us", "name": "John", "unreadCount": 2, "lastMessage": "Hey!", "timestamp": 1700000000, "isGroup": false }
  ]
}</pre></div>
      </div>

      <div class="endpoint">
        <span class="method method-get">GET</span><span class="path">/api/chats/{chatId}/msgs?limit=50</span>
        <div class="desc">Get message history for a specific chat</div>
        <div class="curl-box"><div class="label">Example</div>
        <pre>curl "${baseUrl}/api/chats/919876543210%40c.us/msgs?limit=10"</pre></div>
      </div>

      <div class="endpoint">
        <span class="method method-post">POST</span><span class="path">/api/logout</span>
        <div class="desc">Disconnect WhatsApp and clear session</div>
      </div>
    </div>

    <!-- Webhooks -->
    <div class="section">
      <h2>Webhooks (Incoming Messages)</h2>
      <p style="font-size:14px;color:#555;margin-bottom:12px;">
        Register a URL and the module will POST incoming messages to it in real-time.
      </p>

      <div class="endpoint">
        <span class="method method-post">POST</span><span class="path">/api/webhook</span>
        <div class="desc">Register a webhook URL</div>
        <div class="curl-box"><div class="label">Example</div>
        <pre>curl -X POST ${baseUrl}/api/webhook \\
  -H "Content-Type: application/json" \\
  -d '{"url": "https://yourapp.com/whatsapp-webhook"}'</pre></div>
      </div>

      <div class="endpoint">
        <span class="method method-get">GET</span><span class="path">/api/webhooks</span>
        <div class="desc">List all registered webhooks</div>
      </div>

      <div class="endpoint">
        <span class="method method-delete">DELETE</span><span class="path">/api/webhook/{url}</span>
        <div class="desc">Remove a registered webhook (URL must be URL-encoded)</div>
      </div>

      <h3 style="margin-top:20px;font-size:15px;color:#333;">Webhook Payload</h3>
      <pre style="background:#1e1e1e;color:#d4d4d4;padding:12px;border-radius:6px;margin-top:8px;font-size:13px;">POST /your-webhook-url
Content-Type: application/json

{
  "event": "message",
  "timestamp": 1700000000,
  "data": {
    "id": "ABEGkSm9s2s",
    "from": "919876543210@c.us",
    "fromName": "John",
    "body": "Hey, how are you?",
    "timestamp": 1700000000,
    "hasMedia": false,
    "isGroup": false
  }
}</pre>
      <p style="font-size:13px;color:#888;margin-top:8px;">
        The module will retry up to 3 times with a 10s timeout if your endpoint is unreachable.
      </p>
    </div>

    <!-- Socket.IO -->
    <div class="section">
      <h2>Real-time (Socket.IO)</h2>
      <p style="font-size:14px;color:#555;">
        For real-time apps, connect via Socket.IO at <code>${baseUrl}</code>.
        Events: <code>status</code>, <code>message</code>, <code>qr_update</code>.
      </p>
      <div class="curl-box"><div class="label">JavaScript example</div>
      <pre>import { io } from 'socket.io-client';

const socket = io('${baseUrl}');

socket.on('status', (status) => {
  console.log('Connection:', status.status);
  if (status.qrCode) {
    document.getElementById('qr').src = status.qrCode;
  }
});

socket.on('message', (msg) => {
  console.log('Incoming:', msg.fromName, msg.body);
});</pre></div>
    </div>

    <!-- Quick Integration -->
    <div class="section">
      <h2>Quick Integration Examples</h2>

      <h3 style="font-size:14px;margin-bottom:8px;color:#333;">cURL — Send a message</h3>
      <pre style="background:#1e1e1e;color:#d4d4d4;padding:12px;border-radius:6px;font-size:13px;">TO="919876543210"
curl -X POST ${baseUrl}/api/send \\
  -H "Content-Type: application/json" \\
  -d "{\\"to\\": \\"$TO\\", \\"body\\": \\"Hello from cURL!\\"}"

# With API key:
curl -X POST ${baseUrl}/api/send \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: your-key" \\
  -d '{"to": "919876543210", "body": "Hello"}'
</pre>

      <h3 style="font-size:14px;margin:16px 0 8px;color:#333;">Python</h3>
      <pre style="background:#1e1e1e;color:#d4d4d4;padding:12px;border-radius:6px;font-size:13px;">import requests

API = "${baseUrl}/api"

# Send a message
resp = requests.post(f"{API}/send", json={
    "to": "919876543210",
    "body": "Hello from Python!"
})
print(resp.json())

# Register webhook
resp = requests.post(f"{API}/webhook", json={
    "url": "https://myapp.com/hook"
})
print(resp.json())
</pre>

      <h3 style="font-size:14px;margin:16px 0 8px;color:#333;">JavaScript (fetch)</h3>
      <pre style="background:#1e1e1e;color:#d4d4d4;padding:12px;border-radius:6px;font-size:13px;">const API = '${baseUrl}/api';

// Send a message
await fetch(\`$\{API}/send\`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ to: '919876543210', body: 'Hello!' }),
});

// Check status
const status = await fetch(\`$\{API}/status\`).then(r => r.json());
console.log(status.data.qrCode);  // base64 image for QR display
</pre>
    </div>

  </div>
</body>
</html>`);
});

// ── Start ──────────────────────────────────────────────────────

async function start() {
  whatsapp.start().catch((err) => {
    console.error('WhatsApp client error:', err.message);
  });

  server.listen(PORT, () => {
    console.log('\n=======================================================');
    console.log(`  WhatsApp Module — Running on port ${PORT}`);
    console.log(`  Web UI:  http://localhost:${PORT}`);
    console.log(`  API:     http://localhost:${PORT}/api/docs`);
    if (API_KEY) {
      console.log(`  API Key: ${API_KEY}`);
    } else {
      console.log(`  API Key: NOT SET (open access — set API_KEY env for production)`);
    }
    console.log('=======================================================\n');
  });
}

start();
