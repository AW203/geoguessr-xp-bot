const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

// --- BOT CONFIGURATION ---
const API_DELAY_MS = 250;
const STREAK_LIMIT = 50;
const TARGET_URL = 'https://www.geoguessr.com/country-streak';
const RESTART_INTERVAL_MS = 24 * 60 * 60 * 1000;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const askQuestion = (query) => new Promise(resolve => rl.question(query, resolve));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- TELEMETRY & STATE ---
let activeToken = null;
let currentCoords = null;
let currentStreakCount = 0;
let activeApiEndpoint = null;
let botStartTime = Date.now();
let lastCycleStartTime = Date.now();
let totalRoundsPlayed = 0;

// Handle manual exit signal (Ctrl+C)
let isExitingRequested = false;
process.on('SIGINT', () => {
    if (isExitingRequested) {
        console.log('\n[STOP] Forced exit!');
        process.exit();
    }
    isExitingRequested = true;
    console.log('\n\n[STOP] Signal received. Finishing current 50-streak before clean exit...');
});

/**
 * Extracts guess coordinates from game data object
 * Supports v3 API payloads and raw panorama objects
 */
function extractCoords(data) {
    if (!data) return null;
    if (data.rounds && data.rounds.length > 0) {
        const roundIndex = (data.round ? data.round : data.rounds.length) - 1;
        const currentRound = data.rounds[roundIndex];
        if (currentRound && typeof currentRound.lat === 'number') {
            return {
                lat: currentRound.lat,
                lng: currentRound.lng,
                streakCode: currentRound.streakLocationCode || null
            };
        }
    }
    if (typeof data.lat === 'number') return { lat: data.lat, lng: data.lng };
    if (data.panorama && typeof data.panorama.lat === 'number') return data.panorama;
    return null;
}

/**
 * Initializes Puppeteer instance with optimized flags
 * Handles crash recovery and resource interception (media/css/trackers)
 */
async function createBrowser(isHeadless) {
    const userDataDir = path.join(__dirname, 'session_data');

    // Fix Chrome crash popup on startup
    try {
        const prefPath = path.join(userDataDir, 'Default', 'Preferences');
        if (fs.existsSync(prefPath)) {
            let prefs = fs.readFileSync(prefPath, 'utf8');
            prefs = prefs.replace(/"exit_type"\s*:\s*"Crashed"/g, '"exit_type":"Normal"')
                .replace(/"exited_cleanly"\s*:\s*false/g, '"exited_cleanly":true');
            fs.writeFileSync(prefPath, prefs, 'utf8');
        }
    } catch (e) { }

    const browser = await puppeteer.launch({
        headless: isHeadless ? 'new' : false,
        userDataDir: userDataDir,
        handleSIGINT: false, // Prevents Puppeteer from closing browser on Ctrl+C automatically
        handleSIGTERM: false,
        handleSIGHUP: false,
        defaultViewport: null,
        args: [
            '--start-maximized', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
            '--disk-cache-size=1', '--disable-blink-features=AutomationControlled',
            '--disable-session-crashed-bubble', '--hide-crash-restore-window'
        ]
    });

    const pages = await browser.pages();
    const page = pages[0];

    // Resource interception to reduce overhead
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        const type = req.resourceType();
        const url = req.url();

        // Filter analytics and social tracking
        const isTracker = url.includes('google-analytics') || url.includes('googletagmanager') ||
            url.includes('facebook') || url.includes('intercom') ||
            url.includes('mixpanel') || url.includes('hotjar');

        const blockList = ['image', 'media', 'font'];
        if (isHeadless) blockList.push('stylesheet'); // Block CSS only in headless mode

        if (blockList.includes(type) || url.includes('google.com/maps/vt/') || isTracker) {
            req.abort();
        } else {
            req.continue();
        }
    });

    // Bypass basic bot detection
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    return { browser, page };
}

/**
 * Validates current session status on GeoGuessr
 */
