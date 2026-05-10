/**
 * whatsapp-client.js
 * WhatsApp Web client wrapper — handles QR login, messaging, and events.
 *
 * Uses whatsapp-web.js with headless Chrome. The library automates WhatsApp Web
 * in a browser, shows a QR code for authentication, then exposes send/receive APIs.
 */

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');

class WhatsAppClient {
  constructor() {
    this.client = null;
    this.isReady = false;
    this.qrCodeData = null;
    this.qrCodeString = null;
    this.connectionStatus = 'disconnected';
    this.lastError = null;
    this._restartAttempts = 0;
    this._maxRestartAttempts = 3;

    // Callbacks (set by server.js)
    this.onMessage = null;
    this.onStatusChange = null;

    // Webhooks — external URLs to forward incoming messages to
    this.webhooks = [];

    this.sessionDir = path.resolve(__dirname, 'whatsapp-sessions');
  }

  /**
   * Initialise and start the WhatsApp client.
   */
  async start() {
    this.connectionStatus = 'connecting';
    this._emitStatus();

    this.client = new Client({
      authStrategy: new LocalAuth({
        dataPath: this.sessionDir,
      }),

      // Disable web cache — prevents navigation-related crashes
      webCache: false,

      // Don't download chromium (use system Chrome)
      chromiumDownload: false,

      puppeteer: {
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: "shell",

        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process',
          '--disable-site-isolation-trials',
          '--remote-allow-origins=*',
          '--window-size=1280,800',
        ],

        defaultViewport: {
          width: 1280,
          height: 800,
        },
      },
    });

    // ── Events ─────────────────────────────────────────────────

    // Loading screen — useful for debugging
    this.client.on('loading_screen', (percent, message) => {
      if (percent != null) {
        console.log(`Loading: ${percent}% — ${message || ''}`);
      }
    });

    // QR Code
    this.client.on('qr', async (qrString) => {
      this.qrCodeString = qrString;
      this.connectionStatus = 'qr_ready';
      try {
        this.qrCodeData = await qrcode.toDataURL(qrString, {
          width: 300,
          margin: 2,
          color: { dark: '#000000', light: '#ffffff' },
        });
      } catch (err) {
        console.error('QR generation error:', err.message);
      }
      this._emitStatus();
    });

    // Authenticated (QR scanned, session established)
    this.client.on('authenticated', () => {
      console.log('WhatsApp authenticated — session saved.');
    });

    // Auth failure
    this.client.on('auth_failure', (msg) => {
      this.connectionStatus = 'error';
      this.lastError = typeof msg === 'string' ? msg : JSON.stringify(msg);
      this._emitStatus();
      console.error('Auth failure:', this.lastError);
    });

    // Ready
    this.client.on('ready', () => {
      this.isReady = true;
      this.connectionStatus = 'connected';
      this.qrCodeData = null;
      this.qrCodeString = null;
      this._restartAttempts = 0;
      this._emitStatus();
      console.log('=== WhatsApp client is ready! ===');
    });

    // Disconnected
    this.client.on('disconnected', (reason) => {
      this.isReady = false;
      this.connectionStatus = 'disconnected';
      this.qrCodeData = null;
      this.qrCodeString = null;
      this._emitStatus();
      console.log('WhatsApp disconnected:', reason);

      // Don't auto-restart — just show QR again if user wants to reconnect
      // Scans and crashes would cause a restart loop
    });

    // ── Incoming messages ──────────────────────────────────────
    this.client.on('message', async (msg) => {
      if (msg.fromMe) return;
      if (msg.isStatus) return;

      const messageData = {
        id: msg.id?.id || msg.id?._serialized,
        from: msg.from,
        fromName: (await msg.getContact())?.name || msg.from,
        body: msg.body,
        timestamp: msg.timestamp,
        hasMedia: msg.hasMedia,
        isGroup: msg.from ? msg.from.endsWith('@g.us') : false,
      };

      if (messageData.isGroup) {
        try {
          const chat = await msg.getChat();
          messageData.groupName = chat.name;
        } catch (_) {}
      }

      if (msg.hasMedia) {
        try {
          const media = await msg.downloadMedia();
          messageData.mediaMimeType = media?.mimetype;
          messageData.mediaData = media?.data;
          messageData.mediaFilename = media?.filename;
        } catch (_) {}
      }

      console.log(`[MSG] ${messageData.fromName} (${messageData.from}): ${messageData.body}`);

      if (this.onMessage) {
        this.onMessage(messageData);
      }

      // Forward to all registered webhooks (fire-and-forget)
      this._forwardToWebhooks(messageData);
    });

