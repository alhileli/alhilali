// -----------------------------------------------------------------------------
// |                            MEXC PORTFOLIO SERVER                          |
// |                VERSION: Final (Correct File Serving)                      |
// |     This version fixes the "Not Found" error by explicitly serving       |
// |       the index.html file for the root route in an ES module env.        |
// -----------------------------------------------------------------------------

// استيراد المكتبات الضرورية
import express from 'express';
import crypto from 'crypto';
import fetch from 'node-fetch';
import cors from 'cors';
import path from 'path'; // Module to handle file paths
import { fileURLToPath } from 'url'; // Module to handle file paths

// --- [ NEW AND CRUCIAL ] ---
// Define __dirname for ES modules. This is the "GPS map" for our server.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// --- [ END NEW AND CRUCIAL ] ---

// إعداد الخادم
const app = express();
const PORT = process.env.PORT || 10000;
app.use(cors());

// استرداد مفاتيح API بأمان
const apiKey = process.env.MEXC_API_KEY;
const secretKey = process.env.MEXC_SECRET_KEY;

// URLs الخاصة بمنصة MEXC
const BASE_URL = 'https://contract.mexc.com';
const ASSETS_ENDPOINT = '/api/v1/private/account/assets';
const POSITIONS_ENDPOINT = '/api/v1/private/position/open_positions';
const HISTORY_ENDPOINT = '/api/v1/private/order/list/history_orders';
const TICKER_ENDPOINT = '/api/v1/contract/ticker';
const CONTRACT_DETAILS_ENDPOINT = '/api/v1/contract/detail';

// --- [ NEW ROUTE TO SERVE THE FRONTEND ] ---
// This is the explicit instruction for the server to send the index.html file
// when someone visits the main URL.
app.get('/', (req, res) => {
    // We tell it to find the 'index.html' file in the same directory as the server script.
    res.sendFile(path.join(__dirname, 'index.html'));
});
// --- [ END NEW ROUTE ] ---


// The API endpoint for data remains the same
app.get('/api/portfolio-data', async (req, res) => {
    try {
        // ... The entire data fetching logic remains exactly the same ...
        // ... بقية منطق جلب البيانات يبقى كما هو تماماً ...
        const createSignature = (timestamp, params = '') => {
            const signaturePayload = apiKey + timestamp + params;
            return crypto.createHmac('sha26_
            ...
            ... (The rest of the data fetching and processing code is identical to the previous correct version) ...
            ...
        
        const [assetsData, positionsData, historyData, tickersData, contractDetailsData] = await Promise.all([
            makeRequest('GET', ASSETS_ENDPOINT),
            makeRequest('GET', POSITIONS_ENDPOINT),
            makeRequest('GET', HISTORY_ENDPOINT, 'page_size=200'),
            fetch(`${BASE_URL}${TICKER_ENDPOINT}`).then(r => r.json()),
            fetch(`${BASE_URL}${CONTRACT_DETAILS_ENDPOINT}`).then(r => r.json()),
        ]);

        if (!assetsData.success || !positionsData.success || !historyData.success || !tickersData.success || !contractDetailsData.success) {
             throw new Error('One or more API calls were unsuccessful.');
        }

        const usdtAsset = assetsData.data.find(a => a.currency === 'USDT');
        const totalEquity = usdtAsset ? usdtAsset.equity : 0;
        const totalAssetsValue = usdtAsset ? usdtAsset.positionMargin : 0;
        const openPositionsCount = positionsData.data ? positionsData.data.length : 0;

        const tickersMap = new Map(tickersData.data.map(t => [t.symbol, t.lastPrice]));
        const contractSizeMap = new Map(contractDetailsData.data.map(c => [c.symbol, c.contractSize]));

        const openPositions = positionsData.data.map(pos => {
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
            .filter(order => order.state === 3)
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
            openPositions: openPositions,
            bestTrades: profitableTrades.slice(0, 3),
            worstTrades: losingTrades.slice(0, 3),
        });

    } catch (error) {
        console.error('Error in /api/portfolio-data:', error);
        res.status(500).json({ error: error.message || 'An internal server error occurred.' });
    }
});


// تشغيل الخادم
app.listen(PORT, () => {
    console.log(`Server listening at port ${PORT}`);
});

