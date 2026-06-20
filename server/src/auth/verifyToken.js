// src/auth/verifyToken.js
const axios = require('axios');
const logger = require('../utils/logger');

const LARAVEL_URL = process.env.LARAVEL_INTERNAL_URL;
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET;

// ── Cache mémoire court (10s) ────────────────────────────────────
// But : si un utilisateur a 3 onglets / reconnecte son socket en boucle
// (réseau instable), on ne tape pas Laravel à chaque fois.
// 10s est assez court pour qu'une révocation de token (logout) soit
// respectée rapidement, mais assez long pour absorber les rafales.
const cache = new Map(); // token -> { user, expiresAt }
const CACHE_TTL_MS = 10_000;

setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of cache.entries()) {
    if (entry.expiresAt < now) cache.delete(token);
  }
}, 30_000);

/**
 * Vérifie un token auprès de Laravel (endpoint interne dédié).
 * Retourne { id, name, ... } si valide, null sinon.
 */
async function verifyToken(token) {
  if (!token) return null;

  const cached = cache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.user;
  }

  try {
    const resp = await axios.get(`${LARAVEL_URL}/api/internal/verify-token`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Internal-Secret': INTERNAL_SECRET,
        Accept: 'application/json',
      },
      timeout: 5000,
    });

    if (resp.status === 200 && resp.data?.user) {
      const user = resp.data.user;
      cache.set(token, { user, expiresAt: Date.now() + CACHE_TTL_MS });
      return user;
    }
    return null;
  } catch (err) {
    logger.warn('verifyToken: échec vérification', {
      status: err.response?.status,
      message: err.message,
    });
    return null;
  }
}

/** Invalide immédiatement le cache pour un token (ex: logout) */
function invalidateToken(token) {
  cache.delete(token);
}

module.exports = { verifyToken, invalidateToken };
