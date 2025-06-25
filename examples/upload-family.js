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

// Fonction pour valider la structure routing_config
function validateRoutingConfig(routingConfig, familyId) {
  const errors = [];

  // Vérifier les champs requis
  if (!routingConfig.score_ranges || !Array.isArray(routingConfig.score_ranges)) {
    errors.push('score_ranges is required and must be an array');
  }

  if (!routingConfig.fallback_model || typeof routingConfig.fallback_model !== 'string') {
    errors.push('fallback_model is required and must be a string');
  }

  if (!routingConfig.fallback_provider || typeof routingConfig.fallback_provider !== 'string') {
    errors.push('fallback_provider is required and must be a string');
  }

  if (!routingConfig.cache_duration_minutes || typeof routingConfig.cache_duration_minutes !== 'number') {
    errors.push('cache_duration_minutes is required and must be a number');
  }

  if (!routingConfig.evaluation_timeout_ms || typeof routingConfig.evaluation_timeout_ms !== 'number') {
    errors.push('evaluation_timeout_ms is required and must be a number');
  }

  // Valider score_ranges
  if (routingConfig.score_ranges && Array.isArray(routingConfig.score_ranges)) {
    if (routingConfig.score_ranges.length === 0) {
      errors.push('score_ranges cannot be empty');
    }

    routingConfig.score_ranges.forEach((range, index) => {
      if (typeof range.min_score !== 'number' || range.min_score < 1 || range.min_score > 100) {
        errors.push(`score_ranges[${index}].min_score must be a number between 1 and 100`);
      }
      if (typeof range.max_score !== 'number' || range.max_score < 1 || range.max_score > 100) {
        errors.push(`score_ranges[${index}].max_score must be a number between 1 and 100`);
      }
      if (range.min_score >= range.max_score) {
        errors.push(`score_ranges[${index}].min_score must be less than max_score`);
      }
      if (!range.target_model || typeof range.target_model !== 'string') {
        errors.push(`score_ranges[${index}].target_model is required and must be a string`);
      }
      if (!range.reason || typeof range.reason !== 'string') {
        errors.push(`score_ranges[${index}].reason is required and must be a string`);
      }
    });

    // Vérifier la couverture des scores (pas de gaps)
    const sortedRanges = [...routingConfig.score_ranges].sort((a, b) => a.min_score - b.min_score);
    for (let i = 0; i < sortedRanges.length - 1; i++) {
      if (sortedRanges[i].max_score + 1 !== sortedRanges[i + 1].min_score) {
        console.warn(`⚠️ Warning for ${familyId}: Gap detected between score ranges ${sortedRanges[i].max_score} and ${sortedRanges[i + 1].min_score}`);
      }
    }

    // Vérifier les overlaps
    for (let i = 0; i < sortedRanges.length - 1; i++) {
      if (sortedRanges[i].max_score >= sortedRanges[i + 1].min_score) {
        errors.push(`score_ranges overlap detected: range ending at ${sortedRanges[i].max_score} overlaps with range starting at ${sortedRanges[i + 1].min_score}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid routing_config for family ${familyId}:\n  - ${errors.join('\n  - ')}`);
  }

  return true;
}

// Fonction pour parser le YAML et extraire les familles
function parseYamlToFamilies(yamlContent) {
  const data = yaml.load(yamlContent);
  const families = [];

  if (!data.families) {
    throw new Error('No "families" section found in YAML file');
  }

  for (const [familyId, familyData] of Object.entries(data.families)) {
    // Valider la structure routing_config
    try {
      validateRoutingConfig(familyData.routing_config, familyId);
    } catch (error) {
      console.error(`❌ Validation failed for family ${familyId}:`, error.message);
      throw error;
    }

    const family = {
      family_id: familyId,
      display_name: familyData.display_name || familyId,
      description: familyData.description || null,
      evaluation_model_id: familyData.evaluation_model_id,
      evaluation_provider: familyData.evaluation_provider,
      is_active: familyData.is_active !== undefined ? familyData.is_active : true,
      routing_config: familyData.routing_config,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    families.push(family);
  }

  console.log(`✅ Parsed ${families.length} families from YAML`);
  families.forEach(family => {
    const rangeCount = family.routing_config.score_ranges.length;
    console.log(`  • ${family.family_id}: ${rangeCount} score ranges, eval model: ${family.evaluation_model_id}`);
  });

  return families;
}

// Fonction pour récupérer les familles existantes de la DB
async function getExistingFamilies() {
  try {
    const { data, error } = await supabase
      .from('family')
      .select('family_id, display_name, description, evaluation_model_id, evaluation_provider, is_active, routing_config, created_at, updated_at');

    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('Erreur lors de la récupération des familles existantes:', error);
    throw error;
  }
}

// Fonction pour comparer et déterminer les changements
function analyzeChanges(newFamilies, existingFamilies) {
  const existingMap = new Map();
  existingFamilies.forEach(family => {
    existingMap.set(family.family_id, family);
  });

  const newFamiliesMap = new Map();
  newFamilies.forEach(family => {
    newFamiliesMap.set(family.family_id, family);
  });

  const changes = {
    toUpsert: [], // Nouvelles familles ou mises à jour
    toDelete: [], // Familles à supprimer
    unchanged: []
  };

  // Analyser les familles du YAML (nouvelles ou à mettre à jour)
  newFamilies.forEach(newFamily => {
    const existing = existingMap.get(newFamily.family_id);
    
    if (!existing) {
      changes.toUpsert.push({ type: 'insert', family: newFamily });
    } else {
      // Comparer les champs pour voir s'il y a des changements
      const hasChanges = (
        existing.display_name !== newFamily.display_name ||
        existing.description !== newFamily.description ||
        existing.evaluation_model_id !== newFamily.evaluation_model_id ||
        existing.evaluation_provider !== newFamily.evaluation_provider ||
        existing.is_active !== newFamily.is_active ||
        JSON.stringify(existing.routing_config) !== JSON.stringify(newFamily.routing_config)
      );

      if (hasChanges) {
        changes.toUpsert.push({ 
          type: 'update', 
          existing, 
          family: { 
            ...newFamily, 
            created_at: existing.created_at // Conserver la date de création
          } 
        });
      } else {
        changes.unchanged.push(newFamily);
      }
    }
  });

  // Identifier les familles à supprimer (présentes en DB mais absentes du YAML)
  existingFamilies.forEach(existing => {
    if (!newFamiliesMap.has(existing.family_id)) {
      changes.toDelete.push(existing);
    }
  });

  return changes;
}

// Fonction pour afficher le preview des changements
function displayChangesPreview(changes) {
  console.log('\n' + '='.repeat(80));
  console.log('PREVIEW DES CHANGEMENTS À APPLIQUER - FAMILLES');
  console.log('='.repeat(80));

  const insertCount = changes.toUpsert.filter(c => c.type === 'insert').length;
  const updateCount = changes.toUpsert.filter(c => c.type === 'update').length;

  console.log(`\n📊 RÉSUMÉ:`);
  console.log(`  • Nouvelles familles à insérer: ${insertCount}`);
  console.log(`  • Familles existantes à mettre à jour: ${updateCount}`);
  console.log(`  • Familles à supprimer: ${changes.toDelete.length}`);
  console.log(`  • Familles inchangées: ${changes.unchanged.length}`);

  const newFamilies = changes.toUpsert.filter(c => c.type === 'insert');
  if (newFamilies.length > 0) {
    console.log(`\n✅ NOUVELLES FAMILLES (${newFamilies.length}):`);
    newFamilies.forEach(change => {
      const family = change.family;
      console.log(`  • ${family.family_id}`);
      console.log(`    Nom: ${family.display_name}`);
      console.log(`    Modèle d'évaluation: ${family.evaluation_model_id} (${family.evaluation_provider})`);
      console.log(`    Score ranges: ${family.routing_config.score_ranges.length}`);
      console.log(`    Fallback: ${family.routing_config.fallback_model}`);
      console.log(`    Cache duration: ${family.routing_config.cache_duration_minutes}min`);
      console.log(`    Active: ${family.is_active}`);
      console.log('');
    });
  }

  const updatedFamilies = changes.toUpsert.filter(c => c.type === 'update');
  if (updatedFamilies.length > 0) {
    console.log(`\n🔄 FAMILLES À METTRE À JOUR (${updatedFamilies.length}):`);
    updatedFamilies.forEach(change => {
      console.log(`  • ${change.family.family_id}`);
      
      // Afficher seulement les champs qui changent
      if (change.existing.display_name !== change.family.display_name) {
        console.log(`    Nom: ${change.existing.display_name} → ${change.family.display_name}`);
      }
      if (change.existing.description !== change.family.description) {
        console.log(`    Description: ${change.existing.description || 'NULL'} → ${change.family.description || 'NULL'}`);
      }
      if (change.existing.evaluation_model_id !== change.family.evaluation_model_id) {
        console.log(`    Modèle d'évaluation: ${change.existing.evaluation_model_id} → ${change.family.evaluation_model_id}`);
      }
      if (change.existing.evaluation_provider !== change.family.evaluation_provider) {
        console.log(`    Provider d'évaluation: ${change.existing.evaluation_provider} → ${change.family.evaluation_provider}`);
      }
      if (change.existing.is_active !== change.family.is_active) {
        console.log(`    Active: ${change.existing.is_active} → ${change.family.is_active}`);
      }
      if (JSON.stringify(change.existing.routing_config) !== JSON.stringify(change.family.routing_config)) {
        console.log(`    Routing config: Mis à jour (${change.family.routing_config.score_ranges.length} ranges)`);
        
        // Afficher les détails des score ranges si changés
        const oldRanges = change.existing.routing_config.score_ranges || [];
        const newRanges = change.family.routing_config.score_ranges || [];
        
        if (oldRanges.length !== newRanges.length) {
          console.log(`      Score ranges count: ${oldRanges.length} → ${newRanges.length}`);
        }
        
        newRanges.forEach((range, i) => {
          console.log(`      Range ${i + 1}: ${range.min_score}-${range.max_score} → ${range.target_model}`);
        });
      }
      console.log('');
    });
  }

  if (changes.toDelete.length > 0) {
    console.log(`\n🗑️ FAMILLES À SUPPRIMER (${changes.toDelete.length}):`);
    changes.toDelete.forEach(family => {
      console.log(`  • ${family.family_id} (${family.display_name})`);
    });
    console.log('');
  }

  if (changes.unchanged.length > 0) {
    console.log(`\n⚪ FAMILLES INCHANGÉES (${changes.unchanged.length}):`);
    changes.unchanged.slice(0, 5).forEach(family => {
      console.log(`  • ${family.family_id}`);
    });
    if (changes.unchanged.length > 5) {
      console.log(`  ... et ${changes.unchanged.length - 5} autres familles inchangées`);
    }
  }

  console.log('\n' + '='.repeat(80));
}

// Fonction pour exécuter les upserts et suppressions
async function executeUpserts(changes) {
  try {
    let upsertCount = 0;
    let deleteCount = 0;

    // Upsert des familles (nouvelles et mises à jour)
    if (changes.toUpsert.length > 0) {
      const familiesToUpsert = changes.toUpsert.map(change => ({
        family_id: change.family.family_id,
        display_name: change.family.display_name,
        description: change.family.description,
        evaluation_model_id: change.family.evaluation_model_id,
        evaluation_provider: change.family.evaluation_provider,
        is_active: change.family.is_active,
        routing_config: change.family.routing_config,
        created_at: change.family.created_at,
        updated_at: new Date().toISOString()
      }));

      const { error: upsertError } = await supabase
        .from('family')
        .upsert(familiesToUpsert, { 
          onConflict: 'family_id',
          ignoreDuplicates: false 
        });

      if (upsertError) throw upsertError;
      upsertCount = changes.toUpsert.length;
    }

    // Supprimer les familles qui ne sont plus dans le YAML
    if (changes.toDelete.length > 0) {
      for (const family of changes.toDelete) {
        const { error: deleteError } = await supabase
          .from('family')
          .delete()
          .eq('family_id', family.family_id);

        if (deleteError) throw deleteError;
        deleteCount++;
      }
    }
    
    console.log(`\n✅ SUCCÈS!`);
    console.log(`  • ${upsertCount} familles traitées (upsert)`);
    console.log(`  • ${deleteCount} familles supprimées`);
    console.log(`  • Total: ${upsertCount + deleteCount} modifications appliquées`);

  } catch (error) {
    console.error('❌ Erreur lors de l\'exécution:', error);
    throw error;
  }
}

// Fonction pour vérifier que les modèles d'évaluation existent
async function validateEvaluationModels(families) {
  console.log('🔍 Vérification des modèles d\'évaluation...');
  
  const uniqueEvalModels = new Set();
  families.forEach(family => {
    uniqueEvalModels.add(`${family.evaluation_model_id}|${family.evaluation_provider}`);
  });

  for (const modelKey of uniqueEvalModels) {
    const [modelId, provider] = modelKey.split('|');
    
    const { data, error } = await supabase
      .from('models')
      .select('model_id, provider')
      .eq('model_id', modelId)
      .eq('provider', provider)
      .single();

    if (error || !data) {
      console.warn(`⚠️ Warning: Evaluation model ${modelId} (${provider}) not found in models table`);
      console.warn(`   This family will not work until this model is added to the models table`);
    } else {
      console.log(`✅ Evaluation model ${modelId} (${provider}) found`);
    }
  }
}

// Fonction principale
async function main() {
  try {
    console.log('🚀 Démarrage du processus d\'upload des familles YAML vers DB...\n');

    // Lire le fichier YAML
    const yamlPath = await askQuestion('Chemin vers le fichier YAML (ou "families.yaml" par défaut): ');
    const filePath = yamlPath.trim() || 'families.yaml';
    
    if (!fs.existsSync(filePath)) {
      throw new Error(`Le fichier ${filePath} n'existe pas.`);
    }

    console.log(`📖 Lecture du fichier: ${filePath}`);
    const yamlContent = fs.readFileSync(filePath, 'utf8');
    
    // Parser le YAML
    console.log('🔍 Analyse du fichier YAML...');
    const newFamilies = parseYamlToFamilies(yamlContent);
    console.log(`Trouvé ${newFamilies.length} familles dans le fichier YAML`);

    // Valider les modèles d'évaluation
    await validateEvaluationModels(newFamilies);

    // Récupérer les familles existantes
    console.log('🔍 Récupération des familles existantes en base...');
    const existingFamilies = await getExistingFamilies();
    console.log(`Trouvé ${existingFamilies.length} familles existantes en base`);

    // Analyser les changements
    console.log('📊 Analyse des changements...');
    const changes = analyzeChanges(newFamilies, existingFamilies);

    // Afficher le preview
    displayChangesPreview(changes);

    // Demander confirmation
    if (changes.toUpsert.length === 0 && changes.toDelete.length === 0) {
      console.log('\n✅ Aucun changement à appliquer. Toutes les familles sont déjà à jour!');
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
  }
}

// Exécuter le script
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export {
  parseYamlToFamilies,
  analyzeChanges,
  executeUpserts,
  validateRoutingConfig
};
