import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
import dotenv from 'dotenv';

// Charger les variables d'environnement
dotenv.config();

// Importer les routes
import chatRoutes from './routes/chat.js';
import webhookRoutes from './routes/webhook.js';

// Créer l'application Hono
const app = new Hono();

// Middleware globaux
app.use('*', logger());
app.use('*', prettyJSON());
app.use('*', cors({
  origin: ['*'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Webhook-Secret'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  exposeHeaders: ['Content-Length'],
  maxAge: 600,
  credentials: true,
}));

// Middleware de gestion d'erreurs globales
app.onError((err, c) => {
  console.error('Global error handler:', err);
  
  return c.json({
    error: {
      message: err.message || 'Internal server error',
      type: 'internal_error',
      timestamp: new Date().toISOString()
    }
  }, err.status || 500);
});

// Route de santé générale
app.get('/', (c) => {
  return c.json({
    name: 'Makehub API Gateway',
    version: '1.0.0',
    status: 'running',
    timestamp: new Date().toISOString(),    endpoints: {
      chat: '/v1/chat/completions',
      completion: '/v1/completion',
      models: '/v1/chat/models',
      estimate: '/v1/chat/estimate'
    }
  });
});


// Monter les routes
app.route('/v1/chat', chatRoutes);
app.route('/v1', chatRoutes); // Pour /v1/completion endpoint legacy
app.route('/webhook', webhookRoutes);

// Route 404
app.notFound((c) => {
  return c.json({
    error: {
      message: 'Not Found',
      type: 'not_found_error',
      path: c.req.path
    }
  }, 404);
});

// Configuration du serveur
const port = parseInt(process.env.PORT) || 3000;

// Gestionnaire de signaux pour un arrêt propre
process.on('SIGINT', () => {
  console.log('\nReceived SIGINT. Graceful shutdown...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM. Graceful shutdown...');
  process.exit(0);
});

// Gestionnaire d'erreurs non capturées
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Démarrer le serveur
console.log(`🚀 LLM API Gateway starting on port ${port}`);
console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
console.log(` Chat endpoint: http://localhost:${port}/v1/chat/completions`);

serve({
  fetch: app.fetch,
  port: port,
}, (info) => {
  console.log(`✅ Server is running on http://localhost:${info.port}`);
});

export default app;
