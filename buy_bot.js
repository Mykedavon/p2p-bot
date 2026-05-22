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

// Per-order rate limit tracking (each order has its own timer)
const lastReminderTimeMap = new Map();
const MIN_REMINDER_INTERVAL = 5000;

// Track reminder state for each order (new reminder logic)
const reminderStateMap = new Map(); // orderId -> { reminderCount, reminderPhase, lastReminderTime, markAsPaidTime }

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
        
        if (!selectedMethod) {
            console.log(`[DEBUG] Available payment methods in termList:`);
            for (const method of paymentTermList) {
                console.log(`[DEBUG]   - paymentType: ${method.paymentType}, bankName: ${method.bankName || 'N/A'}`);
            }
            
            selectedMethod = paymentTermList.find(method => method.paymentType === 1);
            if (selectedMethod) {
                console.log(`[DEBUG] Selected Bank Transfer method (paymentType: 1)`);
            }
        }
        
        if (!selectedMethod) {
            selectedMethod = paymentTermList.find(method => method.paymentType === 520 || method.paymentType === 14);
            if (selectedMethod) {
                console.log(`[DEBUG] Selected OPay method (paymentType: ${selectedMethod.paymentType})`);
            }
        }
        
        if (!selectedMethod) {
            selectedMethod = paymentTermList.find(method => method.paymentType === 470 || method.paymentType === 1003);
            if (selectedMethod) {
                console.log(`[DEBUG] Selected PalmPay method (paymentType: ${selectedMethod.paymentType})`);
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
        
        console.log(`[DEBUG] FINAL SELECTED - paymentType: ${selectedMethod.paymentType}, bankName: ${selectedMethod.bankName || 'N/A'}`);
        
        return {
            bankName: selectedMethod.bankName || "N/A",
            accountNumber: selectedMethod.accountNo || "N/A",
            accountName: selectedMethod.realName || "N/A",
            paymentId: selectedMethod.id,
            paymentType: selectedMethod.paymentType
        };
        
    }, 5, 3000);
}

