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

// --- Main API Route for Diagnostics ---
app.get('/api/portfolio-data', async (req, res) => {
    console.log("=============================================");
    console.log(">>> DIAGNOSTIC RUN STARTED <<<");
    console.log("=============================================");

    if (!apiKey || !secretKey) {
        console.error("CRITICAL ERROR: API keys are not configured on the server.");
        return res.status(500).json({ error: 'API keys not set' });
    }

    try {
        // --- Step 1: Fetch Account Assets ---
        console.log("\n--- [STEP 1/3] FETCHING ACCOUNT ASSETS ---");
        const accountAssetsResponse = await makeRequest('/api/v1/private/account/assets');
        console.log("Raw Response from Account Assets:", JSON.stringify(accountAssetsResponse, null, 2));
        if (!accountAssetsResponse.success) {
            console.error("Failed to fetch account assets.");
        }

        // --- Step 2: Fetch Open Positions ---
        console.log("\n--- [STEP 2/3] FETCHING OPEN POSITIONS ---");
        const openPositionsResponse = await makeRequest('/api/v1/private/position/open_positions');
        console.log("Raw Response from Open Positions:", JSON.stringify(openPositionsResponse, null, 2));
        if (!openPositionsResponse.success) {
            console.error("Failed to fetch open positions.");
        }
        
        // --- Step 3: Fetch All Tickers for prices ---
        console.log("\n--- [STEP 3/3] FETCHING ALL TICKERS ---");
        const tickerResponse = await fetch(`${API_BASE_URL}/api/v1/contract/ticker`);
        const tickerData = await tickerResponse.json();
        console.log("Raw Response from All Tickers (first 5 symbols):", JSON.stringify(tickerData.data?.slice(0, 5), null, 2));


        console.log("\n=============================================");
        console.log(">>> DIAGNOSTIC RUN FINISHED <<<");
        console.log("=============================================");

        // We send a minimal response just to complete the request
        res.json({ status: "Diagnostic run completed. Check server logs." });

    } catch (error) {
        console.error('CRITICAL ERROR during diagnostic run:', error);
        res.status(500).json({ error: `Server error during diagnostics: ${error.message}` });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- Helper Function for making authenticated requests ---
async function makeRequest(endpoint, params = {}) {
    const timestamp = Date.now();
    const queryString = new URLSearchParams(params).toString();
    const toSign = `${apiKey}${timestamp}${queryString}`;
    const signature = CryptoJS.HmacSHA256(toSign, secretKey).toString(CryptoJS.enc.Hex);
    let url = `${API_BASE_URL}${endpoint}`;
    if (queryString) url += `?${queryString}`;

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json', 'ApiKey': apiKey, 'Request-Time': timestamp, 'Signature': signature }
        });
        const data = await response.json();
        return data;
    } catch (error) {
        console.error(`Error in makeRequest for ${endpoint}:`, error);
        return { success: false, code: 9999, msg: error.message, data: null };
    }
}

app.listen(port, () => {
    console.log(`Diagnostic server listening at port ${port}`);
});

