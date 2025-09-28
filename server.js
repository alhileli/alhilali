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
        // Use Promise.all to fetch all data concurrently for better performance
        const [
            accountAssetsResponse,
            openPositionsResponse,
            historyDealsResponse
        ] = await Promise.all([
            makeRequest('/api/v1/private/account/assets'),
            makeRequest('/api/v1/private/position/open_positions'),
            makeRequest('/api/v1/private/order/list_history_orders', { page_size: 200 }) // Fetch last 200 trades
        ]);
        
        // --- 1. Process Account Balance ---
        if (!accountAssetsResponse.success || !accountAssetsResponse.data) throw new Error('فشل في جلب أصول المحفظة.');
        const assets = accountAssetsResponse.data;
        const totalBalance = assets.reduce((sum, asset) => sum + parseFloat(asset.im), 0);
        const assetsValue = assets.filter(a => a.currency !== 'USDT').reduce((sum, asset) => sum + parseFloat(asset.im), 0);

        // --- 2. Process Open Positions ---
        if (!openPositionsResponse.success || !openPositionsResponse.data) throw new Error('فشل في جلب المراكز المفتوحة.');
        const openPositions = openPositionsResponse.data.map(pos => ({
            symbol: pos.symbol,
            positionType: pos.positionType === 1 ? 'Long' : 'Short',
            leverage: pos.leverage,
            openPrice: parseFloat(pos.holdAvgPrice),
            currentPrice: parseFloat(pos.lastPrice),
            unrealizedPNL: parseFloat(pos.unrealizedPL),
            pnlPercentage: (parseFloat(pos.unrealizedPL) / parseFloat(pos.im)) * 100
        }));

        // --- 3. Analyze Trade History ---
        if (!historyDealsResponse.success || !historyDealsResponse.data?.resultList) throw new Error('فشل في جلب سجل الصفقات.');
        // Filter only closed/filled orders and calculate PNL for each
        const closedTrades = historyDealsResponse.data.resultList
            .filter(order => order.state === 3) // State 3 means fully filled
            .map(order => ({
                symbol: order.symbol,
                pnl: parseFloat(order.profit), // Assuming 'profit' field exists and is the PNL
                date: new Date(order.updateTime).toLocaleDateString('ar-EG')
            }));
            
        closedTrades.sort((a, b) => b.pnl - a.pnl); // Sort by profit, descending
        
        const bestTrades = closedTrades.slice(0, 3);
        const worstTrades = closedTrades.slice(-3).reverse();

        // --- 4. Send the final compiled data ---
        res.json({
            totalBalance,
            assetsValue,
            assetsCount: assets.length,
            openPositions,
            bestTrades,
            worstTrades
        });

    } catch (error) {
        console.error('Backend Error:', error.message);
        res.status(500).json({ error: `خطأ في الخادم: ${error.message}` });
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
    const stringToSign = `${apiKey}${timestamp}${queryString ? `&${queryString}` : ''}`;
    const signature = CryptoJS.HmacSHA256(stringToSign, secretKey).toString(CryptoJS.enc.Hex);

    const url = `${API_BASE_URL}${endpoint}${queryString ? `?${queryString}` : ''}`;
    
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
        throw new Error(errorData.message || `HTTP Error ${response.status}`);
    }
    return response.json();
}

// --- Start the server ---
app.listen(port, () => {
    console.log(`Server listening at port ${port}`);
});

