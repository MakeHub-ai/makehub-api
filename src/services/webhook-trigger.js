/**
 * Utilitaire pour envoyer des requêtes asynchrones au webhook
 */

import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const WEBHOOK_SECRET_KEY = process.env.WEBHOOK_SECRET_KEY || 'default-webhook-secret-key';
const API_BASE_URL = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

/**
 * Envoie une requête asynchrone vers le webhook de calcul des tokens
 * Cette fonction n'attend pas la réponse et ne bloque pas le processus principal
 * @param {number} delay - Délai en millisecondes avant d'envoyer la requête (défaut: 1000ms)
 */
export async function triggerWebhookAsync(delay = 1000) {
  // Programmer l'envoi de la requête de manière asynchrone
  setTimeout(async () => {
    try {
      console.log('🔄 Déclenchement asynchrone du webhook de calcul des tokens...');
      
      const response = await axios.post(`${API_BASE_URL}/webhook/calculate-tokens`, {}, {
        headers: {
          'X-Webhook-Secret': WEBHOOK_SECRET_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 60000, // 60 secondes de timeout
        // Ne pas suivre les redirections automatiquement
        maxRedirects: 0
      });
      
      if (response.data.success) {
        console.log(`✅ Webhook exécuté avec succès: ${response.data.stats.processed} requêtes traitées, ${response.data.stats.errors} erreurs`);
      } else {
        console.log(`⚠️ Webhook terminé avec des problèmes: ${response.data.message}`);
      }
      
    } catch (error) {
      if (error.response) {
        // Le serveur a répondu avec un code d'erreur
        if (error.response.status === 409) {
          console.log('ℹ️ Webhook déjà en cours d\'exécution, requête ignorée');
        } else {
          console.error(`❌ Erreur webhook (${error.response.status}): ${error.response.data?.message || error.response.statusText}`);
        }
      } else if (error.code === 'ECONNREFUSED') {
        console.error('❌ Impossible de joindre le webhook (serveur non accessible)');
      } else if (error.code === 'ETIMEDOUT') {
        console.error('❌ Timeout lors de l\'appel au webhook');
      } else {
        console.error('❌ Erreur lors de l\'appel asynchrone au webhook:', error.message);
      }
    }
  }, delay);
  
  // Cette fonction retourne immédiatement sans attendre l'exécution du webhook
  console.log(`⏲️ Webhook programmé pour exécution dans ${delay}ms`);
}

/**
 * Version alternative utilisant fetch au lieu d'axios
 * Peut être utile si axios n'est pas disponible
 */
export async function triggerWebhookAsyncFetch(delay = 1000) {
  setTimeout(async () => {
    try {
      console.log('🔄 Déclenchement asynchrone du webhook de calcul des tokens (fetch)...');
      
      const response = await fetch(`${API_BASE_URL}/webhook/calculate-tokens`, {
        method: 'POST',
        headers: {
          'X-Webhook-Secret': WEBHOOK_SECRET_KEY,
          'Content-Type': 'application/json'
        },
        signal: AbortSignal.timeout(60000) // 60 secondes de timeout
      });
      
      const data = await response.json();
      
      if (response.ok && data.success) {
        console.log(`✅ Webhook exécuté avec succès: ${data.stats.processed} requêtes traitées, ${data.stats.errors} erreurs`);
      } else {
        console.log(`⚠️ Webhook terminé avec des problèmes (${response.status}): ${data.message || response.statusText}`);
      }
      
    } catch (error) {
      if (error.name === 'AbortError') {
        console.error('❌ Timeout lors de l\'appel au webhook');
      } else {
        console.error('❌ Erreur lors de l\'appel asynchrone au webhook:', error.message);
      }
    }
  }, delay);
  
  console.log(`⏲️ Webhook programmé pour exécution dans ${delay}ms`);
}
