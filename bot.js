const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const undici = require('undici');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

// Activate Puppeteer Stealth Plugin
puppeteer.use(StealthPlugin());

/**
 * GeoGuessr XP BOT
 * Optimized for undici connection pooling and stealth operation.
 * Performance: ~400k-600k XP/h (with jitter and adaptive delay).
 */

const CONFIG = {
    MIN_DELAY_MS: 30,           // Minimum floor delay for stability
    MAX_DELAY_MS: 60,
    STREAK_LIMIT: 50,
    TARGET_URL: 'https://www.geoguessr.com/country-streak',
    RATE_LIMIT_PAUSE_MS: 7500,
    COOLING_PAUSE_403_MS: 7500,  // Pause duration on 403 Forbidden detection
    RESTART_INTERVAL_MS: 24 * 60 * 60 * 1000,
    RETRY_ATTEMPTS: 3,
    MAX_REQUEST_TIMEOUT_MS: 15000
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const askQuestion = (query) => new Promise(resolve => rl.question(query, resolve));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- GLOBAL STATE ---
let session = { token: null, coords: null, streak: 0, cookies: null, ua: null };
let sessionRecord = Infinity;
let botStartTime = Date.now();
let isExitingRequested = false;

let baseHeaders = null;
const client = new undici.Pool('https://www.geoguessr.com', {
    connections: 15,
    pipelining: 0,
    keepAliveTimeout: 90000,
    headersTimeout: 20000,
    bodyTimeout: 20000
});

process.on('SIGINT', () => {
    isExitingRequested = true;
    console.log('\n\n[STOP] Shutdown requested. Finishing current streak...');
});

/**
 * Randomize request headers to avoid fingerprinting.
 */
function getStealthHeaders() {
    const variants = [
        { 'cache-control': 'max-age=0' },
        { 'pragma': 'no-cache' },
        { 'sec-fetch-user': '?1' },
        { 'upgrade-insecure-requests': '1' },
        { 'x-requested-with': 'XMLHttpRequest' }
    ];
    // Select a random variation to mimic realistic browser behavior
    const pick = variants[Math.floor(Math.random() * variants.length)];
    return { ...baseHeaders, ...pick };
}

/**
 * Robust API request handler using undici pooling.
 */
async function requestAPI(path, method = 'GET', body = null, useStealth = false) {
    const options = {
        method,
        headers: useStealth ? getStealthHeaders() : baseHeaders,
        body: body ? JSON.stringify(body) : undefined
    };

    let lastError;
    for (let i = 0; i < CONFIG.RETRY_ATTEMPTS; i++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), CONFIG.MAX_REQUEST_TIMEOUT_MS);
        let responseBody;
        try {
            const result = await client.request({ path, ...options, signal: controller.signal });
            responseBody = result.body;
            const statusCode = result.statusCode;

            if (statusCode === 429 || statusCode === 403) {
                await responseBody.dump();
                return { rateLimit: true, is403: (statusCode === 403) };
            }
            if (statusCode >= 400) {
                await responseBody.dump();
                throw new Error(`HTTP_STATUS_${statusCode}`);
            }

            const text = await responseBody.text();
            if (text.trim().startsWith('{')) {
                return { success: true, data: JSON.parse(text) };
            } else {
                throw new Error('INVALID_JSON_RESPONSE');
            }
        } catch (e) {
            lastError = e;
            if (responseBody) try { await responseBody.dump(); } catch (dumpErr) { }
            if (i < CONFIG.RETRY_ATTEMPTS - 1) await sleep(50 * (i + 1));
        } finally { clearTimeout(timeout); }
    }
    return { success: false, error: lastError?.message };
}

/**
 * Extracts coordinate data from various API response structures.
 */
function extractCoords(data) {
    if (!data) return null;
    let target = data.game ? data.game : data;
    if (target.rounds && target.rounds.length > 0) {
        const rIdx = (target.round !== undefined) ? target.round : (target.rounds.length - 1);
        const curr = target.rounds[rIdx] || target.rounds[target.rounds.length - 1];
        return curr && curr.lat ? { lat: curr.lat, lng: curr.lng, code: curr.streakLocationCode } : null;
    }
    return (target && target.lat) ? { lat: target.lat, lng: target.lng } : null;
}

/**
 * Initializes session by extracting cookies and User-Agent from Puppeteer.
 */