// ============ TELEGRAM FUNCTIONS ============
async function sendTelegramPaymentInfo(orderId, amount, sellerBank, paymentType) {
    const paymentMethodName = getPaymentMethodName(paymentType);
    const paymentLabel = getPaymentLabel(paymentType);
    
    let message = `*💰 NEW ORDER - SEND PAYMENT TO SELLER*

*Order ID:* \`${orderId}\`
*Amount:* ${amount} USDT

*📌 Payment Method:* ${paymentMethodName}`;

    // Show bank name if available
    if (sellerBank.bankName && sellerBank.bankName !== 'N/A' && sellerBank.bankName !== '') {
        message += `\n*🏦 Bank Name:* ${sellerBank.bankName}`;
    }

    // Show account number if available, otherwise indicate it's missing
    if (sellerBank.accountNumber && sellerBank.accountNumber !== 'N/A' && sellerBank.accountNumber !== '') {
        message += `\n*🔢 ${paymentLabel} Number:* \`${sellerBank.accountNumber}\``;
    } else {
        message += `\n*🔢 ${paymentLabel} Number:* \`Not available via API - please check Bybit app\``;
    }

    // Show account name if available
    if (sellerBank.accountName && sellerBank.accountName !== 'N/A' && sellerBank.accountName !== '') {
        message += `\n*👤 Account Name:* ${sellerBank.accountName}`;
    }

    message += `\n\n⚠️ Send payment to the ${paymentLabel} account above.`;

    // Copy button - only add if account number exists
    let copyButton = {};
    if (sellerBank.accountNumber && sellerBank.accountNumber !== 'N/A' && sellerBank.accountNumber !== '') {
        copyButton = {
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: `📋 Copy ${paymentLabel} Number`,
                            copy_text: { text: sellerBank.accountNumber }
                        }
                    ]
                ]
            }
        };
    }

    const sentMessage = await telegramBot.telegram.sendMessage(TELEGRAM_CHAT_ID, message, {
        parse_mode: 'Markdown',
        ...copyButton
    });
    
    console.log(`[${new Date().toLocaleString()}] 📱 Payment details sent for order ${orderId}`);
    
    setTimeout(async () => {
        try {
            await telegramBot.telegram.deleteMessage(TELEGRAM_CHAT_ID, sentMessage.message_id);
            console.log(`[${new Date().toLocaleString()}] 🗑️ Auto-deleted payment message for order ${orderId}`);
        } catch (deleteError) {
            console.error(`[${new Date().toLocaleString()}] ❌ Failed to delete payment message: ${deleteError.message}`);
        }
    }, 10 * 60 * 1000);
}
    const sentMessage = await telegramBot.telegram.sendMessage(TELEGRAM_CHAT_ID, message, {
        parse_mode: 'Markdown',
        ...copyButton
    });
    
    console.log(`[${new Date().toLocaleString()}] 📱 Payment details sent for order ${orderId}`);
    
    setTimeout(async () => {
        try {
            await telegramBot.telegram.deleteMessage(TELEGRAM_CHAT_ID, sentMessage.message_id);
            console.log(`[${new Date().toLocaleString()}] 🗑️ Auto-deleted payment message for order ${orderId}`);
        } catch (deleteError) {
            console.error(`[${new Date().toLocaleString()}] ❌ Failed to delete payment message: ${deleteError.message}`);
        }
    }, 10 * 60 * 1000);
}
    const sentMessage = await telegramBot.telegram.sendMessage(TELEGRAM_CHAT_ID, message, {
        parse_mode: 'Markdown',
        ...copyButton
    });
    
    console.log(`[${new Date().toLocaleString()}] 📱 Payment details sent for order ${orderId}`);
    
    setTimeout(async () => {
        try {
            await telegramBot.telegram.deleteMessage(TELEGRAM_CHAT_ID, sentMessage.message_id);
            console.log(`[${new Date().toLocaleString()}] 🗑️ Auto-deleted payment message for order ${orderId}`);
        } catch (deleteError) {
            console.error(`[${new Date().toLocaleString()}] ❌ Failed to delete payment message: ${deleteError.message}`);
        }
    }, 10 * 60 * 1000);
}
    const sentMessage = await telegramBot.telegram.sendMessage(TELEGRAM_CHAT_ID, message, {
        parse_mode: 'Markdown',
        ...copyButton
    });
    
    console.log(`[${new Date().toLocaleString()}] 📱 Payment details sent for order ${orderId}`);
    
    setTimeout(async () => {
        try {
            await telegramBot.telegram.deleteMessage(TELEGRAM_CHAT_ID, sentMessage.message_id);
            console.log(`[${new Date().toLocaleString()}] 🗑️ Auto-deleted payment message for order ${orderId}`);
        } catch (deleteError) {
            console.error(`[${new Date().toLocaleString()}] ❌ Failed to delete payment message: ${deleteError.message}`);
        }
    }, 10 * 60 * 1000);
}

async function sendFallbackMessage(orderId, amount, sellerName) {
    const message = `
*💰 ORDER MARKED AS PAID*

*Order ID:* \`${orderId}\`
*Amount:* ${amount} USDT
*Seller:* ${sellerName}

*⚠️ Payment Details Not Available via API*

Please check the Bybit app for the seller's payment information.

P2P → Orders → Pending → Order ID: ${orderId}

*Status:* ✅ Marked as Paid - Waiting for seller to release
`;
    
    const sentMessage = await telegramBot.telegram.sendMessage(TELEGRAM_CHAT_ID, message, {
        parse_mode: 'Markdown'
    });
    
    console.log(`[${new Date().toLocaleString()}] 📱 Fallback message sent for order ${orderId}`);
    
    setTimeout(async () => {
        try {
            await telegramBot.telegram.deleteMessage(TELEGRAM_CHAT_ID, sentMessage.message_id);
            console.log(`[${new Date().toLocaleString()}] 🗑️ Auto-deleted fallback message for order ${orderId}`);
        } catch (deleteError) {
            console.error(`[${new Date().toLocaleString()}] ❌ Failed to delete fallback message: ${deleteError.message}`);
        }
    }, 10 * 60 * 1000);
}

