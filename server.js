// -----------------------------------------------------------------------------
// |                            MEXC PORTFOLIO SERVER                          |
// |                   VERSION: Definitive (Correct Path Fix)                  |
// |      This version provides the absolute final fix for the ENOENT error    |
// | by explicitly serving index.html from the correct directory (__dirname).  |
// |            This is the definitive solution based on the logs.             |
// -----------------------------------------------------------------------------

// استيراد المكتبات الضرورية
import express from 'express';
import crypto from 'crypto';
import fetch from 'node-fetch';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

// --- [ THE GPS COORDINATES ] ---
// This correctly sets up the directory path for ES modules.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// إعداد الخادم
const app = express();
const PORT = process.env.PORT || 10000;
app.use(cors());

// --- [ THE DEFINITIVE FIX ] ---
// We are now explicitly telling the server where to find the API endpoint
// AND where to find the HTML file. No more confusion.

// 1. Serve the API data from this endpoint
app.get('/api/portfolio-data', async (req, res) => {
    // The data fetching logic will go here
    try {
        const apiKey = process.env.MEXC_API_KEY;
        const secretKey = process.env.MEXC_SECRET_KEY;
        const BASE_URL = 'https://contract.mexc.com';

        const createSignature = (timestamp, params = '') => {
            const signaturePayload = apiKey + timestamp + params;
            return crypto.createHmac('sha256', secretKey).update(signaturePayload).digest('hex');
        };

        const makeRequest = async (method, endpoint, params = '') => {
            const timestamp = Date.now().toString();
            const signature = createSignature(timestamp, params);
            const url = `${BASE_URL}${endpoint}${params ? '?' + params : ''}`;
            const headers = { 'Content-Type': 'application/json', 'ApiKey': apiKey, 'Request-Time': timestamp, 'Signature': signature };
            const response = await fetch(url, { method, headers, timeout: 30000 });
            if (!response.ok) {
                const errorBody = await response.json();
                throw new Error(errorBody.msg || `Request failed with status ${response.status}`);
            }
            return await response.json();
        };

        const [assetsData, positionsData, historyData, tickersData, contractDetailsData] = await Promise.all([
            makeRequest('GET', '/api/v1/private/account/assets'),
            makeRequest('GET', '/api/v1/private/position/open_positions'),
            makeRequest('GET', '/api/v1/private/order/list/history_orders', 'page_size=200'),
            fetch(`${BASE_URL}/api/v1/contract/ticker`).then(r => r.json()),
            fetch(`${BASE_URL}/api/v1/contract/detail`).then(r => r.json()),
        ]);

        if (!assetsData.success || !positionsData.success || !historyData.success || !tickersData.success || !contractDetailsData.success) {
            throw new Error('One or more API calls were unsuccessful.');
        }

        const usdtAsset = assetsData.data.find(a => a.currency === 'USDT');
        const totalEquity = usdtAsset ? usdtAsset.equity : 0;
        const totalAssetsValue = usdtAsset ? usdtAsset.positionMargin : 0;
        
        const openPositions = positionsData.data ? positionsData.data : [];
        const openPositionsCount = openPositions.length;

        const tickersMap = new Map(tickersData.data.map(t => [t.symbol, t.lastPrice]));
        const contractSizeMap = new Map(contractDetailsData.data.map(c => [c.symbol, c.contractSize]));

        const processedPositions = openPositions.map(pos => {
            const currentPrice = tickersMap.get(pos.symbol) || 0;
            const contractSize = contractSizeMap.get(pos.symbol) || 1;
            const pnl = (currentPrice - pos.holdAvgPrice) * pos.holdVol * contractSize * (pos.positionType === 1 ? 1 : -1);
            const pnlPercentage = pos.im > 0 ? (pnl / pos.im) * 100 : 0;
            return {
                symbol: pos.symbol,
                positionType: pos.positionType === 1 ? 'Long' : 'Short',
                leverage: pos.leverage,
                entryPrice: pos.holdAvgPrice,
                currentPrice: currentPrice,
                pnl: pnl,
                pnlPercentage: pnlPercentage,
            };
        });

        const closedTrades = historyData.data
            .filter(order => order.state === 3 && order.profit !== 0)
            .map(order => ({
                symbol: order.symbol,
                profit: order.profit || 0,
                closeDate: order.updateTime ? new Date(order.updateTime).toLocaleDateString('ar-EG') : 'N/A',
            }));

        const profitableTrades = closedTrades.filter(t => t.profit > 0).sort((a, b) => b.profit - a.profit);
        const losingTrades = closedTrades.filter(t => t.profit < 0).sort((a, b) => a.profit - b.profit);

        res.json({
            totalBalance: totalEquity,
            assetsValue: totalAssetsValue,
            openPositionsCount: openPositionsCount,
            openPositions: processedPositions,
            bestTrades: profitableTrades.slice(0, 3),
            worstTrades: losingTrades.slice(0, 3),
        });

    } catch (error) {
        console.error('Error in /api/portfolio-data:', error);
        res.status(500).json({ error: error.message || 'An internal server error occurred.' });
    }
});

// 2. Serve the frontend file for ALL other requests
app.use(express.static(__dirname));
app.get('*', (req, res) => {
    // This tells the server: "For any other request, just send the index.html file".
    res.sendFile(path.join(__dirname, 'index.html'));
});

// تشغيل الخادم
app.listen(PORT, () => {
    console.log(`Server listening at port ${PORT}`);
});

