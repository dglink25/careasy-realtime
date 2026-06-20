// src/server.js
'use strict';
require('dotenv').config();

const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { createClient } = require('redis');

const logger = require('./utils/logger');
const { initSocket } = require('./socket');
const internalRoutes = require('./webhooks/internalRoutes');

const app = express();

const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // apps mobiles natives
    if (allowedOrigins.includes(origin)) return cb(null, true);
    if (process.env.NODE_ENV !== 'production') return cb(null, true);
    cb(new Error('CORS non autorisé'));
  },
  credentials: true,
}));

app.use(express.json({ limit: '5mb' }));

// ── Santé ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status: 'ok',
  service: 'CarEasy Realtime',
  timestamp: new Date().toISOString(),
  uptime: process.uptime(),
}));

// ── Routes internes appelées par Laravel ─────────────────────────────
app.use('/internal', internalRoutes);

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      if (process.env.NODE_ENV !== 'production') return callback(null, true);
      callback(new Error('CORS Socket.IO non autorisé'));
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 30000,
  pingInterval: 15000,
  connectTimeout: 20000,
  // Pour gros volume : éviter la compression CPU-intensive par défaut
  perMessageDeflate: false,
  // Limiter la taille des messages (évite les abus, le gros transfert
  // de fichiers passe par HTTP Laravel, pas par le socket)
  maxHttpBufferSize: 1e6, // 1 Mo
});

// ── Redis adapter : indispensable dès qu'on a >1 instance Node ──────
// Sans ça, un message émis sur l'instance A n'atteint pas un socket
// connecté à l'instance B → c'est le point n°1 qui casse le "temps réel"
// en prod à grande échelle.
async function setupRedisAdapter() {
  if (!process.env.REDIS_HOST) {
    logger.warn('REDIS_HOST non défini — adapter Redis désactivé (mono-instance uniquement)');
    return;
  }
  try {
    const redisUrl = process.env.REDIS_URL;
    const pubClient = createClient({ url: redisUrl });
    const subClient = pubClient.duplicate();

    await Promise.all([pubClient.connect(), subClient.connect()]);
    io.adapter(createAdapter(pubClient, subClient));
    logger.info('Redis adapter activé — scalabilité multi-instance OK');
  } catch (err) {
    logger.error('Erreur connexion Redis adapter:', err.message);
    logger.warn('Le serveur continue en mode mono-instance');
  }
}

app.set('io', io);

const PORT = parseInt(process.env.PORT) || 6001;

async function bootstrap() {
  await setupRedisAdapter();
  initSocket(io);

  server.listen(PORT, '0.0.0.0', () => {
    logger.info(`
╔══════════════════════════════════════════════════════╗
║         CarEasy — Serveur Temps Réel                 ║
║  Port: ${PORT}                                            ║
║  Env: ${process.env.NODE_ENV || 'development'}                                  ║
╚══════════════════════════════════════════════════════╝`);
  });
}

bootstrap();

const gracefulShutdown = (signal) => {
  logger.info(`Signal ${signal} reçu — arrêt propre...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000);
};
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('unhandledRejection', (r) => logger.error('Promesse rejetée:', r));
process.on('uncaughtException', (e) => { logger.error('Exception non gérée:', e); process.exit(1); });
