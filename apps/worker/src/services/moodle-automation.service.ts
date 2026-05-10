import { Browser, BrowserContext, Page, errors } from 'playwright';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import Boom from '@hapi/boom';
import { random } from '../utils/random.js';
import { ALLOWED_TRIGGER_TARGET_HOSTS } from '../security/trigger-security.constants.js';

/** Moodle login credentials (decrypted from the webhook payload). */
export interface MoodleCredentials {
  email: string;
  password: string;
}

/** Configuration for a single automation run. */
export interface MoodleAutomationOptions {
  credentials: MoodleCredentials;
  targetUrl: string;
  mode: 'production' | 'development';
}

let stealthRegistered = false;
if (!stealthRegistered) {
  chromium.use(StealthPlugin());
  stealthRegistered = true;
}

/**
 * Drives a headless Chromium browser through the Moodle SSO login flow,
 * using stealth techniques and human-like interaction patterns to avoid
 * bot detection.
 */
export class MoodleAutomation {
  constructor(private readonly options: MoodleAutomationOptions) {}

  /**
   * Simulates erratic human mouse movements and pauses to lower bot-detection scores.
   */
  private async mockUserBehavior(page: Page) {
    const viewport = page.viewportSize() || { width: 1280, height: 720 };

    await page.mouse.move(
      random(0, Math.floor(viewport.width / 2)),
      random(0, Math.floor(viewport.height / 2)),
      { steps: 5 },
    );

    await page.waitForTimeout(random(500, 1500));
  }

  /**
   * Executes the full automation flow: launches a browser, navigates to the
   * target URL, authenticates via SSO, and closes the browser on completion.
   */
  public async run() {
    console.log(`[Process] Starting browser in ${this.options.mode} mode.`);

    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let page: Page | undefined;

    try {
      const isProduction = this.options.mode === 'production';
      browser = await chromium.launch({
        headless: isProduction,
        // Docker / root cannot use Chromium’s sandbox unless using a dedicated user + seccomp; see Playwright Docker guide.
        chromiumSandbox: !isProduction,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-features=IsolateOrigins,site-per-process',
          ...(isProduction ? ['--disable-dev-shm-usage'] : []),
        ],
      });

      const browserVersion = browser.version();
      context = await browser.newContext({
        userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browserVersion} Safari/537.36`,
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 2,
      });
      page = await context.newPage();

      console.log(
        `[MoodleAutomation] Navigating to ${this.options.targetUrl} and waiting for redirect...`,
      );
      await this.safeGoto(page, this.options.targetUrl);

      console.log(`[MoodleAutomation] Clicking #pills-email-tab...`);
      await this.mockUserBehavior(page);
      await page.click('#pills-email-tab');

      console.log(`[MoodleAutomation] Waiting for inputs to become visible...`);
      await page.waitForSelector('form#f3 #username', { state: 'visible' });

      console.log(`[MoodleAutomation] Typing credentials...`);
      await this.mockUserBehavior(page);

      await page
        .locator('form#f3 #username')
        .pressSequentially(this.options.credentials.email, { delay: random(50, 100) });
      await page.waitForTimeout(random(100, 400));

      await page
        .locator('form#f3 #password')
        .pressSequentially(this.options.credentials.password, { delay: random(50, 100) });

      console.log(`[MoodleAutomation] Submitting form #f3...`);
      const submitButton = page.locator('form#f3 button');

      await this.mockUserBehavior(page);
      await submitButton.hover();
      await page.waitForTimeout(200);

      await submitButton.click();

      try {
        const result = await Promise.race([
          page
            .waitForURL(
              (url) => ALLOWED_TRIGGER_TARGET_HOSTS.some((host) => url.hostname.includes(host)),
              {
                timeout: 15_000,
              },
            )
            .then(() => 'success' as const)
            .catch(() => 'timeout' as const),
          page
            .waitForSelector('p.alert.alert-danger', { state: 'visible', timeout: 15_000 })
            .then(() => 'bad_credentials' as const)
            .catch(() => 'timeout' as const),
        ]);

        if (result === 'bad_credentials') {
          const text = await page.locator('p.alert.alert-danger').innerText();
          throw Boom.unauthorized(text);
        }

        if (result === 'timeout') {
          throw Boom.gatewayTimeout('Login failed: SSO redirect timed out after 15s');
        }
      } catch (error) {
        if (Boom.isBoom(error)) throw error;
        if (error instanceof errors.TimeoutError) {
          throw Boom.gatewayTimeout('Login failed: SSO redirect timed out after 15s');
        }
        throw error;
      }

      console.log(`[MoodleAutomation] Authentication complete.`);
    } catch (error) {
      console.error(`[MoodleAutomation Error] Automation failed:`, error);
      throw error;
    } finally {
      if (this.options.mode === 'development') {
        console.log(`[MoodleAutomation] Keeping browser open for 5s in development mode...`);
        if (page && !page.isClosed()) await page.waitForTimeout(5000);
      }
      if (context) await context.close();
      if (browser) await browser.close();
    }
  }

  private async safeGoto(page: Page, url: string, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        console.log(`[Network] Attempting navigation... (Try ${i + 1}/${retries})`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        return;
      } catch (error: any) {
        if (error.message.includes('ERR_CONNECTION_RESET') && i < retries - 1) {
          console.warn(`[Network] Connection reset by WAF. Retrying in ${(i + 1) * 2}s...`);
          await page.waitForTimeout((i + 1) * 2000);
          continue;
        }
        throw error;
      }
    }
  }
}
