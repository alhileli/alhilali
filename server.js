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
    console.log("==> New request received. Starting diagnostic...");

    if (!apiKey || !secretKey) {
        console.error("Diagnostic FAIL: API keys are not configured on the server.");
        return res.status(500).json({ error: 'لم يتم إعداد مفاتيح API على الخادم بشكل صحيح.' });
    }

    try {
        // --- STEP 1: ONLY Fetch Account Assets (Balance) ---
        console.log("Diagnostic STEP 1: Attempting to fetch account assets...");
        const accountAssetsResponse = await makeRequest('/api/v1/private/account/assets');
        
        if (!accountAssetsResponse.success || !accountAssetsResponse.data) {
             console.error("Diagnostic FAIL at STEP 1: Invalid response from MEXC assets endpoint.", accountAssetsResponse);
             throw new Error('فشل في جلب أصول المحفظة.');
        }
        
        console.log("Diagnostic SUCCESS at STEP 1: Successfully fetched account assets.");
        const assets = accountAssetsResponse.data;
        const totalBalance = assets.reduce((sum, asset) => sum + parseFloat(asset.im || 0), 0);
        const assetsValue = assets.filter(a => a.currency !== 'USDT').reduce((sum, asset) => sum + parseFloat(asset.im || 0), 0);
        const assetsCount = assets.length;

        // --- All other steps are disabled for this test ---
        console.log("Diagnostic COMPLETE: Sending simplified data to frontend.");

        // --- Send only the balance data ---
        res.json({
            totalBalance,
            assetsValue,
            assetsCount,
            openPositions: [], // Sending empty data for other sections
            bestTrades: [],
            worstTrades: []
        });

    } catch (error) {
        console.error('Diagnostic CRITICAL ERROR:', error.message);
        res.status(500).json({ error: `خطأ في الخادم أثناء التشخيص: ${error.message}` });
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
    console.log(`Making request to: ${endpoint}`); // Log which endpoint is being called
    
    const response = await fetch(url, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'ApiKey': apiKey,
            'Request-Time': timestamp,
            'Signature': signature
        }
    });

    const textResponse = await response.text(); // Read response as text first
    try {
        return JSON.parse(textResponse); // Try to parse as JSON
    } catch (e) {
        console.error("Failed to parse JSON from MEXC:", textResponse);
        throw new Error(`MEXC returned a non-JSON response: ${textResponse}`);
    }
}

// --- Start the server ---
app.listen(port, () => {
    console.log(`Server listening at port ${port}`);
});

