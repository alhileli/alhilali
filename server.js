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
    if (!apiKey || !secretKey) {
        return res.status(500).json({ error: 'لم يتم إعداد مفاتيح API على الخادم بشكل صحيح.' });
    }

    const finalData = {};

    try {
        // --- 1. Fetch Account Assets (Balance) ---
        try {
            const accountAssetsResponse = await makeRequest('/api/v1/private/account/assets');
            if (!accountAssetsResponse.success || !accountAssetsResponse.data) throw new Error('فشل في جلب أصول المحفظة.');
            
            const assets = accountAssetsResponse.data;
            finalData.totalBalance = assets.reduce((sum, asset) => sum + parseFloat(asset.im || 0), 0);
            finalData.assetsValue = assets.filter(a => a.currency !== 'USDT').reduce((sum, asset) => sum + parseFloat(asset.im || 0), 0);
            finalData.assetsCount = assets.length;
        } catch (error) {
            console.error('Error fetching account assets:', error.message);
            finalData.totalBalance = 0;
            finalData.assetsValue = 0;
            finalData.assetsCount = 0;
        }

        // --- 2. Fetch Open Positions ---
        try {
            const openPositionsResponse = await makeRequest('/api/v1/private/position/open_positions');
            if (!openPositionsResponse.success) throw new Error(openPositionsResponse.message || 'فشل في جلب المراكز المفتوحة.');
            
            finalData.openPositions = (openPositionsResponse.data || []).map(pos => ({
                symbol: pos.symbol,
                positionType: pos.positionType === 1 ? 'Long' : 'Short',
                leverage: pos.leverage,
                openPrice: parseFloat(pos.holdAvgPrice || 0),
                currentPrice: parseFloat(pos.lastPrice || 0),
                unrealizedPNL: parseFloat(pos.unrealizedPL || 0),
                pnlPercentage: (parseFloat(pos.unrealizedPL || 0) / parseFloat(pos.im || 1)) * 100 // Avoid division by zero
            }));
        } catch (error) {
            console.error('Error fetching open positions:', error.message);
            finalData.openPositions = [];
        }

        // --- 3. Fetch and Analyze Trade History ---
        try {
            const historyDealsResponse = await makeRequest('/api/v1/private/order/list_history_orders', { page_size: 200 });
            if (!historyDealsResponse.success) throw new Error(historyDealsResponse.message || 'فشل في جلب سجل الصفقات.');
            
            const closedTrades = (historyDealsResponse.data?.resultList || [])
                .filter(order => order.state === 3 && order.profit !== undefined) // Ensure order is filled and has a profit field
                .map(order => ({
                    symbol: order.symbol,
                    pnl: parseFloat(order.profit),
                    date: new Date(order.updateTime).toLocaleDateString('ar-EG')
                }));
            
            closedTrades.sort((a, b) => b.pnl - a.pnl);
            
            finalData.bestTrades = closedTrades.slice(0, 3);
            finalData.worstTrades = closedTrades.filter(t => t.pnl < 0).slice(-3).reverse();
        } catch (error) {
            console.error('Error fetching trade history:', error.message);
            finalData.bestTrades = [];
            finalData.worstTrades = [];
        }

        // --- 4. Send the final compiled data ---
        res.json(finalData);

    } catch (error) {
        console.error('A critical error occurred in the main route:', error.message);
        res.status(500).json({ error: `خطأ حرج في الخادم: ${error.message}` });
    }
});


// --- Serve the HTML file for all other routes ---
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- Helper function for FUTURES API requests ---
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

    // Check if the response is valid JSON
    const contentType = response.headers.get("content-type");
    if (contentType && contentType.indexOf("application/json") !== -1) {
        return response.json();
    } else {
        const text = await response.text();
        throw new Error(`MEXC returned a non-JSON response: ${text}`);
    }
}

// --- Start the server ---
app.listen(port, () => {
    console.log(`Server listening at port ${port}`);
});

