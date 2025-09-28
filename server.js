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
// IMPORTANT: Switched to the Futures API base URL
const API_BASE_URL = 'https://contract.mexc.com';

// --- API Keys ---
const apiKey = process.env.MEXC_API_KEY;
const secretKey = process.env.MEXC_SECRET_KEY;

// --- Middleware ---
app.use(cors());
app.use(express.static(__dirname));

// --- API Route for Futures Data ---
app.get('/api/portfolio-data', async (req, res) => {
    if (!apiKey || !secretKey) {
        return res.status(500).json({ error: 'لم يتم إعداد مفاتيح API على الخادم بشكل صحيح.' });
    }

    try {
        // 1. Fetch Futures Account Assets
        const accountAssets = await makeRequest('/api/v1/private/account/assets');
        if (!accountAssets.success || !accountAssets.data) {
            throw new Error(accountAssets.message || 'استجابة غير صالحة من MEXC API عند جلب أصول العقود الآجلة.');
        }

        // Filter assets with a balance
        const assets = accountAssets.data.filter(b => parseFloat(b.availableBalance) > 0);

        // 2. Fetch all Futures contract tickers to get their prices
        const tickerResponse = await fetch(`${API_BASE_URL}/api/v1/contract/ticker`);
        const allTickers = await tickerResponse.json();
        if (!allTickers.success || !allTickers.data) {
            throw new Error('فشل في جلب أسعار العقود الآجلة.');
        }

        const prices = {};
        allTickers.data.forEach(ticker => {
            // We use the lastPrice for calculation
            prices[ticker.symbol] = parseFloat(ticker.lastPrice);
        });

        // 3. Calculate portfolio values
        let totalBalance = 0;
        const processedAssets = assets.map(asset => {
            const totalAmount = parseFloat(asset.availableBalance);
            // Futures symbols are like BTC_USDT, ETH_USDT
            const symbol = `${asset.currency}_USDT`;
            
            let value = 0;
            if (asset.currency === 'USDT') {
                value = totalAmount;
            } else if (prices[symbol]) {
                value = totalAmount * prices[symbol];
            }
            
            totalBalance += value;

            return {
                asset: asset.currency,
                totalAmount,
                value
            };
        });
        
        const assetsValue = processedAssets.filter(a => a.asset !== 'USDT').reduce((sum, a) => sum + a.value, 0);

        // 4. Send the final data
        res.json({
            totalBalance,
            assetsValue,
            assets: processedAssets.sort((a, b) => b.value - a.value)
        });

    } catch (error) {
        console.error('Backend Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// --- Serve the HTML file for all other routes ---
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- UPDATED Helper function for FUTURES API requests ---
async function makeRequest(endpoint) {
    const timestamp = Date.now();
    // Futures API signing is different from Spot API
    const stringToSign = apiKey + timestamp;
    const signature = CryptoJS.HmacSHA256(stringToSign, secretKey).toString(CryptoJS.enc.Hex);

    const url = `${API_BASE_URL}${endpoint}`;
    const response = await fetch(url, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'ApiKey': apiKey,
            'Request-Time': timestamp,
            'Signature': signature
        }
    });

    if (!response.ok) {
        const errorData = await response.json();
        // Use 'message' for futures API errors, not 'msg'
        throw new Error(errorData.message || `HTTP Error ${response.status}`);
    }
    return response.json();
}

// --- Start the server ---
app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
});

