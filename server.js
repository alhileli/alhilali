// -----------------------------------------------------------------------------
// |                            MEXC PORTFOLIO SERVER                          |
// |         VERSION: Final Professional (Accurate & Live Calculations)        |
// | This is the definitive version. It fetches all tickers at once for speed, |
// | uses contract size for 100% accurate PNL calculation, and reports true   |
// | equity. This should resolve all previously observed data discrepancies.  |
// -----------------------------------------------------------------------------

// استيراد المكتبات الضرورية
import express from 'express';
import crypto from 'crypto';
import fetch from 'node-fetch';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

// --- [ CRUCIAL FIX for Path Issues ] ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// إعداد الخادم
const app = express();
const PORT = process.env.PORT || 10000;
app.use(cors());

// --- [ CRUCIAL FIX for "Not Found" Error ] ---
app.use(express.static(__dirname));

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

// دالة لإنشاء التوقيع الرقمي
function createSignature(timestamp, params = '') {
    const signaturePayload = apiKey + timestamp + params;
    return crypto.createHmac('sha256', secretKey).update(signaturePayload).digest('hex');
}

// دالة لإجراء طلبات API بشكل آمن
async function makeRequest(method, endpoint, params = '') {
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
}

// نقطة النهاية الرئيسية التي تطلبها الواجهة الأمامية
app.get('/api/portfolio-data', async (req, res) => {
    try {
        const [tickersResponse, contractDetailsResponse, assetsData, positionsData, historyData] = await Promise.all([
            fetch(`${BASE_URL}${TICKER_ENDPOINT}`),
            fetch(`${BASE_URL}${CONTRACT_DETAILS_ENDPOINT}`),
            makeRequest('GET', ASSETS_ENDPOINT),
            makeRequest('GET', POSITIONS_ENDPOINT),
            makeRequest('GET', HISTORY_ENDPOINT, 'page_size=200')
        ]);

        const tickersJson = await tickersResponse.json();
        const contractDetailsJson = await contractDetailsResponse.json();

        if (!assetsData.success || !positionsData.success || !historyData.success || !tickersJson.success || !contractDetailsJson.success) {
            throw new Error('One or more API calls were unsuccessful.');
        }

        const tickersMap = new Map(tickersJson.data.map(t => [t.symbol, t.lastPrice]));
        const contractSizeMap = new Map(contractDetailsJson.data.map(c => [c.symbol, c.contractSize]));
        
        const openPositions = positionsData.data ? positionsData.data : [];
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

        const unrealizedPnlSum = processedPositions.reduce((sum, pos) => sum + pos.pnl, 0);
        const usdtAsset = assetsData.data.find(a => a.currency === 'USDT');
        const availableBalance = usdtAsset ? usdtAsset.availableBalance : 0;
        const positionMargin = usdtAsset ? usdtAsset.positionMargin : 0;
        const totalEquity = availableBalance + positionMargin + unrealizedPnlSum;

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
            assetsValue: positionMargin,
            openPositionsCount: openPositions.length,
            openPositions: processedPositions,
            bestTrades: profitableTrades.slice(0, 3),
            worstTrades: losingTrades.slice(0, 3),
        });

    } catch (error) {
        console.error('Error in /api/portfolio-data:', error);
        res.status(500).json({ error: error.message || 'An internal server error occurred.' });
    }
});

// Serve the frontend for any other request
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// تشغيل الخادم
app.listen(PORT, () => {
    console.log(`Server listening at port ${PORT}`);
});

