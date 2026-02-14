const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const multer = require('multer'); // Для загрузки фото
const FormData = require('form-data');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// 👇 ВСТАВЬ СВОЮ ССЫЛКУ!
const SERVER_URL = 'https://trippufftestback-production-2f91.up.railway.app'; 

const WEBAPP_URL = process.env.WEBAPP_URL || process.env.MINI_APP_URL || process.env.FRONTEND_URL || process.env.CLIENT_URL || '';

app.use(cors());
app.use(express.json());

// Настройка Multer (храним фото в памяти перед отправкой в ТГ)
const upload = multer({ storage: multer.memoryStorage() });

if (!process.env.DATABASE_URL) console.error("❌ Нет DATABASE_URL");
if (!process.env.BOT_TOKEN) console.error("❌ Нет BOT_TOKEN");
if (!process.env.ADMIN_CHAT_ID) console.error("❌ Нет ADMIN_CHAT_ID");

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

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
const isAdmin = (chatId) => getAdmins().includes(chatId.toString());

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

// --- АДМИНКА ---

// 1. Добавить товар (Одиночный)
app.post('/api/admin/product', upload.single('photo'), async (req, res) => {
    try {
        const { userId, name, category, description, price, purchase_price, stock } = req.body;
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });

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
app.post('/api/admin/products/batch', async (req, res) => {
    try {
        const { userId, products } = req.body;
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });
        
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
app.post('/api/admin/product/:id/image', upload.single('photo'), async (req, res) => {
    try {
        const userId = req.body.userId; // Multer parses body too
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });
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
app.delete('/api/admin/product/:id', async (req, res) => {
    try {
        const userId = req.headers['user-id']; 
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });

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
app.post('/api/admin/product/stock', async (req, res) => {
    try {
        const { userId, productId, change } = req.body;
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });
        await pool.query('UPDATE products SET stock = stock + $1 WHERE id = $2', [parseInt(change), productId]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Stock update error' }); }
});

// 3. Получить заказы
app.get('/api/admin/orders', async (req, res) => {
    try {
        const { userId, status } = req.query;
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });

        // Backward-compatible behavior:
        // - Admin UI historically запросит status=active / status=completed.
        // - Теперь новые заказы создаются со статусом 'pending' и должны быть видны в "Активные".
        const want = (status || 'active').toString();
        const result = (want === 'active')
            ? await pool.query("SELECT * FROM orders WHERE status IN ('pending','active') ORDER BY id DESC LIMIT 50")
            : await pool.query("SELECT * FROM orders WHERE status = $1 ORDER BY id DESC LIMIT 50", [want]);
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

// 3.1 Принять заказ (списание со склада происходит только здесь)
app.post('/api/admin/order/:id/accept', async (req, res) => {
    const client = await pool.connect();
    try {
        const { userId } = (req.body || {});
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });

        const orderId = parseInt(req.params.id, 10);
        if (!Number.isFinite(orderId)) return res.status(400).json({ error: 'Bad order id' });

        await client.query('BEGIN');

        const orderRes = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
        if (orderRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Order not found' });
        }

        const orderRow = orderRes.rows[0];

        // idempotency / state checks
        const st = (orderRow.status || '').toString();
        if (st === 'completed') {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Order already completed' });
        }
        if (st === 'active') {
            await client.query('COMMIT');
            return res.json({ success: true, alreadyAccepted: true });
        }
        if (st !== 'pending') {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Invalid order status' });
        }

        let items = [];
        try { items = JSON.parse(orderRow.details || '[]'); } catch (e) { items = []; }
        if (!Array.isArray(items) || items.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Order is empty' });
        }

        // Lock all involved products, check stock, then decrement.
        const productIds = Array.from(new Set(items.map(i => i && i.product_id).filter(Boolean)));
        const prodRes = await client.query(
            'SELECT id, stock FROM products WHERE id = ANY($1) FOR UPDATE',
            [productIds]
        );
        const stockMap = new Map(prodRes.rows.map(r => [Number(r.id), parseInt(r.stock, 10) || 0]));

        const 부족 = [];
        for (const it of items) {
            const pid = Number(it.product_id);
            const qty = parseInt(it.quantity, 10) || 0;
            const stock = stockMap.has(pid) ? stockMap.get(pid) : null;
            if (!pid || qty <= 0 || stock === null || stock < qty) {
                부족.push({ product_id: pid || null, requested: qty, stock: stock === null ? null : stock });
            }
        }

        if (부족.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'OUT_OF_STOCK', details: 부족 });
        }

        for (const it of items) {
            const pid = Number(it.product_id);
            const qty = parseInt(it.quantity, 10) || 0;
            await client.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [qty, pid]);
        }

        await client.query("UPDATE orders SET status = 'active' WHERE id = $1", [orderId]);

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_e) {}
        console.error(e);
        res.status(500).json({ error: 'Accept error' });
    } finally {
        client.release();
    }
});

// 4. Завершить заказ
app.post('/api/admin/order/:id/done', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });
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

