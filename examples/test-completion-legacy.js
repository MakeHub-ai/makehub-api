#!/usr/bin/env node

/**
 * Script de test pour l'endpoint legacy /v1/completion
 * 
 * Usage:
 * npm run test:completion
 * ou
 * node examples/test-completion-legacy.js
 */

import axios from 'axios';
import dotenv from 'dotenv';

// Charger les variables d'environnement
dotenv.config();

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const API_KEY = process.env.TEST_API_KEY;

if (!API_KEY) {
  console.error('❌ TEST_API_KEY non définie dans les variables d\'environnement');
  process.exit(1);
}

// Configuration axios
const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'X-API-Key': API_KEY,
    'Content-Type': 'application/json'
  },
  timeout: 30000
});

/**
 * Test de completion simple
 */
async function testSimpleCompletion() {
  console.log('💬 Test de completion simple...');
  try {
    const response = await api.post('/v1/completion', {
      model: 'gpt-4o',
      prompt: 'Once upon a time, in a magical forest',
      max_tokens: 100,
      temperature: 0.7
    });
    
    console.log('✅ Completion simple réussie');
    console.log('📝 Texte généré:', response.data.choices[0].text);
    console.log('📊 Usage:', response.data.usage);
    return true;
  } catch (error) {
    console.error('❌ Completion simple échouée:', error.response?.data || error.message);
    return false;
  }
}

/**
 * Test de completion avec prompts multiples
 */
async function testMultiplePrompts() {
  console.log('\n📝 Test de completion avec prompts multiples...');
  try {
    const response = await api.post('/v1/completion', {
      model: 'gpt-4o',
      prompt: [
        'The capital of France is',
        'The color of the sky is',
        'Two plus two equals'
      ],
      max_tokens: 20,
      temperature: 0.3
    });
    
    console.log('✅ Completion multiple réussie');
    console.log('📋 Nombre de choix:', response.data.choices.length);
    response.data.choices.forEach((choice, index) => {
      console.log(`  ${index + 1}. "${choice.text.trim()}"`);
    });
    console.log('📊 Usage total:', response.data.usage);
    return true;
  } catch (error) {
    console.error('❌ Completion multiple échouée:', error.response?.data || error.message);
    return false;
  }
}

/**
 * Test de completion en streaming
 */
async function testStreamingCompletion() {
  console.log('\n🌊 Test de completion en streaming...');
  try {
    const response = await api.post('/v1/completion', {
      model: 'gpt-4o',
      prompt: 'Write a short poem about the ocean.',
      max_tokens: 150,
      temperature: 0.8,
      stream: true
    }, {
      responseType: 'stream'
    });

    console.log('✅ Streaming démarré...');
    let fullText = '';
    let buffer = '';
    let errorHandled = false;

    return new Promise((resolve, reject) => {
      response.data.on('data', (chunk) => {
        if (errorHandled) return;
        buffer += chunk.toString();
        
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (errorHandled) break;
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') {
              console.log('\n✅ Streaming terminé');
              console.log('📝 Texte complet:', fullText);
              errorHandled = true;
              resolve(true);
              return;
            }
            
            try {
              const parsed = JSON.parse(data);
              if (parsed.error) {
                console.error('❌ Erreur dans le stream:', parsed.error);
                errorHandled = true;
                reject(false);
                return;
              }
              
              if (parsed.choices?.[0]?.text) {
                process.stdout.write(parsed.choices[0].text);
                fullText += parsed.choices[0].text;
              }
            } catch (e) {
              // Ignorer les erreurs de parsing pour les lignes non-JSON
            }
          }
        }
      });

      response.data.on('error', (err) => {
        if (!errorHandled) {
          console.error('❌ Erreur de connexion streaming:', err.message);
          errorHandled = true;
          reject(false);
        }
      });
      
      response.data.on('end', () => {
        if (!errorHandled && !fullText) {
          console.error('❌ Stream terminé prématurément');
          reject(false);
        }
      });
    });
  } catch (error) {
    console.error('❌ Completion streaming échouée:', error.response?.data || error.message);
    return false;
  }
}

/**
 * Test avec paramètres avancés
 */
async function testAdvancedCompletion() {
  console.log('\n⚙️ Test de completion avec paramètres avancés...');
  try {
    const response = await api.post('/v1/completion', {
      model: 'gpt-4o',
      prompt: 'Explain quantum computing in simple terms.',
      max_tokens: 200,
      temperature: 0.5,
      top_p: 0.9,
      frequency_penalty: 0.5,
      presence_penalty: 0.3,
      stop: ['\n\n', 'However'],
      user: 'test-user-completion'
    });
    
    console.log('✅ Completion avancée réussie');
    console.log('📝 Texte:', response.data.choices[0].text);
    console.log('🛑 Raison d\'arrêt:', response.data.choices[0].finish_reason);
    console.log('📊 Usage:', response.data.usage);
    return true;
  } catch (error) {
    console.error('❌ Completion avancée échouée:', error.response?.data || error.message);
    return false;
  }
}

/**
 * Fonction principale de test
 */
async function runAllTests() {
  console.log('🚀 Démarrage des tests de l\'endpoint /v1/completion');
  console.log(`🔗 API: ${API_BASE_URL}`);
  console.log(`🔑 Clé API: ${API_KEY.substring(0, 10)}...`);
  console.log('=' .repeat(60));
  
  const results = [];
  
  // Tests séquentiels
  results.push(await testSimpleCompletion());
  results.push(await testMultiplePrompts());
  results.push(await testStreamingCompletion());
  results.push(await testAdvancedCompletion());
  
  // Résumé
  console.log('\n' + '=' .repeat(60));
  console.log('📊 RÉSUMÉ DES TESTS');
  console.log('=' .repeat(60));
  
  const passed = results.filter(r => r).length;
  const total = results.length;
  
  console.log(`✅ Tests réussis: ${passed}/${total}`);
  console.log(`❌ Tests échoués: ${total - passed}/${total}`);
  
  if (passed === total) {
    console.log('🎉 Tous les tests sont passés !');
    process.exit(0);
  } else {
    console.log('⚠️ Certains tests ont échoué');
    process.exit(1);
  }
}

// Lancement des tests
runAllTests().catch(error => {
  console.error('💥 Erreur fatale:', error);
  process.exit(1);
});
