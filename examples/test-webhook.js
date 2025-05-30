/**
 * Script pour tester le webhook de calcul des tokens
 * 
 * Ce script teste l'endpoint webhook /webhook/calculate-tokens qui permet de
 * traiter les requêtes avec le statut 'ready_to_compute' et calculer leurs tokens.
 *
 * Usage:
 * 1. Configurer les variables d'environnement (WEBHOOK_SECRET_KEY, API_BASE_URL si non localhost:3000)
 * 2. Démarrer le serveur: npm run dev
 * 3. Exécuter: node examples/test-webhook.js
 */

import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET_KEY || 'default-webhook-secret-key';

// Configuration axios pour le webhook
const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'X-Webhook-Secret': WEBHOOK_SECRET,
    'Content-Type': 'application/json'
  },
  timeout: 60000 // 60 secondes de timeout (le webhook peut prendre du temps)
});

/**
 * Teste l'endpoint webhook de calcul des tokens
 */
async function testWebhookCalculateTokens() {
  console.log('🔧 Test du webhook de calcul des tokens');
  console.log('='.repeat(50));
  
  try {
    console.log('📤 Envoi de la requête webhook...');
    const startTime = Date.now();
    
    const response = await api.post('/webhook/calculate-tokens');
    
    const duration = Date.now() - startTime;
    
    console.log('✅ Réponse reçue avec succès !');
    console.log(`⏱️  Durée d'exécution: ${duration}ms`);
    console.log('📊 Réponse:');
    console.log(JSON.stringify(response.data, null, 2));
    
    if (response.data.success) {
      console.log('');
      console.log('📈 Statistiques:');
      console.log(`   • Requêtes traitées: ${response.data.stats.processed}`);
      console.log(`   • Erreurs: ${response.data.stats.errors}`);
      
      if (response.data.stats.processed === 0) {
        console.log('ℹ️  Aucune requête à traiter (aucune requête avec le statut "ready_to_compute")');
      }
    }
    
  } catch (error) {
    console.error('❌ Erreur lors du test du webhook:');
    
    if (error.response) {
      // La requête a été faite et le serveur a répondu avec un code d'erreur
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Message: ${error.response.data?.message || error.response.statusText}`);
      console.error('   Réponse complète:', JSON.stringify(error.response.data, null, 2));
      
      if (error.response.status === 401) {
        console.error('🔑 Vérifiez la clé secrète du webhook (WEBHOOK_SECRET_KEY)');
      } else if (error.response.status === 409) {
        console.error('⚠️  Une autre instance du traitement est déjà en cours');
      }
    } else if (error.request) {
      // La requête a été faite mais aucune réponse n'a été reçue
      console.error('   Aucune réponse reçue du serveur');
      console.error('   Vérifiez que le serveur est démarré sur:', API_BASE_URL);
    } else {
      // Erreur lors de la configuration de la requête
      console.error('   Erreur de configuration:', error.message);
    }
  }
}

/**
 * Teste l'authentification du webhook avec une mauvaise clé
 */
async function testWebhookAuth() {
  console.log('');
  console.log('🔐 Test de l\'authentification webhook (avec mauvaise clé)');
  console.log('='.repeat(50));
  
  try {
    const badApi = axios.create({
      baseURL: API_BASE_URL,
      headers: {
        'X-Webhook-Secret': 'wrong-secret-key',
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    
    const response = await badApi.post('/webhook/calculate-tokens');
    console.log('⚠️  Réponse inattendue (devrait être une erreur 401):', response.data);
    
  } catch (error) {
    if (error.response && error.response.status === 401) {
      console.log('✅ Authentification échouée comme attendu (401)');
      console.log(`   Message: ${error.response.data?.message}`);
    } else {
      console.error('❌ Erreur inattendue:', error.message);
    }
  }
}

/**
 * Teste l'endpoint sans en-tête d'authentification
 */
async function testWebhookNoAuth() {
  console.log('');
  console.log('🚫 Test sans authentification');
  console.log('='.repeat(50));
  
  try {
    const noAuthApi = axios.create({
      baseURL: API_BASE_URL,
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    
    const response = await noAuthApi.post('/webhook/calculate-tokens');
    console.log('⚠️  Réponse inattendue (devrait être une erreur 401):', response.data);
    
  } catch (error) {
    if (error.response && error.response.status === 401) {
      console.log('✅ Accès refusé comme attendu (401)');
      console.log(`   Message: ${error.response.data?.message}`);
    } else {
      console.error('❌ Erreur inattendue:', error.message);
    }
  }
}

/**
 * Fonction principale pour exécuter tous les tests
 */
async function runTests() {
  console.log('🧪 Tests du webhook de calcul des tokens');
  console.log('🔗 API Base URL:', API_BASE_URL);
  console.log('🔑 Webhook Secret:', WEBHOOK_SECRET.substring(0, 8) + '...');
  console.log('');
  
  // Test principal
  await testWebhookCalculateTokens();
  
  // Tests d'authentification
  await testWebhookAuth();
  await testWebhookNoAuth();
  
  console.log('');
  console.log('🏁 Tests terminés');
}

// Exécuter les tests si le script est appelé directement
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().catch(console.error);
}

export { testWebhookCalculateTokens, testWebhookAuth, testWebhookNoAuth };
