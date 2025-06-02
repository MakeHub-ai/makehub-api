import fs from 'fs';
import yaml from 'js-yaml';
import readline from 'readline';
import { supabase } from '../dist/config/database.js';

// Interface pour les inputs utilisateur
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function askQuestion(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
}

// Configuration des conversions d'unités
const UNIT_CONVERSIONS = {
  // Prix dans le YAML sont par 1M tokens, DB stocke par 1K tokens
  PRICE_YAML_TO_DB_MULTIPLIER: 0.001, // Divise par 1000
};

// Fonction pour convertir les prix du YAML vers le format DB
function convertPrice(yamlPrice) {
  if (!yamlPrice || yamlPrice === 0) return 0.00;
  return parseFloat((yamlPrice * UNIT_CONVERSIONS.PRICE_YAML_TO_DB_MULTIPLIER).toFixed(6));
}

// Fonction pour convertir le context window du YAML vers le format DB
function convertContextWindow(yamlContext) {
  if (!yamlContext) return null;
  // Si la valeur est déjà grande (>10000), on assume qu'elle est déjà en unités absolues
  if (yamlContext > 10000) return yamlContext;
  return yamlContext;
}

/**
 * Détermine l'adapter et les paramètres extra selon le provider et les données du modèle
 * @param {string} providerName - Nom du provider
 * @param {object} modelData - Données du modèle depuis le YAML
 * @returns {object} - {adapter: string, extraParam: object}
 */

/**
 * Détermine l'adapter et les paramètres extra selon le provider et les données du modèle
 * @param {string} providerName - Nom du provider
 * @param {object} modelData - Données du modèle depuis le YAML
 * @returns {object} - {adapter: string, extraParam: object, cleanBaseUrl: string|null}
 */
function determineAdapterAndParams(providerName, modelData) {
  // Fonction utilitaire pour nettoyer les URLs de proxy
  function getCleanBaseUrl(baseUrl, targetUrl) {
    // Si c'est une URL de proxy, utiliser target_url ou null
    if (baseUrl && baseUrl.includes('proxy_')) {
      return targetUrl || null;
    }
    // Sinon garder l'URL originale
    return baseUrl || null;
  }

  // Azure OpenAI
  if (providerName.startsWith('azure-')) {
    const region = providerName.replace('azure-', '');
    const deployment = modelData.provider_model_id || 'unknown-deployment';
    const cleanBaseUrl = getCleanBaseUrl(modelData.base_url, modelData.target_url);
    
    return {
      adapter: 'azure-openai',
      cleanBaseUrl: cleanBaseUrl,
      extraParam: {
        api_version: '2024-02-15-preview',
        deployment_name: deployment,
        endpoint: cleanBaseUrl || `https://unknown.openai.azure.com`,
        region: region,
        // Variables d'environnement spécifiques à cette région
        endpoint_env: `AZURE_OPENAI_ENDPOINT_${region.toUpperCase().replace(/[-]/g, '')}`,
        api_version_env: `AZURE_OPENAI_API_VERSION_${region.toUpperCase().replace(/[-]/g, '')}`,
        api_key_env: `AZURE_OPENAI_API_KEY_${region.toUpperCase().replace(/[-]/g, '')}`
      }
    };
  }
  
  // AWS Bedrock
  if (providerName === 'bedrock' || modelData.provider_model_id?.includes('arn:aws:bedrock')) {
    // Extraire la région depuis l'ARN si disponible
    let region = 'us-east-1'; // Valeur par défaut
    if (modelData.provider_model_id?.includes('arn:aws:bedrock')) {
      const arnParts = modelData.provider_model_id.split(':');
      if (arnParts.length > 3) {
        region = arnParts[3]; // us-east-2, eu-west-1, etc.
      }
    }
    
    return {
      adapter: 'bedrock',
      cleanBaseUrl: null, // Bedrock n'a pas besoin de base_url
      extraParam: {
        region: region,
        service: 'bedrock-runtime',
        // Variables d'environnement spécifiques à cette région
        aws_access_key_env: `AWS_ACCESS_KEY_ID_BEDROCK_${region.toUpperCase().replace(/[-]/g, '_')}`,
        aws_secret_key_env: `AWS_SECRET_ACCESS_KEY_BEDROCK_${region.toUpperCase().replace(/[-]/g, '_')}`,
        aws_region_env: `AWS_REGION_BEDROCK_${region.toUpperCase().replace(/[-]/g, '_')}`
      }
    };
  }

  // Vertex AI (Google Cloud)
  if (providerName === 'vertex') {
    const cleanBaseUrl = getCleanBaseUrl(modelData.base_url, modelData.target_url);
    
    return {
      adapter: 'vertex',
      cleanBaseUrl: cleanBaseUrl,
      extraParam: {
        project_id: 'cs-poc-430lnj79urvf1fpvk3obdby', // À extraire depuis l'URL si possible
        location: 'us-central1', // À extraire depuis l'URL si possible
        endpoint: cleanBaseUrl
      }
    };
  }
  
  // OpenAI-compatible par défaut (tous les autres providers)
  const cleanBaseUrl = getCleanBaseUrl(modelData.base_url, modelData.target_url);
  
  return {
    adapter: 'openai',
    cleanBaseUrl: cleanBaseUrl,
    extraParam: {
      // Garder quelques infos utiles depuis le YAML pour référence
      exclude_param: modelData.exclude_param || null,
      max_output: modelData.max_output || null,
      working: modelData.working || null,
      assistant_ready: modelData.assistant_ready || null
    }
  };
}

