import fs from 'fs';
import yaml from 'js-yaml';
import readline from 'readline';

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

// Champs essentiels à conserver pour chaque modèle
const ESSENTIAL_MODEL_FIELDS = [
  'base_url',
  'context', // pour context_window
  'price_per_input_token',
  'price_per_output_token',
  'price_cached_token', // prix pour les tokens en cache
  'provider_model_id',
  'quantisation',
  'support_tool_calling',
  'support_input_cache', // support du cache d'entrée
  'support_vision', // support de la vision
  'max_output', // pour certains providers
  'assistant_ready', // pour filtrer les modèles prêts pour Cline
  'display_name', // pour affichage dans l'interface
];

// Champs essentiels à conserver pour chaque provider
const ESSENTIAL_PROVIDER_FIELDS = [
  'api_key_name',
  'models',
  'provider_name' // optionnel mais utile
];

/**
 * Nettoie un objet modèle en gardant uniquement les champs essentiels
 */
function cleanModelData(modelData) {
  const cleaned = {};
  
  ESSENTIAL_MODEL_FIELDS.forEach(field => {
    if (modelData.hasOwnProperty(field)) {
      cleaned[field] = modelData[field];
    }
  });
  
  // Ajouter les valeurs par défaut pour les nouveaux champs s'ils ne sont pas présents
  if (!cleaned.hasOwnProperty('support_input_cache')) {
    cleaned.support_input_cache = false;
  }
  
  if (!cleaned.hasOwnProperty('support_vision')) {
    cleaned.support_vision = false;
  }
  
  if (!cleaned.hasOwnProperty('price_cached_token')) {
    cleaned.price_cached_token = null;
  }
  
  return cleaned;
}

/**
 * Nettoie un objet provider en gardant uniquement les champs essentiels
 */
function cleanProviderData(providerData) {
  const cleaned = {};
  
  // Copier les champs essentiels du provider
  ESSENTIAL_PROVIDER_FIELDS.forEach(field => {
    if (providerData.hasOwnProperty(field) && field !== 'models') {
      cleaned[field] = providerData[field];
    }
  });
  
  // Nettoyer les modèles
  if (providerData.models) {
    cleaned.models = {};
    Object.entries(providerData.models).forEach(([modelName, modelData]) => {
      cleaned.models[modelName] = cleanModelData(modelData);
    });
  }
  
  return cleaned;
}

/**
 * Nettoie tout le fichier YAML
 */
function cleanYamlData(yamlData) {
  const cleaned = {
    providers: {}
  };
  
  if (yamlData.providers) {
    Object.entries(yamlData.providers).forEach(([providerName, providerData]) => {
      cleaned.providers[providerName] = cleanProviderData(providerData);
    });
  }
  
  return cleaned;
}

/**
 * Compte les champs supprimés pour statistiques
 */
function countRemovedFields(original, cleaned) {
  let originalFields = 0;
  let cleanedFields = 0;
  
  function countFields(obj, prefix = '') {
    let count = 0;
    for (const [key, value] of Object.entries(obj)) {
      count++;
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        count += countFields(value, `${prefix}${key}.`);
      }
    }
    return count;
  }
  
  originalFields = countFields(original);
  cleanedFields = countFields(cleaned);
  
  return {
    original: originalFields,
    cleaned: cleanedFields,
    removed: originalFields - cleanedFields
  };
}

/**
 * Analyse les différences entre le fichier original et nettoyé
 */
function analyzeChanges(originalData, cleanedData) {
  const stats = {
    providers: {
      total: Object.keys(originalData.providers || {}).length,
      kept: Object.keys(cleanedData.providers || {}).length
    },
    models: {
      total: 0,
      kept: 0
    },
    fields: countRemovedFields(originalData, cleanedData)
  };
  
  // Compter les modèles
  Object.values(originalData.providers || {}).forEach(provider => {
    if (provider.models) {
      stats.models.total += Object.keys(provider.models).length;
    }
  });
  
  Object.values(cleanedData.providers || {}).forEach(provider => {
    if (provider.models) {
      stats.models.kept += Object.keys(provider.models).length;
    }
  });
  
  return stats;
}

/**
 * Affiche un aperçu des changements
 */
