const { P2P } = require('bybit-p2p-sdk');
const { Telegraf } = require('telegraf');
require('dotenv').config();

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;
const TELEGRAM_TOKEN = process.env.TELEGRAM_SELL_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Initialize Bybit P2P Client
const client = new P2P({
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    recvWindow: 30000,
    timeout: 15000
});

// Initialize Telegram Bot
const telegramBot = new Telegraf(TELEGRAM_TOKEN);

// Track orders being processed
const processedOrders = new Set();
const monitoringTasks = new Map();

// ============ GET ACTIVE SELL ORDERS (status 10 - waiting for payment) ============

async function getActiveSellOrders() {
    try {
        const response = await withRetry(async () => {
            return await client.getPendingOrders({ page: 1, size: 30 });
        });
        
        const allOrders = response.result?.items || [];
        
        const activeSellOrders = allOrders.filter(order => 
            order.side === 1 && order.status === 10
        );
        
        if (activeSellOrders.length > 0) {
            console.log(`[${new Date().toLocaleString()}] 📊 Found ${activeSellOrders.length} pending sell order(s) needing payment (status 10)`);
        }
        
        return activeSellOrders;
    } catch (error) {
        if (error.message.includes('40001')) {
            return [];
        }
        console.error(`[${new Date().toLocaleString()}] ⚠️ API error: ${error.message}`);
        return [];
    }
}

// ============ GET ORDERS WAITING FOR RELEASE (status 20) ============

async function getWaitingForReleaseOrders() {
    try {
        const response = await withRetry(async () => {
            return await client.getPendingOrders({ page: 1, size: 30 });
        });
        
        const allOrders = response.result?.items || [];
        
        const waitingForRelease = allOrders.filter(order => 
            order.side === 1 && order.status === 20
        );
        
        if (waitingForRelease.length > 0) {
            console.log(`[${new Date().toLocaleString()}] 📊 Found ${waitingForRelease.length} order(s) waiting for release (status 20)`);
        }
        
        return waitingForRelease;
    } catch (error) {
        if (error.message.includes('40001')) {
            return [];
        }
        console.error(`[${new Date().toLocaleString()}] ⚠️ API error: ${error.message}`);
        return [];
    }
}

// ============ ORDER MONITORING FOR RELEASE (NON-BLOCKING) ============

async function monitorOrderUntilRelease(orderId, buyerName) {
    let reminderCount = 0;
    let lastReminderTime = 0;
    const REMINDER_INTERVAL = 5 * 60 * 1000; // 5 minutes between reminders
    
    console.log(`[${new Date().toLocaleString()}] 🔍 Monitoring order ${orderId} for release (checking every 10s)`);
    
    while (true) {
        await new Promise(resolve => setTimeout(resolve, 10000)); // Check every 10 seconds
        
        try {
            const currentOrder = await getOrderDetails(orderId);
            const status = currentOrder.status || currentOrder.orderStatus;
            
            if (status === 50 || status === 'Completed' || status === 'Finished' || status === 'Released') {
                console.log(`[${new Date().toLocaleString()}] 🎉 Order ${orderId} completed! Coins released.`);
                await sendChatMessage(orderId, "✅ Coins released!\n\n⭐ Please leave a good review! Your rating helps me serve you better.");
                await sendTelegramCompletion(orderId);
                monitoringTasks.delete(orderId);
                processedOrders.delete(orderId);
                break;
            } 
            else if (status === 20 || status === 'Paid') {
                const now = Date.now();
                // Send reminder every 5 minutes
                if (now - lastReminderTime >= REMINDER_INTERVAL) {
                    lastReminderTime = now;
                    reminderCount++;
                    const reminderMsg = `Reminder #${reminderCount}: Payment has been sent. Please release the coins. Thank you!`;
                    await sendChatMessage(orderId, reminderMsg);
                    console.log(`[${new Date().toLocaleString()}] 💬 Reminder #${reminderCount} sent for order ${orderId}`);
                }
            }
        } catch (error) {
            console.error(`[${new Date().toLocaleString()}] ❌ Monitoring error for ${orderId}: ${error.message}`);
        }
    }
}

// ============ MONITOR FOR BUYER TO MARK AS PAID (NON-BLOCKING) ============

