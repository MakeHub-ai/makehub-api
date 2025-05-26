/**
 * Script pour tester les requêtes de streaming et afficher le contenu brut de chaque chunk.
 * Utile pour vérifier la présence et la structure des données 'usage' dans les chunks.
 *
 * Usage:
 * 1. Configurer les variables d'environnement (TEST_API_KEY, API_BASE_URL si non localhost:3000)
 * 2. Démarrer le serveur: npm run dev
 * 3. Exécuter: node examples/test-stream-chunks.js
 */

import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const GATEWAY_API_KEY = process.env.TEST_API_KEY || 'test-api-key-123'; // Clé pour la gateway
const OPENAI_API_KEY = process.env.API_KEY_OPENAI; // Clé directe pour OpenAI

// Configuration axios pour la Gateway
const gatewayApi = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'X-API-Key': GATEWAY_API_KEY,
    'Content-Type': 'application/json'
  },
  timeout: 30000 // 30 secondes de timeout
});

// Configuration axios pour OpenAI direct
const openaiApi = axios.create({
  baseURL: 'https://api.openai.com/v1',
  headers: {
    'Authorization': `Bearer ${OPENAI_API_KEY}`,
    'Content-Type': 'application/json'
  },
  timeout: 30000
});


/**
 * Test de streaming via la Gateway LLM, affiche le contenu brut de chaque chunk.
 */
async function testGatewayStreamAndLogChunks() {
  console.log('🌊 Testing Gateway streaming chat completion and logging raw chunks...');
  console.log(`Connecting to Gateway: ${API_BASE_URL}/v1/chat/completions with API Key: ${GATEWAY_API_KEY ? GATEWAY_API_KEY.substring(0, 10) + '...' : 'Not Set'}`);

  if (!GATEWAY_API_KEY) {
    console.error('❌ TEST_API_KEY is not set in environment variables for Gateway test.');
    return;
  }

  try {
    const response = await gatewayApi.post('/v1/chat/completions', {
      model: 'gpt-4o', // ou un autre modèle que vous souhaitez tester
      messages: [
        { role: 'user', content: 'Tell me a very short story about a curious cat. Just a few sentences.' }
      ],
      stream: true,
      max_tokens: 150
    }, {
      responseType: 'stream' // Important pour qu'axios gère la réponse comme un stream
    });

    console.log('✅ Streaming request sent. Waiting for chunks...\n');
    
    let chunkCounter = 0;

    response.data.on('data', (chunk) => {
      chunkCounter++;
      console.log(`---------- RAW CHUNK ${chunkCounter} START ----------`);
      console.log(chunk.toString());
      console.log(`---------- RAW CHUNK ${chunkCounter} END ----------\n`);
    });

    response.data.on('error', (err) => {
      console.error('❌ Streaming connection error:', err.message);
      if (err.response) {
        console.error('Error response data:', err.response.data);
        console.error('Error response status:', err.response.status);
        console.error('Error response headers:', err.response.headers);
      }
    });
    
    response.data.on('end', () => {
      console.log('🏁 Stream ended.');
      console.log(`Total chunks received: ${chunkCounter}`);
    });

  } catch (error) {
    // Ce bloc catch gère les erreurs lors de la requête POST initiale (avant le début du streaming)
    console.error('❌ Streaming test setup failed:');
    if (error.response) {
      // Erreur de l'API (e.g., 4xx, 5xx)
      console.error('   Status:', error.response.status);
      console.error('   Headers:', JSON.stringify(error.response.headers, null, 2));
      // Essayez de lire le corps de la réponse d'erreur si c'est un stream
      if (error.response.data && typeof error.response.data.on === 'function') {
        let errorBody = '';
        error.response.data.on('data', chunk => errorBody += chunk);
        error.response.data.on('end', () => console.error('   Body:', errorBody));
      } else {
        console.error('   Body:', JSON.stringify(error.response.data, null, 2));
      }
    } else if (error.request) {
      // La requête a été faite mais aucune réponse n'a été reçue
      console.error('   No response received:', error.message);
    } else {
      // Quelque chose s'est mal passé lors de la configuration de la requête
      console.error('   Error setting up request:', error.message);
    }
    console.error('   Full error object:', error.config);
  }
}