// 4.1 Принять заказ (списать товар со склада)
app.post('/api/admin/order/:id/accept', async (req, res) => {
    const client = await pool.connect();
    try {
        const { userId } = (req.body || {});
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });

        const orderId = parseInt(req.params.id, 10);
        if (!Number.isFinite(orderId)) return res.status(400).json({ error: 'Bad order id' });

        await client.query('BEGIN');

        const orderRes = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
        if (orderRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Order not found' });
        }

        const order = orderRes.rows[0];

        if (order.status === 'completed') {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Order already completed' });
        }

        // idempotency: if already accepted
        if (order.status === 'active') {
            await client.query('COMMIT');
            return res.json({ success: true, alreadyAccepted: true });
        }

        // Only pending orders require acceptance.
        const items = (() => { try { return JSON.parse(order.details); } catch { return []; } })();
        if (!Array.isArray(items) || items.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Empty order items' });
        }

        const productIds = Array.from(new Set(items.map(i => parseInt(i.product_id, 10)).filter(n => Number.isFinite(n))));
        if (productIds.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Empty product ids' });
        }

        // Lock products to prevent concurrent stock changes while we check + decrement
        const prodRes = await client.query('SELECT id, stock FROM products WHERE id = ANY($1) FOR UPDATE', [productIds]);
        const stockById = new Map(prodRes.rows.map(r => [parseInt(r.id, 10), parseInt(r.stock, 10) || 0]));

        const insuff = [];
        for (const it of items) {
            const pid = parseInt(it.product_id, 10);
            const qty = parseInt(it.quantity, 10) || 0;
            const stock = stockById.has(pid) ? stockById.get(pid) : null;
            if (!pid || qty <= 0 || stock === null || stock < qty) {
                insuff.push({ product_id: pid, requested: qty, stock: stock === null ? 0 : stock, name: it.name || '' });
            }
        }

        if (insuff.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'OUT_OF_STOCK', items: insuff });
        }

        for (const it of items) {
            const pid = parseInt(it.product_id, 10);
            const qty = parseInt(it.quantity, 10) || 0;
            await client.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [qty, pid]);
        }

        await client.query("UPDATE orders SET status = 'active' WHERE id = $1", [orderId]);
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) {}
        res.status(500).json({ error: 'Accept error' });
    } finally {
        client.release();
    }
});

// 5. Редактировать заказ
app.put('/api/admin/order/:id', async (req, res) => {
    try {
        const { userId, address, comment, details, total_price } = req.body;
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });
        await pool.query(
            "UPDATE orders SET address = $1, comment = $2, details = $3, total_price = $4 WHERE id = $5",
            [address, comment, JSON.stringify(details), total_price, req.params.id]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Update error' }); }
});

