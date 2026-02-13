const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const multer = require('multer'); // Для загрузки фото
const FormData = require('form-data');
require('dotenv').config();
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const BIND_HOST = (process.env.BIND_HOST || '0.0.0.0').trim();

// 👇 ВСТАВЬ СВОЮ ССЫЛКУ!
const SERVER_URL = process.env.SERVER_URL || 'https://ytiiiipuff-production.up.railway.app';
const WEBAPP_URL = process.env.WEBAPP_URL || process.env.MINI_APP_URL || process.env.FRONTEND_URL || process.env.CLIENT_URL || '';

const corsOptions = {
    origin: '*',
    methods: ['GET','POST','PUT','DELETE','OPTIONS'],
    allowedHeaders: ['Content-Type','X-Telegram-Init-Data','user-id']
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());

// --- PROCESS DIAGNOSTICS (helps debug Railway SIGTERM / crashes) ---
process.on('unhandledRejection', (reason) => {
    console.error('❌ [unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
    console.error('❌ [uncaughtException]', err);
});

// Настройка Multer (храним фото в памяти перед отправкой в ТГ)
const upload = multer({ storage: multer.memoryStorage() });

if (!process.env.DATABASE_URL) console.error("❌ Нет DATABASE_URL");
if (!process.env.BOT_TOKEN) console.error("❌ Нет BOT_TOKEN");
if (!process.env.ADMIN_CHAT_ID) console.error("❌ Нет ADMIN_CHAT_ID");

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const bot = new TelegramBot(process.env.BOT_TOKEN); // webhook mode (no polling)
// --- БД ---
const initDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                telegram_id BIGINT UNIQUE NOT NULL,
                username VARCHAR(255),
                nickname VARCHAR(255),
                -- deprecated поля (регистрация удалена на фронте)
                name VARCHAR(255),
                phone VARCHAR(50),
                points INTEGER DEFAULT 500,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS products (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                category VARCHAR(100),
                description TEXT,
                price DECIMAL(10, 2) NOT NULL,
                purchase_price DECIMAL(10, 2) DEFAULT 0,
                image_url TEXT,
                stock INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            ALTER TABLE products ADD COLUMN IF NOT EXISTS brand TEXT;
            CREATE TABLE IF NOT EXISTS expenses (
                id SERIAL PRIMARY KEY,
                amount DECIMAL(10, 2) NOT NULL,
                comment TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS faq (
                id SERIAL PRIMARY KEY,
                question TEXT NOT NULL,
                answer TEXT NOT NULL
            );
CREATE TABLE IF NOT EXISTS cart_items (
                id SERIAL PRIMARY KEY,
                user_telegram_id BIGINT NOT NULL,
                product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
                quantity INTEGER DEFAULT 1,
                UNIQUE(user_telegram_id, product_id)
            );
            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY,
                user_telegram_id BIGINT NOT NULL,
                details TEXT NOT NULL,
                total_price DECIMAL(10, 2),
                subtotal_price DECIMAL(10, 2),
                promo_code VARCHAR(50),
                promo_discount_percent INTEGER DEFAULT 0,
                points_spent INTEGER DEFAULT 0,
                points_awarded INTEGER DEFAULT 0,
                address TEXT,
                comment TEXT,
                status VARCHAR(20) DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

	        // В старых деплоях таблица users могла быть создана без username/nickname.
	        // CREATE TABLE IF NOT EXISTS не добавляет новые колонки в существующую таблицу,
	        // поэтому делаем мягкую миграцию.
	        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(255);`);
	        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname VARCHAR(255);`);

        // Promo codes table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS promo_codes (
                id SERIAL PRIMARY KEY,
                code VARCHAR(50) UNIQUE NOT NULL,
                discount_percent INTEGER NOT NULL,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        
        // --- settings schema (robust / backward-compatible) ---
        // В старых деплоях таблица `settings` могла существовать в другом формате (например, с колонкой "key" NOT NULL).
        // Поэтому: (1) создаем таблицу, если ее нет, (2) определяем реальные имена колонок, (3) используем их везде далее.
        const { rows: settingsTableRows } = await pool.query(`SELECT to_regclass('public.settings') AS reg;`);
        if (!settingsTableRows[0]?.reg) {
            await pool.query(`
                CREATE TABLE settings (
                    "key" TEXT PRIMARY KEY,
                    value TEXT
                );
            `);
        }

        const { rows: settingsColsRows } = await pool.query(`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'settings'
        `);
        const settingsCols = new Set(settingsColsRows.map(r => r.column_name));

        // choose key/value columns that actually exist
        const SETTINGS_KEY_COL = settingsCols.has('key')
            ? 'key'
            : (settingsCols.has('setting_key') ? 'setting_key' : (settingsCols.has('name') ? 'name' : (settingsCols.has('setting') ? 'setting' : null)));

        const SETTINGS_VALUE_COL = settingsCols.has('value')
            ? 'value'
            : (settingsCols.has('setting_value') ? 'setting_value' : null);

        // If no key/value column detected, create minimal compatible columns
        if (!SETTINGS_KEY_COL) {
            await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS "key" TEXT;`);
        }
        if (!SETTINGS_VALUE_COL) {
            await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS value TEXT;`);
        }

        // expose for later handlers
        global.__SETTINGS_KEY_COL = SETTINGS_KEY_COL || 'key';
        global.__SETTINGS_VALUE_COL = SETTINGS_VALUE_COL || 'value';

        // Ensure default setting exists without relying on UNIQUE/PK constraints on a specific column name
        await pool.query(
            `INSERT INTO settings ("${global.__SETTINGS_KEY_COL}", "${global.__SETTINGS_VALUE_COL}")
             SELECT $1, $2
             WHERE NOT EXISTS (
                 SELECT 1 FROM settings WHERE "${global.__SETTINGS_KEY_COL}" = $1
             );`,
            ['reviews_channel_url', '']
        );

// Safe schema upgrades for existing deployments
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname VARCHAR(255);`);
        await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS subtotal_price DECIMAL(10, 2);`);
        await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS promo_code VARCHAR(50);`);
        await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS promo_discount_percent INTEGER DEFAULT 0;`);
        await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS points_spent INTEGER DEFAULT 0;`);
        await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS points_awarded INTEGER DEFAULT 0;`);

        console.log('✅ БД готова.');
    } catch (err) { console.error('❌ Ошибка БД:', err); }
};
initDB();