async function sendTelegramCompletion(orderId) {
    const message = `
*✅ ORDER COMPLETED*

Order ID: \`${orderId}\`
Status: Seller has released the coins!

The transaction is complete. Check your wallet.
`;
    
    const sentMessage = await telegramBot.telegram.sendMessage(TELEGRAM_CHAT_ID, message, {
        parse_mode: 'Markdown'
    });
    
    console.log(`[${new Date().toLocaleString()}] 📱 Completion message sent for order ${orderId}`);
    
    setTimeout(async () => {
        try {
            await telegramBot.telegram.deleteMessage(TELEGRAM_CHAT_ID, sentMessage.message_id);
            console.log(`[${new Date().toLocaleString()}] 🗑️ Auto-deleted completion message for order ${orderId}`);
        } catch (deleteError) {
            console.error(`[${new Date().toLocaleString()}] ❌ Failed to delete completion message: ${deleteError.message}`);
        }
    }, 10 * 60 * 1000);
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
        const activeBuyOrders = allOrders.filter(order => 
            order.side === 0 && order.status === 10
        );
        
        if (activeBuyOrders.length > 0) {
            console.log(`[${new Date().toLocaleString()}] 📊 Found ${activeBuyOrders.length} pending order(s) needing payment (status 10)`);
        }
        
        return activeBuyOrders;
    } catch (error) {
        if (error.message.includes('40001')) {
            return [];
        }
        console.error(`[${new Date().toLocaleString()}] ⚠️ API error: ${error.message}`);
        return [];
    }
}

async function getAllActiveOrders() {
    try {
        const response = await withRetry(async () => {
            return await client.getPendingOrders({ 
                page: 1, 
                size: 30,
                status: 20
            });
        });
        
        const allOrders = response.result?.items || [];
        
        console.log(`[DEBUG] Pending orders with status 20: ${allOrders.length}`);
        
        const pendingResponse = await withRetry(async () => {
            return await client.getPendingOrders({ 
                page: 1, 
                size: 30,
                status: 10
            });
        });
        
        const pendingOrders = pendingResponse.result?.items || [];
        console.log(`[DEBUG] Pending orders with status 10: ${pendingOrders.length}`);
        
        const allActiveOrders = [...allOrders, ...pendingOrders];
        
        return allActiveOrders;
    } catch (error) {
        if (error.message.includes('40001')) {
            return [];
        }
        console.error(`[${new Date().toLocaleString()}] ⚠️ API error: ${error.message}`);
        return [];
    }
}

// ============ ORDER MONITORING (UPDATED REMINDER LOGIC) ============
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
                    
                    const reminderMsg = `Reminder #1: Payment has been confirmed. Please release the coins. Thank you!`;
                    await sendChatMessage(orderId, reminderMsg);
                    console.log(`[${new Date().toLocaleString()}] 💬 First reminder sent for order ${orderId} (after 5 min wait)`);
                }
                else if (state.reminderPhase === 'active' && state.reminderCount < 5) {
                    const timeSinceLastReminder = now - state.lastReminderTime;
                    
                    if (timeSinceLastReminder >= oneMinuteInMs) {
                        state.reminderCount++;
                        state.lastReminderTime = now;
                        
                        const reminderMsg = `Reminder #${state.reminderCount}: Payment has been confirmed. Please release the coins. Thank you!`;
                        await sendChatMessage(orderId, reminderMsg);
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

// ============ RESUME MONITORING FOR ACTIVE ORDERS ============
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
        
        if (monitoringTasks.has(orderId)) {
            console.log(`[${new Date().toLocaleString()}] ⏭️ Order ${orderId} already being monitored`);
            continue;
        }
        
        if (order.status === 20) {
            console.log(`[${new Date().toLocaleString()}] 🔄 Resuming monitoring for order ${orderId} (status 20 - awaiting release)`);
            console.log(`[${new Date().toLocaleString()}] 👤 Seller: ${order.targetNickName}, Amount: ${order.amount} USDT`);
            
            const monitorTask = monitorOrderUntilRelease(orderId, order.amount);
            monitoringTasks.set(orderId, monitorTask);
            processedOrders.add(orderId);
        } 
        else if (order.status === 10) {
            console.log(`[${new Date().toLocaleString()}] 🔄 Order ${orderId} has status 10 - processing as new order`);
            
            if (!processedOrders.has(orderId)) {
                await processNewOrder(order);
            }
        }
        else if (order.status === 30) {
            console.log(`[${new Date().toLocaleString()}] ⚠️ Order ${orderId} is in appeal (status 30) - manual intervention needed`);
        }
    }
}

