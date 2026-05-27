const { P2P } = require('bybit-p2p-sdk');
const { Telegraf } = require('telegraf');
require('dotenv').config();

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
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

// Track processed orders
const processedOrders = new Set();
const monitoringTasks = new Map();
const failedOrders = new Set();

// Per-order rate limit tracking
const lastReminderTimeMap = new Map();
const MIN_REMINDER_INTERVAL = 5000;

// Track reminder state for each order
const reminderStateMap = new Map();

// ============ ESCAPE MARKDOWN FUNCTION ============
function escapeMarkdown(text) {
    if (!text) return '';
    return String(text)
        .replace(/_/g, '\\_')
        .replace(/\*/g, '\\*')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)')
        .replace(/~/g, '\\~')
        .replace(/`/g, '\\`')
        .replace(/>/g, '\\>')
        .replace(/#/g, '\\#')
        .replace(/\+/g, '\\+')
        .replace(/-/g, '\\-')
        .replace(/=/g, '\\=')
        .replace(/\|/g, '\\|')
        .replace(/\{/g, '\\{')
        .replace(/\}/g, '\\}')
        .replace(/\./g, '\\.')
        .replace(/\!/g, '\\!');
}

// ============ GET SELLER INFO (RATING & RELEASE TIME) ============
async function getSellerInfo(orderId, sellerUid) {
    try {
        if (!sellerUid || sellerUid === "0" || sellerUid === process.env.API_UID) {
            console.log(`[DEBUG] Invalid sellerUid provided: ${sellerUid}`);
            return { avgReleaseTime: 0, rating: 'N/A' };
        }

        const response = await client.getCounterpartyInfo({
            originalUid: String(sellerUid),
            orderId: orderId
        });
        
        const result = response.result || {};
        const avgReleaseTime = parseInt(result.averageReleaseTime || result.avgReleaseTime) || 0;
        
        let rating = 'N/A';
        if (result.favourableRate && result.favourableRate !== '0') {
            rating = `${result.favourableRate}%`;
        } else if (result.goodAppraiseRate && result.goodAppraiseRate !== '0') {
            rating = `${result.goodAppraiseRate}%`;
        } else if (result.recentRate) {
            rating = `${result.recentRate}%`;
        }
        
        console.log(`[DEBUG] Target Seller (${sellerUid}) - Release Time: ${avgReleaseTime} mins, Rating: ${rating}`);
        return { avgReleaseTime, rating };
    } catch (error) {
        console.log(`[DEBUG] Could not fetch seller info: ${error.message}`);
        return { avgReleaseTime: 0, rating: 'N/A' };
    }
}

// ============ HELPER FUNCTIONS ============
function getPaymentMethodName(paymentType) {
    const paymentTypes = {
        '1': '🏦 Bank Transfer',
        '2': '📱 Digital Wallet',
        '14': '🏦 Bank Transfer',
        '470': '📱 PalmPay',
        '520': '📱 OPay',
        '1001': '📱 Kuda Bank',
        '1002': '📱 Moniepoint',
        '1003': '📱 PalmPay',
        '1004': '💰 Access Bank'
    };
    return paymentTypes[String(paymentType)] || `💰 Payment Method (Type: ${paymentType})`;
}

function getPaymentLabel(paymentType) {
    const labels = {
        '1': 'Bank',
        '2': 'Wallet',
        '14': 'Bank',
        '470': 'PalmPay',
        '520': 'OPay',
        '1001': 'Kuda',
        '1002': 'Moniepoint',
        '1003': 'PalmPay',
        '1004': 'Access Bank'
    };
    return labels[String(paymentType)] || 'Account';
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

// ============ GET SELLER'S SELECTED PAYMENT METHOD ============
async function getSellersSelectedPaymentMethod(orderId) {
    return withRetry(async () => {
        const orderDetails = await client.getOrderDetails({ orderId: orderId });
        const orderResult = orderDetails.result;

        console.log(`[DEBUG] Order ${orderId} - paymentTermList length:`, orderResult.paymentTermList?.length || 0);
        
        const paymentTermList = orderResult.paymentTermList || [];
        
        if (paymentTermList.length === 0) {
            console.log(`[DEBUG] No paymentTermList found for order ${orderId}`);
            return null;
        }
        
        let selectedMethod = null;
        const confirmedPayment = orderResult.confirmedPayTerm;
        
        if (confirmedPayment && confirmedPayment.id) {
            selectedMethod = paymentTermList.find(method => method.id === confirmedPayment.id);
            if (selectedMethod) {
                console.log(`[DEBUG] Found payment method via confirmedPayTerm - paymentType: ${selectedMethod.paymentType}`);
            }
        }
        
        if (!selectedMethod && paymentTermList.length > 0) {
            selectedMethod = paymentTermList[0];
            console.log(`[DEBUG] Using first available payment method (paymentType: ${selectedMethod.paymentType})`);
        }
        
        if (!selectedMethod) {
            console.log(`[DEBUG] No payment method found`);
            return null;
        }
        
        // Extract account number from multiple possible locations
        let extractedAccountNo = selectedMethod.accountNo || 
                                 selectedMethod.cardNo || 
                                 selectedMethod.bankCardNo || 
                                 "";
        
        if (!extractedAccountNo || String(extractedAccountNo).trim() === "") {
            extractedAccountNo = selectedMethod.paymentExt2 || 
                                 selectedMethod.paymentExt1 || 
                                 selectedMethod.paymentExt3 || 
                                 selectedMethod.mobile || 
                                 "";
        }
        
        if (!extractedAccountNo || String(extractedAccountNo).trim() === "") {
            extractedAccountNo = "N/A";
        } else {
            extractedAccountNo = String(extractedAccountNo).trim();
        }
        
        console.log(`[DEBUG] FINAL SELECTED - paymentType: ${selectedMethod.paymentType}, bankName: ${selectedMethod.bankName || 'N/A'}, account: ${extractedAccountNo}`);
        console.log(`[DEBUG] Account name: ${selectedMethod.realName || 'N/A'}`);
        
        return {
            bankName: selectedMethod.bankName || "N/A",
            accountNumber: extractedAccountNo,
            accountName: selectedMethod.realName || "N/A",
            paymentId: selectedMethod.id,
            paymentType: selectedMethod.paymentType
        };
    }, 5, 3000);
}

// ============ TELEGRAM FUNCTIONS ============
async function sendTelegramMessage(message) {
    try {
        const sentMessage = await telegramBot.telegram.sendMessage(TELEGRAM_CHAT_ID, message, {
            parse_mode: 'Markdown'
        });
        
        setTimeout(async () => {
            try {
                await telegramBot.telegram.deleteMessage(TELEGRAM_CHAT_ID, sentMessage.message_id);
                console.log(`[${new Date().toLocaleString()}] 🗑️ Auto-deleted telegram message`);
            } catch (deleteError) {
                console.error(`[${new Date().toLocaleString()}] ❌ Failed to delete message: ${deleteError.message}`);
            }
        }, 15 * 60 * 1000);
        
        return sentMessage;
    } catch (err) {
        console.error(`[ERROR] Telegram send failure: ${err.message}`);
    }
}

async function sendTelegramPaymentInfo(orderId, amount, sellerBank, paymentType, sellerName, sellerRating, avgReleaseTime) {
    const paymentMethodName = getPaymentMethodName(paymentType);
    const paymentLabel = getPaymentLabel(paymentType);
    
    const safeSellerName = escapeMarkdown(sellerName);
    const safeBankName = escapeMarkdown(sellerBank.bankName);
    const safeAccountName = escapeMarkdown(sellerBank.accountName);
    const safeAccountNo = escapeMarkdown(sellerBank.accountNumber);
    
    // ✅ FIXED: Use sellerRating directly (it already contains %)
    const ratingDisplay = (sellerRating && sellerRating !== 'N/A') ? sellerRating : 'N/A';
    
    let message = `*💰 NEW ORDER - SEND PAYMENT TO SELLER*\n\n` +
                  `*Order ID:* \`${orderId}\`\n` +
                  `*Amount:* \`${amount}\` USDT\n` +
                  `*Seller:* ${safeSellerName}\n` +
                  `*Rating:* ${ratingDisplay}\n` +
                  `*Avg Release Time:* ${avgReleaseTime} mins\n\n` +
                  `*📌 Payment Method:* ${paymentMethodName}\n` +
                  `*🏦 Bank:* ${safeBankName}\n` +
                  `*👤 Account Name:* \`${safeAccountName}\`\n` +
                  `*🔢 ${paymentLabel} Number:* \`${safeAccountNo}\`\n\n` +
                  `👉 Tap the number inside the backticks to copy.`;

    await sendTelegramMessage(message);
}

async function sendFallbackMessage(orderId, amount, sellerName) {
    const safeSellerName = escapeMarkdown(sellerName);
    const message = `
*⚠️ ORDER MARKED AS PAID - MANUAL ACTION REQUIRED*

*Order ID:* \`${orderId}\`
*Amount:* ${amount} USDT
*Seller:* ${safeSellerName}

*⚠️ Payment Details Not Available via API*

Please check the Bybit app for the seller's payment information.

P2P → Orders → Pending → Order ID: ${orderId}

*Status:* ✅ Marked as Paid - Waiting for seller to release
`;
    await sendTelegramMessage(message);
}

async function sendTelegramCompletion(orderId) {
    const safeOrderId = escapeMarkdown(orderId);
    const message = `
*✅ ORDER COMPLETED*

Order ID: \`${safeOrderId}\`
Status: Seller has released the coins!

The transaction is complete. Check your wallet.
`;
    await sendTelegramMessage(message);
}

// ============ TELEGRAM CALLBACK HANDLER ============
telegramBot.on('callback_query', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        console.log(`[${new Date().toLocaleString()}] 🔘 Copy button clicked`);
    } catch (error) {
        console.error(`[${new Date().toLocaleString()}] ❌ Callback error: ${error.message}`);
        try {
            await ctx.answerCbQuery('Error occurred');
        } catch (e) {}
    }
});

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

