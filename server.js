// -----------------------------------------------------------------------------
// |                  ANONYMOUS ASTRONAUT - SERVER ENGINE                      |
// |                   VERSION: Final Verified & Polished                      |
// | This is the complete, verified, and final server code. It includes all    |
// | features: DB connection, AI status analysis, XP calculation, and all      |
// | previous bug fixes. This is the definitive engine for your cockpit.       |
// -----------------------------------------------------------------------------

// استيراد المكتبات الضرورية
import express from 'express';
import crypto from 'crypto';
import fetch from 'node-fetch';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

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
let pool;
if (process.env.DATABASE_URL) {
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
} else {
    console.warn("DATABASE_URL not found. Database features will be disabled.");
}

const initializeDatabase = async () => {
    if (!pool) return;
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
    if (!response.ok) { 
        const errorBody = await response.json(); 
        console.error(`API Error on ${endpoint}:`, errorBody);
        throw new Error(errorBody.msg || 'API Request Failed'); 
    }
    return await response.json();
}

async function getPortfolioDataAndLog() {
    const [assetsData, positionsData, historyData, tickersData, contractDetailsData] = await Promise.all([
        makeRequest('GET', '/api/v1/private/account/assets'),
        makeRequest('GET', '/api/v1/private/position/open_positions'),
        makeRequest('GET', '/api/v1/private/order/list/history_orders', 'page_size=200'),
        fetch(`${BASE_URL}/api/v1/contract/ticker`).then(r => r.json()),
        fetch(`${BASE_URL}/api/v1/contract/detail`).then(r => r.json()),
    ]);

    // Data Guards to prevent crashes
    const usdtAsset = (assetsData.data || []).find(a => a.currency === 'USDT');
    const openPositions = positionsData.data || [];
    const closedOrders = historyData.data || [];
    const tickers = tickersData.data || [];
    const contracts = contractDetailsData.data || [];
    
    // Use the definitive 'equity' value from the API as the total balance
    const totalEquity = usdtAsset ? usdtAsset.equity : 0;
    
    // Log equity to the database periodically
    if (pool) {
        try {
            const lastLog = await pool.query('SELECT timestamp FROM portfolio_history ORDER BY timestamp DESC LIMIT 1');
            const now = new Date();
            const lastLogTime = lastLog.rows.length > 0 ? new Date(lastLog.rows[0].timestamp) : new Date(0);
            const minutesSinceLastLog = (now.getTime() - lastLogTime.getTime()) / 60000;
            if (minutesSinceLastLog > 5) { // Log approximately every 5 minutes
                await pool.query('INSERT INTO portfolio_history (equity, timestamp) VALUES ($1, NOW())', [totalEquity]);
                console.log(`Successfully logged new equity: ${totalEquity}`);
            }
        } catch (err) {
            console.error('Error logging equity to database:', err);
        }
    }

    const totalAssetsValue = usdtAsset ? usdtAsset.positionMargin : 0;
    
    const tickersMap = new Map(tickers.map(t => [t.symbol, t.lastPrice]));
    const contractSizeMap = new Map(contracts.map(c => [c.symbol, c.contractSize]));
    
    const processedPositions = openPositions.map(pos => {
        const currentPrice = tickersMap.get(pos.symbol) || 0;
        const contractSize = contractSizeMap.get(pos.symbol) || 1;
        const pnl = (currentPrice - pos.holdAvgPrice) * pos.holdVol * contractSize * (pos.positionType === 1 ? 1 : -1);
        const pnlPercentage = pos.im > 0 ? (pnl / pos.im) * 100 : 0;
        return { symbol: pos.symbol, positionType: pos.positionType === 1 ? 'Long' : 'Short', leverage: pos.leverage, entryPrice: pos.holdAvgPrice, currentPrice: currentPrice, pnl, pnlPercentage };
    });

    // --- [ AI Analysis Logic ] ---
    let portfolioStatus = 'STABLE';
    let aiMessage = 'الأنظمة مستقرة. كل شيء على ما يرام أيها القائد.';
    let change24h = 0;

    if (pool) {
        try {
            const historyResult = await pool.query(`
                SELECT equity FROM portfolio_history 
                WHERE timestamp <= NOW() - INTERVAL '24 hours' 
                ORDER BY timestamp DESC LIMIT 1
            `);
            if (historyResult.rows.length > 0) {
                const pastEquity = parseFloat(historyResult.rows[0].equity);
                if (pastEquity > 0) {
                    change24h = ((totalEquity - pastEquity) / pastEquity) * 100;
                }
            }

            const topPerformingPosition = processedPositions.length > 0 
                ? processedPositions.reduce((max, p) => p.pnl > max.pnl ? p : max, {pnl: -Infinity}) 
                : null;

            if (change24h > 3) { // If profit is more than 3%
                portfolioStatus = 'PROFIT';
                aiMessage = topPerformingPosition?.pnl > 0 
                    ? `أداء ممتاز! تم رصد نمو بنسبة ${change24h.toFixed(1)}%. مهمة ${topPerformingPosition.symbol} تسير بنجاح.`
                    : `أداء ممتاز! تم رصد نمو بنسبة ${change24h.toFixed(1)}%.`;
            } else if (change24h < -3) { // If loss is more than 3%
                portfolioStatus = 'LOSS';
                aiMessage = `تنبيه: تم رصد تقلبات سلبية بنسبة ${change24h.toFixed(1)}%. يرجى مراجعة المهمات النشطة.`;
            }

        } catch (err) {
            console.error("AI Analysis Error:", err);
        }
    }
    
    const closedTrades = closedOrders.filter(o => o.state === 3 && o.profit !== 0).map(o => ({ symbol: o.symbol, profit: o.profit || 0, closeDate: o.updateTime ? new Date(o.updateTime).toLocaleDateString('ar-EG') : 'N/A' }));
    const profitableTrades = closedTrades.filter(t => t.profit > 0).sort((a, b) => b.profit - a.profit);
    const losingTrades = closedTrades.filter(t => t.profit < 0).sort((a, b) => a.profit - b.profit);
    
    // Calculate total profit for XP
    const totalHistoricalProfit = profitableTrades.reduce((sum, trade) => sum + trade.profit, 0);

    return {
        totalBalance: totalEquity,
        assetsValue: totalAssetsValue,
        openPositionsCount: openPositions.length,
        openPositions: processedPositions,
        bestTrades: profitableTrades.slice(0, 3),
        worstTrades: losingTrades.slice(0, 3),
        totalXP: totalHistoricalProfit,
        portfolioStatus,
        aiMessage,
    };
}

// API Endpoints
app.get('/api/portfolio-data', async (req, res) => {
    try {
        const data = await getPortfolioDataAndLog();
        res.json(data);
    } catch (error) {
        console.error("Error in /api/portfolio-data endpoint:", error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/portfolio-history', async (req, res) => {
    if (!pool) { return res.status(503).json({ error: "Database service is not configured." }); }
    try {
        const history = await pool.query(`
            WITH daily_equity AS (
                SELECT DATE_TRUNC('day', timestamp) AS day, AVG(equity) as avg_equity
                FROM portfolio_history WHERE timestamp > NOW() - INTERVAL '90 days'
                GROUP BY day
            )
            SELECT avg_equity as equity, day as timestamp FROM daily_equity ORDER BY day ASC;
        `);
        res.json(history.rows);
    } catch (err) {
        console.error("Error in /api/portfolio-history endpoint:", err);
        res.status(500).json({ error: err.message });
    }
});

// Serve Frontend
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server listening at port ${PORT}`);
    initializeDatabase();
});