async function extractSession() {
    const userDataDir = path.join(__dirname, 'session_data');
    const browser = await puppeteer.launch({
        headless: 'new',
        userDataDir: userDataDir,
        args: [
            '--no-sandbox', 
            '--disable-gpu', 
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled'
        ],
        ignoreDefaultArgs: ['--enable-automation']
    });
    let pages = await browser.pages();
    while (pages.length > 1) { await pages.pop().close(); }
    const page = pages[0];
    try {
        await page.goto('https://www.geoguessr.com/', { waitUntil: 'networkidle2', timeout: 30000 });
        await sleep(3000);
        
        let currentUrl = page.url();
        let pCookies = await page.cookies();
        let hasAuthCookie = pCookies.some(c => c.name.includes('ncfa') || c.name === 'sid');

        // If we have cookies but we're still on the landing page, try to force go to /home
        if (hasAuthCookie && currentUrl === 'https://www.geoguessr.com/') {
            await page.goto('https://www.geoguessr.com/home', { waitUntil: 'networkidle2' });
            currentUrl = page.url();
            pCookies = await page.cookies();
        }

        const isLoggedOut = await page.evaluate(() => {
            const hasProfile = document.querySelector('a[href^="/me"]') !== null || 
                               document.querySelector('div[class*="user-nickname"]') !== null ||
                               document.querySelector('div[class*="header__user"]') !== null;
            const hasSignIn = document.querySelector('a[href^="/signin"]') !== null;
            // We only consider it logged out if there is NO profile AND a sign-in button
            return !hasProfile && hasSignIn;
        });

        if (isLoggedOut && !hasAuthCookie) { 
            console.log(`\n[DEBUG] URL: ${currentUrl}`);
            console.log(`[DEBUG] Cookies found: ${pCookies.length > 0 ? pCookies.map(c => c.name).join(', ') : 'NONE'}`);
            console.log(`[DEBUG] Status: Signed out (No valid session detected)`);
            await browser.close(); return null; 
        }

        const cookieStr = pCookies.map(c => `${c.name}=${c.value}`).join('; ');
        session.cookies = cookieStr;
        session.ua = await page.evaluate(() => navigator.userAgent);
        
        baseHeaders = {
            'content-type': 'application/json',
            'cookie': session.cookies,
            'user-agent': session.ua,
            'origin': 'https://www.geoguessr.com',
            'referer': 'https://www.geoguessr.com/country-streak',
            'accept': 'application/json, text/plain, */*',
            'accept-language': 'en-US,en;q=0.9',
            'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin', 'dnt': '1'
        };
        
        if (!hasAuthCookie) {
            console.log(`\n[DEBUG] Cookies found: ${pCookies.map(c => c.name).join(', ')}`);
        }

    } catch (e) {
        console.log(`\n[DEBUG] Extraction Error: ${e.message}`);
    }
    await browser.close();
    return (session.cookies && (session.cookies.includes('ncfa') || session.cookies.includes('sid'))) ? true : null;
}

/**
 * Core execution engine.
 */
