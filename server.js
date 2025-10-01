// -----------------------------------------------------------------------------
// |                            MEXC PORTFOLIO SERVER                          |
// |                   VERSION: RPG Upgrade Pt. 1 (Database)                   |
// | This version connects to a PostgreSQL database to log portfolio history,  |
// | enabling the future implementation of the growth chart and other RPG elements. |
// -----------------------------------------------------------------------------

// استيراد المكتبات الضرورية
import express from 'express';
import crypto from 'crypto';
import fetch from 'node-fetch';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg'; // <-- الأداة الجديدة التي أضفناها

// --- [ CONFIGURATION ] ---
const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// إعداد الخادم
const app = express();
const PORT = process.env.PORT || 10000;
app.use(cors());
app.use(express.static(__dirname));

// --- [ DATABASE SETUP ] ---
// الاتصال بقاعدة البيانات باستخدام العنوان السري الذي أضفته في Render
let pool;
if (process.env.DATABASE_URL) {
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: {
            rejectUnauthorized: false
        }
    });
} else {
    console.warn("DATABASE_URL not found. Database features will be disabled.");
}


// دالة لإنشاء جدول السجل التاريخي إذا لم يكن موجوداً
const initializeDatabase = async () => {
    if (!pool) return; // لا تعمل إذا لم يتم تكوين قاعدة البيانات
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS portfolio_history (
                id SERIAL PRIMARY KEY,
                equity NUMERIC(20, 8) NOT NULL,
                timestamp TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        console.log('Database table checked/created successfully.');
    } catch (err) {
        console.error('Error initializing database table:', err);
    }
};

// --- [ API & SERVER LOGIC ] ---
const apiKey = process.env.MEXC_API_KEY;
const secretKey = process.env.MEXC_SECRET_KEY;
const BASE_URL = 'https://contract.mexc.com';

// (جميع الدوال المساعدة مثل createSignature و makeRequest تبقى كما هي)
function createSignature(timestamp, params = '') {
    const signaturePayload = apiKey + timestamp + params;
    return crypto.createHmac('sha256', secretKey).update(signaturePayload).digest('hex');
}

async function makeRequest(method, endpoint, params = '') {
    const timestamp = Date.now().toString();
    const signature = createSignature(timestamp, params);
    const url = `${BASE_URL}${endpoint}${params ? '?' + params : ''}`;
    const headers = { 'Content-Type': 'application/json', 'ApiKey': apiKey, 'Request-Time': timestamp, 'Signature': signature };
    const response = await fetch(url, { method, headers, timeout: 30000 });
    if (!response.ok) { const errorBody = await response.json(); throw new Error(errorBody.msg || 'API Request Failed'); }
    return await response.json();
}

// دالة جلب البيانات الرئيسية، الآن مع تسجيل في قاعدة البيانات
async function getPortfolioDataAndLog() {
    const [assetsData, positionsData, historyData, tickersData, contractDetailsData] = await Promise.all([
        makeRequest('GET', '/api/v1/private/account/assets'),
        makeRequest('GET', '/api/v1/private/position/open_positions'),
        makeRequest('GET', '/api/v1/private/order/list/history_orders', 'page_size=200'),
        fetch(`${BASE_URL}/api/v1/contract/ticker`).then(r => r.json()),
        fetch(`${BASE_URL}/api/v1/contract/detail`).then(r => r.json()),
    ]);

    const usdtAsset = assetsData.data.find(a => a.currency === 'USDT');
    const totalEquity = usdtAsset ? usdtAsset.equity : 0;
    
    // تسجيل القيمة الجديدة للمحفظة في قاعدة البيانات
    if (pool) {
        try {
            await pool.query('INSERT INTO portfolio_history (equity, timestamp) VALUES ($1, NOW())', [totalEquity]);
            console.log(`Successfully logged new equity: ${totalEquity}`);
        } catch (err) {
            console.error('Error logging equity to database:', err);
        }
    }

    // معالجة وإرجاع جميع البيانات الأخرى كما في السابق
    const totalAssetsValue = usdtAsset ? usdtAsset.positionMargin : 0;
    const openPositions = positionsData.data ? positionsData.data : [];
    
    const tickersMap = new Map(tickersData.data.map(t => [t.symbol, t.lastPrice]));
    const contractSizeMap = new Map(contractDetailsData.data.map(c => [c.symbol, c.contractSize]));
    
    const processedPositions = openPositions.map(pos => {
        const currentPrice = tickersMap.get(pos.symbol) || 0;
        const contractSize = contractSizeMap.get(pos.symbol) || 1;
        const pnl = (currentPrice - pos.holdAvgPrice) * pos.holdVol * contractSize * (pos.positionType === 1 ? 1 : -1);
        const pnlPercentage = pos.im > 0 ? (pnl / pos.im) * 100 : 0;
        return { symbol: pos.symbol, positionType: pos.positionType === 1 ? 'Long' : 'Short', leverage: pos.leverage, entryPrice: pos.holdAvgPrice, currentPrice: currentPrice, pnl, pnlPercentage };
    });
    
    const closedTrades = (historyData.data || []).filter(o => o.state === 3 && o.profit !== 0).map(o => ({ symbol: o.symbol, profit: o.profit || 0, closeDate: o.updateTime ? new Date(o.updateTime).toLocaleDateString('ar-EG') : 'N/A' }));
    const profitableTrades = closedTrades.filter(t => t.profit > 0).sort((a, b) => b.profit - a.profit);
    const losingTrades = closedTrades.filter(t => t.profit < 0).sort((a, b) => a.profit - b.profit);
    
    return {
        totalBalance: totalEquity,
        assetsValue: totalAssetsValue,
        openPositionsCount: openPositions.length,
        openPositions: processedPositions,
        bestTrades: profitableTrades.slice(0, 3),
        worstTrades: losingTrades.slice(0, 3),
    };
}


// --- [ API ENDPOINTS ] ---
app.get('/api/portfolio-data', async (req, res) => {
    try {
        const data = await getPortfolioDataAndLog(); // استخدام الدالة الجديدة
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// نقطة بيانات جديدة للمخطط البياني
app.get('/api/portfolio-history', async (req, res) => {
    if (!pool) {
        return res.status(503).json({ error: "Database service is not configured." });
    }
    try {
        const history = await pool.query('SELECT equity, timestamp FROM portfolio_history ORDER BY timestamp ASC');
        res.json(history.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// تقديم الواجهة الأمامية
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- [ SERVER START ] ---
app.listen(PORT, () => {
    console.log(`Server listening at port ${PORT}`);
    initializeDatabase(); // فحص/إنشاء جدول قاعدة البيانات عند بدء تشغيل الخادم
});

