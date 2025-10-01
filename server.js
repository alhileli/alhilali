// --- Dependencies ---
const express = require('express');
const fetch = require('node-fetch');
const CryptoJS = require('crypto-js');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

// --- Configuration ---
const app = express();
const port = process.env.PORT || 3000;
const API_BASE_URL = 'https://contract.mexc.com';

// --- API Keys ---
const apiKey = process.env.MEXC_API_KEY;
const secretKey = process.env.MEXC_SECRET_KEY;

// --- Middleware ---
app.use(cors());
app.use(express.static(__dirname));

// --- Main API Route ---
app.get('/api/portfolio-data', async (req, res) => {
    console.log("===================================");
    console.log("==> Received new request for portfolio data...");

    if (!apiKey || !secretKey) {
        console.error("FATAL ERROR: API keys are not configured on the server.");
        return res.status(500).json({ error: 'لم يتم إعداد مفاتيح API على الخادم بشكل صحيح.' });
    }

    let finalData = {
        totalBalance: 0,
        assetsValue: 0,
        assetsCount: 0,
        openPositions: [],
        bestTrades: [],
        worstTrades: []
    };

    try {
        // --- STEP 1: Fetch Account Assets ---
        console.log("[STEP 1/3] Attempting to fetch account assets...");
        const accountAssetsResponse = await makeRequest('/api/v1/private/account/assets');
        if (accountAssetsResponse.success && Array.isArray(accountAssetsResponse.data)) {
            const assets = accountAssetsResponse.data;
            const availableBalance = assets.reduce((sum, asset) => sum + parseFloat(asset.availableBalance || 0), 0);
            finalData.assetsCount = assets.length;
            finalData.totalBalance += availableBalance; // Start with available balance
            console.log(`[STEP 1/3] SUCCESS: Fetched ${assets.length} assets. Available balance: ${availableBalance}`);
        } else {
            console.warn("[STEP 1/3] WARNING: Could not fetch account assets or data is empty.", accountAssetsResponse);
        }

        // --- STEP 2: Fetch Open Positions ---
        console.log("[STEP 2/3] Attempting to fetch open positions...");
        const openPositionsResponse = await makeRequest('/api/v1/private/position/open_positions');
        if (openPositionsResponse.success && Array.isArray(openPositionsResponse.data)) {
            const positions = openPositionsResponse.data;
            const totalMarginInPositions = positions.reduce((sum, pos) => sum + parseFloat(pos.im || 0), 0);
            finalData.totalBalance += totalMarginInPositions; // Add margin to total balance
            finalData.assetsValue = totalMarginInPositions;
            finalData.openPositions = positions.map(pos => ({
                symbol: pos.symbol,
                positionType: pos.positionType === 1 ? 'Long' : 'Short',
                leverage: pos.leverage,
                openPrice: parseFloat(pos.holdAvgPrice || 0),
                currentPrice: parseFloat(pos.lastPrice || 0),
                unrealizedPNL: parseFloat(pos.unrealizedPL || 0),
                pnlPercentage: (parseFloat(pos.unrealizedPL || 0) / (parseFloat(pos.im) || 1)) * 100
            }));
            console.log(`[STEP 2/3] SUCCESS: Fetched ${positions.length} open positions. Total margin: ${totalMarginInPositions}`);
        } else {
            console.warn("[STEP 2/3] WARNING: Could not fetch open positions or data is empty.", openPositionsResponse);
        }

        // --- STEP 3: Fetch Trade History ---
        console.log("[STEP 3/3] Attempting to fetch trade history...");
        const historyDealsResponse = await makeRequest('/api/v1/private/order/list_history_orders', { page_size: 200 });
        if (historyDealsResponse.success && historyDealsResponse.data && Array.isArray(historyDealsResponse.data.resultList)) {
            const closedTrades = historyDealsResponse.data.resultList
                .filter(order => order.state === 3 && typeof order.profit !== 'undefined')
                .map(order => ({
                    symbol: order.symbol,
                    pnl: parseFloat(order.profit),
                    date: new Date(order.updateTime).toLocaleDateString('ar-EG')
                }));
            
            closedTrades.sort((a, b) => b.pnl - a.pnl);
            finalData.bestTrades = closedTrades.slice(0, 3);
            finalData.worstTrades = closedTrades.filter(t => t.pnl < 0).slice(-3).reverse();
            console.log(`[STEP 3/3] SUCCESS: Processed ${closedTrades.length} closed trades.`);
        } else {
            console.warn("[STEP 3/3] WARNING: Could not fetch trade history or data is empty.", historyDealsResponse);
        }

        console.log("==> All steps completed. Sending final data to frontend.");
        res.json(finalData);

    } catch (error) {
        console.error('!!!!!!!!!! A CRITICAL ERROR OCCURRED !!!!!!!!!!!');
        console.error('ERROR MESSAGE:', error.message);
        console.error('ERROR STACK:', error.stack);
        console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
        res.status(500).json({ error: `خطأ حرج في الخادم: ${error.message}` });
    }
});

// --- Serve the HTML file ---
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- API Request Helper ---
async function makeRequest(endpoint, params = {}) {
    const timestamp = Date.now();
    const queryString = new URLSearchParams(params).toString();
    const toSign = `${apiKey}${timestamp}${queryString}`;
    const signature = CryptoJS.HmacSHA256(toSign, secretKey).toString(CryptoJS.enc.Hex);
    const url = `${API_BASE_URL}${endpoint}?${queryString}`;
    
    const response = await fetch(url, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'ApiKey': apiKey,
            'Request-Time': timestamp,
            'Signature': signature
        }
    });

    const text = await response.text();
    if (!response.ok) {
        throw new Error(`MEXC request failed with status ${response.status}: ${text}`);
    }
    try {
        const jsonResponse = JSON.parse(text);
        if (jsonResponse.code !== 0) {
            throw new Error(`MEXC API Error (${jsonResponse.code}): ${jsonResponse.msg}`);
        }
        return jsonResponse;
    } catch (e) {
        throw new Error(`Failed to parse JSON from MEXC: ${text}`);
    }
}

// --- Start Server ---
app.listen(port, () => {
    console.log(`Server listening at port ${port}`);
});

