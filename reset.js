const { Pool } = require('pg');

const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'messenger_db',
    password: '1', // Ваш пароль
    port: 5433,    // Ваш порт
});

async function resetUsers() {
    try {
        // Команда TRUNCATE CASCADE удаляет всех пользователей и каскадно всё, что к ним привязано (сообщения, чаты)
        await pool.query('TRUNCATE TABLE users CASCADE;');
        console.log('✅ База данных успешно сброшена! Все пользователи удалены.');
    } catch (err) {
        console.error('❌ Ошибка:', err);
    } finally {
        pool.end();
    }
}

resetUsers();
