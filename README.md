# GeoGuessr XP BOT 

A highly optimized Node.js automation script for GeoGuessr Country Streaks. 

## 📊 Performance Metrics

Benchmarks based on the latest **Stealth-Adaptive** engine (including security pauses):

| Metric | Measured Value |
| :--- | :--- |
| **Round Completion Delay** | **~0.10s (100ms)** |
| **Total Time (50 Rounds)** | **~12 - 14 seconds** |
| **Real XP Yield** | **~160,000 - 220,000 XP / Hour** |

> [!IMPORTANT]
> This yield includes mandatory "human-like" micro-pauses every 15 rounds and randomized jitter to ensure long-term account safety.

## ⏳ Estimated Levelling Time

Based on community XP data and **Real-World** bot performance:

| Target Milestone | Total XP Required | Estimated Time (@ 170k XP/h) |
| :--- | :--- | :--- |
| **Level 0 → 100** | **422,640 XP** | **~2.5 Hours** |
| **Level 0 → 200 (Max)** | **2,782,050 XP** | **~16 Hours** |

> [!TIP]
> Reaching Level 200 (the current game cap) takes about 16 hours of automated farming.

## 🛠️ Core Features
- **Connection Pooling**: Uses `undici.Pool` for low-overhead HTTP/1.1 communication and persistent TCP sockets.
- **Stealth Integration**: 
    - **Stealth Plugin**: Uses `puppeteer-extra-stealth` to bypass browser-based automated detection.
    - **Jitter Logic**: Randomized delay (+/- 25ms) to break automated pattern detection.
    - **Header Randomization**: Periodic cycling of browser-mimetic headers.
    - **Human-Like Micro-Pauses**: Simulated idle time every 15 rounds to mimic real user interaction.
- **GET Elimination**: 50% Reduction in API calls by extracting data from guess responses.

## 🚀 Installation & Setup
1. **Clone the repository**: `git clone https://github.com/AW203/geoguessr-xp-bot.git`
2. **Navigate to the bot directory**: `cd geoguessr-xp-bot`
3. **Install Dependencies**: 
   ```bash
   npm install puppeteer-extra puppeteer-extra-plugin-stealth undici puppeteer
   ```
4. **Run the engine**: `node bot.js`
5. **Authentication**: Use the built-in login assistant (Chromium) to sign in. Once authenticated, the bot runs in a pure-API "headless" mode.

---
*Disclaimer: This tool is for research and educational purposes only. Use of automation tools may violate terms of service.*
