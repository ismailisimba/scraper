import express from 'express';
import puppeteer from 'puppeteer';
import lighthouse from 'lighthouse';
import { readFileSync } from 'fs';
import { platform } from 'process';
import { exec } from 'child_process';
import { Storage } from '@google-cloud/storage';
import crypto from 'crypto';

// --- Configuration ---
const PORT = process.env.PORT || 8080;
const GCS_BUCKET_NAME = process.env.GCS_BUCKET || 'ismizo-aiworkspace-user-uploads'; // A single bucket for all uploads
const GCS_URL_PREFIX = "https://mnembo.com/download/user-file/"; // Your public URL prefix

const axeCoreSource = readFileSync('./node_modules/axe-core/axe.min.js', 'utf8');

// --- Google Cloud Storage Setup ---
let gcsBucket;
try {
    const storage = new Storage();
    gcsBucket = storage.bucket(GCS_BUCKET_NAME);
    console.log(`Service configured to use GCS bucket: ${GCS_BUCKET_NAME}`);
} catch (error) {
    console.error('FATAL: Failed to initialize Google Cloud Storage. Service will not be able to save files.', error);
    gcsBucket = null;
}

// --- Express App Setup ---
const app = express();
app.use(express.json({ limit: '10mb' })); // Allow larger payloads for configs


// --- Helper Functions ---
function hashText(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Centralized function to launch Puppeteer with consistent settings.
 */
async function launchBrowser() {
    return puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--single-process' // Often helps in constrained environments
        ],
    });
}