async function markAsPaid(orderId) {
    return withRetry(async () => {
        const orderDetails = await client.getOrderDetails({ orderId: orderId });
        const paymentTermList = orderDetails?.result?.paymentTermList;
        
        if (!paymentTermList || paymentTermList.length === 0) {
            throw new Error("No payment methods found for this order");
        }
        
        const sellerPaymentMethod = paymentTermList[0];
        const paymentId = String(sellerPaymentMethod.id);
        const paymentType = String(sellerPaymentMethod.paymentType);
        
        await client.markAsPaid({ 
            orderId: String(orderId),
            paymentId: paymentId,
            paymentType: paymentType
        });
        
        console.log(`[${new Date().toLocaleString()}] ✅ Order ${orderId} marked as paid`);
        return true;
    }).catch(error => {
        console.error(`[${new Date().toLocaleString()}] ❌ Failed to mark as paid: ${error.message}`);
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

async function getActiveBuyOrders() {
    try {
        const response = await withRetry(async () => {
            return await client.getPendingOrders({ page: 1, size: 30 });
        });
        const allOrders = response.result?.items || [];
        const activeBuyOrders = allOrders.filter(order => order.side === 0 && order.status === 10);
        
        if (activeBuyOrders.length > 0) {
            console.log(`[${new Date().toLocaleString()}] 📊 Found ${activeBuyOrders.length} pending order(s) needing payment (status 10)`);
        }
        return activeBuyOrders;
    } catch (error) {
        if (error.message.includes('40001')) return [];
        console.error(`[${new Date().toLocaleString()}] ⚠️ API error: ${error.message}`);
        return [];
    }
}

async function getAllActiveOrders() {
    try {
        const response = await withRetry(async () => {
            return await client.getPendingOrders({ page: 1, size: 30, status: 20 });
        });
        const allOrders = response.result?.items || [];
        console.log(`[DEBUG] Pending orders with status 20: ${allOrders.length}`);
        
        const pendingResponse = await withRetry(async () => {
            return await client.getPendingOrders({ page: 1, size: 30, status: 10 });
        });
        const pendingOrders = pendingResponse.result?.items || [];
        console.log(`[DEBUG] Pending orders with status 10: ${pendingOrders.length}`);
        
        return [...allOrders, ...pendingOrders];
    } catch (error) {
        if (error.message.includes('40001')) return [];
        console.error(`[${new Date().toLocaleString()}] ⚠️ API error: ${error.message}`);
        return [];
    }
}

// ============ ORDER MONITORING ============
async function monitorOrderUntilRelease(orderId, amount) {
    reminderStateMap.set(orderId, {
        reminderCount: 0,
        reminderPhase: 'waiting',
        lastReminderTime: 0,
        markAsPaidTime: Date.now()
    });
    
    console.log(`[${new Date().toLocaleString()}] 🔍 Monitoring order ${orderId} (checking every 10s)`);
    
    while (true) {
        await new Promise(resolve => setTimeout(resolve, 10000));
        try {
            const currentOrder = await getOrderDetails(orderId);
            const status = currentOrder.status || currentOrder.orderStatus;
            const state = reminderStateMap.get(orderId);
            
            if (status === 50 || status === 'Completed' || status === 'Finished' || status === 'Released') {
                console.log(`[${new Date().toLocaleString()}] 🎉 Order ${orderId} completed! Coins released.`);
                await sendChatMessage(orderId, "✅ Coins released!\n\n⭐ Please leave a good review! Your rating helps me serve you better.");
                await sendTelegramCompletion(orderId);
                monitoringTasks.delete(orderId);
                processedOrders.delete(orderId);
                reminderStateMap.delete(orderId);
                break;
            } 
            else if (status === 20 || status === 'Paid') {
                const now = Date.now();
                const timeSinceMarkAsPaid = now - state.markAsPaidTime;
                const fiveMinutesInMs = 5 * 60 * 1000;
                const oneMinuteInMs = 1 * 60 * 1000;
                
                if (state.reminderPhase === 'waiting' && timeSinceMarkAsPaid >= fiveMinutesInMs) {
                    state.reminderPhase = 'active';
                    state.reminderCount = 1;
                    state.lastReminderTime = now;
                    await sendChatMessage(orderId, `Reminder #1: Payment has been confirmed. Please release the coins. Thank you!`);
                    console.log(`[${new Date().toLocaleString()}] 💬 First reminder sent for order ${orderId} (after 5 min wait)`);
                }
                else if (state.reminderPhase === 'active' && state.reminderCount < 5) {
                    const timeSinceLastReminder = now - state.lastReminderTime;
                    if (timeSinceLastReminder >= oneMinuteInMs) {
                        state.reminderCount++;
                        state.lastReminderTime = now;
                        await sendChatMessage(orderId, `Reminder #${state.reminderCount}: Payment has been confirmed. Please release the coins. Thank you!`);
                        console.log(`[${new Date().toLocaleString()}] 💬 Reminder #${state.reminderCount} sent for order ${orderId}`);
                    }
                }
                else if (state.reminderPhase === 'active' && state.reminderCount >= 5) {
                    state.reminderPhase = 'completed';
                    console.log(`[${new Date().toLocaleString()}] 🛑 No more reminders for order ${orderId} (5 reminders sent)`);
                }
            }
        } catch (error) {
            console.error(`[${new Date().toLocaleString()}] ❌ Monitoring error for ${orderId}: ${error.message}`);
        }
    }
}

// ============ RESUME MONITORING ============
async function resumeMonitoringForActiveOrders() {
    console.log(`[${new Date().toLocaleString()}] 🔍 Checking for existing active orders...`);
    const activeOrders = await getAllActiveOrders();
    
    if (activeOrders.length === 0) {
        console.log(`[${new Date().toLocaleString()}] 📭 No active orders found`);
        return;
    }
    
    console.log(`[${new Date().toLocaleString()}] 📊 Found ${activeOrders.length} active order(s) needing attention`);
    
    for (const order of activeOrders) {
        const orderId = order.id;
        if (monitoringTasks.has(orderId)) continue;
        
        if (order.status === 20) {
            console.log(`[${new Date().toLocaleString()}] 🔄 Resuming monitoring for order ${orderId} (status 20 - awaiting release)`);
            monitorOrderUntilRelease(orderId, order.amount);
            processedOrders.add(orderId);
        } 
        else if (order.status === 10 && !processedOrders.has(orderId) && !failedOrders.has(orderId)) {
            console.log(`[${new Date().toLocaleString()}] 🔄 Order ${orderId} has status 10 - processing as new order`);
            await processNewOrder(order);
        }
    }
}

// ============ PROCESS NEW ORDER ============
async function processNewOrder(order) {
    const orderId = order.id;
    
    // ✅ CRITICAL: For BUY orders, the seller's UID is targetUserId, NOT userId
    // userId = YOU (the buyer)
    // targetUserId = THE SELLER
    const sellerUid = order.targetUserId || order.makerUserId;
    const sellerName = order.targetNickName;
    const amount = order.amount;
    
    // Prevent duplicate processing
    if (failedOrders.has(orderId) || processedOrders.has(orderId) || monitoringTasks.has(orderId)) {
        console.log(`[${new Date().toLocaleString()}] ⏭️ Order ${orderId} already being processed, skipping`);
        return;
    }
    processedOrders.add(orderId);
    
    console.log(`[${new Date().toLocaleString()}] 📦 New order: ${orderId} | Seller: ${sellerName} | Amount: ${amount} USDT`);
    console.log(`[DEBUG] Seller UID for info lookup: ${sellerUid}`);
    console.log(`[DEBUG] Your UID (buyer) is: ${order.userId}`);
    
    // Get seller's rating and release time (using the CORRECT seller UID)
    const { avgReleaseTime, sellerRating } = await getSellerInfo(orderId, sellerUid);
    
    await new Promise(resolve => setTimeout(resolve, 5000));
    await sendChatMessage(orderId, "Hope you've read my terms before placing trade. Please reply 'agree' to confirm. Thanks 🙏.");
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    // Check if already marked as paid before calling markAsPaid
    const currentOrder = await getOrderDetails(orderId);
    if (currentOrder.status === 20 || currentOrder.status === 'Paid') {
        console.log(`[${new Date().toLocaleString()}] Order ${orderId} already marked as paid. Skipping markAsPaid.`);
    } else {
        const success = await markAsPaid(orderId);
        if (!success) {
            console.log(`[${new Date().toLocaleString()}] ❌ Failed to mark order ${orderId} as paid`);
            processedOrders.delete(orderId);
            failedOrders.add(orderId);
            return;
        }
    }
    
    const sellerBank = await getSellersSelectedPaymentMethod(orderId);
    const hasPaymentInfo = sellerBank && (
        (sellerBank.bankName && sellerBank.bankName !== 'N/A') ||
        (sellerBank.accountNumber && sellerBank.accountNumber !== 'N/A') ||
        (sellerBank.accountName && sellerBank.accountName !== 'N/A')
    );
    
    if (hasPaymentInfo && sellerBank.accountNumber !== 'N/A') {
        await sendTelegramPaymentInfo(orderId, amount, sellerBank, sellerBank.paymentType, sellerName, sellerRating, avgReleaseTime);
        console.log(`[${new Date().toLocaleString()}] 📱 Payment details sent to Telegram for order ${orderId}`);
    } else {
        await sendFallbackMessage(orderId, amount, sellerName);
        console.log(`[${new Date().toLocaleString()}] 📱 Fallback message sent for order ${orderId} (no payment details)`);
        failedOrders.add(orderId);
        return;
    }
    
    monitorOrderUntilRelease(orderId, amount);
}

// ============ MAIN CHECK LOOP ============
async function checkPendingOrders() {
    try {
        const orders = await getActiveBuyOrders();
        for (const order of orders) {
            const orderId = order.id;
            // ✅ Skip if already being processed or failed
            if (processedOrders.has(orderId) || monitoringTasks.has(orderId) || failedOrders.has(orderId)) {
                console.log(`[${new Date().toLocaleString()}] ⏭️ Skipping already processed order ${orderId}`);
                continue;
            }
            await processNewOrder(order);
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
        await telegramBot.telegram.sendMessage(TELEGRAM_CHAT_ID, '🤖 *P2P Bot is Online!*\n\n✅ Shows seller rating & release time\n✅ Auto-deletes messages after 15 mins\n✅ Copy button for account numbers', { parse_mode: 'Markdown' });
        console.log('📱 Telegram connected');
    } catch (error) {
        console.error('⚠️ Telegram connection failed:', error.message);
    }
}

// ============ GRACEFUL SHUTDOWN (NO CRASH) ============
let isShuttingDown = false;

async function handleShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`);
    
    // Clear all tracking collections
    monitoringTasks.clear();
    processedOrders.clear();
    failedOrders.clear();
    reminderStateMap.clear();
    lastReminderTimeMap.clear();
    
    console.log('✅ Shutdown complete. Exiting.');
    process.exit(0);
}

process.once('SIGINT', () => handleShutdown('SIGINT'));
process.once('SIGTERM', () => handleShutdown('SIGTERM'));

// ============ MAIN ============
async function main() {
    console.log(`\n    ╔══════════════════════════════════════════════════╗
    ║     Bybit P2P Bot - BUY BOT (FULLY CORRECTED)     ║
    ║     Correctly fetches SELLER's rating & release   ║
    ╚══════════════════════════════════════════════════╝\n`);
    console.log('============================================================');
    console.log('🤖 BYBIT P2P AUTO TRADING BOT');
    console.log('============================================================');
    console.log(`📱 Telegram: Connected`);
    console.log(`⏰ Timings: Wait 5s → Chat → Wait 10s → Mark as paid → Monitor every 10s`);
    console.log(`📊 Status 10: New orders (needs payment)`);
    console.log(`📊 Status 20: Already paid (waiting for release)`);
    console.log(`⭐ Shows SELLER's rating & average release time`);
    console.log(`🗑️ All messages auto-delete after 15 minutes`);
    console.log(`🔢 Copy button for account numbers`);
    console.log(`🔧 Extracts from: accountNo, cardNo, paymentExt1-6, mobile`);
    console.log('------------------------------------------------------------');
    
    await sendStartupMessage();
    await resumeMonitoringForActiveOrders();
    
    while (true) {
        await checkPendingOrders();
        await new Promise(resolve => setTimeout(resolve, 5000));
    }
}

// No telegramBot.launch() needed - we're not using webhooks
// No telegramBot.stop() in shutdown - prevents crash

main().catch(console.error);
