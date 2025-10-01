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

// --- Cache for contract details to avoid repeated API calls ---
const contractDetailsCache = new Map();

// --- Robust Helper Functions ---
const safeParseFloat = (value) => {
    const num = parseFloat(value);
    return isNaN(num) ? 0 : num;
};

async function getContractDetails(symbol) {
    if (contractDetailsCache.has(symbol)) {
        return contractDetailsCache.get(symbol);
    }
    try {
        const response = await fetch(`${API_BASE_URL}/api/v1/contract/detail?symbol=${symbol}`);
        if (!response.ok) return null;
        const data = await response.json();
        if (data.success && data.data) {
            contractDetailsCache.set(symbol, data.data);
            return data.data;
        }
        return null;
    } catch (error) {
        console.error(`Could not fetch contract details for ${symbol}:`, error.message);
        return null;
    }
}

async function getAllTickers() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/v1/contract/ticker`);
        if (!response.ok) return {};
        const data = await response.json();
        if (!data.success || !Array.isArray(data.data)) return {};
        return data.data.reduce((map, ticker) => {
            map[ticker.symbol] = ticker;
            return map;
        }, {});
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

        let totalEquity = 0;
        let availableBalance = 0;
        if (accountAssetsResponse.success && Array.isArray(accountAssetsResponse.data)) {
            const usdtAsset = accountAssetsResponse.data.find(asset => asset.currency === "USDT");
            if (usdtAsset) {
                totalEquity = safeParseFloat(usdtAsset.equity);
                availableBalance = safeParseFloat(usdtAsset.availableBalance);
            }
        }

        let openPositions = [];
        if (openPositionsResponse.success && Array.isArray(openPositionsResponse.data)) {
            for (const pos of openPositionsResponse.data) {
                const contractDetails = await getContractDetails(pos.symbol);
                const ticker = allTickers[pos.symbol];

                const currentPrice = ticker ? safeParseFloat(ticker.lastPrice) : 0;
                const openPrice = safeParseFloat(pos.holdAvgPrice);
                const positionSize = safeParseFloat(pos.holdVol);
                const contractSize = contractDetails ? safeParseFloat(contractDetails.contractSize) : 1;
                const pnlDirection = pos.positionType === 1 ? 1 : -1;

                const calculatedPNL = (currentPrice > 0) ? (currentPrice - openPrice) * positionSize * contractSize * pnlDirection : 0;
                const margin = safeParseFloat(pos.im) || 1;
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

        const totalMarginInPositions = openPositions.reduce((sum, pos) => {
            const originalPos = openPositionsResponse.data.find(p => p.symbol === pos.symbol);
            return sum + (originalPos ? safeParseFloat(originalPos.im) : 0);
        }, 0);


        let bestTrades = [], worstTrades = [];
        if (historyDealsResponse.success && historyDealsResponse.data && Array.isArray(historyDealsResponse.data.resultList)) {
            const closedTradesPromises = historyDealsResponse.data.resultList
                .filter(order => order.state === 3 && order.dealAvgPrice && order.openAvgPrice && order.vol)
                .map(async (order) => {
                    const contractDetails = await getContractDetails(order.symbol);
                    const openPrice = safeParseFloat(order.openAvgPrice);
                    const closePrice = safeParseFloat(order.dealAvgPrice);
                    const positionSize = safeParseFloat(order.vol);
                    const contractSize = contractDetails ? safeParseFloat(contractDetails.contractSize) : 1;
                    const pnlDirection = order.openType === 1 ? 1 : -1;
                    
                    const calculatedPnl = (closePrice - openPrice) * positionSize * contractSize * pnlDirection;
                    
                    return {
                        symbol: order.symbol, 
                        pnl: calculatedPnl, 
                        date: order.updateTime ? new Date(order.updateTime).toLocaleDateString('en-GB') : 'N/A'
                    };
                });
                
            const closedTrades = await Promise.all(closedTradesPromises);

            closedTrades.sort((a, b) => b.pnl - a.pnl);
            bestTrades = closedTrades.slice(0, 3);
            worstTrades = closedTrades.filter(t => t.pnl < 0).slice(-3).reverse();
        }

        res.json({
            totalBalance: totalEquity,
            assetsValue: totalMarginInPositions,
            openPositionsCount: openPositions.length,
            openPositions: openPositions,
            bestTrades: bestTrades,
            worstTrades: worstTrades
        });

    } catch (error) {
        console.error('A critical error occurred in the main route:', error);
        res.status(500).json({ error: `خطأ حرج في الخادم: ${error.message}` });
    }
});


app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

async function makeRequest(endpoint, params = {}) {
    const timestamp = Date.now();
    const queryString = new URLSearchParams(params).toString();
    const toSign = `${apiKey}${timestamp}${queryString}`;
    const signature = CryptoJS.HmacSHA256(toSign, secretKey).toString(CryptoJS.enc.Hex);
    let url = `${API_BASE_URL}${endpoint}`;
    if (queryString) url += `?${queryString}`;
    
    const controller = new AbortController();
    const timeout = setTimeout(() => { controller.abort(); }, REQUEST_TIMEOUT);

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json', 'ApiKey': apiKey, 'Request-Time': timestamp, 'Signature': signature },
            signal: controller.signal
        });
        const text = await response.text();
        if (!response.ok) throw new Error(`MEXC request failed with status ${response.status}: ${text}`);
        const jsonResponse = JSON.parse(text);
        if (jsonResponse.code && jsonResponse.code !== 0) throw new Error(`MEXC API Error (${jsonResponse.code}): ${jsonResponse.msg}`);
        return { success: true, data: jsonResponse.data };
    } catch (error) {
        if (error.name === 'AbortError') return { success: false, error: 'Request timed out' };
        return { success: false, error: error.message };
    } finally {
        clearTimeout(timeout);
    }
}

app.listen(port, () => {
    console.log(`Server listening at port ${port}`);
});

