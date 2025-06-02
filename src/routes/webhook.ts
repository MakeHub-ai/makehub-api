import { Hono } from 'hono';
import { processReadyRequests, getProcessorStats } from '../services/request-processor.js';
import dotenv from 'dotenv';
import type { Context, Next } from 'hono';

// Charger les variables d'environnement
dotenv.config();

/**
 * Interface pour les réponses du webhook
 */
interface WebhookResponse {
  success: boolean;
  message: string;
  stats?: {
    processed: number;
    errors: number;
  };
  timestamp: string;
}

/**
 * Interface pour les statistiques du processeur
 */
interface ProcessorStatsResponse {
  processor: {
    pendingRequests: number;
    errorRequests: number;
    completedToday: number;
    avgProcessingTime: number;
    cacheInfo: {
      encoders: number;
    };
  };
  timestamp: string;
}

/**
 * Interface pour les erreurs du webhook
 */
interface WebhookErrorResponse {
  success: false;
  message: string;
  error?: string;
  timestamp: string;
}

// Création d'un sémaphore simple pour éviter les exécutions concurrentes
let isProcessing = false;

// Clé webhook sécurisée définie dans les variables d'environnement
const WEBHOOK_SECRET_KEY = process.env.WEBHOOK_SECRET_KEY || 'default-webhook-secret-key';

// Validation de la clé secrète
if (WEBHOOK_SECRET_KEY === 'default-webhook-secret-key') {
  console.warn('⚠️ Using default webhook secret key. Please set WEBHOOK_SECRET_KEY in environment variables for production.');
}

const webhook = new Hono();

/**
 * Valide une clé secrète de webhook
 * @param providedKey - Clé fournie dans l'en-tête
 * @returns true si la clé est valide
 */
function validateWebhookSecret(providedKey: string | undefined): boolean {
  if (!providedKey) {
    return false;
  }
  
  // Comparaison sécurisée pour éviter les timing attacks
  if (providedKey.length !== WEBHOOK_SECRET_KEY.length) {
    return false;
  }
  
  let result = 0;
  for (let i = 0; i < providedKey.length; i++) {
    result |= providedKey.charCodeAt(i) ^ WEBHOOK_SECRET_KEY.charCodeAt(i);
  }
  
  return result === 0;
}

/**
 * Middleware pour vérifier la clé secrète du webhook
 */
async function webhookAuthMiddleware(c: Context, next: Next): Promise<Response | void> {
  const secretHeader = c.req.header('X-Webhook-Secret');
  
  if (!validateWebhookSecret(secretHeader)) {
    const errorResponse: WebhookErrorResponse = {
      success: false,
      message: 'Clé d\'authentification invalide ou manquante',
      timestamp: new Date().toISOString()
    };
    
    console.warn(`❌ Webhook authentication failed from ${c.req.header('x-forwarded-for') || 'unknown'}`);
    
    return c.json(errorResponse, 401);
  }
  
  await next();
}

/**
 * Crée une réponse d'erreur standardisée
 */
function createErrorResponse(message: string, error?: unknown): WebhookErrorResponse {
  return {
    success: false,
    message,
    error: error instanceof Error ? error.message : String(error),
    timestamp: new Date().toISOString()
  };
}

/**
 * Crée une réponse de succès standardisée
 */
function createSuccessResponse(
  message: string, 
  stats?: { processed: number; errors: number }
): WebhookResponse {
  return {
    success: true,
    message,
    stats,
    timestamp: new Date().toISOString()
  };
}

/**
 * GET /webhook/status
 * Endpoint pour vérifier le statut du webhook (sans authentification)
 */
webhook.get('/status', async (c: Context) => {
  try {
    const stats = await getProcessorStats();
    
    const response = {
      status: 'healthy',
      processing: isProcessing,
      webhook_secret_configured: WEBHOOK_SECRET_KEY !== 'default-webhook-secret-key',
      processor_stats: stats,
      timestamp: new Date().toISOString()
    };
    
    return c.json(response);
  } catch (error) {
    console.error('Error getting webhook status:', error);
    
    const errorResponse = {
      status: 'error',
      processing: isProcessing,
      webhook_secret_configured: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    };
    
    return c.json(errorResponse, 500);
  }
});