function displayCleaningPreview(originalData, cleanedData, stats) {
  console.log('\n' + '='.repeat(80));
  console.log('APERÇU DU NETTOYAGE YAML');
  console.log('='.repeat(80));
  
  console.log(`\n📊 STATISTIQUES:`);
  console.log(`  • Providers: ${stats.providers.kept}/${stats.providers.total} conservés`);
  console.log(`  • Modèles: ${stats.models.kept}/${stats.models.total} conservés`);
  console.log(`  • Champs: ${stats.fields.cleaned}/${stats.fields.original} conservés (${stats.fields.removed} supprimés)`);
  
  // Calculer le pourcentage de réduction
  const sizeReduction = ((stats.fields.removed / stats.fields.original) * 100).toFixed(1);
  console.log(`  • Réduction: ${sizeReduction}% des champs supprimés`);
  
  console.log(`\n✅ CHAMPS CONSERVÉS PAR MODÈLE:`);
  console.log(`  • base_url - URL de base de l'API`);
  console.log(`  • context - Taille de la fenêtre de contexte`);
  console.log(`  • price_per_input_token - Prix par token d'entrée`);
  console.log(`  • price_per_output_token - Prix par token de sortie`);
  console.log(`  • price_cached_token - Prix par token en cache`);
  console.log(`  • provider_model_id - ID du modèle chez le provider`);
  console.log(`  • quantisation - Type de quantisation`);
  console.log(`  • support_tool_calling - Support des outils`);
  console.log(`  • support_input_cache - Support du cache d'entrée`);
  console.log(`  • support_vision - Support de la vision`);
  console.log(`  • target_url - URL cible pour les proxies`);
  console.log(`  • exclude_param - Paramètres à exclure`);
  console.log(`  • max_output - Limite de sortie`);
  console.log(`  • working - Statut de fonctionnement`);
  console.log(`  • assistant_ready - Prêt pour assistant`);
  
  console.log(`\n🗑️ CHAMPS SUPPRIMÉS (exemples):`);
  console.log(`  • last_test_timestamp - Timestamp du dernier test`);
  console.log(`  • latency_median - Latence médiane`);
  console.log(`  • throughput_median - Débit médian`);
  console.log(`  • throughput_p25/p5 - Percentiles de débit`);
  console.log(`  • error_in_function_calling - Erreurs de fonction`);
  console.log(`  • failed_reason - Raison d'échec`);
  console.log(`  • token_ratio - Ratio de tokens`);
  console.log(`  • rtt_from_makehub - Round-trip time`);
  console.log(`  • Et autres métriques de performance...`);
  
  console.log('\n' + '='.repeat(80));
}

/**
 * Fonction principale
 */
async function main() {
  try {
    console.log('🧹 Démarrage du nettoyage du fichier YAML...\n');
    
    // Demander le fichier d'entrée
    const inputPath = await askQuestion('Fichier YAML d\'entrée (ou "providers.yaml" par défaut): ');
    const inputFile = inputPath.trim() || 'providers.yaml';
    
    if (!fs.existsSync(inputFile)) {
      throw new Error(`Le fichier ${inputFile} n'existe pas.`);
    }
    
    // Demander le fichier de sortie
    const outputPath = await askQuestion('Fichier YAML de sortie (ou "providers_clean.yaml" par défaut): ');
    const outputFile = outputPath.trim() || 'providers_clean.yaml';
    
    console.log(`\n📖 Lecture du fichier: ${inputFile}`);
    const yamlContent = fs.readFileSync(inputFile, 'utf8');
    
    console.log('🔍 Analyse du fichier YAML...');
    const originalData = yaml.load(yamlContent);
    
    console.log('🧹 Nettoyage des données...');
    const cleanedData = cleanYamlData(originalData);
    
    console.log('📊 Analyse des changements...');
    const stats = analyzeChanges(originalData, cleanedData);
    
    // Afficher l'aperçu
    displayCleaningPreview(originalData, cleanedData, stats);
    
    // Demander confirmation
    const confirmation = await askQuestion('\n❓ Voulez-vous sauvegarder le fichier nettoyé? (oui/non): ');
    
    if (confirmation.toLowerCase() === 'oui' || confirmation.toLowerCase() === 'o' || confirmation.toLowerCase() === 'yes' || confirmation.toLowerCase() === 'y') {
      console.log(`\n💾 Sauvegarde vers: ${outputFile}`);
      
      // Générer le YAML nettoyé avec des commentaires
      const yamlOptions = {
        indent: 2,
        lineWidth: 120,
        noRefs: true,
        sortKeys: false
      };
      
      const cleanedYaml = yaml.dump(cleanedData, yamlOptions);
      
      // Ajouter un header explicatif
      const header = `# Fichier YAML nettoyé - Généré automatiquement
# Contient uniquement les champs nécessaires pour l'upload vers la base de données
# Fichier original: ${inputFile}
# Date: ${new Date().toISOString()}
# Réduction: ${((stats.fields.removed / stats.fields.original) * 100).toFixed(1)}% des champs supprimés

`;
      
      fs.writeFileSync(outputFile, header + cleanedYaml, 'utf8');
      
      console.log(`\n✅ SUCCÈS!`);
      console.log(`  • Fichier sauvegardé: ${outputFile}`);
      console.log(`  • Taille réduite de ${((stats.fields.removed / stats.fields.original) * 100).toFixed(1)}%`);
      console.log(`  • ${stats.models.kept} modèles conservés sur ${stats.providers.kept} providers`);
      
      // Calculer la taille des fichiers
      const originalSize = fs.statSync(inputFile).size;
      const cleanedSize = fs.statSync(outputFile).size;
      const sizeDiff = ((originalSize - cleanedSize) / originalSize * 100).toFixed(1);
      
      console.log(`  • Taille fichier: ${(cleanedSize / 1024).toFixed(1)}KB (${sizeDiff}% de réduction)`);
      
    } else {
      console.log('\n❌ Opération annulée par l\'utilisateur.');
    }
    
  } catch (error) {
    console.error('❌ Erreur:', error.message);
  } finally {
    rl.close();
  }
}

// Exécuter le script
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export {
  cleanYamlData,
  cleanModelData,
  cleanProviderData,
  analyzeChanges
};
