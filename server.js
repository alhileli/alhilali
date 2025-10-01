// -----------------------------------------------------------------------------
// |                            MEXC PORTFOLIO SERVER                          |
// |                 VERSION: Final (with Static Path Fix)                     |
// |      This version fixes the "Cannot GET /" error by correctly setting     |
// |          the static path for ES modules and serving index.html.          |
// -----------------------------------------------------------------------------

// استيراد المكتبات الضرورية
// We are importing the necessary libraries.
import express from 'express';
import crypto from 'crypto';
import fetch from 'node-fetch';
import cors from 'cors';
import path from 'path'; // <-- Module added to handle file paths
import { fileURLToPath } from 'url'; // <-- Module added to handle file paths

// --- [ NEW ] ---
// Define __dirname for ES modules, this is the "new map" for our server.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// --- [ END NEW ] ---

// إعداد الخادم
// Setting up the Express server.
const app = express();
const PORT = process.env.PORT || 10000;
app.use(cors());

// --- [ MODIFIED ] ---
// Tell Express to serve static files (like index.html) from the 'public' directory.
// We now use the full path to avoid any confusion.
app.use(express.static(path.join(__dirname, 'public')));
// --- [ END MODIFIED ] ---


// استرداد مفاتيح API بأمان من متغيرات البيئة
// Securely getting API keys from environment variables.
const apiKey = process.env.MEXC_API_KEY;
const secretKey = process.env.MEXC_SECRET_KEY;

// URLs الخاصة بمنصة MEXC للعقود الآجلة
// URLs for MEXC Futures API.
const BASE_URL = 'https://contract.mexc.com';
const ASSETS_ENDPOINT = '/api/v1/private/account/assets';
const POSITIONS_ENDPOINT = '/api/v1/private/position/open_positions';
const HISTORY_ENDPOINT = '/api/v1/private/order/list/history_orders';
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
        const response = await fetch(url, { method, headers, timeout: 30000 });
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
    // ... The rest of this function remains exactly the same ...
    // ... بقية هذه الدالة تبقى كما هي تماماً ...
    try {
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
            const pnlPercentage = (pnl / pos.im) * 100;

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

// --- [ NEW ] ---
// A "catch-all" route to serve the index.html file for any other request.
// This ensures that your frontend loads correctly.
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// --- [ END NEW ] ---

// تشغيل الخادم
// Starting the server.
app.listen(PORT, () => {
    console.log(`Server listening at port ${PORT}`);
});