/**
 * GET /webhook/stats
 * Endpoint pour récupérer les statistiques du processeur (avec authentification)
 */
webhook.get('/stats', webhookAuthMiddleware, async (c: Context) => {
  try {
    const stats = await getProcessorStats();
    
    const response: ProcessorStatsResponse = {
      processor: stats,
      timestamp: new Date().toISOString()
    };
    
    return c.json(response);
  } catch (error) {
    console.error('Error getting processor stats:', error);
    const errorResponse = createErrorResponse('Erreur lors de la récupération des statistiques', error);
    return c.json(errorResponse, 500);
  }
});

/**
 * POST /webhook/calculate-tokens
 * Endpoint pour calculer les tokens et mettre à jour les transactions
 * Utilise un mécanisme de sémaphore pour éviter les exécutions concurrentes
 */
webhook.post('/calculate-tokens', webhookAuthMiddleware, async (c: Context) => {
  // Vérifier si une instance est déjà en cours d'exécution
  if (isProcessing) {
    const conflictResponse: WebhookErrorResponse = {
      success: false,
      message: 'Une autre instance de calcul est déjà en cours d\'exécution',
      timestamp: new Date().toISOString()
    };
    
    return c.json(conflictResponse, 409); // Conflict
  }

  // Acquérir le sémaphore
  isProcessing = true;
  const startTime = Date.now();
  
  try {
    
    // Récupérer les paramètres de requête (optionnels)
    const batchSize = parseInt(c.req.query('batch_size') || '20');
    const timeLimit = parseInt(c.req.query('time_limit') || '30000');
    
    // Validation des paramètres
    if (batchSize <= 0 || batchSize > 100) {
      throw new Error('batch_size must be between 1 and 100');
    }
    
    if (timeLimit <= 0 || timeLimit > 120000) { // Max 2 minutes
      throw new Error('time_limit must be between 1ms and 120000ms (2 minutes)');
    }
    
    // Exécuter le processus de calcul et de mise à jour avec limitation
    const result = await processReadyRequests(batchSize, timeLimit);
    const duration = Date.now() - startTime;
    
    console.log(`✅ Calcul des tokens terminé avec succès: ${result.processed} traitées, ${result.errors} erreurs en ${duration}ms`);
    
    const successResponse = createSuccessResponse(
      `Calcul des tokens et mise à jour des transactions effectués avec succès (${duration}ms)`,
      {
        processed: result.processed,
        errors: result.errors
      }
    );
    
    return c.json(successResponse);
    
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`❌ Erreur lors du calcul des tokens via webhook (${duration}ms):`, error);
    
    const errorResponse = createErrorResponse(
      `Erreur lors du calcul des tokens (${duration}ms)`, 
      error
    );
    
    return c.json(errorResponse, 500);
  } finally {
    // Libérer le sémaphore quoi qu'il arrive
    isProcessing = false;
  }
});

/**
 * POST /webhook/force-process
 * Endpoint pour forcer le traitement même si déjà en cours (use with caution)
 */
webhook.post('/force-process', webhookAuthMiddleware, async (c: Context) => {
  try {
    
    // Reset du sémaphore
    const wasProcessing = isProcessing;
    isProcessing = false;
    
    if (wasProcessing) {
    }
    
    // Traitement normal
    const batchSize = parseInt(c.req.query('batch_size') || '10');
    const timeLimit = parseInt(c.req.query('time_limit') || '15000'); // Plus court pour force
    
    isProcessing = true;
    const startTime = Date.now();
    
    const result = await processReadyRequests(batchSize, timeLimit);
    const duration = Date.now() - startTime;
    
    const successResponse = createSuccessResponse(
      `Force processing completed (${duration}ms)`,
      {
        processed: result.processed,
        errors: result.errors
      }
    );
    
    return c.json(successResponse);
    
  } catch (error) {
    console.error('Error in force processing:', error);
    const errorResponse = createErrorResponse('Erreur lors du traitement forcé', error);
    return c.json(errorResponse, 500);
  } finally {
    // Toujours libérer le sémaphore
    isProcessing = false;
  }
});

export default webhook;