// Fonction pour parser le YAML et extraire les modèles
function parseYamlToModels(yamlContent) {
  const data = yaml.load(yamlContent);
  const models = [];

  for (const [providerName, providerData] of Object.entries(data.providers)) {
    if (providerData.models) {
      for (const [modelName, modelData] of Object.entries(providerData.models)) {
        // Utiliser directement modelName comme model_id (ex: deepseek/deepseek-R1-05-28-fp8)
        const modelId = modelName;
        
        // Détecter le type d'adapter et construire adapter + extra_param
        const { adapter, extraParam, cleanBaseUrl } = determineAdapterAndParams(providerName, modelData);

        const model = {
          model_id: modelId,
          provider: providerName,
          provider_model_id: modelData.provider_model_id || modelName,
          base_url: cleanBaseUrl, // Utiliser l'URL nettoyée
          api_key_name: providerData.api_key_name || null,
          adapter: adapter, // Nouveau champ
          window_size: convertContextWindow(modelData.context),
          support_tool_calling: modelData.support_tool_calling || false,
          context_window: convertContextWindow(modelData.context),
          price_per_input_token: convertPrice(modelData.price_per_input_token),
          price_per_output_token: convertPrice(modelData.price_per_output_token),
          quantisation: modelData.quantisation ? String(modelData.quantisation) : null,
          extra_param: extraParam
        };


        models.push(model);
      }
    }
  }

  return models;
}

// Fonction pour récupérer les modèles existants de la DB
async function getExistingModels() {
  try {
    const { data, error } = await supabase
      .from('models')
      .select('model_id, provider, provider_model_id, base_url, api_key_name, adapter, window_size, support_tool_calling, context_window, price_per_input_token, price_per_output_token, quantisation, extra_param');

    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('Erreur lors de la récupération des modèles existants:', error);
    throw error;
  }
}

// Fonction pour comparer et déterminer les changements
function analyzeChanges(newModels, existingModels) {
  const existingMap = new Map();
  existingModels.forEach(model => {
    // Utiliser la clé composite (model_id, provider) comme clé primaire
    const key = `${model.model_id}|${model.provider}`;
    existingMap.set(key, model);
  });

  const newModelsMap = new Map();
  newModels.forEach(model => {
    const key = `${model.model_id}|${model.provider}`;
    newModelsMap.set(key, model);
  });

  const changes = {
    toUpsert: [], // Remplace toInsert et toUpdate
    toDelete: [], // Nouveaux modèles à supprimer
    unchanged: []
  };

  // Analyser les modèles du YAML (nouveaux ou à mettre à jour)
  newModels.forEach(newModel => {
    const key = `${newModel.model_id}|${newModel.provider}`;
    const existing = existingMap.get(key);
    
    if (!existing) {
      changes.toUpsert.push({ type: 'insert', model: newModel });
    } else {
      // Comparer les champs pour voir s'il y a des changements (avec tolérance pour les prix)
      const priceInputDiff = Math.abs(parseFloat(existing.price_per_input_token) - parseFloat(newModel.price_per_input_token));
      const priceOutputDiff = Math.abs(parseFloat(existing.price_per_output_token) - parseFloat(newModel.price_per_output_token));
      
      const hasChanges = (
        existing.provider_model_id !== newModel.provider_model_id ||
        existing.base_url !== newModel.base_url ||
        existing.api_key_name !== newModel.api_key_name ||
        existing.adapter !== newModel.adapter ||
        existing.window_size !== newModel.window_size ||
        existing.support_tool_calling !== newModel.support_tool_calling ||
        existing.context_window !== newModel.context_window ||
        priceInputDiff > 0.000001 || // Tolérance pour les erreurs de floating point
        priceOutputDiff > 0.000001 ||
        existing.quantisation !== newModel.quantisation ||
        JSON.stringify(existing.extra_param) !== JSON.stringify(newModel.extra_param)
      );

      if (hasChanges) {
        changes.toUpsert.push({ type: 'update', existing, model: newModel });
      } else {
        changes.unchanged.push(newModel);
      }
    }
  });

  // Identifier les modèles à supprimer (présents en DB mais absents du YAML)
  existingModels.forEach(existing => {
    const key = `${existing.model_id}|${existing.provider}`;
    if (!newModelsMap.has(key)) {
      changes.toDelete.push(existing);
    }
  });

  return changes;
}

