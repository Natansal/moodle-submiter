import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { Boom } from '@hapi/boom';
import { rm } from 'node:fs/promises';
import { encryptJson, getKeyFromEnv } from '@repo/shared-crypto';
import type { WebhookPayload } from '@repo/shared-types';

interface ListenerCredentials {
  email: string;
  password: string;
}

export class WhatsappListener {
  private sock: ReturnType<typeof makeWASocket> | null = null;
  private readonly TARGET_GROUP_ID = process.env.WHATSAPP_GROUP_ID; // e.g., '1234567890-1234@g.us'

  async start() {
    console.log('[WhatsApp] Initializing Baileys connection...');
    await this.connectToWhatsApp();
  }

  private async connectToWhatsApp() {
    // Baileys saves auth state in a folder to persist sessions across restarts
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    this.sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      version: [2, 3000, 1034074495],
      browser: ['Moodle Automation Bot', 'Safari', '3.0'],
      markOnlineOnConnect: false,
    });

    // 1. Handle Connection Updates (QR code & Reconnections)
    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('[WhatsApp] Scan this QR code to link your device:');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'close') {
        const error = lastDisconnect?.error as Boom;
        const shouldReconnect = error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log(
          `[WhatsApp] Connection closed (reason: ${error?.output?.statusCode}, ${error?.message}). Reconnecting: ${shouldReconnect}`,
        );

        if (shouldReconnect) {
          setTimeout(() => this.connectToWhatsApp(), 1000);
        } else {
          console.log('[WhatsApp] Logged out. Clearing session and re-pairing...');
          await rm('auth_info_baileys', { recursive: true, force: true });
          setTimeout(() => this.connectToWhatsApp(), 1000);
        }
      } else if (connection === 'open') {
        console.log('[WhatsApp] Connection opened successfully!');
      }
    });

    // 2. Save credentials whenever they are updated
    this.sock.ev.on('creds.update', saveCreds);

    // 3. Listen for Incoming Messages
    this.sock.ev.on('messages.upsert', async (m) => {
      // Only process new messages, ignore history syncs
      if (m.type !== 'notify') return;

      const msg = m.messages[0];
      if (!msg.message || !msg.key.remoteJid) return;
      if (msg.key.fromMe) return;

      // Filter to only listen to your target group
      if (msg.key.remoteJid !== this.TARGET_GROUP_ID) return;

      // Extract text from the complex Baileys message object
      const messageText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

      if (!messageText) return;

      console.log(`[WhatsApp] GroupID: ${msg.key.remoteJid}`);
      console.log(`[WhatsApp] Message text: ${messageText}`);

      // Look for the Moodle URL
      const urlRegex = /(https:\/\/moodle\.huji\.ac\.il[^\s]+)/;
      const match = messageText.match(urlRegex);

      if (match) {
        const targetUrl = match[0];
        console.log(`[WhatsApp] Found Moodle URL from ${msg.key.remoteJid}: ${targetUrl}`);

        await this.triggerAutomation(targetUrl);
      }
    });
  }

  private async triggerAutomation(url: string) {
    try {
      const workerUrl = process.env.WORKER_URL;
      if (!workerUrl) {
        throw new Error('WORKER_URL environment variable is required.');
      }

      const credentials: ListenerCredentials = {
        email: process.env.HUJI_USER!,
        password: process.env.HUJI_PASS!,
      };
      const key = getKeyFromEnv();

      const triggerSecret = process.env.TRIGGER_SHARED_SECRET;
      if (!triggerSecret) {
        throw new Error('TRIGGER_SHARED_SECRET environment variable is required.');
      }

      const payload: WebhookPayload = {
        targetUrl: url,
        credentials: encryptJson(credentials, key),
        mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
      };

      const base = workerUrl.replace(/\/$/, '');
      const triggerEndpoint = base.endsWith('/trigger') ? base : `${base}/trigger`;

      const response = await fetch(triggerEndpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${triggerSecret}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok && response.status !== 202) {
        throw new Error(`Worker responded with status ${response.status}`);
      }

      console.log(`[Listener] Worker accepted automation request with status ${response.status}.`);
    } catch (error) {
      console.error(`[Listener] Failed to trigger worker:`, error);
    }
  }
}
