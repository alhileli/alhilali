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

    try {
        // Fetch both account assets and open positions concurrently for better performance
        const [accountAssetsResponse, openPositionsResponse, historyDealsResponse] = await Promise.all([
            makeRequest('/api/v1/private/account/assets').catch(e => ({ success: false, error: e })),
            makeRequest('/api/v1/private/position/open_positions').catch(e => ({ success: false, error: e })),
            makeRequest('/api/v1/private/order/list_history_orders', { page_size: 200 }).catch(e => ({ success: false, error: e }))
        ]);

        // --- 1. Process Account Assets (Available Balance) ---
        let availableBalance = 0;
        let assetsCount = 0;
        if (accountAssetsResponse.success && accountAssetsResponse.data) {
            const assets = accountAssetsResponse.data;
            availableBalance = assets.reduce((sum, asset) => sum + parseFloat(asset.availableBalance || 0), 0);
            assetsCount = assets.length;
        } else {
            console.error('Error fetching account assets:', accountAssetsResponse.error?.message);
        }

        // --- 2. Process Open Positions ---
        let openPositions = [];
        let totalMarginInPositions = 0;
        if (openPositionsResponse.success && openPositionsResponse.data) {
            totalMarginInPositions = openPositionsResponse.data.reduce((sum, pos) => sum + parseFloat(pos.im || 0), 0);
            openPositions = openPositionsResponse.data.map(pos => ({
                symbol: pos.symbol,
                positionType: pos.positionType === 1 ? 'Long' : 'Short',
                leverage: pos.leverage,
                openPrice: parseFloat(pos.holdAvgPrice || 0),
                currentPrice: parseFloat(pos.lastPrice || 0),
                unrealizedPNL: parseFloat(pos.unrealizedPL || 0),
                pnlPercentage: (parseFloat(pos.unrealizedPL || 0) / (parseFloat(pos.im) || 1)) * 100 // Avoid division by zero
            }));
        } else {
            console.error('Error fetching open positions:', openPositionsResponse.error?.message);
        }

        // --- 3. Calculate TRUE Total Balance ---
        const totalBalance = availableBalance + totalMarginInPositions;
        
        // --- 4. Process and Analyze Trade History ---
        let bestTrades = [];
        let worstTrades = [];
        if (historyDealsResponse.success && historyDealsResponse.data?.resultList) {
            const closedTrades = historyDealsResponse.data.resultList
                .filter(order => order.state === 3 && order.profit !== undefined)
                .map(order => ({
                    symbol: order.symbol,
                    pnl: parseFloat(order.profit),
                    date: new Date(order.updateTime).toLocaleDate-string('ar-EG')
                }));
            
            closedTrades.sort((a, b) => b.pnl - a.pnl);
            bestTrades = closedTrades.slice(0, 3);
            worstTrades = closedTrades.filter(t => t.pnl < 0).slice(-3).reverse();
        } else {
             console.error('Error fetching trade history:', historyDealsResponse.error?.message);
        }

        // --- 5. Send the final compiled data ---
        res.json({
            totalBalance: totalBalance,
            assetsValue: totalMarginInPositions, // We'll consider assets value as the margin in positions
            assetsCount: assetsCount,
            openPositions: openPositions,
            bestTrades: bestTrades,
            worstTrades: worstTrades
        });

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

    const contentType = response.headers.get("content-type");
    if (contentType && contentType.indexOf("application/json") !== -1) {
        const jsonResponse = await response.json();
        if (jsonResponse.code !== 0) { // MEXC specific error code check
             throw new Error(`MEXC API Error (${jsonResponse.code}): ${jsonResponse.msg}`);
        }
        return jsonResponse;
    } else {
        const text = await response.text();
        throw new Error(`MEXC returned a non-JSON response: ${text}`);
    }
}

// --- Start the server ---
app.listen(port, () => {
    console.log(`Server listening at port ${port}`);
});

