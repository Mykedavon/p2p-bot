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
const activeOrders = new Map(); // orderId -> { reminderInterval, type }

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

// ============ GET ACTIVE SELL ORDERS ============
async function getActiveSellOrders() {
    try {
        const response = await withRetry(async () => {
            return await client.getPendingOrders({ page: 1, size: 30 });
        });
        const allOrders = response.result?.items || [];
        return allOrders.filter(order => order.side === 1 && order.status === 10);
    } catch (error) {
        if (error.message.includes('40001')) return [];
        console.error(`[${new Date().toLocaleString()}] ⚠️ API error: ${error.message}`);
        return [];
    }
}

// ============ START PAYMENT REMINDERS (status 10 - unpaid) ============
async function startPaymentReminders(orderId, buyerName, amount) {
    console.log(`[${new Date().toLocaleString()}] ⏰ Starting payment reminders for order ${orderId} (every 5 minutes)`);
    
    const reminderInterval = setInterval(async () => {
        // Check if order is still active (status 10)
        const orderDetails = await getOrderDetails(orderId);
        const currentStatus = orderDetails.status || orderDetails.orderStatus;
        
        // If order is no longer status 10, stop reminders
        if (currentStatus !== 10) {
            console.log(`[${new Date().toLocaleString()}] 🛑 Stopping payment reminders for order ${orderId} (status changed to ${currentStatus})`);
            clearInterval(reminderInterval);
            activeOrders.delete(orderId);
            return;
        }
        
        // Send payment reminder to buyer
        const reminderMsg = "Kindly make payment fast and mark as paid to receive your coins.";
        await sendChatMessage(orderId, reminderMsg);
        console.log(`[${new Date().toLocaleString()}] 💬 Payment reminder sent for order ${orderId}`);
        
    }, 5 * 60 * 1000); // Every 5 minutes
    
    activeOrders.set(orderId, { reminderInterval, type: 'payment' });
}

// ============ TELEGRAM NOTIFICATION TO YOU (when buyer marks as paid) ============
async function sendTelegramPaymentClaim(orderId, buyerName, amount) {
    const message = `
*💰 PAYMENT CLAIMED - VERIFY MANUALLY*

*Order ID:* \`${orderId}\`
*Buyer:* ${buyerName}
*Amount:* ${amount} USDT

⚠️ Please check your bank/PalmPay app to verify payment.
If payment is confirmed, release coins on Bybit app.

P2P → Orders → Pending → Click "RELEASE"
`;
    const sentMessage = await telegramBot.telegram.sendMessage(TELEGRAM_CHAT_ID, message, {
        parse_mode: 'Markdown'
    });
    
    console.log(`[${new Date().toLocaleString()}] 📱 Payment claim notification sent to you for order ${orderId}`);
    
    // Auto-delete this notification after 5 minutes
    setTimeout(async () => {
        try {
            await telegramBot.telegram.deleteMessage(TELEGRAM_CHAT_ID, sentMessage.message_id);
            console.log(`[${new Date().toLocaleString()}] 🗑️ Auto-deleted payment claim notification for order ${orderId}`);
        } catch (deleteError) {
            console.error(`[${new Date().toLocaleString()}] ❌ Failed to delete payment claim notification: ${deleteError.message}`);
        }
    }, 5 * 60 * 1000);
}

// ============ TELEGRAM COMPLETION MESSAGE (deletes after 2 minutes) ============
async function sendTelegramCompletion(orderId) {
    try {
        const message = `✅ Order ${orderId} completed`;
        const sentMessage = await telegramBot.telegram.sendMessage(TELEGRAM_CHAT_ID, message);
        console.log(`[${new Date().toLocaleString()}] 📱 Telegram completion sent for order ${orderId}`);
        
        // Auto-delete after 2 MINUTES
        setTimeout(async () => {
            try {
                await telegramBot.telegram.deleteMessage(TELEGRAM_CHAT_ID, sentMessage.message_id);
                console.log(`[${new Date().toLocaleString()}] 🗑️ Deleted completion message for order ${orderId}`);
            } catch (deleteError) {
                console.error(`[${new Date().toLocaleString()}] ❌ Failed to delete completion message: ${deleteError.message}`);
            }
        }, 2 * 60 * 1000); // 2 minutes
    } catch (error) {
        console.error(`[${new Date().toLocaleString()}] ❌ Failed to send Telegram completion: ${error.message}`);
    }
}

// ============ MONITOR FOR BUYER TO MARK AS PAID ============
async function monitorForMarkAsPaid(orderId, buyerName, amount) {
    console.log(`[${new Date().toLocaleString()}] 🔍 Monitoring order ${orderId} for mark as paid`);
    
    while (true) {
        await new Promise(resolve => setTimeout(resolve, 10000)); // Check every 10 seconds
        
        try {
            const orderDetails = await getOrderDetails(orderId);
            const currentStatus = orderDetails.status || orderDetails.orderStatus;
            
            if (currentStatus === 20) {
                console.log(`[${new Date().toLocaleString()}] ✅ Buyer marked order ${orderId} as paid`);
                
                // Stop payment reminders
                if (activeOrders.has(orderId)) {
                    clearInterval(activeOrders.get(orderId).reminderInterval);
                    activeOrders.delete(orderId);
                }
                
                // Send ONE verification message to buyer (NO reminders after this)
                await sendChatMessage(orderId, "Payment claimed. Verifying...");
                
                // Send Telegram notification to YOU
                await sendTelegramPaymentClaim(orderId, buyerName, amount);
                
                // NO reminders after mark as paid - YOU verify manually
                // Start monitoring for completion (when YOU release coins)
                monitorForCompletion(orderId, buyerName, amount);
                break;
            }
        } catch (error) {
            console.error(`[${new Date().toLocaleString()}] ❌ Status check error for ${orderId}: ${error.message}`);
        }
    }
}