// 6. Статистика
app.get('/api/admin/stats', async (req, res) => {
    try {
        const userId = req.query.userId;
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });
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

app.post('/api/admin/expense', async (req, res) => {
    try {
        const { userId, amount, comment } = req.body;
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });
        await pool.query('INSERT INTO expenses (amount, comment) VALUES ($1, $2)', [amount, comment]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

// 7. VISUAL DB MANAGER
const isValidTable = (t) => ['users', 'products', 'expenses', 'faq', 'orders', 'cart_items', 'promo_codes'].includes(t);

app.get('/api/admin/db/:table', async (req, res) => {
    try {
        if (!isAdmin(req.query.userId)) return res.status(403).json({ error: 'Denied' });
        if (!isValidTable(req.params.table)) return res.status(400).json({ error: 'Invalid table' });
        const result = await pool.query(`SELECT * FROM ${req.params.table} ORDER BY id DESC LIMIT 100`);
        res.json(result.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/db/:table', async (req, res) => {
    try {
        const userId = req.headers['user-id'];
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Denied' });
        if (!isValidTable(req.params.table)) return res.status(400).json({ error: 'Invalid table' });
        const data = req.body;
        const keys = Object.keys(data);
        const values = Object.values(data);
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
        await pool.query(`INSERT INTO ${req.params.table} (${keys.join(', ')}) VALUES (${placeholders})`, values);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/db/:table/:id', async (req, res) => {
    try {
        const userId = req.headers['user-id'];
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Denied' });
        if (!isValidTable(req.params.table)) return res.status(400).json({ error: 'Invalid table' });
        const data = req.body;
        const keys = Object.keys(data);
        const values = Object.values(data);
        const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
        await pool.query(`UPDATE ${req.params.table} SET ${setClause} WHERE id = $${values.length + 1}`, [...values, req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/db/:table/:id', async (req, res) => {
    try {
        const userId = req.headers['user-id'];
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Denied' });
        if (!isValidTable(req.params.table)) return res.status(400).json({ error: 'Invalid table' });
        await pool.query(`DELETE FROM ${req.params.table} WHERE id = $1`, [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- PROMO CODES (ADMIN) ---
app.get('/api/admin/promos', async (req, res) => {
    try {
        const { userId } = req.query;
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });
        const result = await pool.query('SELECT * FROM promo_codes ORDER BY id DESC');
        res.json(result.rows);
    } catch (e) { res.status(500).json({ error: 'Promos error' }); }
});

app.post('/api/admin/promos', async (req, res) => {
    try {
        const { userId, code, discount_percent } = req.body;
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });
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

app.put('/api/admin/promos/:id', async (req, res) => {
    try {
        const { userId, discount_percent, is_active } = req.body;
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });
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

app.delete('/api/admin/promos/:id', async (req, res) => {
    try {
        const userId = req.headers['user-id'];
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });
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
app.get('/api/user/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [req.params.id]);
        if (result.rows.length > 0) { const user = result.rows[0]; user.is_admin = isAdmin(req.params.id); res.json(user); } 
        else res.status(404).json({ message: 'User not found' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get user's own order history (for profile)
app.get('/api/user/:id/orders', async (req, res) => {
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
app.post('/api/register', async (req, res) => {
    try {
        const { userId, username, nickname } = (req.body || {});
        if (!userId) return res.status(400).json({ success: false, message: 'Missing userId' });

        const u = (username || '').toString().trim().replace(/^@/, '');
        const n = (nickname || '').toString().trim();

        const result = await pool.query(
	            `INSERT INTO users (telegram_id, username, nickname)
	             VALUES ($1, $2, $3)
             ON CONFLICT (telegram_id)
             DO UPDATE SET username = EXCLUDED.username, nickname = EXCLUDED.nickname
             RETURNING *`,
	            [userId, u, n]
        );

        const user = result.rows[0];
        user.is_admin = isAdmin(userId);
        res.json({ success: true, user });
    } catch (err) { console.error(err); res.status(500).json({ success: false }); }
});
app.get('/api/products', async (req, res) => {
    try { const result = await pool.query('SELECT * FROM products ORDER BY id DESC'); res.json(result.rows); } catch (err) { res.status(500).json({ error: err.message }); }
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
app.get('/api/cart/:userId', async (req, res) => {
    try {
        const result = await pool.query(`SELECT c.product_id, c.quantity, p.name, p.price, p.image_url FROM cart_items c JOIN products p ON c.product_id = p.id WHERE c.user_telegram_id = $1 ORDER BY p.name ASC`, [req.params.userId]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Cart error' }); }
});
app.post('/api/cart/add', async (req, res) => {
    try {
        const { userId, productId } = (req.body || {});
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
app.put('/api/admin/product/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const userId = req.headers['user-id'] || (req.body && req.body.userId);
        if (!isAdmin(userId)) return res.status(403).json({ error: 'Access denied' });

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
app.post('/api/cart/remove', async (req, res) => {
    try {
        const { userId, productId, removeAll } = req.body;
        if (removeAll) await pool.query('DELETE FROM cart_items WHERE user_telegram_id = $1 AND product_id = $2', [userId, productId]);
        else {
            const check = await pool.query('SELECT quantity FROM cart_items WHERE user_telegram_id = $1 AND product_id = $2', [userId, productId]);
            if (check.rows.length > 0 && check.rows[0].quantity > 1) await pool.query('UPDATE cart_items SET quantity = quantity - 1 WHERE user_telegram_id = $1 AND product_id = $2', [userId, productId]);
            else await pool.query('DELETE FROM cart_items WHERE user_telegram_id = $1 AND product_id = $2', [userId, productId]);
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Remove cart error' }); }
});
app.post('/api/order', async (req, res) => {
    const client = await pool.connect();
    try {
        const { userId, promo_code, points_to_spend } = (req.body || {});
        const comment = ((req.body && req.body.comment) ? String(req.body.comment) : '').trim();

        if (!userId) return res.status(400).json({ success: false });

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

        // ВАЖНО: товар НЕ списываем со склада на этапе оформления заказа.
        // Списание происходит только после принятия заказа админом (см. /api/admin/order/:id/accept).

        const safeUsername = (user.username || '').toString().trim().replace(/^@/, '');
        const userLinkHtml = safeUsername
            ? `@${escapeHtml(safeUsername)}`
            : `<a href="tg://user?id=${user.telegram_id}">ID:${user.telegram_id}</a>`;
        const promoLine = appliedPromoCode ? `\n🎟 <b>Промокод:</b> ${escapeHtml(appliedPromoCode)} (-${promoPercent}%)` : '';
        const pointsLine = pointsSpent > 0 ? `\n⭐️ <b>Списано баллов:</b> ${pointsSpent}` : '';
        const orderText = `📦 <b>НОВЫЙ ЗАКАЗ</b>\n\n👤 <b>Клиент:</b> ${userLinkHtml}\n📝 <b>Выдача:</b> ${escapeHtml(pickupNote)}\n\n${itemsListText}${promoLine}${pointsLine}\n💰 <b>ИТОГО: ${totalPrice}₽</b>\n\n⏳ <i>Ожидает принятия в админ-панели</i>`;

        const newOrder = await client.query(
            'INSERT INTO orders (user_telegram_id, details, total_price, subtotal_price, promo_code, promo_discount_percent, points_spent, address, comment, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id',
            [userId, JSON.stringify(orderDetails), totalPrice, subtotal, appliedPromoCode, promoPercent, pointsSpent, address, comment, 'pending']
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


app.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
