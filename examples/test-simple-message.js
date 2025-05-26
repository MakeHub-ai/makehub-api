/**
 * Script pour tester une requête simple et afficher clairement le message
 * dans le terminal.
 *
 * Usage:
 * 1. Configurer les variables d'environnement (TEST_API_KEY, API_BASE_URL si non localhost:3000)
 * 2. Démarrer le serveur: npm run dev
 * 3. Exécuter: node examples/test-simple-message.js
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
 * Envoie une requête simple et affiche le message dans le terminal
 */
async function testAndDisplayMessage(prompt = 'Ecrit le 5e amendement', model = 'gpt-4o') {
  console.log(`🚀 Envoi d'une requête au modèle ${model} avec le prompt: "${prompt}"`);
  console.log(`🔑 Utilisation de l'API: ${API_BASE_URL} avec la clé: ${API_KEY ? API_KEY.substring(0, 10) + '...' : 'Non définie'}`);
  
  try {
    // Vérifier si la clé API est définie
    if (!API_KEY) {
      console.error('❌ TEST_API_KEY n\'est pas définie dans les variables d\'environnement.');
      return;
    }

    console.log('⏳ Requête en mode streaming en cours...');
    
    const response = await api.post('/v1/chat/completions', {
      model: model,
      messages: [
        { role: 'user', content: prompt }
      ],
      max_tokens: 200,
      stream: true  // Activer le mode streaming
    }, {
      responseType: 'stream'  // Important pour qu'axios gère la réponse comme un stream
    });
    
    console.log('✅ Connexion établie, réception du stream:\n');
    
    // Afficher l'en-tête du message
    console.log('📝 DÉBUT DU MESSAGE 📝');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    // Variables pour reconstruire la réponse complète
    let fullContent = '';
    let buffer = '';
    let usageInfo = null;
    let modelInfo = null;
    let errorOccurred = false;
    
    // Traiter le stream de données
    response.data.on('data', (chunk) => {
      buffer += chunk.toString();
      
      // Traiter les lignes complètes dans le buffer
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Garder la dernière ligne incomplète
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          
          // Vérifier si c'est la fin du stream
          if (data === '[DONE]') {
            return;
          }
          
          try {
            const parsed = JSON.parse(data);
            
            // Extraire le modèle s'il est présent
            if (parsed.model && !modelInfo) {
              modelInfo = parsed.model;
            }
            
            // Extraire les statistiques d'utilisation si présentes
            if (parsed.usage) {
              usageInfo = parsed.usage;
            }
            
            // Extraire et afficher le contenu
            if (parsed.choices && parsed.choices[0] && parsed.choices[0].delta && parsed.choices[0].delta.content) {
              const content = parsed.choices[0].delta.content;
              process.stdout.write(content);
              //Afficher un saut de ligne pour chaque chunk
                console.log();
              fullContent += content;
            }
          } catch (e) {
            // Ignorer les erreurs de parsing pour les lignes non-JSON
          }
        }
      }
    });
    
    // Gérer la fin du stream
    response.data.on('end', () => {
      if (errorOccurred) return;
      
      // Afficher la fin du message
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('📝 FIN DU MESSAGE 📝\n');
      
      // Afficher les statistiques d'utilisation si disponibles
      if (usageInfo) {
        console.log('📊 Statistiques d\'utilisation:');
        console.log(`   - Tokens prompt: ${usageInfo.prompt_tokens}`);
        console.log(`   - Tokens réponse: ${usageInfo.completion_tokens}`);
        console.log(`   - Tokens total: ${usageInfo.total_tokens}`);
      }
      
      // Afficher le modèle utilisé
      console.log(`🤖 Modèle utilisé: ${modelInfo || model}`);
    });
    
    // Gérer les erreurs du stream
    response.data.on('error', (err) => {
      errorOccurred = true;
      console.error('\n❌ Erreur durant le streaming:', err.message);
    });
    
    // Retourner une promesse qui se résout lorsque le stream est terminé
    return new Promise((resolve, reject) => {
      response.data.on('end', resolve);
      response.data.on('error', reject);
    });

  } catch (error) {
    console.error('❌ La requête a échoué:');
    if (error.response) {
      // Erreur de l'API (e.g., 4xx, 5xx)
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Message: ${JSON.stringify(error.response.data, null, 2)}`);
    } else if (error.request) {
      // La requête a été faite mais aucune réponse n'a été reçue
      console.error(`   Aucune réponse reçue: ${error.message}`);
    } else {
      // Problème lors de la configuration de la requête
      console.error(`   Erreur lors de la configuration de la requête: ${error.message}`);
    }
  }
}

// Si ce fichier est exécuté directement
if (import.meta.url === `file://${process.argv[1]}`) {
  // Récupérer les arguments optionnels
  const prompt = process.argv[2] || 'Ecrit le 5e amendement';
  const model = process.argv[3] || 'gpt-4o';
  
  console.log('🧪 Test de messagerie simple LLM API Gateway\n');
  
  testAndDisplayMessage(prompt, model).catch(console.error);
}

export {
  testAndDisplayMessage
};
