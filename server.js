require('dotenv').config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // Отключаем строгую проверку сертификатов для Aiven на уровне Node.js
const http = require('http');
const { Server } = require('socket.io');
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcrypt');
const customParser = require('socket.io-msgpack-parser');
const multer = require('multer');
const cloudinaryStorage = require('multer-storage-cloudinary');
const cloudinaryModule = require('cloudinary');
const cloudinaryV2 = cloudinaryModule.v2;

cloudinaryV2.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = typeof cloudinaryStorage === 'function'
    ? cloudinaryStorage({
        cloudinary: cloudinaryModule,
        folder: 'messenger_app', // Папка в Cloudinary
        allowedFormats: ['jpg', 'png', 'jpeg', 'webp', 'gif']
    })
    : new cloudinaryStorage.CloudinaryStorage({
        cloudinary: cloudinaryV2,
        params: {
            folder: 'messenger_app',
            allowed_formats: ['jpg', 'png', 'jpeg', 'webp', 'gif']
        }
    });

const upload = multer({ storage: storage });

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors());
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

// Подключение к PostgreSQL
let poolConfig = {
    user: 'postgres',
    host: 'localhost',
    database: 'wb_db',
    password: 'root',
    port: 5432,
};

if (process.env.DATABASE_URL) {
    const url = new URL(process.env.DATABASE_URL);
    poolConfig = {
        user: url.username,
        password: url.password,
        host: url.hostname,
        port: url.port,
        database: url.pathname.slice(1),
        ssl: { rejectUnauthorized: false }
    };
}

const pool = new Pool(poolConfig);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }, parser: customParser });

const initDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                nickname VARCHAR(50) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                bio TEXT DEFAULT 'Новый пользователь',
                credits INTEGER DEFAULT 0,
                points INTEGER DEFAULT 0,
                rank VARCHAR(50) DEFAULT 'Новичок',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS chats (
                id SERIAL PRIMARY KEY,
                title VARCHAR(100),
                is_group BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS chat_members (
                chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                role VARCHAR(20) DEFAULT 'user',
                PRIMARY KEY (chat_id, user_id)
            );
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
                sender_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                text TEXT NOT NULL,
                is_read BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS news (
                id SERIAL PRIMARY KEY,
                title VARCHAR(255) NOT NULL,
                description TEXT NOT NULL,
                image_url VARCHAR(255),
                author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS store_items (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                type VARCHAR(50) NOT NULL,
                price INTEGER NOT NULL,
                icon VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS polls (
                id SERIAL PRIMARY KEY,
                question TEXT NOT NULL,
                is_anonymous BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS poll_options (
                id SERIAL PRIMARY KEY,
                poll_id INTEGER REFERENCES polls(id) ON DELETE CASCADE,
                option_text TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS poll_votes (
                poll_id INTEGER REFERENCES polls(id) ON DELETE CASCADE,
                option_id INTEGER REFERENCES poll_options(id) ON DELETE CASCADE,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                PRIMARY KEY (poll_id, user_id)
            );
        `);
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;');
        await pool.query('ALTER TABLE chats ADD COLUMN IF NOT EXISTS avatar_url TEXT;');
        await pool.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL;');
        await pool.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS poll_id INTEGER REFERENCES polls(id) ON DELETE CASCADE;');
        await pool.query('ALTER TABLE news ADD COLUMN IF NOT EXISTS poll_id INTEGER REFERENCES polls(id) ON DELETE CASCADE;');
        console.log('Таблицы PostgreSQL успешно инициализированы.');
    } catch (err) { console.error(' Ошибка при создании таблиц:', err); }
};
initDB();

// --- UPLOAD API ---
app.post('/api/upload', (req, res) => {
    upload.single('image')(req, res, function (err) {
        if (err) {
            console.error('Ошибка Multer:', err);
            return res.status(500).json({ error: err.message || 'Ошибка при загрузке. ' + String(err) });
        }
        if (!req.file) {
            return res.status(400).json({ error: 'Файл не загружен' });
        }
        const fileUrl = req.file.path || req.file.secure_url || req.file.url;
        res.json({ url: fileUrl });
    });
});

// --- API ---
app.post('/api/register', async (req, res) => {
    const { nickname, password } = req.body;
    if (!nickname || nickname.length < 3 || nickname.length > 16) {
        return res.status(400).json({ success: false, message: 'Имя пользователя должно быть от 3 до 16 символов' });
    }
    try {
        const hash = await bcrypt.hash(password, 10);
        const result = await pool.query('INSERT INTO users (nickname, password) VALUES ($1, $2) RETURNING id, nickname, rank', [nickname, hash]);
        const newUser = result.rows[0];
        const newChat = await pool.query("INSERT INTO chats (title, is_group) VALUES ('Избранное', false) RETURNING id");
        await pool.query('INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2)', [newChat.rows[0].id, newUser.id]);
        res.status(201).json({ success: true, user: newUser });
    } catch (err) {
        if (err.code === '23505') res.status(400).json({ success: false, message: 'Этот никнейм уже занят' });
        else res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

app.post('/api/login', async (req, res) => {
    const { nickname, password } = req.body;
    try {
        const result = await pool.query('SELECT id, nickname, password, bio, credits, points, rank, avatar_url FROM users WHERE nickname = $1', [nickname]);
        if (result.rows.length > 0) {
            const user = result.rows[0];
            const isValid = await bcrypt.compare(password, user.password);
            if (isValid) {
                delete user.password;
                res.json({ success: true, user });
            } else {
                res.status(401).json({ success: false, message: 'Неверный никнейм или пароль' });
            }
        } else {
            res.status(401).json({ success: false, message: 'Неверный никнейм или пароль' });
        }
    } catch (err) { res.status(500).json({ success: false, message: 'Ошибка сервера' }); }
});

// --- NEWS API ---
app.get('/api/news', async (req, res) => {
    const userId = req.query.userId;
    try {
        const result = await pool.query(`
            SELECT n.*, u.nickname as author_name, u.rank as author_rank, u.avatar_url as author_avatar,
                p.question as poll_question,
                p.is_anonymous as poll_anonymous,
                (SELECT json_agg(json_build_object(
                    'id', po.id, 
                    'option_text', po.option_text, 
                    'vote_count', (SELECT COUNT(*) FROM poll_votes pv WHERE pv.option_id = po.id),
                    'my_vote', EXISTS(SELECT 1 FROM poll_votes pv2 WHERE pv2.option_id = po.id AND pv2.user_id = $1)
                )) FROM poll_options po WHERE po.poll_id = p.id) as poll_options_data
            FROM news n 
            LEFT JOIN users u ON n.author_id = u.id 
            LEFT JOIN polls p ON n.poll_id = p.id
            ORDER BY n.created_at DESC
        `, [userId || 0]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/news', async (req, res) => {
    const { title, description, image_url, author_id, poll_id } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO news (title, description, image_url, author_id, poll_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [title, description, image_url, author_id, poll_id || null]
        );
        await giveActionPoints(author_id, 50); // Бонус за опубликованную новость
        res.status(201).json({ success: true, news: result.rows[0] });
    } catch (err) { res.status(500).json({ error: 'Ошибка при создании новости' }); }
});

app.delete('/api/news/:id', async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'Не указан пользователь' });

    try {
        const userRes = await pool.query('SELECT rank, id FROM users WHERE id = $1', [userId]);
        if (userRes.rows.length === 0) return res.status(404).json({ error: 'Пользователь не найден' });
        const user = userRes.rows[0];
        const isModerator = user.rank && (user.rank.includes('Всевышний') || user.rank.includes('Куратор'));

        const newsRes = await pool.query('SELECT author_id FROM news WHERE id = $1', [req.params.id]);
        if (newsRes.rows.length === 0) return res.status(404).json({ error: 'Новость не найдена' });
        const newsAuthorId = newsRes.rows[0].author_id;

        const isAuthor = (user.id === newsAuthorId);

        if (!isModerator && !isAuthor) {
            return res.status(403).json({ error: 'Недостаточно прав' });
        }

        await pool.query('DELETE FROM news WHERE id = $1', [req.params.id]);

        if (isAuthor) {
            await pool.query('UPDATE users SET points = GREATEST(points - 50, 0) WHERE id = $1', [user.id]);
        }
        res.json({ success: true });
    } catch (err) {
        console.error('Ошибка при удалении новости:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/api/moderation/assign-curator', async (req, res) => {
    const { adminId, targetNickname } = req.body;
    try {
        const adminRes = await pool.query('SELECT rank FROM users WHERE id = $1', [adminId]);
        if (adminRes.rows.length === 0 || !adminRes.rows[0].rank || !adminRes.rows[0].rank.includes('Всевышний')) {
            return res.status(403).json({ error: 'Только Всевышний может раздавать роли' });
        }
        const targetRes = await pool.query("UPDATE users SET rank = 'Куратор' WHERE nickname = $1 RETURNING id", [targetNickname]);
        if (targetRes.rows.length === 0) return res.status(404).json({ error: 'Пользователь не найден' });
        res.json({ success: true });
    } catch (err) {
        console.error('Ошибка при выдаче роли:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.get('/api/users', async (req, res) => {
    try { const result = await pool.query('SELECT id, nickname, bio, rank, points, avatar_url FROM users ORDER BY points DESC'); res.json(result.rows); }
    catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/profile/:nickname', async (req, res) => {
    try {
        const result = await pool.query('SELECT nickname, bio, credits, points, rank, avatar_url FROM users WHERE nickname = $1', [req.params.nickname]);
        if (result.rows.length > 0) res.json(result.rows[0]); else res.status(404).json({ error: 'Не найден' });
    } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/profile/update-bio', async (req, res) => {
    try {
        await pool.query('UPDATE users SET bio = $1, avatar_url = COALESCE($2, avatar_url) WHERE nickname = $3', [req.body.bio, req.body.avatar_url, req.body.nickname]);
        res.json({ success: true });
    }
    catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/profile/update-nickname', async (req, res) => {
    const { userId, newNickname } = req.body;
    if (!newNickname || newNickname.length < 3 || newNickname.length > 16) {
        return res.status(400).json({ error: 'Имя пользователя должно быть от 3 до 16 символов' });
    }
    try {
        await pool.query('UPDATE users SET nickname = $1 WHERE id = $2', [newNickname, userId]);
        res.json({ success: true });
    } catch (err) {
        if (err.code === '23505') {
            res.status(400).json({ error: 'Этот никнейм уже занят' });
        } else {
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    }
});

app.post('/api/chats/get-or-create', async (req, res) => {
    const { user1_id, user2_id } = req.body;
    const isSelf = (user1_id == user2_id);
    try {
        if (isSelf) {
            const existingChat = await pool.query(`SELECT c.id as chat_id FROM chats c JOIN chat_members cm ON c.id = cm.chat_id WHERE c.is_group = false GROUP BY c.id HAVING COUNT(cm.user_id) = 1 AND MAX(cm.user_id) = $1`, [user1_id]);
            if (existingChat.rows.length > 0) return res.json({ chat_id: existingChat.rows[0].chat_id });
        } else {
            const existingChat = await pool.query(`SELECT c.id as chat_id FROM chats c JOIN chat_members cm1 ON c.id = cm1.chat_id JOIN chat_members cm2 ON c.id = cm2.chat_id WHERE c.is_group = false AND cm1.user_id = $1 AND cm2.user_id = $2`, [user1_id, user2_id]);
            if (existingChat.rows.length > 0) return res.json({ chat_id: existingChat.rows[0].chat_id });
        }
        const newChat = await pool.query('INSERT INTO chats (title, is_group) VALUES ($1, false) RETURNING id', [isSelf ? 'Избранное' : null]);
        if (isSelf) await pool.query('INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2)', [newChat.rows[0].id, user1_id]);
        else await pool.query('INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2), ($1, $3)', [newChat.rows[0].id, user1_id, user2_id]);
        res.json({ chat_id: newChat.rows[0].id });
    } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/chats/create-group', async (req, res) => {
    try {
        const newChat = await pool.query('INSERT INTO chats (title, is_group, avatar_url) VALUES ($1, true, $2) RETURNING id', [req.body.title, req.body.avatar_url]);
        await pool.query("INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, 'admin')", [newChat.rows[0].id, req.body.creator_id]);
        res.json({ success: true, chat_id: newChat.rows[0].id });
    } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/chats/:chatId/members', async (req, res) => {
    try {
        const result = await pool.query(`SELECT u.id, u.nickname, u.rank, u.avatar_url, cm.role FROM chat_members cm JOIN users u ON cm.user_id = u.id WHERE cm.chat_id = $1 ORDER BY CASE WHEN cm.role = 'admin' THEN 1 WHEN cm.role = 'moderator' THEN 2 ELSE 3 END`, [req.params.chatId]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

// ИСПРАВЛЕНА СОРТИРОВКА (Теперь новые беседы падают сразу под "Избранное")
app.get('/api/chats/my/:userId', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT c.id as chat_id, c.is_group, c.avatar_url as group_avatar,
                COALESCE(c.title, (SELECT nickname FROM users u JOIN chat_members cm ON u.id = cm.user_id WHERE cm.chat_id = c.id AND u.id != $1 LIMIT 1), 'Избранное') as chat_name,
                (SELECT avatar_url FROM users u JOIN chat_members cm ON u.id = cm.user_id WHERE cm.chat_id = c.id AND u.id != $1 LIMIT 1) as other_avatar,
                COALESCE((SELECT rank FROM users u JOIN chat_members cm ON u.id = cm.user_id WHERE cm.chat_id = c.id AND u.id != $1 LIMIT 1), (SELECT rank FROM users WHERE id = $1)) as chat_rank,
                (SELECT text FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1) as last_msg,
                (SELECT COUNT(*) FROM messages WHERE chat_id = c.id AND sender_id != $1 AND is_read = false) as unread_count
            FROM chats c JOIN chat_members cm ON c.id = cm.chat_id WHERE cm.user_id = $1
            ORDER BY 
                CASE WHEN COALESCE(c.title, (SELECT nickname FROM users u JOIN chat_members cm ON u.id = cm.user_id WHERE cm.chat_id = c.id AND u.id != $1 LIMIT 1), 'Избранное') = 'Избранное' THEN 0 ELSE 1 END ASC,
                COALESCE((SELECT created_at FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1), c.created_at) DESC
        `, [req.params.userId]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/messages/:chatId', async (req, res) => {
    const userId = req.query.userId;
    try {
        const result = await pool.query(`
            SELECT m.*, u.nickname as sender_name, u.rank as sender_rank, u.avatar_url as sender_avatar, cm.role as sender_role,
                (SELECT text FROM messages WHERE id = m.reply_to_id) as reply_text,
                (SELECT u2.nickname FROM users u2 JOIN messages m2 ON u2.id = m2.sender_id WHERE m2.id = m.reply_to_id) as reply_author,
                p.question as poll_question,
                p.is_anonymous as poll_anonymous,
                (SELECT json_agg(json_build_object(
                    'id', po.id, 
                    'option_text', po.option_text, 
                    'vote_count', (SELECT COUNT(*) FROM poll_votes pv WHERE pv.option_id = po.id),
                    'my_vote', EXISTS(SELECT 1 FROM poll_votes pv2 WHERE pv2.option_id = po.id AND pv2.user_id = $2)
                )) FROM poll_options po WHERE po.poll_id = p.id) as poll_options_data
            FROM messages m 
            JOIN users u ON m.sender_id = u.id 
            JOIN chat_members cm ON m.chat_id = cm.chat_id AND m.sender_id = cm.user_id 
            LEFT JOIN polls p ON m.poll_id = p.id
            WHERE m.chat_id = $1 
            ORDER BY m.created_at ASC
        `, [req.params.chatId, userId || 0]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/polls', async (req, res) => {
    const { question, is_anonymous, options, creator_id } = req.body;
    try {
        const pollRes = await pool.query("INSERT INTO polls (question, is_anonymous, creator_id) VALUES ($1, $2, $3) RETURNING id", [question, is_anonymous, creator_id]);
        const pollId = pollRes.rows[0].id;
        for (const opt of options) {
            await pool.query("INSERT INTO poll_options (poll_id, option_text) VALUES ($1, $2)", [pollId, opt]);
        }
        res.json({ success: true, poll_id: pollId });
    } catch (err) { res.status(500).json({ error: 'Ошибка создания опроса' }); }
});

app.post('/api/polls/:id/vote', async (req, res) => {
    const { optionId, userId } = req.body;
    const pollId = req.params.id;
    try {
        await pool.query('DELETE FROM poll_votes WHERE poll_id = $1 AND user_id = $2', [pollId, userId]);
        await pool.query('INSERT INTO poll_votes (poll_id, option_id, user_id) VALUES ($1, $2, $3)', [pollId, optionId, userId]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Ошибка голосования' }); }
});

app.get('/api/polls/:id/results', async (req, res) => {
    const pollId = req.params.id;
    try {
        const pollRes = await pool.query('SELECT is_anonymous FROM polls WHERE id = $1', [pollId]);
        if (pollRes.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        if (pollRes.rows[0].is_anonymous) return res.status(403).json({ error: 'Анонимное голосование' });

        const result = await pool.query(`
            SELECT u.nickname, po.option_text 
            FROM poll_votes pv 
            JOIN users u ON pv.user_id = u.id 
            JOIN poll_options po ON pv.option_id = po.id 
            WHERE pv.poll_id = $1
            ORDER BY po.id ASC
        `, [pollId]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Ошибка загрузки результатов' }); }
});

// --- РАНГОВАЯ СИСТЕМА И ОПЫТ ---
const RANK_THRESHOLDS = [
    { rank: '🌟 Легенда', threshold: 5000 },
    { rank: '👑 Старейшина', threshold: 1500 },
    { rank: '🛡️ Доверенный', threshold: 500 },
    { rank: '⚡ Активный', threshold: 100 },
    { rank: 'Новичок', threshold: 0 }
];

const onlineUsers = new Set();
async function giveActionPoints(userId, pointsToAdd) {
    if (!userId || pointsToAdd <= 0) return;
    try {
        const res = await pool.query('UPDATE users SET points = points + $1 WHERE id = $2 RETURNING points, rank', [pointsToAdd, userId]);
        if (res.rows.length === 0) return;

        const currentRank = res.rows[0].rank;
        const newPoints = res.rows[0].points;

        if (currentRank.includes('Всевышний') || currentRank.includes('Админ')) return;

        let targetRank = 'Новичок';
        for (let t of RANK_THRESHOLDS) {
            if (newPoints >= t.threshold) {
                targetRank = t.rank;
                break;
            }
        }

        if (currentRank !== targetRank) {
            await pool.query('UPDATE users SET rank = $1 WHERE id = $2', [targetRank, userId]);
        }
    } catch (e) { console.error('Exp error', e); }
}

// 1 балл раз в минуту для всех, кто онлайн
setInterval(async () => {
    const userIds = Array.from(onlineUsers);
    for (const uid of userIds) {
        await giveActionPoints(uid, 1);
    }
}, 60 * 1000);

// --- SOCKET.IO ---
io.on('connection', (socket) => {
    socket.on('user_login', (userId) => {
        socket.userId = userId;
        onlineUsers.add(userId);
        socket.join(`user_${userId}`);
    });

    socket.on('disconnect', () => {
        if (socket.userId) onlineUsers.delete(socket.userId);
    });

    socket.on('join_room', (chatId) => socket.join(`chat_${chatId}`));

    socket.on('send_msg', async (data) => {
        try {
            const insRes = await pool.query('INSERT INTO messages (chat_id, sender_id, text, reply_to_id, poll_id) VALUES ($1, $2, $3, $4, $5) RETURNING id', [data.chatId, data.senderId, data.text, data.replyToId || null, data.pollId || null]);
            const msgFull = await pool.query(`
                SELECT m.*, u.nickname as sender_name, u.rank as sender_rank, u.avatar_url as sender_avatar, cm.role as sender_role,
                    (SELECT text FROM messages WHERE id = m.reply_to_id) as reply_text,
                    (SELECT u2.nickname FROM users u2 JOIN messages m2 ON u2.id = m2.sender_id WHERE m2.id = m.reply_to_id) as reply_author,
                    p.question as poll_question,
                    p.is_anonymous as poll_anonymous,
                    (SELECT json_agg(json_build_object(
                        'id', po.id,  'option_text', po.option_text,  'vote_count', 0, 'my_vote', false
                    )) FROM poll_options po WHERE po.poll_id = p.id) as poll_options_data
                FROM messages m 
                JOIN users u ON m.sender_id = u.id 
                JOIN chat_members cm ON m.chat_id = cm.chat_id AND m.sender_id = cm.user_id 
                LEFT JOIN polls p ON m.poll_id = p.id
                WHERE m.id = $1
            `, [insRes.rows[0].id]);
            io.to(`chat_${data.chatId}`).emit('new_msg', msgFull.rows[0]);

            // Начисление опыта за сообщение
            const chatRes = await pool.query(`SELECT c.is_group, c.title, (SELECT COUNT(*) FROM chat_members WHERE chat_id = c.id) as mem_count FROM chats c WHERE c.id = $1`, [data.chatId]);
            if (chatRes.rows.length > 0) {
                const chat = chatRes.rows[0];
                let pointsToGive = 0;
                if (!chat.is_group && chat.title === 'Избранное') {
                    pointsToGive = 0; // В Избранном опыта нет
                } else if (!chat.is_group) {
                    pointsToGive = 2; // В ЛС
                } else {
                    pointsToGive = parseInt(chat.mem_count) || 2; // Количество участников
                }

                if (pointsToGive > 0) await giveActionPoints(data.senderId, pointsToGive);
            }

            const members = await pool.query('SELECT user_id FROM chat_members WHERE chat_id = $1', [data.chatId]);
            members.rows.forEach(r => io.to(`user_${r.user_id}`).emit('update_chat_list'));
        } catch (err) { console.error(err); }
    });

    socket.on('mark_read', async (data) => {
        try {
            await pool.query('UPDATE messages SET is_read = true WHERE chat_id = $1 AND sender_id != $2 AND is_read = false', [data.chatId, data.userId]);
            const members = await pool.query('SELECT user_id FROM chat_members WHERE chat_id = $1', [data.chatId]);
            members.rows.forEach(r => io.to(`user_${r.user_id}`).emit('update_chat_list'));
        } catch (err) { }
    });

    socket.on('add_to_group', async (data) => {
        try {
            const user = await pool.query('SELECT id FROM users WHERE nickname = $1', [data.nickname]);
            if (user.rows.length === 0) return;
            await pool.query('INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [data.chatId, user.rows[0].id]);
            const members = await pool.query('SELECT user_id FROM chat_members WHERE chat_id = $1', [data.chatId]);
            members.rows.forEach(r => io.to(`user_${r.user_id}`).emit('update_chat_list'));
            io.to(`chat_${data.chatId}`).emit('group_structure_changed', data.chatId); // Сигнал для обновления инфо
        } catch (err) { }
    });

    socket.on('kick_user', async (data) => {
        try {
            const check = await pool.query('SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2', [data.chatId, data.adminId]);
            if (check.rows.length === 0 || check.rows[0].role === 'user') return;
            await pool.query('DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2', [data.chatId, data.targetId]);
            io.to(`user_${data.targetId}`).emit('update_chat_list');
            const members = await pool.query('SELECT user_id FROM chat_members WHERE chat_id = $1', [data.chatId]);
            members.rows.forEach(r => io.to(`user_${r.user_id}`).emit('update_chat_list'));
            io.to(`chat_${data.chatId}`).emit('group_structure_changed', data.chatId); // Сигнал для обновления инфо
        } catch (err) { }
    });

    socket.on('set_user_role', async (data) => {
        try {
            const check = await pool.query("SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2", [data.chatId, data.adminId]);
            if (check.rows.length === 0 || check.rows[0].role !== 'admin') return;
            await pool.query('UPDATE chat_members SET role = $1 WHERE chat_id = $2 AND user_id = $3', [data.role, data.chatId, data.targetId]);
            io.to(`chat_${data.chatId}`).emit('group_structure_changed', data.chatId); // Сигнал для обновления инфо
        } catch (err) { }
    });

    socket.on('rename_group', async (data) => {
        try {
            const check = await pool.query('SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2', [data.chatId, data.adminId]);
            if (check.rows.length === 0 || check.rows[0].role === 'user') return;
            await pool.query('UPDATE chats SET title = $1 WHERE id = $2 AND is_group = true', [data.newTitle, data.chatId]);
            const members = await pool.query('SELECT user_id FROM chat_members WHERE chat_id = $1', [data.chatId]);
            members.rows.forEach(r => io.to(`user_${r.user_id}`).emit('group_renamed', data));
        } catch (err) { }
    });

    // УДАЛЕНИЕ БЕСЕДЫ
    socket.on('delete_group', async (data) => {
        try {
            const check = await pool.query('SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2', [data.chatId, data.adminId]);
            if (check.rows.length === 0 || check.rows[0].role !== 'admin') return;

            const members = await pool.query('SELECT user_id FROM chat_members WHERE chat_id = $1', [data.chatId]);
            await pool.query('DELETE FROM chats WHERE id = $1', [data.chatId]); // Каскадное удаление уберет участников и сообщения

            members.rows.forEach(r => {
                io.to(`user_${r.user_id}`).emit('group_deleted', data.chatId);
            });
        } catch (err) { }
    });
});

server.listen(3000, () => console.log('Сервер готов: http://localhost:3000'));