async function monitorForMarkAsPaid(orderId, buyerName) {
    console.log(`[${new Date().toLocaleString()}] 🔍 Monitoring order ${orderId} for mark as paid (checking every 10s)`);
    
    while (true) {
        await new Promise(resolve => setTimeout(resolve, 10000)); // Check every 10 seconds
        
        try {
            const orderDetails = await getOrderDetails(orderId);
            const currentStatus = orderDetails.status || orderDetails.orderStatus;
            
            if (currentStatus === 20) {
                console.log(`[${new Date().toLocaleString()}] ✅ Buyer marked order ${orderId} as paid`);
                await sendChatMessage(orderId, "Payment claimed. Verifying...");
                // Start release monitoring without awaiting
                monitorOrderUntilRelease(orderId, buyerName);
                break;
            } else if (currentStatus === 50) {
                console.log(`[${new Date().toLocaleString()}] Order ${orderId} already completed.`);
                break;
            }
        } catch (error) {
            console.error(`[${new Date().toLocaleString()}] ❌ Status check error for ${orderId}: ${error.message}`);
        }
    }
}

// ============ PROCESS NEW SELL ORDER (NON-BLOCKING) ============

async function processNewOrder(order) {
    const orderId = order.id;
    
    if (processedOrders.has(orderId) || monitoringTasks.has(orderId)) {
        return;
    }
    
    processedOrders.add(orderId);
    
    console.log(`[${new Date().toLocaleString()}] 📦 New sell order: ${orderId} | Buyer: ${order.targetNickName} | Amount: ${order.amount} USDT`);
    
    // Wait 5 seconds
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Send initial message
    await sendChatMessage(orderId, "Hi, I'm online. Please make payment and click MARK AS PAID so I can release the coins.");
    
    // Start monitoring for mark as paid (non-blocking - don't await)
    monitorForMarkAsPaid(orderId, order.targetNickName);
}

// ============ RESUME MONITORING FOR EXISTING STATUS 20 ORDERS ============

async function resumeMonitoringForWaitingOrders() {
    console.log(`[${new Date().toLocaleString()}] 🔍 Checking for existing orders waiting for release (status 20)...`);
    
    const waitingOrders = await getWaitingForReleaseOrders();
    
    if (waitingOrders.length === 0) {
        console.log(`[${new Date().toLocaleString()}] 📭 No existing orders waiting for release`);
        return;
    }
    
    console.log(`[${new Date().toLocaleString()}] 📊 Found ${waitingOrders.length} order(s) waiting for release`);
    
    for (const order of waitingOrders) {
        const orderId = order.id;
        
        if (monitoringTasks.has(orderId)) {
            continue;
        }
        
        console.log(`[${new Date().toLocaleString()}] 🔄 Resuming monitoring for order ${orderId} (already paid, waiting for release)`);
        monitorOrderUntilRelease(orderId, order.targetNickName);
        processedOrders.add(orderId);
    }
}

// ============ BYBIT API ACTIONS ============

async function sendChatMessage(orderId, content) {
    return withRetry(async () => {
        const msgUuid = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
        
        await client.sendChatMessage({ 
            orderId: orderId, 
            message: content,
            contentType: 'text',
            msgUuid: msgUuid
        });
        console.log(`[${new Date().toLocaleString()}] 💬 Chat sent for order ${orderId}`);
        return true;
    }).catch(error => {
        console.error(`[${new Date().toLocaleString()}] ❌ Failed to send chat: ${error.message}`);
        return false;
    });
}

async function getOrderDetails(orderId) {
    return withRetry(async () => {
        const response = await client.getOrderDetails({ orderId: orderId });
        return response.result || {};
    }).catch(error => {
        console.error(`[${new Date().toLocaleString()}] ❌ Failed to get order details: ${error.message}`);
        return {};
    });
}

// ============ TELEGRAM FUNCTIONS ============

async function sendTelegramCompletion(orderId) {
    try {
        const message = `✅ Order ${orderId} completed`;
        const sentMessage = await telegramBot.telegram.sendMessage(TELEGRAM_CHAT_ID, message);
        console.log(`[${new Date().toLocaleString()}] 📱 Telegram completion sent for order ${orderId}`);
        
        setTimeout(async () => {
            try {
                await telegramBot.telegram.deleteMessage(TELEGRAM_CHAT_ID, sentMessage.message_id);
                console.log(`[${new Date().toLocaleString()}] 🗑️ Deleted completion message for order ${orderId}`);
            } catch (deleteError) {
                console.error(`[${new Date().toLocaleString()}] ❌ Failed to delete message: ${deleteError.message}`);
            }
        }, 5 * 60 * 1000);
    } catch (error) {
        console.error(`[${new Date().toLocaleString()}] ❌ Failed to send Telegram completion: ${error.message}`);
    }
}

