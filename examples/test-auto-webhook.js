/**
 * Script pour tester le déclenchement automatique du webhook
 * après une requête de chat completion
 * 
 * Ce script envoie une requête de chat completion et observe
 * les logs pour vérifier que le webhook est bien déclenché automatiquement.
 *
 * Usage:
 * 1. Démarrer le serveur: npm run dev
 * 2. Créer des données de test: node examples/create-test-data.js
 * 3. Exécuter: node examples/test-auto-webhook.js
 */

import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const API_KEY = process.env.TEST_API_KEY || 'test-api-key-123';

// Configuration axios pour la Gateway
const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'X-API-Key': API_KEY,
    'Content-Type': 'application/json'
  },
  timeout: 30000 // 30 secondes de timeout
});

/**
 * Teste une requête de chat completion et vérifie le déclenchement automatique du webhook
 */
async function testAutoWebhook() {
  console.log('🤖 Test du déclenchement automatique du webhook');
  console.log('='.repeat(50));
  console.log('');
  
  try {
    console.log('📤 Envoi d\'une requête de chat completion...');
    const startTime = Date.now();
    
    const chatRequest = {
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: 'Bonjour ! Peux-tu me dire quelque chose d\'intéressant sur l\'intelligence artificielle ?'
        }
      ],
      max_tokens: 150,
      stream: false // Test en mode non-streaming d'abord
    };
    
    const response = await api.post('/v1/chat/completions', chatRequest);
    const duration = Date.now() - startTime;
    
    console.log('✅ Requête de chat completion réussie !');
    console.log(`⏱️  Durée: ${duration}ms`);
    console.log('');
    
    console.log('📝 Réponse du modèle:');
    if (response.data.choices && response.data.choices[0] && response.data.choices[0].message) {
      console.log(`"${response.data.choices[0].message.content}"`);
    } else {
      console.log('Réponse:', JSON.stringify(response.data, null, 2));
    }
    console.log('');
    
    console.log('⏳ Le webhook devrait être déclenché automatiquement dans environ 2 secondes...');
    console.log('   Surveillez les logs du serveur pour voir le message:');
    console.log('   "🔄 Déclenchement asynchrone du webhook de calcul des tokens..."');
    console.log('');
    
    // Attendre un peu pour laisser le temps au webhook de s'exécuter
    console.log('⏱️  Attente de 10 secondes pour laisser le webhook s\'exécuter...');
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    console.log('✅ Test terminé ! Vérifiez les logs du serveur pour confirmer l\'exécution du webhook.');
    
  } catch (error) {
    console.error('❌ Erreur lors du test:');
    
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Message: ${error.response.data?.error?.message || error.response.statusText}`);
    } else if (error.request) {
      console.error('   Aucune réponse reçue du serveur');
      console.error('   Vérifiez que le serveur est démarré sur:', API_BASE_URL);
    } else {
      console.error('   Erreur de configuration:', error.message);
    }
  }
}

/**
 * Teste avec le streaming activé
 */
async function testAutoWebhookStreaming() {
  console.log('');
  console.log('🌊 Test du déclenchement automatique du webhook (mode streaming)');
  console.log('='.repeat(50));
  console.log('');
  
  try {
    console.log('📤 Envoi d\'une requête de chat completion en streaming...');
    
    const chatRequest = {
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: 'Raconte-moi une courte histoire sur un robot qui apprend à cuisiner.'
        }
      ],
      max_tokens: 100,
      stream: true // Test en mode streaming
    };
    
    const response = await api.post('/v1/chat/completions', chatRequest, {
      responseType: 'stream'
    });
    
    console.log('✅ Stream initié !');
    
    // Lire le stream
    let streamContent = '';
    response.data.on('data', (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ') && !line.includes('[DONE]')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.choices && data.choices[0] && data.choices[0].delta && data.choices[0].delta.content) {
              streamContent += data.choices[0].delta.content;
              process.stdout.write(data.choices[0].delta.content);
            }
          } catch (e) {
            // Ignorer les erreurs de parsing JSON pour les lignes non-JSON
          }
        }
      }
    });
    
    response.data.on('end', () => {
      console.log('');
      console.log('');
      console.log('✅ Stream terminé !');
      console.log('⏳ Le webhook devrait être déclenché automatiquement dans environ 3 secondes...');
      console.log('   (délai plus long pour le streaming)');
      console.log('');
    });
    
    // Attendre que le stream se termine
    await new Promise((resolve, reject) => {
      response.data.on('end', resolve);
      response.data.on('error', reject);
    });
    
    // Attendre pour le webhook
    console.log('⏱️  Attente de 8 secondes pour laisser le webhook s\'exécuter...');
    await new Promise(resolve => setTimeout(resolve, 8000));
    
  } catch (error) {
    console.error('❌ Erreur lors du test streaming:', error.message);
  }
}

/**
 * Fonction principale
 */
async function runTests() {
  console.log('🧪 Tests du déclenchement automatique du webhook');
  console.log('🔗 API Base URL:', API_BASE_URL);
  console.log('🔑 API Key:', API_KEY.substring(0, 8) + '...');
  console.log('');
  
  // Test non-streaming
  await testAutoWebhook();
  
  // Test streaming
  await testAutoWebhookStreaming();
  
  console.log('🏁 Tous les tests terminés');
  console.log('');
  console.log('💡 Conseils:');
  console.log('   • Surveillez les logs du serveur pour voir l\'exécution des webhooks');
  console.log('   • Les webhooks s\'exécutent avec un délai pour ne pas bloquer les réponses');
  console.log('   • Vérifiez la base de données pour voir si les tokens ont été calculés');
}

// Exécuter les tests si le script est appelé directement
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().catch(console.error);
}

export { testAutoWebhook, testAutoWebhookStreaming };