// --- API Endpoint ---
app.post('/api/v1/task/:taskName', async (req, res) => {
    const { taskName } = req.params;
    const { url, actionConfig, monitorId, userId } = req.body;

    if (!url) {
        return res.status(400).json({ status: 'error', message: 'URL is a required parameter.' });
    }

    console.log(`Received task '${taskName}' for URL: ${url}`);

    let browser = null;
    try {
        browser = await launchBrowser();
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });

        let result;

        // Route task to the correct handler
        switch (taskName) {
            case 'performance':
                const port = new URL(browser.wsEndpoint()).port;
                const { lhr } = await lighthouse(url, { port: port, output: 'json', onlyCategories: ['performance'] });
                result = {
                    status: 'success',
                    score: Math.round(lhr.categories.performance.score * 100),
                    firstContentfulPaint: lhr.audits['first-contentful-paint'].displayValue,
                    largestContentfulPaint: lhr.audits['largest-contentful-paint'].displayValue,
                    totalBlockingTime: lhr.audits['total-blocking-time'].displayValue,
                };
                break;

            case 'accessibility':
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
                await page.evaluate(axeCoreSource);
                const axeResults = await page.evaluate(() => axe.run());
                result = {
                    status: 'success',
                    violations: {
                        critical: axeResults.violations.filter(v => v.impact === 'critical').length,
                        serious: axeResults.violations.filter(v => v.impact === 'serious').length,
                        moderate: axeResults.violations.filter(v => v.impact === 'moderate').length,
                        minor: axeResults.violations.filter(v => v.impact === 'minor').length,
                    },
                    passes: axeResults.passes.length,
                    topViolations: axeResults.violations.slice(0, 3).map(v => ({ help: v.help, impact: v.impact }))
                };
                break;

            case 'js-errors':
                 const errors = [];
                 page.on('pageerror', error => errors.push({ type: 'Uncaught Exception', message: error.message }));
                 page.on('console', msg => {
                     if (msg.type().toUpperCase() === 'ERROR') {
                         errors.push({ type: 'Console Error', message: msg.text() });
                     }
                 });
                 await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
                 result = {
                     status: 'success',
                     errorCount: errors.length,
                     errors: errors.slice(0, 10),
                 };
                break;
            
            case 'brokenLinks':
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

                // 1. Get all valid, unique HTTP links from the page
                const links = await page.$$eval('a', anchors =>
                    anchors
                        .map(a => a.href)
                        .filter(href => href && (href.startsWith('http://') || href.startsWith('https://')))
                );
                const uniqueLinks = [...new Set(links)];
                const brokenLinks = [];
                const maxLinksToCheck = 50; // Limit to prevent long-running jobs

                console.log(`Found ${uniqueLinks.length} unique links. Checking up to ${maxLinksToCheck}...`);

                // 2. Check each link using fetch inside the browser context
                for (const link of uniqueLinks.slice(0, maxLinksToCheck)) {
                    try {
                        const responseStatus = await page.evaluate(async (linkToCheck) => {
                            try {
                                const response = await fetch(linkToCheck, {
                                    method: 'HEAD',
                                    signal: AbortSignal.timeout(8000) // 8-second timeout per link
                                });
                                return response.status;
                            } catch (error) {
                                return 599; // Custom code for network error/timeout
                            }
                        }, link);

                        if (responseStatus >= 400) {
                            brokenLinks.push({ url: link, status: responseStatus });
                            console.log(`-- Found broken link: ${link} (Status: ${responseStatus})`);
                        }
                    } catch (e) {
                        console.error(`Error checking link ${link}:`, e.message);
                        brokenLinks.push({ url: link, status: 'Error' });
                    }
                }

                result = {
                    status: 'success',
                    checkedLinks: Math.min(uniqueLinks.length, maxLinksToCheck),
                    totalLinksFound: uniqueLinks.length,
                    brokenLinkCount: brokenLinks.length,
                    brokenLinks: brokenLinks,
                };
                break;

            case 'snapshot':
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
                const innerText = await page.evaluate(() => document.body.innerText);
                const screenshotBuffer = await page.screenshot({ fullPage: true });
                const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });

                const timestamp = Date.now();
                const screenshotPath = `snapshots/${userId || 'unknown'}/${monitorId}/screenshot-${timestamp}.png`;
                const pdfPath = `snapshots/${userId || 'unknown'}/${monitorId}/document-${timestamp}.pdf`;

                if (!gcsBucket) throw new Error("GCS Bucket not initialized.");

                // Parallel uploads
                await Promise.all([
                    gcsBucket.file(screenshotPath).save(screenshotBuffer, { contentType: 'image/png' }),
                    gcsBucket.file(pdfPath).save(pdfBuffer, { contentType: 'application/pdf' })
                ]);

                result = {
                    status: 'success',
                    screenshotUrl: `${GCS_URL_PREFIX}${encodeURIComponent(`gs://${GCS_BUCKET_NAME}/${screenshotPath}`)}`,
                    pdfUrl: `${GCS_URL_PREFIX}${encodeURIComponent(`gs://${GCS_BUCKET_NAME}/${pdfPath}`)}`,
                    contentHash: hashText(innerText),
                };
                break;

            case 'scheduled-actions':
                 if (!actionConfig || !Array.isArray(actionConfig.steps)) {
                    throw new Error("'actionConfig' is missing or invalid for scheduled-actions task.");
                 }
                 await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
                 for (const step of actionConfig.steps) {
                    console.log(`-- Executing step: ${step.type}`);
                    switch (step.type) {
                        case 'type':
                            await page.waitForSelector(step.selector, { timeout: 10000 });
                            await page.type(step.selector, step.text);
                            break;
                        case 'click':
                            await page.waitForSelector(step.selector, { timeout: 10000 });
                            await page.click(step.selector);
                            break;
                        case 'waitForSelector':
                            await page.waitForSelector(step.selector, { timeout: 15000 });
                            break;
                        case 'wait':
                            await new Promise(resolve => setTimeout(resolve, parseInt(step.duration, 10)));
                            break;
                        default:
                            throw new Error(`Unknown action type: ${step.type}`);
                    }
                    await new Promise(resolve => setTimeout(resolve, 500)); // Small delay between steps
                 }

                 await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for UI to settle
                 const finalScreenshot = await page.screenshot({ fullPage: true });
                 const finalScreenshotPath = `monitors/${userId || 'unknown'}/${monitorId}/final-state-${Date.now()}.png`;
                 await gcsBucket.file(finalScreenshotPath).save(finalScreenshot, { contentType: 'image/png' });
                 
                 result = {
                    status: 'success',
                    stepsCompleted: actionConfig.steps.length,
                    finalScreenshotUrl: `${GCS_URL_PREFIX}${encodeURIComponent(`gs://${GCS_BUCKET_NAME}/${finalScreenshotPath}`)}`
                 };
                break;

            default:
                return res.status(404).json({ status: 'error', message: `Task '${taskName}' not found.` });
        }
        
        res.status(200).json(result);

    } catch (error) {
        console.error(`Error executing task '${taskName}' for URL ${url}:`, error);
        res.status(500).json({ status: 'error', message: error.message || 'An internal error occurred.' });
    } finally {
        if (browser) {
            await browser.close();
            console.log(`Browser closed for task '${taskName}'.`);
        }
    }
});


app.listen(PORT, () => {
    console.log(`Puppeteer service listening on port ${PORT}`);
});
