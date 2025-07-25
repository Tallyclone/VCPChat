const puppeteer = require('puppeteer');
const path = require('path');

let browser = null;
let page = null;

async function start(textCallback) {
    if (browser) {
        console.log('[SpeechRecognizer] Recognizer is already running.');
        return;
    }

    try {
        console.log('[SpeechRecognizer] Attempting to launch Puppeteer...');
        
        const executablePath = puppeteer.executablePath();
        console.log(`[SpeechRecognizer] Puppeteer executable path: ${executablePath}`);

        browser = await puppeteer.launch({
            executablePath: executablePath, // Explicitly set the path
            headless: true, // Back to headless mode for production
            // devtools: true, // No need for devtools in headless mode
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--use-fake-ui-for-media-stream'
            ]
        });

        console.log('[SpeechRecognizer] Puppeteer launched, creating new page...');
        page = await browser.newPage();
        console.log('[SpeechRecognizer] New page created.');

        // Grant microphone permissions
        const context = browser.defaultBrowserContext();
        await context.overridePermissions(`file://${path.join(__dirname, '..')}`, ['microphone']);

        const recognizerPath = `file://${path.join(__dirname, '..', 'Voicechatmodules', 'recognizer.html')}`;
        console.log(`Navigating to recognizer page: ${recognizerPath}`);
        await page.goto(recognizerPath);

        // Expose a function from Node.js to the page (Puppeteer).
        // This is the one and only place this function is defined.
        await page.exposeFunction('sendTextToElectron', (text) => {
            if (textCallback && typeof textCallback === 'function') {
                textCallback(text);
            }
        });
        console.log('[SpeechRecognizer] "sendTextToElectron" function exposed to the page.');

        // Start recognition on the page
        await page.evaluate(() => {
            window.startRecognition();
        });

        console.log('Puppeteer speech recognizer started successfully.');

    } catch (error) {
        console.error('Failed to start Puppeteer speech recognizer:', error);
        await stop(); // Clean up on failure
    }
}

async function stop() {
    if (browser) {
        console.log('Stopping Puppeteer speech recognizer...');
        try {
            await browser.close();
        } catch (error) {
            console.error('Error closing Puppeteer browser:', error);
        }
        browser = null;
        page = null;
        console.log('Puppeteer speech recognizer stopped.');
    }
}

module.exports = {
    start,
    stop
};