async function main() {
    // console.clear(); // Disabled during login debugging
    console.log('----------------------------------------------');
    console.log('GeoGuessr XP BOT');
    console.log('Mode: Stealth-Adaptive | Pool: undici');
    console.log('----------------------------------------------\n');

    if (!session.cookies) {
        process.stdout.write('[SYSTEM] Probing session headers... ');
        const hasSession = await extractSession();
        if (!hasSession) {
            console.log('FAILED\n[SYSTEM] Redirecting to login assistant...');
            const browser = await puppeteer.launch({ 
                headless: false, 
                userDataDir: path.join(__dirname, 'session_data'), 
                args: [
                    '--no-sandbox',
                    '--disable-blink-features=AutomationControlled'
                ],
                ignoreDefaultArgs: ['--enable-automation']
            });
            let pages = await browser.pages();
            while (pages.length > 1) { await pages.pop().close(); }
            const page = pages[0];
            await page.goto('https://www.geoguessr.com/signin');
            await askQuestion('[SYSTEM] Once logged in, press [ENTER]: ');
            await browser.close();
            await sleep(2000); // Give Chrome time to flush session data to disk
            return main();
        }
        console.log('OK');
    }

    while (true) {
        try {
            if (Date.now() - botStartTime > CONFIG.RESTART_INTERVAL_MS) { return main(); }

            if (!session.token) {
                const r = await requestAPI('/api/v3/games/streak', 'POST', {
                    "streakType": "CountryStreak", "timeLimit": 120, "forbidMoving": false, "forbidZooming": false, "forbidRotating": false
                });
                if (r.rateLimit) {
                    const p = r.is403 ? CONFIG.COOLING_PAUSE_403_MS : CONFIG.RATE_LIMIT_PAUSE_MS;
                    console.log(`\n[WARNING] Detection ${r.is403 ? '403 Forbidden' : '429 Rate Limit'} - Cooling down (${p / 1000}s)...`);
                    await sleep(p); continue;
                }
                if (!r.success) { await sleep(3000); continue; }
                session.token = r.data.token;
                session.coords = extractCoords(r.data);
                session.streak = 0;
                console.log(`\n[GAME] New ID: ${session.token}`);
            }

            const endpoint = `/api/v3/games/${session.token}`;
            let times = [];
            let currentDelay = CONFIG.MIN_DELAY_MS;

            while (session.streak <= CONFIG.STREAK_LIMIT) {
                if (!session.coords) {
                    const r = await requestAPI(endpoint);
                    if (r.success) { session.coords = extractCoords(r.data); }
                }

                if (!session.coords) { session.token = null; break; }

                let start = performance.now();
                const isFinalRound = (session.streak >= CONFIG.STREAK_LIMIT);
                let payload = { token: session.token, lat: session.coords.lat, lng: session.coords.lng, timedOut: false, stepsCount: 0 };

                // Intentional error on last round to finalize streak XP
                if (isFinalRound) { payload.lat = 0; payload.lng = -160; payload.streakLocationCode = "kp"; }
                else if (session.coords.code) payload.streakLocationCode = session.coords.code;

                // Jitter injection to break automated patterns
                const jitter = Math.floor(Math.random() * 25);
                await sleep(currentDelay + jitter);

                // Guess submission with stealth headers
                const gRes = await requestAPI(endpoint, 'POST', payload, true);
                if (gRes.rateLimit) {
                    const p = gRes.is403 ? CONFIG.COOLING_PAUSE_403_MS : CONFIG.RATE_LIMIT_PAUSE_MS;
                    console.log(`\n[WARNING] Security encounter (403/429) - Emergency brake (${p / 1000}s)...`);
                    await sleep(p); break;
                }

                if (!gRes.success) { session.token = null; break; }

                const gData = gRes.data;
                if (gData.state === 'finished' || isFinalRound) {
                    const avg = times.reduce((a, b) => a + b, 0) / times.length;
                    const xph = Math.floor(3600 / (avg * 50) * 600);
                    console.log(`\n----------------------------------------------`);
                    console.log(` Streak Summary: Complete`);
                    console.log(` Average Speed : ${avg.toFixed(3)}s`);
                    console.log(` Est. Yield    : ${xph.toLocaleString()} XP/h`);
                    console.log(`----------------------------------------------\n`);
                    session.token = null; session.streak = 0; break;
                }

                session.streak++;
                let rTime = (performance.now() - start) / 1000;
                times.push(rTime);

                // Adaptive Throttle + Human-like micro-pauses
                if (rTime < 0.10) currentDelay = Math.min(CONFIG.MAX_DELAY_MS, currentDelay + 4);
                else currentDelay = Math.max(CONFIG.MIN_DELAY_MS, currentDelay - 2);

                if (session.streak % 15 === 0) {
                    // Periodic micro-pause to mimic reading/latency
                    await sleep(800 + Math.random() * 1200);
                }

                if (session.streak % 5 === 0) {
                    const avgLog = times.reduce((a, b) => a + b, 0) / times.length;
                    process.stdout.write(`\r[STREAK] Progress: ${session.streak}/${CONFIG.STREAK_LIMIT} | Avg: ${avgLog.toFixed(3)}s | Internal Delay: ${currentDelay}ms`);
                }

                // Data extraction for the next round
                let nextCoords = extractCoords(gData);
                if (!nextCoords || (nextCoords.lat === payload.lat && nextCoords.lng === payload.lng)) {
                    const nR = await requestAPI(endpoint);
                    if (nR.success) { nextCoords = extractCoords(nR.data); }
                }
                if (!nextCoords) { session.token = null; break; }
                session.coords = nextCoords;
            }

            if (isExitingRequested) { process.exit(); }
            await sleep(500);

        } catch (e) { await sleep(1000); }
    }
}

main();
