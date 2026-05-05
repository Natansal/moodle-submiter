import { Router } from 'express';
import Boom from '@hapi/boom';
import { decryptJson } from '@repo/shared-crypto';
import type { AppConfig } from '../config.js';
import type { MoodleCredentials } from '../services/moodle-automation.service.js';
import { MoodleAutomation } from '../services/moodle-automation.service.js';
import { LockService } from '@repo/redis';
import {
  constantTimeEqualString,
  getTriggerClientIp,
  isInvokerIpAllowed,
  readBearerToken,
} from '../security/trigger-auth.js';
import { ALLOWED_TRIGGER_INVOKER_IPS } from '../security/trigger-security.constants.js';
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

    const clientIp = getTriggerClientIp(req);
    if (!isInvokerIpAllowed(clientIp, ALLOWED_TRIGGER_INVOKER_IPS)) {
      throw Boom.forbidden();
    }

    const body = req.body;
    if (!isValidWebhookPayload(body)) {
      throw Boom.badRequest('Invalid payload');
    }

    if (!isTargetHostAllowed(body.targetUrl)) {
      throw Boom.badRequest('targetUrl host not allowed');
    }

    let credentials: MoodleCredentials;
    try {
      credentials = decryptJson<MoodleCredentials>(body.credentials, config.encryptionKey);
    } catch {
      throw Boom.badRequest('Failed to decrypt credentials');
    }

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
