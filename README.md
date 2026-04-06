# GeoGuessr XP BOT

A highly optimized, professional-grade Node.js automation script for GeoGuessr Country Streaks. Built with performance and stability in mind.

## 📊 Performance Metrics

Current benchmarks achieved on a standard stable connection:

| Metric | Target Value |
| :--- | :--- |
| **Round Completion Delay** | **~0.10s (100ms)** |
| **Average Speed (50 Rounds)** | **~5.5 - 6.5 seconds** |
| **Effective XP Yield** | **~380,000 - 450,000 XP / Hour** |

## ⏳ Estimated Levelling Time

Based on community XP data and average bot performance:

| Target Milestone | Total XP Required | Estimated Time (@ 500k XP/h) |
| :--- | :--- | :--- |
| **Level 0 → 100** | **422,640 XP** | **~50 Minutes** |
| **Level 0 → 200 (Max)** | **2,782,050 XP** | **~5.5 Hours** |

> [!TIP]
> Reaching Level 200 (the current game cap) takes less than 6 hours of continuous operation.

> [!NOTE]
> Performance is dynamically adjusted based on server response times and security parameters to ensure long-term session stability.

## 🛠️ Core Features
- **Connection Pooling**: Uses `undici.Pool` for low-overhead HTTP/1.1 communication and persistent TCP sockets.
- **Stealth Integration**: 
    - **Jitter Logic**: Randomized delay (+/- 25ms) to break automated pattern detection.
    - **Header Randomization**: Periodic cycling of browser-mimetic headers (Sec-Fetch, Cache-Control).
    - **Human-Like Micro-Pauses**: Simulated idle time every 15 rounds to mimic real user interaction.
- **GET Elimination**: Extracts next round coordinates directly from the previous guess response, reducing network traffic by 50%.
- **Adaptive Throttle**: Self-adjusting delay logic based on real-time server latency.

## 🚀 Installation & Setup
1. **Clone the repository**: `git clone https://github.com/AW203/geoguessr-xp-bot.git`
2. **Paste this command**: `npm install puppeteer-extra puppeteer-extra-plugin-stealth undici puppeteer`
3. **Install dependencies**: `npm install`
4. **Run the engine**: `node bot.js`
5. **Authentication**: Use the built-in login assistant (Chromium) to sign in. Once authenticated, the bot runs in a pure-API "headless" mode.

---
*Disclaimer: This tool is for research and educational purposes only. Use of automation tools may violate terms of service.*
