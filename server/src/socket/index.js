// src/socket/index.js
const { verifyToken } = require('../auth/verifyToken');
const { isMemberOfConversation, getOtherUserId, touchLastSeen } = require('../db/mysql');
const logger = require('../utils/logger');

// userId (string) -> Set<socketId>  — un user peut avoir plusieurs sockets (multi-device)
const userSockets = new Map();

// Anti-spam typing : userId:convId -> timestamp dernier envoi
const lastTypingEmit = new Map();
const TYPING_THROTTLE_MS = 1500;

const initSocket = (io) => {
  // ── Auth middleware ─────────────────────────────────────────────
  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.split(' ')[1];

      if (!token) return next(new Error('Token manquant'));

      const user = await verifyToken(token);
      if (!user || !user.id) return next(new Error('Token invalide'));

      socket.userId = String(user.id);
      socket.user = user;
      socket.authToken = token;
      next();
    } catch (err) {
      logger.error('Erreur middleware auth socket:', err.message);
      next(new Error('Authentification échouée'));
    }
  });

  io.on('connection', async (socket) => {
    const userId = socket.userId;
    logger.info(`Connecté: ${userId} (${socket.id})`);

    // ── Enregistrer le socket ──────────────────────────────────────
    if (!userSockets.has(userId)) userSockets.set(userId, new Set());
    userSockets.get(userId).add(socket.id);

    socket.join(`user:${userId}`);

    const isFirstConnection = userSockets.get(userId).size === 1;

    // ── Présence : seulement si c'est la 1ère connexion de cet user ──
    if (isFirstConnection) {
      touchLastSeen(userId).catch(() => {});
      io.emit('user-status', {
        user_id: userId,
        is_online: true,
        last_seen_at: new Date().toISOString(),
      });
    }

    // Confirmer au client que le socket est prêt (remplace pusher:subscription_succeeded)
    socket.emit('connection:ready', { userId });

    // ════════════════════════════════════════════════════════════
    //  REJOINDRE / QUITTER UNE CONVERSATION
    // ════════════════════════════════════════════════════════════

    socket.on('conversation:join', async ({ conversationId }) => {
      if (!conversationId) return;
      const allowed = await isMemberOfConversation(userId, conversationId);
      if (!allowed) {
        socket.emit('error', { message: 'Accès refusé à cette conversation' });
        return;
      }
      socket.join(`conversation:${conversationId}`);
    });

    socket.on('conversation:leave', ({ conversationId }) => {
      if (conversationId) socket.leave(`conversation:${conversationId}`);
    });

    // ════════════════════════════════════════════════════════════
    //  MESSAGE ENVOYÉ (broadcast immédiat — créé via API HTTP Laravel,
    //  Node ne fait que relayer l'événement une fois le message confirmé)
    // ════════════════════════════════════════════════════════════

    // Le flux réel : le client envoie via HTTP POST à Laravel (upload fichier etc.)
    // Laravel, une fois le message créé, appelle ce serveur Node via un webhook
    // interne pour diffuser l'event (voir src/webhooks/messageBroadcast.js).
    // Mais pour les message texte purs, on permet aussi un chemin direct socket
    // → optimistic ultra-rapide → Laravel persiste en arrière-plan.

    socket.on('message:send', async (payload, ack) => {
      const { conversation_id, temporary_id, content, type = 'text', latitude, longitude, reply_to_id } = payload;

      if (!conversation_id || (!content && type === 'text')) {
        if (ack) ack({ success: false, error: 'Données invalides' });
        return;
      }

      const allowed = await isMemberOfConversation(userId, conversation_id);
      if (!allowed) {
        if (ack) ack({ success: false, error: 'Non autorisé' });
        return;
      }

      // 1. Diffuser IMMÉDIATEMENT à la conversation (optimistic broadcast)
      //    avec un statut "sending" — les autres clients verront le message
      //    arriver en moins de 50ms sur le LAN/bonne connexion.
      const optimisticMsg = {
        temporary_id,
        conversation_id,
        sender_id: userId,
        content: content || '',
        type,
        latitude,
        longitude,
        reply_to_id,
        status: 'sending',
        created_at: new Date().toISOString(),
      };

      socket.to(`conversation:${conversation_id}`).emit('message:incoming', {
        conversation_id,
        message: optimisticMsg,
      });

      // 2. Notifier le destinataire même s'il n'a pas le channel conversation ouvert
      //    (pour mettre à jour sa liste de conversations en temps réel)
      const otherUserId = await getOtherUserId(userId, conversation_id);
      if (otherUserId) {
        io.to(`user:${otherUserId}`).emit('conversation:preview-update', {
          conversation_id,
          message: optimisticMsg,
        });
      }

      // 3. Accuser réception au client émetteur tout de suite (round-trip rapide)
      if (ack) ack({ success: true, temporary_id });

      // 4. La confirmation définitive (avec l'ID réel base de données, l'URL du
      //    fichier uploadé, etc.) arrive via webhook Laravel → broadcastConfirmed()
      //    plus bas, qui émettra 'message:confirmed'.
    });

    // ════════════════════════════════════════════════════════════
    //  TYPING INDICATOR (avec throttle anti-spam)
    // ════════════════════════════════════════════════════════════

    socket.on('typing', ({ conversation_id, is_typing }) => {
      if (!conversation_id) return;

      const key = `${userId}:${conversation_id}`;
      const now = Date.now();

      if (is_typing) {
        const last = lastTypingEmit.get(key) || 0;
        if (now - last < TYPING_THROTTLE_MS) return; // throttle
        lastTypingEmit.set(key, now);
      } else {
        lastTypingEmit.delete(key);
      }

      socket.to(`conversation:${conversation_id}`).emit('typing-indicator', {
        conversation_id,
        user_id: userId,
        is_typing: !!is_typing,
      });
    });

    // ════════════════════════════════════════════════════════════
    //  RECORDING INDICATOR (vocal en cours)
    // ════════════════════════════════════════════════════════════

    socket.on('recording', ({ conversation_id, is_recording }) => {
      if (!conversation_id) return;
      socket.to(`conversation:${conversation_id}`).emit('recording-indicator', {
        conversation_id,
        user_id: userId,
        is_recording: !!is_recording,
      });
    });

    // ════════════════════════════════════════════════════════════
    //  ACCUSÉS DE RÉCEPTION (delivered / read) — temps réel pur,
    //  pas besoin de passer par Laravel pour ça
    // ════════════════════════════════════════════════════════════

    socket.on('messages:delivered', ({ conversation_id, message_ids }) => {
      if (!conversation_id || !Array.isArray(message_ids) || !message_ids.length) return;
      socket.to(`conversation:${conversation_id}`).emit('messages-delivered', {
        conversation_id,
        message_ids,
        delivered_by: userId,
        delivered_at: new Date().toISOString(),
      });
    });

    socket.on('messages:read', ({ conversation_id, message_ids }) => {
      if (!conversation_id) return;
      socket.to(`conversation:${conversation_id}`).emit('messages-read', {
        conversation_id,
        message_ids: message_ids || [],
        user_id: userId,
        read_at: new Date().toISOString(),
      });
    });

    // ════════════════════════════════════════════════════════════
    //  STATUT MANUEL (ex: passer "absent")
    // ════════════════════════════════════════════════════════════

    socket.on('user:set-status', ({ is_online }) => {
      io.emit('user-status', {
        user_id: userId,
        is_online: !!is_online,
        last_seen_at: new Date().toISOString(),
      });
    });

    // ════════════════════════════════════════════════════════════
    //  DÉCONNEXION
    // ════════════════════════════════════════════════════════════

    socket.on('disconnect', async () => {
      const sockets = userSockets.get(userId);
      if (!sockets) return;
      sockets.delete(socket.id);

      if (sockets.size === 0) {
        userSockets.delete(userId);
        const lastSeen = new Date().toISOString();
        touchLastSeen(userId).catch(() => {});
        io.emit('user-status', {
          user_id: userId,
          is_online: false,
          last_seen_at: lastSeen,
        });
        logger.info(`Déconnecté (toutes sockets fermées): ${userId}`);
      }
    });

    socket.on('error', (err) => {
      logger.error(`Erreur socket ${socket.id}:`, err?.message || err);
    });
  });

  return io;
};

// ── Helpers exposés pour les webhooks Laravel → Node ────────────────

const isUserOnline = (userId) => {
  const s = userSockets.get(String(userId));
  return !!s && s.size > 0;
};

const getUserSocketCount = (userId) => userSockets.get(String(userId))?.size || 0;

module.exports = { initSocket, isUserOnline, getUserSocketCount };
