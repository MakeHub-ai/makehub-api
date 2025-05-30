import { Hono } from 'hono';
import { processReadyRequests } from '../services/request-processor.js';
import dotenv from 'dotenv';

// Charger les variables d'environnement
dotenv.config();

// Création d'un sémaphore simple pour éviter les exécutions concurrentes
let isProcessing = false;

// Clé webhook sécurisée définie dans les variables d'environnement
const WEBHOOK_SECRET_KEY = process.env.WEBHOOK_SECRET_KEY || 'default-webhook-secret-key';

const webhook = new Hono();

/**
 * Middleware pour vérifier la clé secrète du webhook
 */
async function webhookAuthMiddleware(c, next) {
  const secretHeader = c.req.header('X-Webhook-Secret');
  
  if (!secretHeader || secretHeader !== WEBHOOK_SECRET_KEY) {
    return c.json({ 
      success: false, 
      message: 'Clé d\'authentification invalide ou manquante' 
    }, 401);
  }
  
  await next();
}

/**
 * Endpoint pour calculer les tokens et mettre à jour les transactions
 * Utilise un mécanisme de sémaphore pour éviter les exécutions concurrentes
 */
webhook.post('/calculate-tokens', webhookAuthMiddleware, async (c) => {
  // Vérifier si une instance est déjà en cours d'exécution
  if (isProcessing) {
    return c.json(
      { 
        success: false,
        message: 'Une autre instance de calcul est déjà en cours d\'exécution'
      }, 
      409 // Conflict
    );
  }

  try {
    // Acquérir le sémaphore
    isProcessing = true;
    console.log('Démarrage du calcul des tokens via webhook...');
    
    // Exécuter le processus de calcul et de mise à jour avec limitation
    // Traitement par lots avec limite de temps pour optimiser l'utilisation mémoire
    const result = await processReadyRequests(20, 30000); // 20 requêtes max, 30s max
    
    console.log(`Calcul des tokens terminé avec succès: ${result.processed} traitées, ${result.errors} erreurs`);
    return c.json({ 
      success: true,
      message: `Calcul des tokens et mise à jour des transactions effectués avec succès`,
      stats: {
        processed: result.processed,
        errors: result.errors
      }
    });
  } catch (error) {
    console.error('Erreur lors du calcul des tokens via webhook:', error);
    return c.json(
      { 
        success: false, 
        message: 'Erreur lors du calcul des tokens',
        error: error.message 
      }, 
      500
    );
  } finally {
    // Libérer le sémaphore quoi qu'il arrive
    isProcessing = false;
  }
});

export default webhook;
