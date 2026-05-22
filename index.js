// ============ HEALTH CHECK SERVER (keeps both bots alive on Render) ============
const express = require('express');
const healthApp = express();
const PORT = process.env.PORT || 10000;

healthApp.get('/health', (req, res) => {
    res.status(200).send('Both bots are alive!');
});

healthApp.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Health check server running on port ${PORT}`);
});

// ============ YOUR EXISTING INDEX.JS CODE BELOW ============
// (Keep your existing spawn code for buy_bot and sell_bot)

// index.js - Runs both bots simultaneously
const { spawn } = require('child_process');

console.log('[Manager] Starting Buy Bot...');
console.log('[Manager] Starting Sell Bot...');

// Start buy_bot.js
const buyBot = spawn('node', ['buy_bot.js'], { stdio: 'inherit' });

// Start sell_bot.js
const sellBot = spawn('node', ['sell_bot.js'], { stdio: 'inherit' });

// Handle buy bot exit
buyBot.on('exit', (code) => {
    console.log(`[Manager] Buy Bot exited with code ${code}`);
});

// Handle sell bot exit
sellBot.on('exit', (code) => {
    console.log(`[Manager] Sell Bot exited with code ${code}`);
});

// Handle process termination
process.on('SIGINT', () => {
    console.log('\n[Manager] Shutting down...');
    buyBot.kill();
    sellBot.kill();
    process.exit();
});

process.on('SIGTERM', () => {
    console.log('\n[Manager] Shutting down...');
    buyBot.kill();
    sellBot.kill();
    process.exit();
});

console.log('[Manager] Both bots are running!');
// Add health check server to keep both bots alive
