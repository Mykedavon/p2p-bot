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

// ============ INDEX.JS - Runs both bots ============
const { spawn } = require('child_process');

console.log('[Manager] Starting Buy Bot...');

// Start buy_bot.js immediately
const buyBot = spawn('node', ['buy_bot.js'], { stdio: 'inherit' });

// Declare sellBot variable outside the timeout
let sellBot;

// Wait 10 seconds, then start sell_bot.js
setTimeout(() => {
    console.log('[Manager] Starting Sell Bot...');
    sellBot = spawn('node', ['sell_bot.js'], { stdio: 'inherit' });
    
    sellBot.on('exit', (code) => {
        console.log(`[Manager] Sell Bot exited with code ${code}`);
    });
}, 10000); // 10 second delay

// Handle buy bot exit
buyBot.on('exit', (code) => {
    console.log(`[Manager] Buy Bot exited with code ${code}`);
});

// Handle process termination (check if sellBot exists before killing)
process.on('SIGINT', () => {
    console.log('\n[Manager] Shutting down...');
    buyBot.kill();
    if (sellBot) sellBot.kill();
    process.exit();
});

process.on('SIGTERM', () => {
    console.log('\n[Manager] Shutting down...');
    buyBot.kill();
    if (sellBot) sellBot.kill();
    process.exit();
});

console.log('[Manager] Sell bot will start in 10 seconds...');