// --- УТИЛИТЫ ---
const getAdmins = () => process.env.ADMIN_CHAT_ID.split(',').map(id => id.trim());
const isAdmin = (telegramUserId) => getAdmins().includes(String(telegramUserId));

const normalizePromoCode = (code) => (code || '').toString().trim().toUpperCase();

const escapeHtml = (s) => (s === null || s === undefined) ? '' : String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// Loyalty points rate: points per 1 ruble of final total (default 0.01 => 1 point per 100₽)
const POINTS_RATE = Number.parseFloat(process.env.POINTS_RATE || '0.01');
const calcEarnedPoints = (total) => {
    const t = Number(total);
    if (!Number.isFinite(t) || t <= 0) return 0;
    const r = Number.isFinite(POINTS_RATE) && POINTS_RATE > 0 ? POINTS_RATE : 0;
    return Math.max(0, Math.floor(t * r));
};

const clampInt = (v, min, max) => {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) return min;
    return Math.min(max, Math.max(min, n));
};



// --- TELEGRAM MINI APP AUTH (initData validation) ---
// Validates Telegram.WebApp.initData via HMAC-SHA256 algorithm:
// secret_key = HMAC_SHA256("WebAppData", bot_token)
// hash = HMAC_SHA256(secret_key, data_check_string)
// Docs: https://docs.telegram-mini-apps.com/platform/init-data and core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

const parseInitData = (initDataRaw) => {
    const s = (initDataRaw || '').toString().trim().replace(/^\?/, '');
    const params = new URLSearchParams(s);
    return params;
};

const buildDataCheckString = (params) => {
    const pairs = [];
    for (const [k, v] of params.entries()) {
        if (k === 'hash' || k === 'signature') continue;
        pairs.push(`${k}=${v}`);
    }
    // Sort alphabetically by whole "key=value" (equivalent to by key if keys unique)
    pairs.sort();
    return pairs.join('\n');
};

const timingSafeEqualHex = (aHex, bHex) => {
    try {
        const a = Buffer.from(String(aHex || '').toLowerCase(), 'hex');
        const b = Buffer.from(String(bHex || '').toLowerCase(), 'hex');
        if (a.length === 0 || b.length === 0 || a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
    } catch {
        return false;
    }
};

const validateTelegramInitData = (initDataRaw, botToken) => {
    if (!initDataRaw || !botToken) return { ok: false, reason: 'missing_initdata_or_token' };
    const params = parseInitData(initDataRaw);
    const receivedHash = params.get('hash');
    if (!receivedHash) return { ok: false, reason: 'missing_hash' };

    const dataCheckString = buildDataCheckString(params);
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (!timingSafeEqualHex(receivedHash, computedHash)) {
        return { ok: false, reason: 'hash_mismatch' };
    }

    // Parse user payload (JSON string)
    let user = null;
    const userRaw = params.get('user');
    if (userRaw) {
        try { user = JSON.parse(userRaw); } catch { user = null; }
    }
    if (!user || !user.id) return { ok: false, reason: 'missing_user' };

    return {
        ok: true,
        user: {
            id: String(user.id),
            username: (user.username || '').toString(),
            first_name: (user.first_name || '').toString(),
            last_name: (user.last_name || '').toString()
        }
    };
};

const requireTelegramAuth = (req, res, next) => {
    const initData = req.get('X-Telegram-Init-Data') || req.headers['x-telegram-init-data'];
    const v = validateTelegramInitData(initData, process.env.BOT_TOKEN);
    if (!v.ok) return res.status(401).json({ error: 'INVALID_TELEGRAM_INIT_DATA', reason: v.reason });

    req.tgUserId = v.user.id;
    req.tgUsername = v.user.username ? v.user.username.trim().replace(/^@/, '') : '';
    req.tgFirstName = v.user.first_name || '';
    req.tgLastName = v.user.last_name || '';
    req.tgIsAdmin = isAdmin(req.tgUserId);
    next();
};

const requireAdmin = (req, res, next) => {
    if (!req.tgIsAdmin) return res.status(403).json({ error: 'Access denied' });
    next();
};

const requireOwnerOrAdmin = (getTargetId) => (req, res, next) => {
    const target = String(getTargetId(req));
    if (String(req.tgUserId) === target || req.tgIsAdmin) return next();
    return res.status(403).json({ error: 'FORBIDDEN' });
};

const buildNicknameFromTelegram = (firstName, lastName, username) => {
    const full = [firstName, lastName].map(s => (s || '').toString().trim()).filter(Boolean).join(' ').trim();
    if (full) return full;
    const u = (username || '').toString().trim().replace(/^@/, '');
    if (u) return u;
    return 'Пользователь';
};

const ensureUserRecord = async (telegramId, username, firstName, lastName) => {
    const u = (username || '').toString().trim().replace(/^@/, '');
    const nick = buildNicknameFromTelegram(firstName, lastName, u);
    const result = await pool.query(
        `INSERT INTO users (telegram_id, username, nickname)
         VALUES ($1, $2, $3)
         ON CONFLICT (telegram_id)
         DO UPDATE SET username = EXCLUDED.username, nickname = EXCLUDED.nickname
         RETURNING *`,
        [telegramId, u, nick]
    );
    return result.rows[0];
};

// Бот теперь нужен только для /start и уведомлений
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const text = 'Привет! Просмотр каталога и оформление заказа по кнопке ниже⬇️';
    const url = WEBAPP_URL;

    if (url) {
        bot.sendMessage(chatId, text, {
            reply_markup: {
                inline_keyboard: [[
                    {
                        text: '🟣 Открыть каталог',
                        web_app: { url }
                        // style: 'primary' // Bot API supports only danger/success/primary; omit for app-specific style
                    }
                ]]
            }
        });
    } else {
        bot.sendMessage(chatId, text);
    }
});

