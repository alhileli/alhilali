// --- Dependencies ---
const express = require('express');
const fetch = require('node-fetch');
const CryptoJS = require('crypto-js');
const cors = require('cors');
require('dotenv').config(); // To load environment variables

// --- Configuration ---
const app = express();
const port = process.env.PORT || 3000;
const API_BASE_URL = 'https://api.mexc.com';

// --- API Keys (Loaded securely from environment variables) ---
const apiKey = process.env.MEXC_API_KEY;
const secretKey = process.env.MEXC_SECRET_KEY;

// --- Middleware ---
app.use(cors()); // Allow requests from the frontend
app.use(express.static('.')); // Serve the index.html file

// --- The Secure API Endpoint ---
app.get('/api/portfolio-data', async (req, res) => {
    // Check if API keys are configured on the server
    if (!apiKey || !secretKey) {
        return res.status(500).json({ error: 'لم يتم إعداد مفاتيح API على الخادم بشكل صحيح.' });
    }

    try {
        // 1. Fetch Account Information (Balances)
        const accountInfo = await makeRequest('/api/v3/account');
        if (!accountInfo || !accountInfo.balances) {
             throw new Error('استجابة غير صالحة من MEXC API عند جلب الأرصدة.');
        }

        const assets = accountInfo.balances.filter(b => (parseFloat(b.free) + parseFloat(b.locked)) > 0.00001);

        // 2. Fetch Current Prices for all assets
        const symbols = assets.filter(a => a.asset !== 'USDT').map(a => `${a.asset}USDT`);
        const pricesResponse = await fetch(`${API_BASE_URL}/api/v3/ticker/price`);
        const allPrices = await pricesResponse.json();
        
        const prices = {};
        allPrices.forEach(item => {
            if (symbols.includes(item.symbol) || item.symbol === 'USDTUSDT') {
                prices[item.symbol] = parseFloat(item.price);
            }
        });
        prices['USDTUSDT'] = 1; // USDT is always 1 dollar

        // 3. Calculate portfolio values
        let totalBalance = 0;
        const processedAssets = assets.map(asset => {
            const totalAmount = parseFloat(asset.free) + parseFloat(asset.locked);
            const symbol = `${asset.asset}USDT`;
            const price = prices[symbol] || 0;
            const value = totalAmount * price;
            totalBalance += value;
            return {
                asset: asset.asset,
                totalAmount,
                value
            };
        });

        const usdtAsset = processedAssets.find(a => a.asset === 'USDT');
        const assetsValue = usdtAsset ? totalBalance - usdtAsset.value : totalBalance;

        // 4. Send the final, clean data to the frontend
        res.json({
            totalBalance,
            assetsValue,
            assets: processedAssets.sort((a, b) => b.value - a.value) // Sort by value
        });

    } catch (error) {
        console.error('Backend Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// --- Helper function to make signed requests to MEXC ---
async function makeRequest(endpoint, params = {}) {
    const timestamp = Date.now();
    const recvWindow = 5000;
    const queryString = new URLSearchParams({ ...params, timestamp, recvWindow }).toString();
    
    const signature = CryptoJS.HmacSHA256(queryString, secretKey).toString(CryptoJS.enc.Hex);
    const url = `${API_BASE_URL}${endpoint}?${queryString}&signature=${signature}`;

    const response = await fetch(url, {
        method: 'GET',
        headers: { 'X-MEXC-APIKEY': apiKey, 'Content-Type': 'application/json' }
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.msg || `HTTP Error ${response.status}`);
    }
    return response.json();
}

// --- Start the server ---
app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
});

