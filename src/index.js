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

// Créer l'application Hono
const app = new Hono();

// Middleware globaux
app.use('*', logger());
app.use('*', prettyJSON());
app.use('*', cors({
  origin: ['http://localhost:3000', 'http://localhost:3001', 'https://your-frontend-domain.com'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
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
    name: 'LLM API Gateway',
    version: '1.0.0',
    status: 'running',
    timestamp: new Date().toISOString(),
    endpoints: {
      chat: '/v1/chat/completions',
      models: '/v1/chat/models',
      health: '/v1/chat/health',
      estimate: '/v1/chat/estimate'
    }
  });
});

// Route de santé détaillée
app.get('/health', async (c) => {
  try {
    // Vérifier la connexion à la base de données
    const { supabase } = await import('./config/database.js');
    const { data, error } = await supabase.from('models').select('count').limit(1);
    
    const dbStatus = error ? 'error' : 'ok';
    
    // Vérifier les providers
    const { getProvidersHealth } = await import('./providers/index.js');
    const providersHealth = getProvidersHealth();
    
    const healthStatus = {
      status: dbStatus === 'ok' ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      services: {
        database: {
          status: dbStatus,
          error: error?.message
        },
        providers: providersHealth,
        cache: {
          status: 'ok' // Le cache est toujours disponible (en mémoire)
        }
      },
      version: '1.0.0',
      uptime: process.uptime()
    };
    
    const statusCode = healthStatus.status === 'healthy' ? 200 : 503;
    return c.json(healthStatus, statusCode);
    
  } catch (error) {
    console.error('Health check failed:', error);
    return c.json({
      status: 'error',
      timestamp: new Date().toISOString(),
      error: error.message
    }, 500);
  }
});

// Monter les routes
app.route('/v1/chat', chatRoutes);

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
console.log(`🔗 Health check: http://localhost:${port}/health`);
console.log(`💬 Chat endpoint: http://localhost:${port}/v1/chat/completions`);

serve({
  fetch: app.fetch,
  port: port,
}, (info) => {
  console.log(`✅ Server is running on http://localhost:${info.port}`);
});

export default app;