// ============ PROCESS NEW ORDER ============
// ============ PROCESS NEW ORDER ============
async function processNewOrder(order) {
    const orderId = order.id;
    
    if (processedOrders.has(orderId) || monitoringTasks.has(orderId)) {
        return;
    }
    
    processedOrders.add(orderId);
    
    console.log(`[${new Date().toLocaleString()}] 📦 New order: ${orderId} | Seller: ${order.targetNickName} | Amount: ${order.amount} USDT`);
    
    await new Promise(resolve => setTimeout(resolve, 5000));
    await sendChatMessage(orderId, "Hope you've read my terms before placing trade. Please reply 'agree' to confirm. Thanks 🙏.");
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    const success = await markAsPaid(orderId);
    
    if (success) {
        const sellerBank = await getSellersSelectedPaymentMethod(orderId);
        
        // Check if we have ANY payment information (bank name OR account number OR account name)
        const hasBankName = sellerBank && sellerBank.bankName && sellerBank.bankName !== 'N/A';
        const hasAccountNumber = sellerBank && sellerBank.accountNumber && sellerBank.accountNumber !== 'N/A';
        const hasAccountName = sellerBank && sellerBank.accountName && sellerBank.accountName !== 'N/A';
        
        if (sellerBank && (hasBankName || hasAccountNumber || hasAccountName)) {
            await sendTelegramPaymentInfo(orderId, order.amount, sellerBank, sellerBank.paymentType);
            console.log(`[${new Date().toLocaleString()}] 📱 Payment details sent to Telegram for order ${orderId}`);
        } else {
            await sendFallbackMessage(orderId, order.amount, order.targetNickName);
            console.log(`[${new Date().toLocaleString()}] 📱 Fallback message sent for order ${orderId} (no payment details)`);
        }
        
        const monitorTask = monitorOrderUntilRelease(orderId, order.amount);
        monitoringTasks.set(orderId, monitorTask);
    } else {
        console.log(`[${new Date().toLocaleString()}] ❌ Failed to mark order ${orderId} as paid`);
        processedOrders.delete(orderId);
    }
}
// ============ MAIN CHECK LOOP ============
async function checkPendingOrders() {
    try {
        const orders = await getActiveBuyOrders();
        
        for (const order of orders) {
            const orderId = order.id;
            if (!processedOrders.has(orderId) && !monitoringTasks.has(orderId)) {
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
        await telegramBot.telegram.sendMessage(TELEGRAM_CHAT_ID, '🤖 *P2P Bot is Online!*\n\n✅ Monitoring for new BUY orders\n✅ Resume monitoring for existing active orders\n✅ Copy buttons fixed\n✅ Per-order rate limiting enabled', {
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
    ║     Bybit P2P Bot - COMPLETE FINAL VERSION       ║
    ║     Buy Order Automation with Telegram           ║
    ╚══════════════════════════════════════════════════╝
    `);
    console.log('============================================================');
    console.log('🤖 BYBIT P2P AUTO TRADING BOT');
    console.log('============================================================');
    console.log(`📱 Telegram: Connected`);
    console.log(`⏰ Timings: Wait 5s → Chat → Wait 10s → Mark as paid → Monitor every 20s`);
    console.log(`📊 Status 10: New orders (needs payment)`);
    console.log(`📊 Status 20: Already paid (waiting for release)`);
    console.log(`🔘 Copy buttons: FIXED`);
    console.log(`🔄 Per-order rate limiting: ENABLED`);
    console.log('------------------------------------------------------------');
    
    await sendStartupMessage();
    
    telegramBot.launch().catch(err => console.error('Telegram launch error:', err));
    await resumeMonitoringForActiveOrders();
    
    while (true) {
        await checkPendingOrders();
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
