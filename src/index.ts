import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
import dotenv from 'dotenv';
import type { Context, Next } from 'hono';
import type { HonoVariables, ApiError } from './types/index.js';

/**
 * Interface pour les erreurs étendues avec timestamp et path
 */
interface ExtendedApiError {
  error: {
    message: string;
    type: string;
    param?: string;
    code?: string;
    provider?: string;
    details?: any;
    timestamp?: string;
    path?: string;
    available_endpoints?: string[];
  };
}

// Charger les variables d'environnement
dotenv.config();

// Importer les routes
import chatRoutes from './routes/chat.js';
import webhookRoutes from './routes/webhook.js';

/**
 * Interface pour les informations du serveur
 */
interface ServerInfo {
  name: string;
  version: string;
  status: 'running' | 'starting' | 'stopping';
  environment: string;
  timestamp: string;
  uptime: number;
  endpoints: {
    chat: string;
    completion: string;
    models: string;
    estimate: string;
    webhook: string;
  };
  features: {
    typescript: boolean;
    streaming: boolean;
    fallback: boolean;
    authentication: boolean;
    webhooks: boolean;
  };
}

/**
 * Interface pour les statistiques du serveur
 */
interface ServerStats {
  uptime: number;
  memory: {
    used: number;
    total: number;
    percentage: number;
  };
  process: {
    pid: number;
    nodeVersion: string;
    platform: string;
  };
  timestamp: string;
}

// Créer l'application Hono avec les variables typées
const app = new Hono<{ Variables: HonoVariables }>();

// Variables globales pour le tracking
const startTime = Date.now();
let serverStatus: ServerInfo['status'] = 'starting';

/**
 * Calcule l'uptime du serveur en millisecondes
 */
function getUptime(): number {
  return Date.now() - startTime;
}

/**
 * Obtient les statistiques système
 */
function getSystemStats(): ServerStats {
  const memUsage = process.memoryUsage();
  
  return {
    uptime: getUptime(),
    memory: {
      used: Math.round(memUsage.heapUsed / 1024 / 1024), // MB
      total: Math.round(memUsage.heapTotal / 1024 / 1024), // MB
      percentage: Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100)
    },
    process: {
      pid: process.pid,
      nodeVersion: process.version,
      platform: process.platform
    },
    timestamp: new Date().toISOString()
  };
}

/**
 * Middleware global de logging personnalisé
 */
const customLogger = () => {
  return async (c: Context, next: Next) => {
    const start = Date.now();
    const method = c.req.method;
    const path = c.req.path;
    const userAgent = c.req.header('user-agent') || 'unknown';
    const forwarded = c.req.header('x-forwarded-for') || 'localhost';
    
    await next();
    
    const duration = Date.now() - start;
    const status = c.res.status;
    
    // Log coloré selon le statut
    const statusColor = status >= 400 ? '🔴' : status >= 300 ? '🟡' : '🟢';
    const logLevel = status >= 400 ? 'ERROR' : 'INFO';
    
    console.log(`${statusColor} [${logLevel}] ${method} ${path} ${status} - ${duration}ms (${forwarded})`);
    
    // Log détaillé pour les erreurs
    if (status >= 400 && process.env.NODE_ENV === 'development') {
      console.log(`   User-Agent: ${userAgent}`);
      console.log(`   Forwarded: ${forwarded}`);
    }
  };
};

// Middleware globaux avec ordre d'importance
app.use('*', customLogger());
app.use('*', prettyJSON());
app.use('*', cors({
  origin: process.env.NODE_ENV === 'production' 
    ? (process.env.ALLOWED_ORIGINS?.split(',') || ['*'])
    : ['*'],
  allowHeaders: [
    'Content-Type', 
    'Authorization', 
    'X-API-Key', 
    'X-Webhook-Secret',
    'X-Request-ID'
  ],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  exposeHeaders: ['Content-Length', 'X-Request-ID'],
  maxAge: 600,
  credentials: true,
}));

// Middleware de gestion d'erreurs globales
app.onError((err: Error, c: Context) => {
  console.error('🚨 Global error handler:', {
    error: err.message,
    stack: err.stack,
    path: c.req.path,
    method: c.req.method,
    timestamp: new Date().toISOString()
  });
  
  // Détermine le code d'erreur approprié
  let status: 400 | 401 | 403 | 404 | 500 = 500;
  let errorType = 'internal_error';
  
  if (err.message.includes('Not Found')) {
    status = 404;
    errorType = 'not_found_error';
  } else if (err.message.includes('Unauthorized') || err.message.includes('Authentication')) {
    status = 401;
    errorType = 'authentication_error';
  } else if (err.message.includes('Forbidden')) {
    status = 403;
    errorType = 'forbidden_error';
  } else if (err.message.includes('Invalid') || err.message.includes('Validation')) {
    status = 400;
    errorType = 'validation_error';
  }
  
  const errorResponse: ExtendedApiError = {
    error: {
      message: err.message || 'Internal server error',
      type: errorType,
      timestamp: new Date().toISOString(),
      path: c.req.path
    }
  };
  
  return c.json(errorResponse, status);
});

// Route de santé générale avec informations détaillées
app.get('/', (c: Context) => {
  const serverInfo: ServerInfo = {
    name: 'Makehub LLM API Gateway',
    version: '2.0.0-typescript',
    status: serverStatus,
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString(),
    uptime: getUptime(),
    endpoints: {
      chat: '/v1/chat/completions',
      completion: '/v1/completion',
      models: '/v1/chat/models',
      estimate: '/v1/chat/estimate',
      webhook: '/webhook/calculate-tokens'
    },
    features: {
      typescript: true,
      streaming: true,
      fallback: true,
      authentication: true,
      webhooks: true
    }
  };
  
  return c.json(serverInfo);
});

