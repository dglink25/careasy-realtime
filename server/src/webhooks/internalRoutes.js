// src/webhooks/internalRoutes.js
const express = require('express');
const logger = require('../utils/logger');
const { isUserOnline } = require('../socket');

const router = express.Router();

// ── Middleware : valider le secret partagé ──────────────────────────
router.use((req, res, next) => {
  const secret = req.headers['x-internal-secret'];
  if (!secret || secret !== process.env.INTERNAL_API_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
});

/**
 * POST /internal/message-confirmed
 * Appelé par Laravel juste après la création définitive d'un message
 * (avec son ID réel, l'URL du fichier uploadé si applicable).
 * Body: { conversation_id, message, sender_id, receiver_id, temporary_id }
 */
router.post('/message-confirmed', (req, res) => {
  const io = req.app.get('io');
  const { conversation_id, message, sender_id, receiver_id } = req.body;

  if (!conversation_id || !message) {
    return res.status(400).json({ error: 'conversation_id et message requis' });
  }

  // Diffuser la version confirmée à toute la conversation (y compris l'émetteur,
  // pour qu'il remplace son message optimiste par la version serveur définitive)
  io.to(`conversation:${conversation_id}`).emit('message:confirmed', {
    conversation_id,
    message,
  });

  // Marquer "delivered" immédiatement si le destinataire est en ligne
  if (receiver_id && isUserOnline(receiver_id)) {
    io.to(`conversation:${conversation_id}`).emit('messages-delivered', {
      conversation_id,
      message_ids: [message.id],
      delivered_by: receiver_id,
      delivered_at: new Date().toISOString(),
    });
  }

  // Notifier la liste des conversations du destinataire (badge non-lu, aperçu)
  if (receiver_id) {
    io.to(`user:${receiver_id}`).emit('conversation:preview-update', {
      conversation_id,
      message,
    });
  }

  return res.json({ success: true, delivered: receiver_id ? isUserOnline(receiver_id) : false });
});

/**
 * POST /internal/message-edited
 */
router.post('/message-edited', (req, res) => {
  const io = req.app.get('io');
  const { conversation_id, message } = req.body;
  if (!conversation_id || !message) return res.status(400).json({ error: 'invalide' });

  io.to(`conversation:${conversation_id}`).emit('message:edited', { conversation_id, message });
  return res.json({ success: true });
});

/**
 * POST /internal/message-deleted
 */
router.post('/message-deleted', (req, res) => {
  const io = req.app.get('io');
  const { conversation_id, message_id } = req.body;
  if (!conversation_id || !message_id) return res.status(400).json({ error: 'invalide' });

  io.to(`conversation:${conversation_id}`).emit('message:deleted', { conversation_id, message_id });
  return res.json({ success: true });
});

/**
 * POST /internal/conversation-deleted
 */
router.post('/conversation-deleted', (req, res) => {
  const io = req.app.get('io');
  const { conversation_id, other_user_id } = req.body;
  if (!conversation_id) return res.status(400).json({ error: 'invalide' });

  io.to(`conversation:${conversation_id}`).emit('conversation:deleted', { conversation_id });
  if (other_user_id) {
    io.to(`user:${other_user_id}`).emit('conversation:deleted', { conversation_id });
  }
  return res.json({ success: true });
});

/**
 * POST /internal/notification
 * Pour les notifs génériques (RDV, entreprise, etc.) qui restent gérées par
 * Laravel mais doivent atteindre l'app en temps réel sans passer par Pusher/FCM
 * lorsque l'utilisateur a l'app ouverte.
 */
router.post('/notification', (req, res) => {
  const io = req.app.get('io');
  const { user_id, event, payload } = req.body;
  if (!user_id || !event) return res.status(400).json({ error: 'invalide' });

  io.to(`user:${user_id}`).emit(event, payload || {});
  return res.json({ success: true, delivered_realtime: isUserOnline(user_id) });
});

/**
 * GET /internal/online-status/:userId
 * Permet à Laravel de demander si un user est connecté en temps réel
 * (utile pour décider d'envoyer un push FCM ou pas).
 */
router.get('/online-status/:userId', (req, res) => {
  const online = isUserOnline(req.params.userId);
  res.json({ user_id: req.params.userId, is_online: online });
});

module.exports = router;
