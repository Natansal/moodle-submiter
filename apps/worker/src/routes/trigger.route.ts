import { Router } from 'express';
import Boom from '@hapi/boom';
import { decryptJson } from '@repo/shared-crypto';
import type { EncryptedCredentials } from '@repo/shared-types';
import type { AppConfig } from '../config.js';
import type { MoodleCredentials } from '../services/moodle-automation.service.js';
import { LockService } from '@repo/redis';
import { constantTimeEqualString, readBearerToken } from '../security/trigger-auth.js';
import { isValidWebhookPayload, isTargetHostAllowed } from '../validation/payload.validation.js';

/**
 * Creates and returns the `/trigger` route with all authentication,
 * validation, and automation orchestration logic.
 */
export function createTriggerRouter(config: AppConfig, lockService: LockService): Router {
  const router = Router();

  router.post('/trigger', async (req, res) => {
    const token = readBearerToken(req);
    if (!token || !constantTimeEqualString(token, config.triggerSecret)) {
      throw Boom.unauthorized();
    }

    const body = req.body;
    if (!isValidWebhookPayload(body)) {
      throw Boom.badRequest('Invalid payload');
    }

    if (!isTargetHostAllowed(body.targetUrl)) {
      throw Boom.badRequest('targetUrl host not allowed');
    }

    const credentials = await resolveCredentials(body, config);

    let lockAcquired = false;
    try {
      lockAcquired = await lockService.acquire(credentials.email, body.targetUrl);
    } catch (error) {
      console.error('[Worker] Failed to check distributed lock:', error);
      throw Boom.internal('Lock service unavailable');
    }

    if (!lockAcquired) {
      console.log(
        `[Worker] Duplicate trigger ignored for ${credentials.email} -> ${body.targetUrl}`,
      );
      return res.status(202).json({ accepted: true, duplicate: true });
    }

    res.status(202).json({ accepted: true });

    // Fire-and-forget: Boom errors from automation.run() are logged here
    // but never reach the client (the 202 response was already sent above).
    setImmediate(async () => {
      try {
        const { MoodleAutomation } = await import('../services/moodle-automation.service.js');
        const automation = new MoodleAutomation({
          credentials,
          targetUrl: body.targetUrl,
          mode: body.mode ?? config.mode,
        });

        console.log(`[Worker] Starting Playwright process...`);
        await automation.run();
        console.log(`[Worker] Automation finished successfully.`);
      } catch (error) {
        console.error('[Worker] Failed to process URL:', error);
        try {
          await lockService.release(credentials.email, body.targetUrl);
        } catch (unlockError) {
          console.error('[Worker] Failed to release lock after error:', unlockError);
        }
      }
    });
  });

  return router;
}

async function resolveCredentials(
  body: { credentials?: EncryptedCredentials },
  config: AppConfig,
): Promise<MoodleCredentials> {
  if (!body.credentials) {
    throw Boom.badRequest('Missing encrypted credentials');
  }
  try {
    return decryptJson<MoodleCredentials>(body.credentials, config.encryptionKey);
  } catch {
    throw Boom.badRequest('Failed to decrypt credentials');
  }
}