// Route de santé pour les load balancers
app.get('/health', (c: Context) => {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: getUptime(),
    memory_usage_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
  };
  
  return c.json(health);
});

// Route de statistiques détaillées
app.get('/stats', (c: Context) => {
  const stats = getSystemStats();
  return c.json(stats);
});

// Route de version
app.get('/version', (c: Context) => {
  const version = {
    version: '2.0.0-typescript',
    node_version: process.version,
    platform: process.platform,
    build_date: new Date().toISOString(),
    features: {
      typescript: true,
      es_modules: true,
      streaming_support: true,
      multi_provider_fallback: true
    }
  };
  
  return c.json(version);
});

// Monter les routes avec préfixes
app.route('/v1/chat', chatRoutes);
app.route('/v1', chatRoutes); // Pour /v1/completion endpoint legacy
app.route('/webhook', webhookRoutes);

// Route 404 personnalisée
app.notFound((c: Context) => {
  const errorResponse: ExtendedApiError = {
    error: {
      message: `Endpoint not found: ${c.req.method} ${c.req.path}`,
      type: 'not_found_error',
      path: c.req.path,
      available_endpoints: [
        '/v1/chat/completions',
        '/v1/completion',
        '/v1/chat/models',
        '/v1/chat/estimate',
        '/webhook/calculate-tokens',
        '/webhook/status'
      ]
    }
  };
  
  console.warn(`❌ 404 Not Found: ${c.req.method} ${c.req.path}`);
  
  return c.json(errorResponse, 404);
});

// Configuration du serveur avec validation
const port = parseInt(process.env.PORT || '3000');
const host = process.env.HOST || 'localhost';

if (isNaN(port) || port < 1 || port > 65535) {
  console.error('❌ Invalid port number. Must be between 1 and 65535.');
  process.exit(1);
}

/**
 * Gestionnaire de signaux pour un arrêt propre
 */
function setupGracefulShutdown(): void {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGUSR2'];
  
  signals.forEach((signal) => {
    process.on(signal, async () => {
      console.log(`\n📴 Received ${signal}. Starting graceful shutdown...`);
      serverStatus = 'stopping';
      
      try {
        // Attendre un peu pour que les requêtes en cours se terminent
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        console.log('✅ Graceful shutdown completed');
        process.exit(0);
      } catch (error) {
        console.error('❌ Error during graceful shutdown:', error);
        process.exit(1);
      }
    });
  });
}

/**
 * Gestionnaire d'erreurs non capturées
 */
function setupErrorHandlers(): void {
  process.on('uncaughtException', (error: Error) => {
    console.error('💥 Uncaught Exception:', {
      message: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
    
    // En production, on essaie un arrêt propre
    if (process.env.NODE_ENV === 'production') {
      setTimeout(() => process.exit(1), 1000);
    } else {
      process.exit(1);
    }
  });

  process.on('unhandledRejection', (reason: unknown, promise: Promise<any>) => {
    console.error('🔥 Unhandled Rejection:', {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
      promise: promise.toString(),
      timestamp: new Date().toISOString()
    });
    
    // En production, on essaie un arrêt propre
    if (process.env.NODE_ENV === 'production') {
      setTimeout(() => process.exit(1), 1000);
    } else {
      process.exit(1);
    }
  });
}

/**
 * Affiche les informations de démarrage
 */
function displayStartupInfo(): void {
  console.log('');
  console.log('🚀 ============================================');
  console.log('🚀  LLM API Gateway - TypeScript Edition');
  console.log('🚀 ============================================');
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🏠 Host: ${host}`);
  console.log(`🚪 Port: ${port}`);
  console.log(`🔗 URL: http://${host}:${port}`);
  console.log('');
  console.log('📡 Available Endpoints:');
  console.log(`   Chat: http://${host}:${port}/v1/chat/completions`);
  console.log(`   Models: http://${host}:${port}/v1/chat/models`);
  console.log(`   Estimate: http://${host}:${port}/v1/chat/estimate`);
  console.log(`   Webhook: http://${host}:${port}/webhook/calculate-tokens`);
  console.log(`   Health: http://${host}:${port}/health`);
  console.log('');
}

/**
 * Interface pour les options du serveur
 */
interface ServerOptions {
  port: number;
  host: string;
}

/**
 * Fonction principale de démarrage
 */
async function startServer(options?: Partial<ServerOptions>): Promise<void> {
  try {
    // Configuration des gestionnaires
    setupGracefulShutdown();
    setupErrorHandlers();
    
    // Affichage des informations
    displayStartupInfo();
    
    const serverPort = options?.port || port;
    const serverHost = options?.host || host;
    
    // Démarrage du serveur
    const server = serve({
      fetch: app.fetch,
      port: serverPort,
      hostname: serverHost
    }, (info) => {
      serverStatus = 'running';
      console.log(`✅ Server is running on http://${info.address}:${info.port}`);
      console.log(`⏰ Started at: ${new Date().toISOString()}`);
      console.log('');
      console.log('🎯 Ready to handle requests!');
      console.log('');
    });
    
    // Retourner une promesse qui ne se résout jamais (serveur en continu)
    return new Promise(() => {
      // Le serveur tourne indéfiniment jusqu'à un signal d'arrêt
    });
    
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Démarrage du serveur seulement si ce fichier est exécuté directement
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((error) => {
    console.error('💥 Server startup failed:', error);
    process.exit(1);
  });
}

// Export par défaut pour les tests
export default app;

// Exports nommés pour les utilitaires
export { 
  getUptime, 
  getSystemStats,
  startServer,
  type ServerInfo, 
  type ServerStats,
  type ServerOptions
};