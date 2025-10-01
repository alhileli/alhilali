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
const REQUEST_TIMEOUT = 30000; // 30 seconds timeout

// --- API Keys ---
const apiKey = process.env.MEXC_API_KEY;
const secretKey = process.env.MEXC_SECRET_KEY;

// --- Middleware ---
app.use(cors());
app.use(express.static(__dirname));

// --- Helper function to get ALL tickers at once ---
async function getAllTickers() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/v1/contract/ticker`);
        if (!response.ok) return {};
        const data = await response.json();
        if (!data.success || !Array.isArray(data.data)) return {};
        const tickersMap = {};
        for (const ticker of data.data) {
            tickersMap[ticker.symbol] = ticker;
        }
        return tickersMap;
    } catch (error) {
        console.error(`Could not fetch all tickers:`, error.message);
        return {};
    }
}

// --- Main API Route ---
app.get('/api/portfolio-data', async (req, res) => {
    if (!apiKey || !secretKey) {
        return res.status(500).json({ error: 'لم يتم إعداد مفاتيح API على الخادم بشكل صحيح.' });
    }

    try {
        const [allTickers, accountAssetsResponse, openPositionsResponse, historyDealsResponse] = await Promise.all([
            getAllTickers(),
            makeRequest('/api/v1/private/account/assets'),
            makeRequest('/api/v1/private/position/open_positions'),
            makeRequest('/api/v1/private/order/list_history_orders', { page_size: 200 })
        ]);

        let availableBalance = 0;
        if (accountAssetsResponse.success && Array.isArray(accountAssetsResponse.data)) {
            const usdtAsset = accountAssetsResponse.data.find(asset => asset.currency === "USDT");
            if (usdtAsset) {
                availableBalance = parseFloat(usdtAsset.availableBalance || 0);
            }
        }

        let openPositions = [];
        let totalMarginInPositions = 0;
        let totalUnrealizedPNL = 0;

        if (openPositionsResponse.success && Array.isArray(openPositionsResponse.data) && openPositionsResponse.data.length > 0) {
            totalMarginInPositions = openPositionsResponse.data.reduce((sum, pos) => sum + parseFloat(pos.im || 0), 0);

            for (const pos of openPositionsResponse.data) {
                const ticker = allTickers[pos.symbol];
                const currentPrice = ticker ? parseFloat(ticker.lastPrice) : 0;
                
                const positionSize = parseFloat(pos.holdVol);
                const openPrice = parseFloat(pos.holdAvgPrice);
                const pnlDirection = pos.positionType === 1 ? 1 : -1;
                const contractSize = parseFloat(pos.contractSize); 
                
                // *** THE ULTIMATE FIX: Revert to manual calculation with the correct Contract Size formula ***
                const calculatedPNL = (currentPrice > 0) ? (currentPrice - openPrice) * positionSize * contractSize * pnlDirection : 0;
                totalUnrealizedPNL += calculatedPNL;
                
                const margin = parseFloat(pos.im) || 1;
                const pnlPercentage = (calculatedPNL / margin) * 100;
                
                openPositions.push({
                    symbol: pos.symbol,
                    positionType: pos.positionType === 1 ? 'Long' : 'Short',
                    leverage: pos.leverage,
                    openPrice: openPrice,
                    currentPrice: currentPrice,
                    unrealizedPNL: calculatedPNL,
                    pnlPercentage: pnlPercentage
                });
            }
        }
        
        const totalBalance = availableBalance + totalMarginInPositions + totalUnrealizedPNL;
        
        let bestTrades = [], worstTrades = [];
        if (historyDealsResponse.success && historyDealsResponse.data && Array.isArray(historyDealsResponse.data.resultList)) {
            const closedTrades = historyDealsResponse.data.resultList
                .filter(order => order.state === 3 && typeof order.profit !== 'undefined')
                .map(order => ({
                    symbol: order.symbol, pnl: parseFloat(order.profit), date: new Date(order.updateTime).toLocaleDateString('ar-EG')
                }));
            closedTrades.sort((a, b) => b.pnl - a.pnl);
            bestTrades = closedTrades.slice(0, 3);
            worstTrades = closedTrades.filter(t => t.pnl < 0).slice(-3).reverse();
        }

        res.json({
            totalBalance: totalBalance,
            assetsValue: totalMarginInPositions,
            openPositionsCount: openPositions.length,
            openPositions: openPositions,
            bestTrades: bestTrades,
            worstTrades: worstTrades
        });

    } catch (error) {
        console.error('A critical error occurred in the main route:', error.message);
        res.status(500).json({ error: `خطأ حرج في الخادم: ${error.message}` });
    }
});

// --- Serve the HTML file ---
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- API Request Helper with Timeout ---
async function makeRequest(endpoint, params = {}) {
    const timestamp = Date.now();
    const queryString = new URLSearchParams(params).toString();
    const toSign = `${apiKey}${timestamp}${queryString}`;
    const signature = CryptoJS.HmacSHA256(toSign, secretKey).toString(CryptoJS.enc.Hex);
    let url = `${API_BASE_URL}${endpoint}`;
    if (queryString) {
        url += `?${queryString}`;
    }
    
    const controller = new AbortController();
    const timeout = setTimeout(() => {
        controller.abort();
    }, REQUEST_TIMEOUT);

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json', 'ApiKey': apiKey, 'Request-Time': timestamp, 'Signature': signature },
            signal: controller.signal
        });

        const text = await response.text();
        if (!response.ok) throw new Error(`MEXC request failed with status ${response.status}: ${text}`);
        
        try {
            const jsonResponse = JSON.parse(text);
            if (jsonResponse.code !== 0) throw new Error(`MEXC API Error (${jsonResponse.code}): ${jsonResponse.msg}`);
            return { success: true, data: jsonResponse.data };
        } catch (e) {
            throw new Error(`Failed to parse JSON from MEXC: ${text}`);
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            console.error(`Request to ${endpoint} timed out.`);
            return { success: false, error: 'Request timed out' };
        }
        console.error(`Error in makeRequest to ${endpoint}:`, error.message);
        return { success: false, error: error.message };
    } finally {
        clearTimeout(timeout);
    }
}

// --- Start Server ---
app.listen(port, () => {
    console.log(`Server listening at port ${port}`);
});

