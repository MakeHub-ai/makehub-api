/**
 * Script pour créer des données de test pour le webhook
 * 
 * Ce script insère des requêtes de test avec le statut 'ready_to_compute'
 * pour pouvoir tester le webhook de calcul des tokens.
 *
 * Usage:
 * 1. Configurer les variables d'environnement de la base de données
 * 2. Exécuter: node examples/create-test-data.js
 */

import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

/**
 * Crée des données de test dans la base
 */
async function createTestData() {
  console.log('📝 Création de données de test pour le webhook...');
  console.log('='.repeat(50));

  try {
    // 1. Vérifier qu'un utilisateur de test existe
    const testUserId = '3dfeb923-1e33-4a3a-9473-ee9637446ae4';
    console.log('👤 Vérification de l\'utilisateur de test...');
    
    // 2. Vérifier qu'un modèle existe
    console.log('🤖 Vérification des modèles disponibles...');
    const { data: models, error: modelsError } = await supabase
      .from('models')
      .select('*')
      .limit(1);
      
    if (modelsError) {
      console.error('❌ Erreur lors de la récupération des modèles:', modelsError);
      return;
    }
    
    if (!models || models.length === 0) {
      console.error('❌ Aucun modèle trouvé dans la base de données');
      console.log('ℹ️  Assurez-vous d\'avoir des modèles configurés dans la table "models"');
      return;
    }
    
    const testModel = models[0];
    console.log(`✅ Modèle de test trouvé: ${testModel.provider}/${testModel.model_id}`);

    // 3. Créer des requêtes de test
    console.log('📝 Création de requêtes de test...');
    
    const testRequests = [
      {
        user_id: testUserId,
        provider: testModel.provider,
        model: testModel.model_id,
        status: 'ready_to_compute',
        input_tokens: null, // Sera calculé par le webhook
        output_tokens: null, // Sera calculé par le webhook
        created_at: new Date().toISOString()
      },
      {
        user_id: testUserId,
        provider: testModel.provider,
        model: testModel.model_id,
        status: 'ready_to_compute',
        input_tokens: null,
        output_tokens: null,
        created_at: new Date().toISOString()
      }
    ];

    // Insérer les requêtes
    const { data: insertedRequests, error: requestsError } = await supabase
      .from('requests')
      .insert(testRequests)
      .select();

    if (requestsError) {
      console.error('❌ Erreur lors de l\'insertion des requêtes:', requestsError);
      return;
    }

    console.log(`✅ ${insertedRequests.length} requêtes de test créées`);

    // 4. Créer le contenu des requêtes
    console.log('📄 Création du contenu des requêtes...');
    
    const testContents = insertedRequests.map((request, index) => ({
      request_id: request.request_id,
      request_json: {
        model: testModel.model_id,
        messages: [
          {
            role: 'user',
            content: `Message de test ${index + 1}: Bonjour, comment allez-vous ?`
          }
        ],
        max_tokens: 100
      },
      response_json: {
        id: `test-response-${index + 1}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: testModel.model_id,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: `Réponse de test ${index + 1}: Bonjour ! Je vais très bien, merci de demander.`
            },
            finish_reason: 'stop'
          }
        ],
        usage: {
          prompt_tokens: 0, // Sera calculé par tiktoken
          completion_tokens: 0, // Sera calculé par tiktoken
          total_tokens: 0
        }
      }
    }));

    const { data: insertedContents, error: contentsError } = await supabase
      .from('requests_content')
      .insert(testContents)
      .select();

    if (contentsError) {
      console.error('❌ Erreur lors de l\'insertion du contenu:', contentsError);
      return;
    }

    console.log(`✅ ${insertedContents.length} contenus de requêtes créés`);
    console.log('');
    console.log('🎉 Données de test créées avec succès !');
    console.log('');
    console.log('📋 Résumé:');
    console.log(`   • Utilisateur de test: ${testUserId}`);
    console.log(`   • Modèle utilisé: ${testModel.provider}/${testModel.model_id}`);
    console.log(`   • Requêtes créées: ${insertedRequests.length}`);
    console.log('');
    console.log('🚀 Vous pouvez maintenant tester le webhook avec:');
    console.log('   node examples/test-webhook.js');

  } catch (error) {
    console.error('❌ Erreur lors de la création des données de test:', error);
  }
}

/**
 * Nettoie les données de test
 */
async function cleanTestData() {
  console.log('🧹 Nettoyage des données de test...');
  console.log('='.repeat(50));

  try {
    const testUserId = '3dfeb923-1e33-4a3a-9473-ee9637446ae4';

    // Supprimer le contenu des requêtes de test
    const { error: contentError } = await supabase
      .from('requests_content')
      .delete()
      .in('request_id', 
        await supabase
          .from('requests')
          .select('request_id')
          .eq('user_id', testUserId)
          .then(({ data }) => data?.map(r => r.request_id) || [])
      );

    if (contentError) {
      console.error('❌ Erreur lors de la suppression du contenu:', contentError);
    } else {
      console.log('✅ Contenu des requêtes supprimé');
    }

    // Supprimer les requêtes de test
    const { error: requestsError } = await supabase
      .from('requests')
      .delete()
      .eq('user_id', testUserId);

    if (requestsError) {
      console.error('❌ Erreur lors de la suppression des requêtes:', requestsError);
    } else {
      console.log('✅ Requêtes de test supprimées');
    }

    // Supprimer les transactions de test
    const { error: transactionsError } = await supabase
      .from('transactions')
      .delete()
      .eq('user_id', testUserId);

    if (transactionsError) {
      console.error('❌ Erreur lors de la suppression des transactions:', transactionsError);
    } else {
      console.log('✅ Transactions de test supprimées');
    }

    console.log('🎉 Nettoyage terminé !');

  } catch (error) {
    console.error('❌ Erreur lors du nettoyage:', error);
  }
}

/**
 * Fonction principale
 */
async function main() {
  const command = process.argv[2];

  if (command === 'clean') {
    await cleanTestData();
  } else {
    await createTestData();
  }
}

// Exécuter si appelé directement
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { createTestData, cleanTestData };
