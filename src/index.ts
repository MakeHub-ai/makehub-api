/// <reference types="bun-types" />
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
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
    name: 'Makehub LLM API Gateway Azure Version',
    version: '2.0.0-typescript',
    status: serverStatus,
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString(),
    uptime: getUptime(),
    endpoints: {
      chat: '/v1/chat/completions',
      completion: '/v1/completion',
      models: '/v1/models',
      estimate: '/v1/chat/estimate'
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

app.get('/favicon.ico', (c: Context) => {
  // Retourne un favicon vide pour éviter les erreurs 404
  return c.newResponse('', 204);
});


// Monter les routes avec préfixes
app.route('/v1/chat', chatRoutes);
app.route('/v1', chatRoutes);
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
        '/v1/models',
        '/v1/chat/estimate',
      ]
    }
  };
  
  console.warn(`❌ 404 Not Found: ${c.req.method} ${c.req.path}`);
  
  return c.json(errorResponse, 404);
});

// Configuration du serveur avec validation
const port = parseInt(process.env.PORT || '3000');
const host = '0.0.0.0';

if (isNaN(port) || port < 1 || port > 65535) {
  console.error('❌ Invalid port number. Must be between 1 and 65535.');
  process.exit(1);
}

/**
 * Interface pour les options du serveur
 */
interface ServerOptions {
  port: number;
  host: string;
}

/**
 * Affiche les informations de démarrage
 */
function displayStartupInfo(): void {
  console.log('');
  console.log('🚀 ============================================');
  console.log('🚀  Makehub API - TypeScript Edition');
  console.log('🚀 ============================================');
  if (process.env.NODE_ENV === 'development') {
    console.log('');
    console.log('🔧 Running in development mode');
  }
}

/**
 * Fonction principale de démarrage avec Bun
 */
async function startServer(options?: Partial<ServerOptions>): Promise<void> {
  try {
    // Configuration des gestionnaires
    setupBunGracefulShutdown();
    
    // Affichage des informations
    displayStartupInfo();
    
    const serverPort = options?.port || port;
    const serverHost = options?.host || host;
    
    // Démarrage du serveur avec Bun
    const server = Bun.serve({
      port: serverPort,
      hostname: serverHost,
      fetch: app.fetch,
      idleTimeout: 300000, // 5 minutes
      error: (error: Error) => {
        console.error('🚨 Bun server error:', {
          message: error.message,
          stack: error.stack,
          timestamp: new Date().toISOString()
        });
        return new Response('Internal Server Error', { status: 500 });
      }
    });
    
    serverStatus = 'running';
    
    console.log(`🚀 Server running at http://${serverHost}:${serverPort}`);
    
  } catch (error) {
    console.error('❌ Failed to start Bun server:', error);
    process.exit(1);
  }
}

/**
 * Gestionnaire de signaux pour un arrêt propre avec Bun
 */
function setupBunGracefulShutdown(): void {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGUSR2'];
  
  signals.forEach((signal) => {
    process.on(signal, async () => {
      console.log(`\n📴 Received ${signal}. Starting graceful shutdown...`);
      serverStatus = 'stopping';
      
      try {
        // Bun handles graceful shutdown automatically
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

// Configuration des gestionnaires de signaux (une seule fois)
if (!(globalThis as any).__bunServerInitialized) {
  setupBunGracefulShutdown();
  (globalThis as any).__bunServerInitialized = true;
}

// Export par défaut pour Bun (gestion automatique du serveur)
export default {
  port: port,
  hostname: host,
  fetch: app.fetch,
  idleTimeout: 255, // 4 minutes 15 secondes
  error: (error: Error) => {
    console.error('🚨 Bun server error:', {
      message: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
    return new Response('Internal Server Error', { status: 500 });
  },
  development: process.env.NODE_ENV === 'development'
};

// Affichage des informations de démarrage (une seule fois)
if (!(globalThis as any).__startupInfoDisplayed) {
  displayStartupInfo();
  console.log(`🚀 Server running at http://${host}:${port}`);
  (globalThis as any).__startupInfoDisplayed = true;
}

serverStatus = 'running';

// Exports nommés pour les utilitaires
export { 
  app,
  getUptime, 
  startServer,
  type ServerInfo
};