// ============ RETRY HELPER ============

async function withRetry(fn, maxRetries = 3, delay = 2000) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            const isNetworkError = error.message.includes('ECONNRESET') || 
                                   error.message.includes('ETIMEDOUT') ||
                                   error.code === 'ECONNRESET';
            if (isNetworkError && attempt < maxRetries) {
                console.log(`[${new Date().toLocaleString()}] ⚠️ Network error (attempt ${attempt}/${maxRetries}), retrying...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }
            throw error;
        }
    }
    throw lastError;
}

// ============ MAIN CHECK LOOP ============

async function checkSellOrders() {
    try {
        // Check for new status 10 orders
        const orders = await getActiveSellOrders();
        
        for (const order of orders) {
            const orderId = order.id;
            if (!processedOrders.has(orderId) && !monitoringTasks.has(orderId)) {
                // Don't await - let each order process in parallel
                processNewOrder(order);
            }
        }
        
        // Check for status 20 orders that need release monitoring
        const waitingOrders = await getWaitingForReleaseOrders();
        
        for (const order of waitingOrders) {
            const orderId = order.id;
            if (!monitoringTasks.has(orderId)) {
                console.log(`[${new Date().toLocaleString()}] 🔄 New status 20 order detected: ${orderId}`);
                monitorOrderUntilRelease(orderId, order.targetNickName);
                processedOrders.add(orderId);
            }
        }
        
    } catch (error) {
        if (!error.message.includes('ECONNRESET')) {
            console.error(`[${new Date().toLocaleString()}] ❌ Check error: ${error.message}`);
        }
    }
}

// ============ STARTUP ============

async function sendStartupMessage() {
    try {
        await telegramBot.telegram.sendMessage(TELEGRAM_CHAT_ID, '🤖 *P2P SELL Bot is Online!*\n\n✅ Monitoring for new SELL orders\n✅ Parallel processing for multiple orders\n✅ Sends Telegram notification when order completes', {
            parse_mode: 'Markdown'
        });
        console.log('📱 Telegram connected');
    } catch (error) {
        console.error('⚠️ Telegram connection failed:', error.message);
    }
}

// ============ MAIN ============

async function main() {
    console.log(`
    ╔══════════════════════════════════════════════════╗
    ║     Bybit P2P SELL Bot - PARALLEL PROCESSING    ║
    ║     Handles multiple orders simultaneously      ║
    ╚══════════════════════════════════════════════════╝
    `);
    console.log('============================================================');
    console.log('🤖 BYBIT P2P SELL BOT');
    console.log('============================================================');
    console.log(`📱 Telegram: Connected`);
    console.log(`📊 Status 10: New orders (awaiting payment)`);
    console.log(`📊 Status 20: Orders waiting for release`);
    console.log(`🔄 PARALLEL PROCESSING: Multiple orders handled simultaneously`);
    console.log(`⏰ Checks every 10 seconds, reminders every 5 minutes`);
    console.log(`📱 Telegram notification when order completes (deletes after 5min)`);
    console.log('------------------------------------------------------------');
    
    await sendStartupMessage();
    
    telegramBot.launch().catch(err => console.error('Telegram launch error:', err));
    
    // Resume monitoring for existing orders waiting for release
    await resumeMonitoringForWaitingOrders();
    
    // Main loop
    while (true) {
        await checkSellOrders();
        await new Promise(resolve => setTimeout(resolve, 5000));
    }
}

// Graceful shutdown
process.once('SIGINT', () => {
    console.log('\n🛑 Bot shutting down...');
    telegramBot.stop('SIGINT');
    process.exit(0);
});

process.once('SIGTERM', () => {
    console.log('\n🛑 Bot shutting down...');
    telegramBot.stop('SIGTERM');
    process.exit(0);
});

// ============ RUN ============
main().catch(console.error);