// ============ MONITOR FOR COMPLETION (when YOU release coins) ============
async function monitorForCompletion(orderId, buyerName, amount) {
    console.log(`[${new Date().toLocaleString()}] 🔍 Monitoring order ${orderId} for completion (you releasing coins)`);
    
    while (true) {
        await new Promise(resolve => setTimeout(resolve, 10000)); // Check every 10 seconds
        
        try {
            const orderDetails = await getOrderDetails(orderId);
            const currentStatus = orderDetails.status || orderDetails.orderStatus;
            
            if (currentStatus === 50 || currentStatus === 'Completed' || currentStatus === 'Finished') {
                console.log(`[${new Date().toLocaleString()}] 🎉 Order ${orderId} completed! Coins released.`);
                
                // Send review request to buyer
                await sendChatMessage(orderId, "✅ Coins released!\n\n⭐ Please leave a good review! Your rating helps me serve you better.");
                
                // Send Telegram completion notification to YOU
                await sendTelegramCompletion(orderId);
                break;
            }
        } catch (error) {
            console.error(`[${new Date().toLocaleString()}] ❌ Completion check error for ${orderId}: ${error.message}`);
        }
    }
}

// ============ PROCESS NEW SELL ORDER ============
async function processNewOrder(order) {
    const orderId = order.id;
    const buyerName = order.targetNickName;
    const amount = order.amount;
    
    if (activeOrders.has(orderId)) {
        return;
    }
    
    console.log(`[${new Date().toLocaleString()}] 📦 New sell order: ${orderId} | Buyer: ${buyerName} | Amount: ${amount} USDT`);
    
    // Send initial message (NO payment details, just "I'm online")
    await sendChatMessage(orderId, "Hi, I'm online. Please make payment and click MARK AS PAID so I can release the coins.");
    
    // Start payment reminders (every 5 minutes until paid)
    await startPaymentReminders(orderId, buyerName, amount);
    
    // Start monitoring for mark as paid
    monitorForMarkAsPaid(orderId, buyerName, amount);
}

// ============ RESUME EXISTING ORDERS ON STARTUP ============
async function resumeExistingOrders() {
        // Add 5 second delay before first API call
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    console.log(`[${new Date().toLocaleString()}] 🔍 Checking for existing active orders...`);
    
    const response = await withRetry(async () => {
        return await client.getPendingOrders({ page: 1, size: 50 });
    });
    const allOrders = response.result?.items || [];
    
    // Status 10 orders - need payment reminders
    const unpaidOrders = allOrders.filter(order => order.side === 1 && order.status === 10);
    // Status 20 orders - already marked as paid, waiting for you to release
    const paidOrders = allOrders.filter(order => order.side === 1 && order.status === 20);
    
    for (const order of unpaidOrders) {
        if (!activeOrders.has(order.id)) {
            console.log(`[${new Date().toLocaleString()}] 🔄 Resuming reminders for unpaid order ${order.id}`);
            await startPaymentReminders(order.id, order.targetNickName, order.amount);
            monitorForMarkAsPaid(order.id, order.targetNickName, order.amount);
        }
    }
    
    for (const order of paidOrders) {
        console.log(`[${new Date().toLocaleString()}] 📌 Order ${order.id} is already marked as paid - awaiting your manual release`);
        await sendTelegramPaymentClaim(order.id, order.targetNickName, order.amount);
        // Start monitoring for completion (when you release coins)
        monitorForCompletion(order.id, order.targetNickName, order.amount);
    }
}

// ============ MAIN CHECK LOOP ============
async function checkSellOrders() {
    try {
        const orders = await getActiveSellOrders();
        for (const order of orders) {
            if (!activeOrders.has(order.id)) {
                await processNewOrder(order);
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
        await telegramBot.telegram.sendMessage(TELEGRAM_CHAT_ID, '🤖 *P2P SELL Bot is Online!*\n\n✅ Payment reminders every 5 minutes: "Kindly make payment fast"\n✅ Alerts you when buyer marks as paid\n✅ YOU verify payment and release coins manually\n✅ Completion message deletes after 2 minutes', {
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
    ║     Bybit P2P SELL Bot - COMPLETE FIXED         ║
    ║     NO buy bot reminders, NO spam after paid    ║
    ╚══════════════════════════════════════════════════╝
    `);
    console.log('============================================================');
    console.log('🤖 BYBIT P2P SELL BOT');
    console.log('============================================================');
    console.log(`📱 Telegram: Connected`);
    console.log(`📊 Status 10: New orders → Payment reminders every 5 minutes`);
    console.log(`📊 Status 20: Buyer marks as paid → Alert YOU, NO reminders to buyer`);
    console.log(`👆 YOU: Verify payment manually, then release coins on Bybit app`);
    console.log(`🗑️ Completion message auto-deletes after 2 minutes`);
    console.log('------------------------------------------------------------');
    
    await sendStartupMessage();
    
    // telegramBot.launch().catch(err => console.error('Telegram launch error:', err));
    
    // Resume monitoring existing orders
    await resumeExistingOrders();
    
    // Main loop
    while (true) {
        await checkSellOrders();
        await new Promise(resolve => setTimeout(resolve, 5000));
    }
}

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

main().catch(console.error);