// Exécuter le test si ce fichier est appelé directement
if (import.meta.url === `file://${process.argv[1]}`) {
  const testToRun = process.argv[2]; // Récupère le 3ème argument (node script.js <argument>)

  if (testToRun === 'openai') {
    testOpenAIStreamAndLogChunks().catch(error => {
      console.error("🚨 Unhandled error in testOpenAIStreamAndLogChunks:", error);
    });
  } else if (testToRun === 'gateway' || !testToRun) { // Par défaut ou si 'gateway' est spécifié
    testGatewayStreamAndLogChunks().catch(error => {
      console.error("🚨 Unhandled error in testGatewayStreamAndLogChunks:", error);
    });
  } else {
    console.log("Invalid argument. Use 'openai' for direct OpenAI test or 'gateway' (or no argument) for Gateway test.");
    console.log("Example: node examples/test-stream-chunks.js openai");
    console.log("Example: node examples/test-stream-chunks.js gateway");
  }
}

/**
 * Test de streaming direct avec OpenAI, affiche le contenu brut de chaque chunk.
 */
async function testOpenAIStreamAndLogChunks() {
  console.log('🌊 Testing DIRECT OpenAI streaming chat completion and logging raw chunks...');
  
  if (!OPENAI_API_KEY) {
    console.error('❌ API_KEY_OPENAI is not set in environment variables.');
    return;
  }
  console.log(`Connecting directly to OpenAI with API Key: ${OPENAI_API_KEY ? OPENAI_API_KEY.substring(0, 10) + '...' : 'Not Set'}`);

  try {
    const response = await openaiApi.post('/chat/completions', {
      model: 'gpt-4o', // ou un autre modèle OpenAI que vous souhaitez tester
      messages: [
        { role: 'user', content: 'Tell me a very short story about a curious robot. Just a few sentences.' }
      ],
      stream: true,
      max_tokens: 150,
      stream_options: { include_usage: true }
    }, {
      responseType: 'stream'
    });

    console.log('✅ Direct OpenAI streaming request sent. Waiting for chunks...\n');
    
    let chunkCounter = 0;

    response.data.on('data', (chunk) => {
      chunkCounter++;
      console.log(`---------- OPENAI RAW CHUNK ${chunkCounter} START ----------`);
      console.log(chunk.toString());
      console.log(`---------- OPENAI RAW CHUNK ${chunkCounter} END ----------\n`);
    });

    response.data.on('error', (err) => {
      console.error('❌ Direct OpenAI streaming connection error:', err.message);
      if (err.response) {
        console.error('Error response data:', err.response.data);
        console.error('Error response status:', err.response.status);
        console.error('Error response headers:', err.response.headers);
      }
    });
    
    response.data.on('end', () => {
      console.log('🏁 Direct OpenAI stream ended.');
      console.log(`Total chunks received: ${chunkCounter}`);
    });

  } catch (error) {
    console.error('❌ Direct OpenAI streaming test setup failed:');
    if (error.response) {
      console.error('   Status:', error.response.status);
      console.error('   Headers:', JSON.stringify(error.response.headers, null, 2));
      if (error.response.data && typeof error.response.data.on === 'function') {
        let errorBody = '';
        error.response.data.on('data', chunk => errorBody += chunk);
        error.response.data.on('end', () => console.error('   Body:', errorBody));
      } else {
        console.error('   Body:', JSON.stringify(error.response.data, null, 2));
      }
    } else if (error.request) {
      console.error('   No response received:', error.message);
    } else {
      console.error('   Error setting up request:', error.message);
    }
    // console.error('   Full error object:', error.config); // Peut être verbeux
  }
}


export {
  testGatewayStreamAndLogChunks,
  testOpenAIStreamAndLogChunks
};
