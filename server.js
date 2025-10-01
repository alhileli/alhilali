// -----------------------------------------------------------------------------
// |                            MEXC PORTFOLIO SERVER                          |
// |                      VERSION: Definitive (Correct History)                |
// |     This version fixes the issue of historical trades not appearing      |
// |      by using the correct API endpoint for futures trade history.        |
// -----------------------------------------------------------------------------

// استيراد المكتبات الضرورية
// We are importing the necessary libraries.
import express from 'express';
import crypto from 'crypto';
import fetch from 'node-fetch';
import cors from 'cors';

// إعداد الخادم
// Setting up the Express server.
const app = express();
const PORT = process.env.PORT || 10000;
app.use(cors());
app.use(express.static('public')); // This line is for serving the frontend if in the same project.

// استرداد مفاتيح API بأمان من متغيرات البيئة
// Securely getting API keys from environment variables.
const apiKey = process.env.MEXC_API_KEY;
const secretKey = process.env.MEXC_SECRET_KEY;

// URLs الخاصة بمنصة MEXC للعقود الآجلة
// URLs for MEXC Futures API.
const BASE_URL = 'https://contract.mexc.com';
const ASSETS_ENDPOINT = '/api/v1/private/account/assets';
const POSITIONS_ENDPOINT = '/api/v1/private/position/open_positions';
const HISTORY_ENDPOINT = '/api/v1/private/order/list/history_orders'; // <-- The CORRECT endpoint for futures history
const TICKER_ENDPOINT = '/api/v1/contract/ticker';
const CONTRACT_DETAILS_ENDPOINT = '/api/v1/contract/detail';

// دالة لإنشاء التوقيع الرقمي
// Function to create the digital signature required by the API.
function createSignature(timestamp, params = '') {
    const signaturePayload = apiKey + timestamp + params;
    return crypto.createHmac('sha256', secretKey).update(signaturePayload).digest('hex');
}

// دالة لإجراء طلبات API بشكل آمن
// A generic function to make secure API requests.
async function makeRequest(method, endpoint, params = '') {
    const timestamp = Date.now().toString();
    const signature = createSignature(timestamp, params);
    const url = `${BASE_URL}${endpoint}${params ? '?' + params : ''}`;

    const headers = {
        'Content-Type': 'application/json',
        'ApiKey': apiKey,
        'Request-Time': timestamp,
        'Signature': signature,
    };

    try {
        const response = await fetch(url, { method, headers, timeout: 30000 }); // Increased timeout to 30s
        if (!response.ok) {
            const errorBody = await response.json();
            console.error(`API Error on ${endpoint}:`, errorBody);
            throw new Error(errorBody.msg || `Request failed with status ${response.status}`);
        }
        return await response.json();
    } catch (error) {
        console.error(`Critical error during fetch to ${endpoint}:`, error);
        throw error;
    }
}

// نقطة النهاية الرئيسية التي تطلبها الواجهة الأمامية
// The main endpoint that the frontend will call.
app.get('/api/portfolio-data', async (req, res) => {
    try {
        // جلب جميع البيانات بشكل متزامن
        // Fetching all data concurrently for better performance.
        const [assetsData, positionsData, historyData, tickersData, contractDetailsData] = await Promise.all([
            makeRequest('GET', ASSETS_ENDPOINT),
            makeRequest('GET', POSITIONS_ENDPOINT),
            makeRequest('GET', HISTORY_ENDPOINT, 'page_size=200'), // Fetching last 200 closed trades
            fetch(`${BASE_URL}${TICKER_ENDPOINT}`).then(r => r.json()),
            fetch(`${BASE_URL}${CONTRACT_DETAILS_ENDPOINT}`).then(r => r.json()),
        ]);

        if (!assetsData.success || !positionsData.success || !historyData.success || !tickersData.success || !contractDetailsData.success) {
            throw new Error('One or more API calls were unsuccessful.');
        }

        // --- 1. حساب بيانات المحفظة الأساسية ---
        // --- 1. Calculating core portfolio data ---
        const usdtAsset = assetsData.data.find(a => a.currency === 'USDT');
        const totalEquity = usdtAsset ? usdtAsset.equity : 0;
        const totalAssetsValue = usdtAsset ? usdtAsset.positionMargin : 0;
        const openPositionsCount = positionsData.data ? positionsData.data.length : 0;

        // --- 2. معالجة المراكز المفتوحة مع الأسعار الحية ---
        // --- 2. Processing open positions with live prices ---
        const tickersMap = new Map(tickersData.data.map(t => [t.symbol, t.lastPrice]));
        const contractSizeMap = new Map(contractDetailsData.data.map(c => [c.symbol, c.contractSize]));

        const openPositions = positionsData.data.map(pos => {
            const currentPrice = tickersMap.get(pos.symbol) || 0;
            const contractSize = contractSizeMap.get(pos.symbol) || 1;
            const pnl = (currentPrice - pos.holdAvgPrice) * pos.holdVol * contractSize * (pos.positionType === 1 ? 1 : -1);
            const pnlPercentage = (pnl / pos.im) * 100;

            return {
                symbol: pos.symbol,
                positionType: pos.positionType === 1 ? 'Long' : 'Short', // شراء أو بيع
                leverage: pos.leverage,
                entryPrice: pos.holdAvgPrice,
                currentPrice: currentPrice,
                pnl: pnl,
                pnlPercentage: pnlPercentage,
            };
        });

        // --- 3. تحليل سجل الصفقات التاريخية ---
        // --- 3. Analyzing historical trade data ---
        const closedTrades = historyData.data
            .filter(order => order.state === 3) // state 3 means fully filled/closed
            .map(order => ({
                symbol: order.symbol,
                profit: order.profit || 0,
                closeDate: order.updateTime ? new Date(order.updateTime).toLocaleDateString('ar-EG') : 'N/A',
            }));

        const profitableTrades = closedTrades.filter(t => t.profit > 0).sort((a, b) => b.profit - a.profit);
        const losingTrades = closedTrades.filter(t => t.profit < 0).sort((a, b) => a.profit - b.profit);

        // --- 4. تجميع وإرسال البيانات النهائية ---
        // --- 4. Assembling and sending the final data package ---
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
// Starting the server.
app.listen(PORT, () => {
    console.log(`Server listening at port ${PORT}`);
});

