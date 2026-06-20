// src/db/mysql.js
const mysql = require('mysql2/promise');
const logger = require('../utils/logger');

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 15,
  queueLimit: 0,
});

/**
 * Vérifie qu'un utilisateur appartient bien à une conversation.
 * Lecture directe MySQL — beaucoup plus rapide qu'un aller-retour HTTP Laravel.
 */
async function isMemberOfConversation(userId, conversationId) {
  try {
    const [rows] = await pool.query(
      `SELECT id FROM conversations
       WHERE id = ? AND (user_one_id = ? OR user_two_id = ?)
       LIMIT 1`,
      [conversationId, userId, userId]
    );
    return rows.length > 0;
  } catch (err) {
    logger.error('isMemberOfConversation erreur SQL:', err.message);
    return false;
  }
}

/**
 * Récupère l'autre membre d'une conversation directe (pour router les events).
 */
async function getOtherUserId(userId, conversationId) {
  try {
    const [rows] = await pool.query(
      `SELECT user_one_id, user_two_id FROM conversations WHERE id = ? LIMIT 1`,
      [conversationId]
    );
    if (!rows.length) return null;
    const { user_one_id, user_two_id } = rows[0];
    return String(user_one_id) === String(userId) ? user_two_id : user_one_id;
  } catch (err) {
    logger.error('getOtherUserId erreur SQL:', err.message);
    return null;
  }
}

/** Met à jour last_seen_at directement (évite un appel HTTP Laravel) */
async function touchLastSeen(userId) {
  try {
    await pool.query(`UPDATE users SET last_seen_at = NOW() WHERE id = ?`, [userId]);
  } catch (err) {
    logger.error('touchLastSeen erreur SQL:', err.message);
  }
}

module.exports = { pool, isMemberOfConversation, getOtherUserId, touchLastSeen };