// Fonction pour afficher le preview des changements
function displayChangesPreview(changes) {
  console.log('\n' + '='.repeat(80));
  console.log('PREVIEW DES CHANGEMENTS À APPLIQUER');
  console.log('='.repeat(80));

  const insertCount = changes.toUpsert.filter(c => c.type === 'insert').length;
  const updateCount = changes.toUpsert.filter(c => c.type === 'update').length;

  console.log(`\n📊 RÉSUMÉ:`);
  console.log(`  • Nouveaux modèles à insérer: ${insertCount}`);
  console.log(`  • Modèles existants à mettre à jour: ${updateCount}`);
  console.log(`  • Modèles à supprimer: ${changes.toDelete.length}`);
  console.log(`  • Modèles inchangés: ${changes.unchanged.length}`);

  const newModels = changes.toUpsert.filter(c => c.type === 'insert');
  if (newModels.length > 0) {
    console.log(`\n✅ NOUVEAUX MODÈLES (${newModels.length}):`);
    newModels.forEach(change => {
      const model = change.model;
      console.log(`  • ${model.model_id} (${model.provider})`);
      console.log(`    Adapter: ${model.adapter}`);
      console.log(`    API Key: ${model.api_key_name || 'N/A'}`);
      console.log(`    Prix input/output: ${model.price_per_input_token}/${model.price_per_output_token}`);
      console.log(`    Context window: ${model.context_window || 'N/A'}`);
      console.log(`    Tool calling: ${model.support_tool_calling}`);
      console.log(`    Base URL: ${model.base_url || 'N/A'}`);
      console.log('');
    });
  }

  const updatedModels = changes.toUpsert.filter(c => c.type === 'update');
  if (updatedModels.length > 0) {
    console.log(`\n🔄 MODÈLES À METTRE À JOUR (${updatedModels.length}):`);
    updatedModels.forEach(change => {
      console.log(`  • ${change.model.model_id} (${change.model.provider})`);
      
      // Afficher seulement les champs qui changent
      if (change.existing.provider_model_id !== change.model.provider_model_id) {
        console.log(`    Provider Model ID: ${change.existing.provider_model_id} → ${change.model.provider_model_id}`);
      }
      if (change.existing.base_url !== change.model.base_url) {
        console.log(`    Base URL: ${change.existing.base_url || 'NULL'} → ${change.model.base_url || 'NULL'}`);
      }
      if (change.existing.api_key_name !== change.model.api_key_name) {
        console.log(`    API Key Name: ${change.existing.api_key_name || 'NULL'} → ${change.model.api_key_name || 'NULL'}`);
      }
      if (change.existing.window_size !== change.model.window_size) {
        console.log(`    Window Size: ${change.existing.window_size || 'NULL'} → ${change.model.window_size || 'NULL'}`);
      }
      if (change.existing.support_tool_calling !== change.model.support_tool_calling) {
        console.log(`    Tool Calling: ${change.existing.support_tool_calling} → ${change.model.support_tool_calling}`);
      }
      if (change.existing.context_window !== change.model.context_window) {
        console.log(`    Context Window: ${change.existing.context_window || 'NULL'} → ${change.model.context_window || 'NULL'}`);
      }
      if (parseFloat(change.existing.price_per_input_token) !== parseFloat(change.model.price_per_input_token)) {
        console.log(`    Prix Input: ${change.existing.price_per_input_token} → ${change.model.price_per_input_token}`);
      }
      if (parseFloat(change.existing.price_per_output_token) !== parseFloat(change.model.price_per_output_token)) {
        console.log(`    Prix Output: ${change.existing.price_per_output_token} → ${change.model.price_per_output_token}`);
      }
      if (change.existing.quantisation !== change.model.quantisation) {
        console.log(`    Quantisation: ${change.existing.quantisation || 'NULL'} → ${change.model.quantisation || 'NULL'}`);
      }
      if (JSON.stringify(change.existing.extra_param) !== JSON.stringify(change.model.extra_param)) {
        console.log(`    Extra Param: Mis à jour`);
      }
      console.log('');
    });
  }

  if (changes.toDelete.length > 0) {
    console.log(`\n🗑️ MODÈLES À SUPPRIMER (${changes.toDelete.length}):`);
    changes.toDelete.forEach(model => {
      console.log(`  • ${model.model_id} (${model.provider})`);
    });
    console.log('');
  }

  if (changes.unchanged.length > 0) {
    console.log(`\n⚪ MODÈLES INCHANGÉS (${changes.unchanged.length}):`);
    changes.unchanged.slice(0, 5).forEach(model => {
      console.log(`  • ${model.model_id} (${model.provider})`);
    });
    if (changes.unchanged.length > 5) {
      console.log(`  ... et ${changes.unchanged.length - 5} autres modèles inchangés`);
    }
  }

  console.log('\n' + '='.repeat(80));
}