// --- TELEGRAM WEBHOOK (instead of polling) ---
// Railway/containers могут перезапускаться; webhook стабилен и не даёт 409 getUpdates конфликтов.
// Опционально можно защитить вебхук secret-токеном:
// - задай TG_WEBHOOK_SECRET (или TELEGRAM_WEBHOOK_SECRET)
// - Telegram будет слать заголовок: x-telegram-bot-api-secret-token
const TG_WEBHOOK_SECRET = (process.env.TG_WEBHOOK_SECRET || process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
const TG_WEBHOOK_PATH = TG_WEBHOOK_SECRET ? `/telegram-webhook/${TG_WEBHOOK_SECRET}` : '/telegram-webhook';

app.get(TG_WEBHOOK_PATH, (req, res) => res.status(200).send('ok'));

app.post(TG_WEBHOOK_PATH, (req, res) => {
    try {
        if (TG_WEBHOOK_SECRET) {
            const header = req.get('x-telegram-bot-api-secret-token') || '';
            if (header !== TG_WEBHOOK_SECRET) return res.sendStatus(401);
        }
        if (req.body && typeof req.body.update_id !== 'undefined') {
            console.log('⬇️ Telegram update_id:', req.body.update_id);
        }
        bot.processUpdate(req.body);
        return res.sendStatus(200);
    } catch (e) {
        console.error('❌ Webhook processing error:', e);
        return res.sendStatus(200);
    }
});

const setupTelegramWebhook = async () => {
    if (!process.env.BOT_TOKEN) return;
    if (!SERVER_URL) {
        console.error('❌ SERVER_URL is empty: cannot set Telegram webhook.');
        return;
    }
    const webhookUrl = `${SERVER_URL}${TG_WEBHOOK_PATH}`;
    try {
        // Defensive: remove any existing webhook first (avoids weird states during redeploys)
        await bot.deleteWebHook({ drop_pending_updates: true });

        await bot.setWebHook(
            webhookUrl,
            TG_WEBHOOK_SECRET
                ? { secret_token: TG_WEBHOOK_SECRET, drop_pending_updates: true }
                : { drop_pending_updates: true }
        );
        console.log(`✅ Telegram webhook set: ${webhookUrl}`);

        // Useful for debugging if Telegram can reach your endpoint
        const info = await bot.getWebHookInfo();
        console.log('ℹ️ Telegram getWebhookInfo:', info);
    } catch (e) {
        // node-telegram-bot-api иногда кладёт ответ в e.response.body
        console.error('❌ Failed to set Telegram webhook:', e?.response?.body || e?.message || e);
    }
};


// --- АДМИНКА ---

// 1. Добавить товар (Одиночный)
app.post('/api/admin/product', requireTelegramAuth, requireAdmin, upload.single('photo'), async (req, res) => {
    try {
        const { name, category, description, price, purchase_price, stock } = req.body;
        let internalLink = null;
        if (req.file) {
            const storageChatId = getAdmins()[0]; 
            const photoMsg = await bot.sendPhoto(storageChatId, req.file.buffer, { caption: `New product: ${name}` });
            const fileId = photoMsg.photo[photoMsg.photo.length - 1].file_id;
            internalLink = `${SERVER_URL}/api/image/${fileId}`;
        } else {
            internalLink = 'https://via.placeholder.com/300x300.png?text=No+Photo'; 
        }

        await pool.query(
            'INSERT INTO products (name, category, description, brand, price, purchase_price, stock, image_url) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [name, category, description, null, price, purchase_price || 0, stock || 0, internalLink]
        );
        res.json({ success: true });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Error adding product' }); }
});

// 1.1 Массовый импорт (Batch)
app.post('/api/admin/products/batch', requireTelegramAuth, requireAdmin, async (req, res) => {
    try {
        const { products } = req.body;

        const client = await pool.connect();
        try {
            await client.query('BEGIN'); 
            const defaultImage = 'https://via.placeholder.com/300x300.png?text=No+Photo'; 
            for (const p of products) {
                await client.query(
                    'INSERT INTO products (name, category, description, brand, price, purchase_price, stock, image_url) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
                    [p.name, p.category, p.description || '', (p.brand && String(p.brand).trim()) ? String(p.brand).trim() : null, p.price, p.purchase_price || 0, p.stock || 0, defaultImage]
                );
            }
            await client.query('COMMIT'); 
            res.json({ success: true, count: products.length });
        } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    } catch (err) { console.error(err); res.status(500).json({ error: 'Batch import error' }); }
});

// 1.2 БЫСТРОЕ ОБНОВЛЕНИЕ ФОТО (НОВОЕ)
app.post('/api/admin/product/:id/image', requireTelegramAuth, requireAdmin, upload.single('photo'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No photo' });

        const storageChatId = getAdmins()[0]; 
        const photoMsg = await bot.sendPhoto(storageChatId, req.file.buffer, { caption: `Updated photo for ID: ${req.params.id}` });
        const fileId = photoMsg.photo[photoMsg.photo.length - 1].file_id;
        const internalLink = `${SERVER_URL}/api/image/${fileId}`;

        await pool.query('UPDATE products SET image_url = $1 WHERE id = $2', [internalLink, req.params.id]);
        
        res.json({ success: true, imageUrl: internalLink });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Image upload error' }); }
});

// 2. Удалить товар (ИСПРАВЛЕНО: удаляет и из корзин тоже)
app.delete('/api/admin/product/:id', requireTelegramAuth, requireAdmin, async (req, res) => {
    try {
        const productId = req.params.id;

        // 1. Сначала удаляем этот товар из всех корзин пользователей
        await pool.query('DELETE FROM cart_items WHERE product_id = $1', [productId]);

        // 2. Теперь удаляем сам товар
        await pool.query('DELETE FROM products WHERE id = $1', [productId]);

        res.json({ success: true });
    } catch (err) { 
        console.error(err);
        res.status(500).json({ error: 'Delete error: ' + err.message }); 
    }
});

// 2.1 Изменить сток
app.post('/api/admin/product/stock', requireTelegramAuth, requireAdmin, async (req, res) => {
    try {
        const { productId, change } = req.body;
        await pool.query('UPDATE products SET stock = stock + $1 WHERE id = $2', [parseInt(change), productId]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Stock update error' }); }
});

// 3. Получить заказы
app.get('/api/admin/orders', requireTelegramAuth, requireAdmin, async (req, res) => {
    try {
        const { status } = req.query;
        const result = await pool.query("SELECT * FROM orders WHERE status = $1 ORDER BY id DESC LIMIT 50", [status || 'active']);
        const orders = await Promise.all(result.rows.map(async (o) => {
            const u = await pool.query(
                "SELECT COALESCE(nickname, name) AS nickname, username FROM users WHERE telegram_id = $1",
                [o.user_telegram_id]
            );
            return { ...o, user_data: u.rows[0], items: JSON.parse(o.details) };
        }));
        res.json(orders);
    } catch (err) { res.status(500).json({ error: 'Orders error' }); }
});

// 4. Завершить заказ
app.post('/api/admin/order/:id/done', requireTelegramAuth, requireAdmin, async (req, res) => {
    try {
        const orderRes = await pool.query("SELECT * FROM orders WHERE id = $1 AND status = 'active'", [req.params.id]);
        if (orderRes.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
        const orderRow = orderRes.rows[0];
        const pointsEarned = calcEarnedPoints(orderRow.total_price);
        // award only for this transition (endpoint работает только для active заказов)
        if (pointsEarned > 0) {
            await pool.query('UPDATE users SET points = COALESCE(points, 0) + $1 WHERE telegram_id = $2', [pointsEarned, orderRow.user_telegram_id]);
        }
        await pool.query("UPDATE orders SET status = 'completed', points_awarded = $1 WHERE id = $2", [pointsEarned, req.params.id]);
        res.json({ success: true, points_awarded: pointsEarned });
    } catch (err) { res.status(500).json({ error: 'Done error' }); }
});

// 5. Редактировать заказ
app.put('/api/admin/order/:id', requireTelegramAuth, requireAdmin, async (req, res) => {
    try {
        const { address, comment, details, total_price } = req.body;
        await pool.query(
            "UPDATE orders SET address = $1, comment = $2, details = $3, total_price = $4 WHERE id = $5",
            [address, comment, JSON.stringify(details), total_price, req.params.id]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Update error' }); }
});

// 6. Статистика
app.get('/api/admin/stats', requireTelegramAuth, requireAdmin, async (req, res) => {
    try {
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
        
        const ordersRes = await pool.query("SELECT details, total_price FROM orders WHERE status = 'completed' AND created_at >= $1 AND created_at <= $2", [startOfMonth, endOfMonth]);
        let totalRevenue = 0, totalCOGS = 0;
        for (const order of ordersRes.rows) {
            totalRevenue += parseFloat(order.total_price);
            const items = JSON.parse(order.details);
            for (const item of items) {
                const productRes = await pool.query("SELECT purchase_price FROM products WHERE id = $1", [item.product_id]);
                if (productRes.rows.length > 0) totalCOGS += parseFloat(productRes.rows[0].purchase_price || 0) * item.quantity;
            }
        }
        const expensesRes = await pool.query("SELECT * FROM expenses WHERE created_at >= $1 AND created_at <= $2 ORDER BY created_at DESC", [startOfMonth, endOfMonth]);
        let totalExpenses = 0;
        const expensesList = expensesRes.rows.map(e => { totalExpenses += parseFloat(e.amount); return e; });
        res.json({ revenue: totalRevenue, cogs: totalCOGS, expenses: totalExpenses, netProfit: totalRevenue - totalCOGS - totalExpenses, expensesList });
    } catch (err) { res.status(500).json({ error: 'Stats error' }); }
});

app.post('/api/admin/expense', requireTelegramAuth, requireAdmin, async (req, res) => {
    try {
        const { amount, comment } = req.body;
        await pool.query('INSERT INTO expenses (amount, comment) VALUES ($1, $2)', [amount, comment]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

// 7. VISUAL DB MANAGER
const isValidTable = (t) => ['users', 'products', 'expenses', 'faq', 'orders', 'cart_items', 'promo_codes'].includes(t);

app.get('/api/admin/db/:table', requireTelegramAuth, requireAdmin, async (req, res) => {
    try {
        if (!isValidTable(req.params.table)) return res.status(400).json({ error: 'Invalid table' });
        const result = await pool.query(`SELECT * FROM ${req.params.table} ORDER BY id DESC LIMIT 100`);
        res.json(result.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/db/:table', requireTelegramAuth, requireAdmin, async (req, res) => {
    try {
        if (!isValidTable(req.params.table)) return res.status(400).json({ error: 'Invalid table' });
        const data = req.body;
        const keys = Object.keys(data);
        const values = Object.values(data);
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
        await pool.query(`INSERT INTO ${req.params.table} (${keys.join(', ')}) VALUES (${placeholders})`, values);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/db/:table/:id', requireTelegramAuth, requireAdmin, async (req, res) => {
    try {
        if (!isValidTable(req.params.table)) return res.status(400).json({ error: 'Invalid table' });
        const data = req.body;
        const keys = Object.keys(data);
        const values = Object.values(data);
        const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
        await pool.query(`UPDATE ${req.params.table} SET ${setClause} WHERE id = $${values.length + 1}`, [...values, req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/db/:table/:id', requireTelegramAuth, requireAdmin, async (req, res) => {
    try {
        if (!isValidTable(req.params.table)) return res.status(400).json({ error: 'Invalid table' });
        await pool.query(`DELETE FROM ${req.params.table} WHERE id = $1`, [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- PROMO CODES (ADMIN) ---
app.get('/api/admin/promos', requireTelegramAuth, requireAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM promo_codes ORDER BY id DESC');
        res.json(result.rows);
    } catch (e) { res.status(500).json({ error: 'Promos error' }); }
});

app.post('/api/admin/promos', requireTelegramAuth, requireAdmin, async (req, res) => {
    try {
        const { code, discount_percent } = req.body;
        const promoCode = normalizePromoCode(code);
        const pct = clampInt(discount_percent, 1, 100);
        if (!promoCode) return res.status(400).json({ error: 'Empty code' });
        await pool.query(
            'INSERT INTO promo_codes (code, discount_percent, is_active) VALUES ($1, $2, TRUE) ON CONFLICT (code) DO UPDATE SET discount_percent = EXCLUDED.discount_percent, is_active = TRUE',
            [promoCode, pct]
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Create promo error' }); }
});

app.put('/api/admin/promos/:id', requireTelegramAuth, requireAdmin, async (req, res) => {
    try {
        const { discount_percent, is_active } = req.body;
        const pct = discount_percent !== undefined ? clampInt(discount_percent, 1, 100) : null;
        const active = (is_active === undefined) ? null : !!is_active;

        const sets = [];
        const vals = [];
        let idx = 1;
        if (pct !== null) { sets.push(`discount_percent = $${idx++}`); vals.push(pct); }
        if (active !== null) { sets.push(`is_active = $${idx++}`); vals.push(active); }
        if (sets.length === 0) return res.json({ success: true });
        vals.push(req.params.id);
        await pool.query(`UPDATE promo_codes SET ${sets.join(', ')} WHERE id = $${idx}`, vals);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Update promo error' }); }
});

app.delete('/api/admin/promos/:id', requireTelegramAuth, requireAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM promo_codes WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Delete promo error' }); }
});

// --- STANDARD API ---
app.get('/', (req, res) => res.send('TripPuff v11 Photo Wizard Running'));
app.get('/api/image/:fileId', async (req, res) => {
    try {
        const fileLink = await bot.getFileLink(req.params.fileId);
        const response = await axios({ url: fileLink, method: 'GET', responseType: 'stream' });
        res.setHeader('Content-Type', 'image/jpeg');
        response.data.pipe(res);
    } catch (e) { res.status(404).send('Not found'); }
});

app.get('/api/user/me', requireTelegramAuth, async (req, res) => {
    try {
        const user = await ensureUserRecord(req.tgUserId, req.tgUsername, req.tgFirstName, req.tgLastName);
        user.is_admin = req.tgIsAdmin;
        res.json(user);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get user's own order history (for profile) - safe shortcut
app.get('/api/user/me/orders', requireTelegramAuth, async (req, res) => {
    try {
        const userId = req.tgUserId;
        const result = await pool.query(
            'SELECT id, details, total_price, subtotal_price, promo_code, promo_discount_percent, points_spent, points_awarded, address, comment, status, created_at FROM orders WHERE user_telegram_id = $1 ORDER BY id DESC LIMIT 100',
            [userId]
        );
        const rows = result.rows.map(r => ({
            ...r,
            items: (() => { try { return JSON.parse(r.details); } catch { return []; } })()
        }));
        res.json(rows);
    } catch (e) { res.status(500).json({ error: 'Orders history error' }); }
});

// Get authenticated user's cart (safe shortcut)
app.get('/api/cart', requireTelegramAuth, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT c.product_id, c.quantity, p.name, p.price, p.image_url
             FROM cart_items c
             JOIN products p ON c.product_id = p.id
             WHERE c.user_telegram_id = $1
             ORDER BY p.name ASC`,
            [req.tgUserId]
        );
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Cart error' }); }
});

app.get('/api/user/:id', requireTelegramAuth, requireOwnerOrAdmin(req => req.params.id), async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [req.params.id]);
        if (result.rows.length > 0) { const user = result.rows[0]; user.is_admin = req.tgIsAdmin; res.json(user); } 
        else res.status(404).json({ message: 'User not found' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get user's own order history (for profile)
app.get('/api/user/:id/orders', requireTelegramAuth, requireOwnerOrAdmin(req => req.params.id), async (req, res) => {
    try {
        const userId = req.params.id;
        const result = await pool.query(
            'SELECT id, details, total_price, subtotal_price, promo_code, promo_discount_percent, points_spent, points_awarded, address, comment, status, created_at FROM orders WHERE user_telegram_id = $1 ORDER BY id DESC LIMIT 100',
            [userId]
        );
        const rows = result.rows.map(r => ({
            ...r,
            items: (() => { try { return JSON.parse(r.details); } catch { return []; } })()
        }));
        res.json(rows);
    } catch (e) { res.status(500).json({ error: 'Orders history error' }); }
});

// Validate promo code (public)
app.post('/api/promo/validate', async (req, res) => {
    try {
        const code = normalizePromoCode(req.body.code);
        if (!code) return res.status(400).json({ valid: false, message: 'Пустой промокод' });
        const result = await pool.query('SELECT code, discount_percent, is_active FROM promo_codes WHERE code = $1', [code]);
        if (result.rows.length === 0) return res.json({ valid: false, message: 'Промокод не найден' });
        const row = result.rows[0];
        if (!row.is_active) return res.json({ valid: false, message: 'Промокод неактивен' });
        res.json({ valid: true, code: row.code, discount_percent: row.discount_percent });
    } catch (e) { res.status(500).json({ valid: false, message: 'Ошибка сервера' }); }
});
app.post('/api/register', requireTelegramAuth, async (req, res) => {
    try {
        const user = await ensureUserRecord(req.tgUserId, req.tgUsername, req.tgFirstName, req.tgLastName);
        user.is_admin = req.tgIsAdmin;
        res.json({ success: true, user });
    } catch (err) { console.error(err); res.status(500).json({ success: false }); }
});
app.get('/api/products', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, name, category, description, brand, price, image_url, stock, created_at FROM products ORDER BY id DESC'
        );
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }

// Admin-only products (includes purchase_price)
app.get('/api/admin/products', requireTelegramAuth, requireAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM products ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

});

// Reviews channel link (stored in settings.reviews_channel_url)
app.get('/api/reviews-channel', async (req, res) => {
    try {
        const r = await pool.query(`SELECT "${global.__SETTINGS_VALUE_COL || "value"}" AS value FROM settings WHERE "${global.__SETTINGS_KEY_COL || "key"}" = $1 LIMIT 1`, ['reviews_channel_url']);
        res.json({ url: r.rows[0]?.value || '' });
    } catch (e) {
        res.json({ url: '' });
    }
});

app.get('/api/faq', async (req, res) => {
    try { const result = await pool.query('SELECT * FROM faq ORDER BY id ASC'); res.json(result.rows); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/cart/:userId', requireTelegramAuth, requireOwnerOrAdmin(req => req.params.userId), async (req, res) => {
    try {
        const result = await pool.query(`SELECT c.product_id, c.quantity, p.name, p.price, p.image_url FROM cart_items c JOIN products p ON c.product_id = p.id WHERE c.user_telegram_id = $1 ORDER BY p.name ASC`, [req.params.userId]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Cart error' }); }
});
app.post('/api/cart/add', requireTelegramAuth, async (req, res) => {
    try {
        const userId = req.tgUserId;
        const { productId } = (req.body || {});
        if (!userId || !productId) return res.status(400).json({ success: false, error: 'BAD_REQUEST' });

        // Enforce stock limit (cannot add more than available in DB)
        const prodRes = await pool.query('SELECT stock FROM products WHERE id = $1', [productId]);
        const stock = prodRes.rows.length ? (parseInt(prodRes.rows[0].stock, 10) || 0) : 0;
        if (stock <= 0) {
            return res.status(409).json({ success: false, error: 'OUT_OF_STOCK', max: 0 });
        }

        const check = await pool.query('SELECT quantity FROM cart_items WHERE user_telegram_id = $1 AND product_id = $2', [userId, productId]);
        const currentQty = check.rows.length ? (parseInt(check.rows[0].quantity, 10) || 0) : 0;
        if (currentQty + 1 > stock) {
            return res.status(409).json({ success: false, error: 'OUT_OF_STOCK', max: stock });
        }

        if (check.rows.length > 0) {
            await pool.query('UPDATE cart_items SET quantity = quantity + 1 WHERE user_telegram_id = $1 AND product_id = $2', [userId, productId]);
        } else {
            await pool.query('INSERT INTO cart_items (user_telegram_id, product_id, quantity) VALUES ($1, $2, 1)', [userId, productId]);
        }

        res.json({ success: true, max: stock });
    } catch (err) { res.status(500).json({ error: 'Add cart error' }); }
});

// Update product fields (admin only) — currently used for editing category in admin products tab
app.put('/api/admin/product/:id', requireTelegramAuth, requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const body = (req.body || {});
        const category = (body.category !== undefined) ? String(body.category) : undefined;
        const name = (body.name !== undefined) ? String(body.name) : undefined;
        const description = (body.description !== undefined) ? String(body.description) : undefined;
        const brand = (body.brand !== undefined) ? String(body.brand) : undefined;

        const sets = [];
        const vals = [];
        let i = 1;

        if (name !== undefined) {
            const n = name.trim();
            if (!n) return res.status(400).json({ error: 'Missing name' });
            sets.push(`name = $${i++}`);
            vals.push(n);
        }

        if (description !== undefined) {
            sets.push(`description = $${i++}`);
            vals.push(description);
        }

        if (category !== undefined) {
            const c = category.trim();
            if (!c) return res.status(400).json({ error: 'Missing category' });
            sets.push(`category = $${i++}`);
            vals.push(c);
        }

        if (brand !== undefined) {
            const b = brand.trim();
            if (!b) {
                // empty brand means "auto from name"
                sets.push(`brand = NULL`);
            } else {
                sets.push(`brand = $${i++}`);
                vals.push(b);
            }
        }

        if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });

        vals.push(id);
        const result = await pool.query(
            `UPDATE products SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
            vals
        );

        if (result.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
        res.json({ success: true, product: result.rows[0] });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Update product error' });
    }
});
app.post('/api/cart/remove', requireTelegramAuth, async (req, res) => {
    try {
        const userId = req.tgUserId;
        const { productId, removeAll } = req.body;
        if (removeAll) await pool.query('DELETE FROM cart_items WHERE user_telegram_id = $1 AND product_id = $2', [userId, productId]);
        else {
            const check = await pool.query('SELECT quantity FROM cart_items WHERE user_telegram_id = $1 AND product_id = $2', [userId, productId]);
            if (check.rows.length > 0 && check.rows[0].quantity > 1) await pool.query('UPDATE cart_items SET quantity = quantity - 1 WHERE user_telegram_id = $1 AND product_id = $2', [userId, productId]);
            else await pool.query('DELETE FROM cart_items WHERE user_telegram_id = $1 AND product_id = $2', [userId, productId]);
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Remove cart error' }); }
});
app.post('/api/order', requireTelegramAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        const userId = req.tgUserId;
        const { promo_code, points_to_spend } = (req.body || {});
        const comment = ((req.body && req.body.comment) ? String(req.body.comment) : '').trim();

        // Доставка отключена — выдачу уточняем в чате
        const pickupNote = 'Уточнить выдачу в чате';
        const address = pickupNote;

        await client.query('BEGIN');

        const userRes = await client.query('SELECT * FROM users WHERE telegram_id = $1 FOR UPDATE', [userId]);
        if (userRes.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ success: false }); }
        const user = userRes.rows[0];

        const cartRes = await client.query(
            `SELECT c.quantity, c.product_id, p.name, p.description, p.price, p.stock
             FROM cart_items c
             JOIN products p ON c.product_id = p.id
             WHERE c.user_telegram_id = $1
             FOR UPDATE`,
            [userId]
        );
        if (cartRes.rows.length === 0) { await client.query('ROLLBACK'); return res.status(400).json({ success: false }); }

        const itemsRaw = cartRes.rows.map(r => ({
            quantity: parseInt(r.quantity, 10) || 0,
            product_id: r.product_id,
            name: r.name,
            description: r.description,
            price: r.price,
            stock: parseInt(r.stock, 10) || 0
        }));

        // Проверка наличия
        const bad = itemsRaw.find(i => i.quantity <= 0 || i.stock < i.quantity);
        if (bad) {
            await client.query('ROLLBACK');
            return res.status(409).json({ success: false, error: 'OUT_OF_STOCK', product_id: bad.product_id });
        }

        const orderDetails = itemsRaw.map(i => ({
            quantity: i.quantity,
            product_id: i.product_id,
            name: i.name,
            description: i.description,
            price: i.price
        }));

        // Subtotal
        let subtotal = 0;
        let itemsListText = '';
        orderDetails.forEach(item => {
            const sum = parseFloat(item.price) * item.quantity;
            subtotal += sum;
            const safeName = escapeHtml(item.name);
            const safeDesc = escapeHtml(item.description || '').trim();
            const descPart = safeDesc ? ` — ${safeDesc}` : '';
            itemsListText += `- ${safeName}${descPart} x${item.quantity} = ${sum}₽\n`;
        });

        // Promo
        let appliedPromoCode = null;
        let promoPercent = 0;
        const codeNorm = normalizePromoCode(promo_code);
        if (codeNorm) {
            const promoRes = await client.query(
                'SELECT code, discount_percent, is_active FROM promo_codes WHERE code = $1',
                [codeNorm]
            );
            if (promoRes.rows.length > 0 && promoRes.rows[0].is_active) {
                appliedPromoCode = promoRes.rows[0].code;
                promoPercent = clampInt(promoRes.rows[0].discount_percent, 0, 100);
            }
        }

        const afterPromo = promoPercent > 0 ? (subtotal - (subtotal * (promoPercent / 100))) : subtotal;

        // Points
        const userPoints = parseInt(user.points || 0, 10);
        const maxPointsByRule = Math.floor(afterPromo * 0.15);
        const requestedPoints = Math.max(0, parseInt(points_to_spend || 0, 10) || 0);
        const pointsSpent = Math.min(userPoints, requestedPoints, maxPointsByRule);

        const totalPrice = Math.max(0, Math.ceil(afterPromo - pointsSpent));

        // Списываем товар со склада СРАЗУ после оформления заказа
        for (const item of itemsRaw) {
            const upd = await client.query(
                'UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1 RETURNING stock',
                [item.quantity, item.product_id]
            );
            if (upd.rowCount === 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({ success: false, error: 'OUT_OF_STOCK', product_id: item.product_id });
            }
        }

        const safeUsername = (user.username || '').toString().trim().replace(/^@/, '');
        const userLinkHtml = safeUsername
            ? `@${escapeHtml(safeUsername)}`
            : `<a href="tg://user?id=${user.telegram_id}">ID:${user.telegram_id}</a>`;
        const promoLine = appliedPromoCode ? `\n🎟 <b>Промокод:</b> ${escapeHtml(appliedPromoCode)} (-${promoPercent}%)` : '';
        const pointsLine = pointsSpent > 0 ? `\n⭐️ <b>Списано баллов:</b> ${pointsSpent}` : '';
        const orderText = `📦 <b>НОВЫЙ ЗАКАЗ</b>\n\n👤 <b>Клиент:</b> ${userLinkHtml}\n📝 <b>Выдача:</b> ${escapeHtml(pickupNote)}\n\n${itemsListText}${promoLine}${pointsLine}\n💰 <b>ИТОГО: ${totalPrice}₽</b>`;

        const newOrder = await client.query(
            'INSERT INTO orders (user_telegram_id, details, total_price, subtotal_price, promo_code, promo_discount_percent, points_spent, address, comment, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id',
            [userId, JSON.stringify(orderDetails), totalPrice, subtotal, appliedPromoCode, promoPercent, pointsSpent, address, comment, 'active']
        );

        if (pointsSpent > 0) {
            await client.query('UPDATE users SET points = GREATEST(points - $1, 0) WHERE telegram_id = $2', [pointsSpent, userId]);
        }

        await client.query('DELETE FROM cart_items WHERE user_telegram_id = $1', [userId]);

        await client.query('COMMIT');

        getAdmins().forEach(adminId => {
            if (!adminId) return;
            bot.sendMessage(
                adminId,
                `${orderText}\n\n🔎 Перейдите в админ-панель для управления.`,
                { parse_mode: 'HTML', disable_web_page_preview: true }
            ).catch(e => console.error(e));
        });

        const orderId = newOrder.rows[0].id;
        const pickupItemsText = orderDetails.map(it => {
            const n = (it.name || '').toString().trim();
            const d = (it.description || '').toString().trim();
            const q = it.quantity;
            return `- ${n}${d ? ` — ${d}` : ''} x${q}`;
        }).join('\n');
        const pickupText = `Привет, я по поводу заказа ${orderId}\n\nСостав заказа:\n${pickupItemsText}`;
        const pickup_contact_link = `https://t.me/trippuff?text=${encodeURIComponent(pickupText)}`;

        res.json({
            success: true,
            orderId,
            orderDetails,
            pickup_contact_link,
            total_price: totalPrice,
            points_spent: pointsSpent,
            promo: { code: appliedPromoCode, promo_discount_percent: promoPercent }
        });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) {}
        res.status(500).json({ success: false });
    } finally {
        client.release();
    }
});


const server = app.listen(PORT, BIND_HOST, () => {
    console.log(`Server running on ${BIND_HOST}:${PORT}`);
    setupTelegramWebhook().catch((e) => console.error('❌ setupTelegramWebhook error:', e));
});

const shutdown = (signal) => {
    console.log(`🛑 [SIGNAL] ${signal} received - Railway is stopping the container`);
    server.close(() => {
        console.log('✅ HTTP server closed');
        process.exit(0);
    });
    // Fallback: force-exit if something hangs
    setTimeout(() => process.exit(0), 10000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