    // ── Start ──────────────────────────────────────────────────
    try {
      await this.client.initialize();
    } catch (err) {
      console.error('Failed to initialize WhatsApp client:', err.message);
      this.connectionStatus = 'error';
      this.lastError = err.message;
      this._emitStatus();

      // If the error is the navigation/crash issue, retry
      if (
        err.message.includes('ExecutionContext was destroyed') ||
        err.message.includes('navigation') ||
        err.message.includes('Protocol error')
      ) {
        console.log('Navigation error detected — retrying after 3s...');
        await this._delay(3000);
        await this.destroy();
        return this.start();
      }
    }
  }

  /**
   * Send a text message.
   */
  async sendMessage(to, body) {
    if (!this.isReady) {
      throw new Error('WhatsApp is not connected. Scan the QR code first.');
    }
    const formatted = this._formatNumber(to);
    const response = await this.client.sendMessage(formatted, body);
    return {
      id: response.id?.id || response.id?._serialized,
      from: response.from,
      to: formatted,
      body,
      timestamp: response.timestamp,
      status: 'sent',
    };
  }

  /**
   * Send a media message (image, document, audio, etc.).
   */
  async sendMedia(to, filePath, options = {}) {
    if (!this.isReady) {
      throw new Error('WhatsApp is not connected. Scan the QR code first.');
    }
    const formatted = this._formatNumber(to);
    const media = MessageMedia.fromFilePath(filePath);
    const response = await this.client.sendMessage(formatted, media, {
      caption: options.caption || '',
    });
    return {
      id: response.id?.id || response.id?._serialized,
      to: formatted,
      caption: options.caption,
      timestamp: response.timestamp,
      status: 'sent',
    };
  }

  /**
   * Get recent chats.
   */
  async getChats(limit = 20) {
    if (!this.isReady) throw new Error('WhatsApp is not connected.');
    const chats = await this.client.getChats();
    return chats.slice(0, limit).map((chat) => ({
      id: chat.id._serialized,
      name: chat.name,
      unreadCount: chat.unreadCount,
      lastMessage: chat.lastMessage?.body || '',
      timestamp: chat.timestamp,
      isGroup: chat.isGroup,
    }));
  }

  /**
   * Get message history for a chat.
   */
  async getMessages(chatId, limit = 50) {
    if (!this.isReady) throw new Error('WhatsApp is not connected.');
    const chat = await this.client.getChatById(chatId);
    const msgs = await chat.fetchMessages({ limit });
    return msgs.map((m) => ({
      id: m.id?.id || m.id?._serialized,
      from: m.from,
      fromMe: m.fromMe,
      body: m.body,
      timestamp: m.timestamp,
      hasMedia: m.hasMedia,
    }));
  }

  /**
   * Logout and destroy the session.
   */
  async logout() {
    if (this.client) {
      try { await this.client.logout(); } catch (_) {}
      try { await this.client.destroy(); } catch (_) {}
    }
    this.isReady = false;
    this.connectionStatus = 'disconnected';
    this.qrCodeData = null;
    this._emitStatus();
  }

  /**
   * Destroy without logout (for restart).
   */
  async destroy() {
    if (this.client) {
      try { await this.client.destroy(); } catch (_) {}
    }
    this.client = null;
    this.isReady = false;
  }

  /**
   * Get current status.
   */
  getStatus() {
    return {
      status: this.connectionStatus,
      isReady: this.isReady,
      qrCode: this.qrCodeData,
      lastError: this.lastError,
    };
  }

  // ── Webhook Management ───────────────────────────────────────

  /**
   * Register a webhook URL that receives incoming messages via POST.
   * @param {string} url - HTTPS URL to receive webhook payloads
   */
  addWebhook(url) {
    if (!this.webhooks.includes(url)) {
      this.webhooks.push(url);
      console.log('Webhook registered:', url);
    }
    return this.webhooks;
  }

  /**
   * Remove a webhook URL.
   * @param {string} url - URL to remove
   */
  removeWebhook(url) {
    this.webhooks = this.webhooks.filter((w) => w !== url);
    console.log('Webhook removed:', url);
    return this.webhooks;
  }

  /**
   * Get all registered webhook URLs.
   */
  getWebhooks() {
    return [...this.webhooks];
  }

  // ── Private ──────────────────────────────────────────────────

  _emitStatus() {
    if (this.onStatusChange) {
      this.onStatusChange(this.getStatus());
    }
  }

  _delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  _scheduleRestart() {
    if (this._restartAttempts >= this._maxRestartAttempts) {
      console.log('Max restart attempts reached. Giving up.');
      return;
    }
    this._restartAttempts++;
    const delay = Math.min(5000 * this._restartAttempts, 30000);
    console.log(`Scheduling restart #${this._restartAttempts} in ${delay / 1000}s...`);
    setTimeout(async () => {
      console.log(`Restart #${this._restartAttempts}...`);
      await this.destroy();
      await this.start();
    }, delay);
  }

  _formatNumber(number) {
    if (number.includes('@')) return number;
    let cleaned = number.replace(/[^0-9]/g, '');
    if (cleaned.startsWith('0')) cleaned = cleaned.substring(1);
    return cleaned + '@c.us';
  }

  /**
   * Forward a message payload to all registered webhooks.
   * Fire-and-forget with retry; webhooks that fail are logged but not removed.
   */
  async _forwardToWebhooks(msg) {
    if (this.webhooks.length === 0) return;

    const payload = JSON.stringify({
      event: 'message',
      timestamp: Math.floor(Date.now() / 1000),
      data: msg,
    });

    for (const url of this.webhooks) {
      this._postWithRetry(url, payload, 3).catch((err) => {
        console.error(`Webhook failed [${url}]:`, err.message);
      });
    }
  }

  async _postWithRetry(url, payload, attempts) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'WhatsApp-Module/1.0',
          },
          body: payload,
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (res.ok) return;
        console.warn(`Webhook ${url} returned ${res.status}, attempt ${i + 1}/${attempts}`);
      } catch (err) {
        clearTimeout(timeout);
        if (i < attempts - 1) {
          await this._delay(2000 * (i + 1));
        } else {
          throw err;
        }
      }
    }
  }
}

module.exports = WhatsAppClient;
