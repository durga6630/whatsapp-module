# WhatsApp Module

A self-hosted WhatsApp integration module. Connect your WhatsApp via QR code scan, then send and receive messages from any app via REST API or Socket.IO.

## Quick Start

```bash
git clone https://github.com/durga-dev/whatsapp-module.git
cd whatsapp-module
PUPPETEER_SKIP_DOWNLOAD=true npm install
node server.js
```

Open `http://localhost:3000` in your browser, scan the QR code with your phone (WhatsApp > Linked Devices > Link a Device), and start messaging.

## Features

- **QR Code Login** — same flow as WhatsApp Web
- **Send Messages** — to any number or group via REST API
- **Receive Messages** — real-time via Socket.IO or Webhooks
- **Webhook Support** — register a URL and incoming messages are POSTed to your app
- **Full Web UI** — QR scanner + chat interface included
- **API Authentication** — optional API key via `API_KEY` env var

## REST API

All endpoints return `{ success: true, data: ... }` JSON.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/status` | Connection status + QR code |
| POST | `/api/send` | Send message `{ to, body }` |
| POST | `/api/send-media` | Send media `{ to, filePath, caption }` |
| GET | `/api/chats` | List chats `?limit=20` |
| GET | `/api/chats/:id/msgs` | Message history `?limit=50` |
| POST | `/api/logout` | Disconnect |
| POST | `/api/webhook` | Register webhook URL `{ url }` |
| GET | `/api/webhooks` | List webhooks |
| DELETE | `/api/webhook/:url` | Remove webhook |

Full interactive docs: `http://localhost:3000/api/docs`

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `API_KEY` | (none) | Require this key via `X-API-Key` header on API calls |

## Prerequisites

- Node.js 18+
- Google Chrome (for WhatsApp Web automation)
- macOS / Linux

## Tech Stack

- **whatsapp-web.js** — WhatsApp Web automation via headless Chrome
- **Express** — REST API server
- **Socket.IO** — Real-time web socket communication
- **Puppeteer** — Headless Chrome control

## License

MIT