async function checkLoggedIn(page) {
    await page.goto('https://www.geoguessr.com/', { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 5; i++) {
        const isLoggedOut = await page.evaluate(() => {
            return document.querySelector('a[href^="/signin"]') !== null || document.body.innerText.includes('LOG IN');
        });
        if (!isLoggedOut) return true;
        await sleep(1000);
    }
    return false;
}

/**
 * Main application loop
 * Handles login flow and high-speed API agriculture
 */
async function main() {
    // Reset state for potential auto-restarts
    activeToken = null;
    currentCoords = null;
    currentStreakCount = 0;

    console.clear();
    console.log('==========================================');
    console.log('🤖 GeoGhost Bot - Country Streaks Farmer');
    console.log(`⏱️ Auto-limit: ${STREAK_LIMIT} countries`);
    console.log('==========================================\n');

    // Phase 1: Silent session probe
    console.log('[BOT] Running silent session check...');
    let { browser, page } = await createBrowser(true);
    let sessionOk = await checkLoggedIn(page);

    if (!sessionOk) {
        console.log('[BOT] ⚠️ Session not found. Opening login window...');
        await browser.close();

        // Phase 2: Manual Login (Visible)
        const visibleRes = await createBrowser(false);
        browser = visibleRes.browser;
        page = visibleRes.page;

        await page.goto('https://www.geoguessr.com/signin', { waitUntil: 'domcontentloaded' });
        console.log('\n-----------------------------------------------------------');
        console.log('👉 LOG IN via the Chrome window that just opened.');
        console.log('-----------------------------------------------------------');
        await askQuestion('✅ Press [ENTER] here once logged in (on the main menu): ');

        console.log('[BOT] Login detected. Switching to Ghost mode...');
        await browser.close();

        // Phase 3: Headless Farm Initialization
        const finalRes = await createBrowser(true);
        browser = finalRes.browser;
        page = finalRes.page;
    } else {
        console.log('✅ Active session! Proceeding directly to invisible farming.');
    }

    console.clear();
    console.log('🚀 LOOP ACTIVATED');
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });

    while (true) {
        await sleep(100);
        try {
            // Fetch game token and initial data
            if (!activeToken || !currentCoords) {
                const nextDataState = await page.evaluate(() => {
                    try { return window.__NEXT_DATA__.props.pageProps.game; } catch (e) { return null; }
                });

                if (nextDataState && nextDataState.token && !activeToken) {
                    activeToken = nextDataState.token;
                    activeApiEndpoint = `/api/v3/games/${activeToken}`;
                    currentCoords = extractCoords(nextDataState);
                }

                if (!activeToken || !currentCoords) {
                    // Create new game via API if no active session found
                    console.log("[BOT] 🆕 Creating new game session via API...");
                    const initData = await page.evaluate(async () => {
                        try {
                            const res = await fetch('https://www.geoguessr.com/api/v3/games/streak', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ "streakType": "CountryStreak", "timeLimit": 120, "forbidMoving": false, "forbidZooming": false, "forbidRotating": false })
                            });
                            return res.ok ? await res.json() : null;
                        } catch (e) { return null; }
                    });

                    if (initData && initData.token) {
                        activeToken = initData.token;
                        activeApiEndpoint = `/api/v3/games/${activeToken}`;
                        currentCoords = extractCoords(initData);
                        currentStreakCount = 0;
                        console.log(`[BOT] 🎮 New Game: ${activeToken}`);
                    } else {
                        console.log("[BOT] ⚠️ API failure, retrying in 2s...");
                        await sleep(2000);
                        continue;
                    }
                }
            }

            // Execute guess and round progression
            if (activeToken && currentCoords) {
                let rStart = performance.now();
                let payload = { token: activeToken, lat: currentCoords.lat, lng: currentCoords.lng, timedOut: false, stepsCount: 0 };

                // Force fail at limit to claim XP
                const isSuicide = (currentStreakCount >= STREAK_LIMIT);
                if (isSuicide) {
                    payload.lat = 0; payload.lng = -160; payload.streakLocationCode = "kp";
                } else if (currentCoords.streakCode) {
                    payload.streakLocationCode = currentCoords.streakCode;
                }

                await sleep(API_DELAY_MS);

                // Submit guess via internal API
                const gRes = await page.evaluate(async (endpoint, p) => {
                    try {
                        const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
                        if (!res.ok) return { success: false };
                        const d = await res.json();
                        return { success: true, state: d.state };
                    } catch (e) { return { success: false }; }
                }, activeApiEndpoint, payload);

                if (!gRes.success) { activeToken = null; continue; }

                // Post-round handling
                if (gRes.state === 'finished' || isSuicide) {
                    console.log(`\n[BOT] 🏁 Streak ${currentStreakCount}/${STREAK_LIMIT} finished. XP Claimed.`);

                    if (isExitingRequested) {
                        console.log('[STOP] Clean exit. Goodbye!');
                        await browser.close();
                        process.exit();
                    }

                    // Handle scheduled restarts
                    if (Date.now() - botStartTime > RESTART_INTERVAL_MS) {
                        console.log('[SYSTEM] 🔄 24h cycle reached. Restarting browser to clear RAM...');
                        await browser.close();
                        return main();
                    }

                    lastCycleStartTime = Date.now();
                    activeToken = null;
                    currentCoords = null;
                    await sleep(1000);
                } else {
                    // Fetch next round data without reloading page
                    currentStreakCount++;
                    process.stdout.write(`\r[FARMING] Streak: ${currentStreakCount}/${STREAK_LIMIT} | Speed: ${((performance.now() - rStart) / 1000).toFixed(2)}s`);

                    const nData = await page.evaluate(async (e) => {
                        try {
                            const r = await fetch(e);
                            return r.ok ? await r.json() : null;
                        } catch (e) { return null; }
                    }, activeApiEndpoint);

                    const nC = extractCoords(nData);
                    if (nC && (nC.lat !== payload.lat || nC.lng !== payload.lng)) {
                        currentCoords = nC;
                    } else {
                        await sleep(300); // Wait for server generation
                    }
                }
            }
        } catch (e) { await sleep(1000); }
    }
}

main();