// Fonction pour exécuter les upserts et suppressions
async function executeUpserts(changes) {
  try {
    let upsertCount = 0;
    let deleteCount = 0;

    // Upsert des modèles (nouveaux et mis à jour)
    if (changes.toUpsert.length > 0) {
      const modelsToUpsert = changes.toUpsert.map(change => ({
        model_id: change.model.model_id,
        provider: change.model.provider,
        provider_model_id: change.model.provider_model_id,
        base_url: change.model.base_url,
        api_key_name: change.model.api_key_name,
        adapter: change.model.adapter, // ← Ajouter cette ligne
        window_size: change.model.window_size,
        support_tool_calling: change.model.support_tool_calling,
        context_window: change.model.context_window,
        price_per_input_token: change.model.price_per_input_token,
        price_per_output_token: change.model.price_per_output_token,
        quantisation: change.model.quantisation,
        extra_param: change.model.extra_param,
        updated_at: new Date().toISOString()
      }));

      const { error: upsertError } = await supabase
        .from('models')
        .upsert(modelsToUpsert, { 
          onConflict: 'model_id,provider',
          ignoreDuplicates: false 
        });

      if (upsertError) throw upsertError;
      upsertCount = changes.toUpsert.length;
    }

    // Supprimer les modèles qui ne sont plus dans le YAML
    if (changes.toDelete.length > 0) {
      for (const model of changes.toDelete) {
        const { error: deleteError } = await supabase
          .from('models')
          .delete()
          .eq('model_id', model.model_id)
          .eq('provider', model.provider);

        if (deleteError) throw deleteError;
        deleteCount++;
      }
    }
    
    console.log(`\n✅ SUCCÈS!`);
    console.log(`  • ${upsertCount} modèles traités (upsert)`);
    console.log(`  • ${deleteCount} modèles supprimés`);
    console.log(`  • Total: ${upsertCount + deleteCount} modifications appliquées`);

  } catch (error) {
    console.error('❌ Erreur lors de l\'exécution:', error);
    throw error;
  }
}

// Fonction principale
async function main() {
  try {
    console.log('🚀 Démarrage du processus d\'upload YAML vers DB...\n');

    // Lire le fichier YAML
    const yamlPath = await askQuestion('Chemin vers le fichier YAML (ou "providers.yaml" par défaut): ');
    const filePath = yamlPath.trim() || 'providers.yaml';
    
    if (!fs.existsSync(filePath)) {
      throw new Error(`Le fichier ${filePath} n'existe pas.`);
    }

    console.log(`📖 Lecture du fichier: ${filePath}`);
    const yamlContent = fs.readFileSync(filePath, 'utf8');
    
    // Parser le YAML
    console.log('🔍 Analyse du fichier YAML...');
    const newModels = parseYamlToModels(yamlContent);
    console.log(`Trouvé ${newModels.length} modèles dans le fichier YAML`);

    // Récupérer les modèles existants
    console.log('🔍 Récupération des modèles existants en base...');
    const existingModels = await getExistingModels();
    console.log(`Trouvé ${existingModels.length} modèles existants en base`);

    // Analyser les changements
    console.log('📊 Analyse des changements...');
    const changes = analyzeChanges(newModels, existingModels);

    // Afficher le preview
    displayChangesPreview(changes);

    // Demander confirmation
    if (changes.toUpsert.length === 0 && changes.toDelete.length === 0) {
      console.log('\n✅ Aucun changement à appliquer. Tous les modèles sont déjà à jour!');
      return;
    }

    const confirmation = await askQuestion('\n❓ Voulez-vous appliquer ces changements? (oui/non): ');
    
    if (confirmation.toLowerCase() === 'oui' || confirmation.toLowerCase() === 'o' || confirmation.toLowerCase() === 'yes' || confirmation.toLowerCase() === 'y') {
      console.log('\n⏳ Application des changements...');
      await executeUpserts(changes);
    } else {
      console.log('\n❌ Opération annulée par l\'utilisateur.');
    }

  } catch (error) {
    console.error('❌ Erreur:', error.message);
  } finally {
    rl.close();
    // Plus besoin de fermer le pool PostgreSQL
  }
}

// Exécuter le script
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export {
  parseYamlToModels,
  analyzeChanges,
  executeUpserts
};