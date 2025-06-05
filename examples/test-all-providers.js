#!/usr/bin/env node

/**
 * Script pour tester toutes les combinaisons modèle/provider
 * 
 * Usage:
 * node test-all-providers.js                           # Teste tout
 * node test-all-providers.js --provider anthropic      # Teste seulement anthropic
 * node test-all-providers.js --models claude-4-sonnet  # Teste seulement ce modèle
 * node test-all-providers.js --force                   # Force le re-test même si déjà fait
 */

import axios from 'axios';
import dotenv from 'dotenv';
import yaml from 'js-yaml';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const API_KEY = process.env.TEST_API_KEY || 'test-api-key-123';
const YAML_FILE = path.join('providers_clean.yaml');
const CACHE_FILE = path.join('temp', 'test-results-cache.json');
const REPORT_FILE = path.join('temp', 'test-report.json');

// Configuration axios
const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'X-API-Key': API_KEY,
    'Content-Type': 'application/json'
  },
  timeout: 60000 // 1 minute timeout
});

// Arguments en ligne de commande
const args = process.argv.slice(2);
const options = {
  provider: null,
  models: null,
  force: false
};

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--provider':
      options.provider = args[++i];
      break;
    case '--models':
      options.models = args[++i]?.split(',');
      break;
    case '--force':
      options.force = true;
      break;
  }
}

/**
 * Charge et parse le fichier YAML
 */
async function loadProviders() {
  try {
    const yamlContent = await fs.readFile(YAML_FILE, 'utf8');
    const data = yaml.load(yamlContent);
    return data.providers;
  } catch (error) {
    console.error('❌ Erreur lors du chargement du fichier YAML:', error.message);
    process.exit(1);
  }
}

/**
 * Charge le cache des résultats
 */
async function loadCache() {
  try {
    const cacheContent = await fs.readFile(CACHE_FILE, 'utf8');
    return JSON.parse(cacheContent);
  } catch (error) {
    return {}; // Cache vide si le fichier n'existe pas
  }
}

/**
 * Sauvegarde le cache
 */
async function saveCache(cache) {
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
}

/**
 * Extrait toutes les combinaisons provider/model
 */
function extractCombinations(providers) {
  const combinations = [];
  
  for (const [providerName, providerConfig] of Object.entries(providers)) {
    if (options.provider && providerName !== options.provider) {
      continue;
    }
    
    for (const [modelKey, modelConfig] of Object.entries(providerConfig.models || {})) {
      if (options.models && !options.models.includes(modelKey)) {
        continue;
      }
      
      combinations.push({
        provider: providerName,
        modelKey,
        modelConfig,
        fullModelName: `${providerName}/${modelKey}`
      });
    }
  }
  
  return combinations;
}

/**
 * Test normal (non-streaming)
 */
async function testNormal(combination) {
  const { provider, modelKey, fullModelName } = combination;
  
  try {
    const response = await api.post('/v1/chat/completions', {
      model: modelKey,
      provider: provider,
      messages: [
        { role: 'user', content: 'Say "Hello, I am working correctly!" in a single sentence.' }
      ],
      max_tokens: 50
    });
    
    const content = response.data.choices[0].message.content;
    return {
      success: true,
      content: content?.slice(0, 100) + (content?.length > 100 ? '...' : ''),
      usage: response.data.usage
    };
  } catch (error) {
    return {
      success: false,
      error: error.response?.data?.error?.message || error.message,
      status: error.response?.status
    };
  }
}

/**
 * Test streaming
 */
async function testStreaming(combination) {
  const { provider, modelKey } = combination;
  
  return new Promise((resolve) => {
    let success = false;
    let content = '';
    let error = null;
    let errorHandled = false;
    
    api.post('/v1/chat/completions', {
      model: modelKey,
      provider: provider,
      messages: [
        { role: 'user', content: 'Count from 1 to 5, one number per line.' }
      ],
      stream: true,
      max_tokens: 100
    }, {
      responseType: 'stream'
    }).then(response => {
      let buffer = '';
      
      response.data.on('data', (chunk) => {
        if (errorHandled) return;
        buffer += chunk.toString();
        
        // Vérifier si c'est une erreur JSON
        try {
          const jsonData = JSON.parse(buffer);
          if (jsonData.error) {
            error = jsonData.error.message || jsonData.error;
            errorHandled = true;
            resolve({ success: false, error });
            return;
          }
        } catch (e) {
          // Continue vers le traitement ligne par ligne
        }

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (errorHandled) break;
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') {
              success = true;
              errorHandled = true;
              resolve({
                success: true,
                content: content.slice(0, 100) + (content.length > 100 ? '...' : ''),
                streamedChunks: content.length
              });
              return;
            }
            
            try {
              const parsed = JSON.parse(data);
              if (parsed.choices?.[0]?.delta?.content) {
                content += parsed.choices[0].delta.content;
              }
            } catch (e) {
              // Ignorer les erreurs de parsing
            }
          }
        }
      });

      response.data.on('error', (err) => {
        if (!errorHandled) {
          error = err.message;
          errorHandled = true;
          resolve({ success: false, error });
        }
      });
      
      response.data.on('end', () => {
        if (!errorHandled) {
          if (content.length > 0) {
            resolve({
              success: true,
              content: content.slice(0, 100) + (content.length > 100 ? '...' : ''),
              streamedChunks: content.length
            });
          } else {
            resolve({ success: false, error: 'No content received' });
          }
        }
      });
    }).catch(err => {
      resolve({
        success: false,
        error: err.response?.data?.error?.message || err.message,
        status: err.response?.status
      });
    });
  });
}

/**
 * Test streaming avec tools
 */
async function testStreamingWithTools(combination) {
  const { provider, modelKey, modelConfig } = combination;
  
  // Seulement pour les modèles assistant_ready
  if (!modelConfig.assistant_ready) {
    return { skipped: true, reason: 'Model not assistant_ready' };
  }
  
  return new Promise((resolve) => {
    let success = false;
    let content = '';
    let toolCalls = [];
    let error = null;
    let errorHandled = false;
    
    api.post('/v1/chat/completions', {
      model: modelKey,
      provider: provider,
      messages: [
        { role: 'user', content: 'What is 15 multiplied by 23? Use the calculator tool to compute this.' }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'calculator',
            description: 'Perform basic arithmetic operations',
            parameters: {
              type: 'object',
              properties: {
                operation: {
                  type: 'string',
                  enum: ['add', 'subtract', 'multiply', 'divide']
                },
                a: { type: 'number' },
                b: { type: 'number' }
              },
              required: ['operation', 'a', 'b']
            }
          }
        }
      ],
      tool_choice: 'auto',
      stream: true,
      max_tokens: 200
    }, {
      responseType: 'stream'
    }).then(response => {
      let buffer = '';
      
      response.data.on('data', (chunk) => {
        if (errorHandled) return;
        buffer += chunk.toString();
        
        // Vérifier si c'est une erreur JSON
        try {
          const jsonData = JSON.parse(buffer);
          if (jsonData.error) {
            error = jsonData.error.message || jsonData.error;
            errorHandled = true;
            resolve({ success: false, error });
            return;
          }
        } catch (e) {
          // Continue vers le traitement ligne par ligne
        }

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (errorHandled) break;
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') {
              success = true;
              errorHandled = true;
              resolve({
                success: true,
                content: content.slice(0, 100) + (content.length > 100 ? '...' : ''),
                toolCallsUsed: toolCalls.length,
                toolCalls: toolCalls.map(tc => ({
                  name: tc.function.name,
                  args: tc.function.arguments
                }))
              });
              return;
            }
            
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta;
              
              // Gérer le contenu texte
              if (delta?.content) {
                content += delta.content;
              }
              
              // Gérer les tool calls
              if (delta?.tool_calls) {
                delta.tool_calls.forEach((toolCall) => {
                  const index = toolCall.index;
                  
                  if (!toolCalls[index]) {
                    toolCalls[index] = {
                      id: toolCall.id || '',
                      type: toolCall.type || 'function',
                      function: {
                        name: toolCall.function?.name || '',
                        arguments: toolCall.function?.arguments || ''
                      }
                    };
                  } else {
                    if (toolCall.function?.arguments) {
                      toolCalls[index].function.arguments += toolCall.function.arguments;
                    }
                    if (toolCall.function?.name) {
                      toolCalls[index].function.name = toolCall.function.name;
                    }
                    if (toolCall.id) {
                      toolCalls[index].id = toolCall.id;
                    }
                  }
                });
              }
            } catch (e) {
              // Ignorer les erreurs de parsing
            }
          }
        }
      });

      response.data.on('error', (err) => {
        if (!errorHandled) {
          error = err.message;
          errorHandled = true;
          resolve({ success: false, error });
        }
      });
      
      response.data.on('end', () => {
        if (!errorHandled) {
          resolve({
            success: toolCalls.length > 0, // Succès seulement si des tools ont été utilisés
            content: content.slice(0, 100) + (content.length > 100 ? '...' : ''),
            toolCallsUsed: toolCalls.length,
            toolCalls: toolCalls.map(tc => ({
              name: tc.function.name,
              args: tc.function.arguments
            })),
            warning: toolCalls.length === 0 ? 'No tools were used despite being available' : null
          });
        }
      });
    }).catch(err => {
      resolve({
        success: false,
        error: err.response?.data?.error?.message || err.message,
        status: err.response?.status
      });
    });
  });
}

/**
 * Test une combinaison complète
 */
async function testCombination(combination) {
  const { provider, modelKey, fullModelName } = combination;
  
  console.log(`\n🧪 Testing ${fullModelName}...`);
  
  const results = {
    provider,
    modelKey,
    fullModelName,
    timestamp: new Date().toISOString(),
    tests: {}
  };
  
  // Test normal
  console.log(`   📝 Normal test...`);
  results.tests.normal = await testNormal(combination);
  console.log(`   ${results.tests.normal.success ? '✅' : '❌'} Normal: ${results.tests.normal.success ? 'OK' : results.tests.normal.error}`);
  
  // Test streaming
  console.log(`   🌊 Streaming test...`);
  results.tests.streaming = await testStreaming(combination);
  console.log(`   ${results.tests.streaming.success ? '✅' : '❌'} Streaming: ${results.tests.streaming.success ? 'OK' : results.tests.streaming.error}`);
  
  // Test streaming avec tools (seulement si assistant_ready)
  console.log(`   🔧 Tool calling test...`);
  results.tests.toolCalling = await testStreamingWithTools(combination);
  if (results.tests.toolCalling.skipped) {
    console.log(`   ⏭️  Tool calling: Skipped (${results.tests.toolCalling.reason})`);
  } else {
    console.log(`   ${results.tests.toolCalling.success ? '✅' : '❌'} Tool calling: ${results.tests.toolCalling.success ? `OK (${results.tests.toolCalling.toolCallsUsed} tools used)` : results.tests.toolCalling.error}`);
  }
  
  return results;
}

/**
 * Génère un rapport
 */
async function generateReport(allResults) {
  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      total: allResults.length,
      success: 0,
      partial: 0,
      failed: 0
    },
    byProvider: {},
    details: allResults
  };
  
  allResults.forEach(result => {
    const { provider, tests } = result;
    
    // Calculer le statut global
    const normalOk = tests.normal.success;
    const streamingOk = tests.streaming.success;
    const toolsOk = tests.toolCalling.skipped || tests.toolCalling.success;
    
    let status;
    if (normalOk && streamingOk && toolsOk) {
      status = 'success';
      report.summary.success++;
    } else if (normalOk || streamingOk) {
      status = 'partial';
      report.summary.partial++;
    } else {
      status = 'failed';
      report.summary.failed++;
    }
    
    result.status = status;
    
    // Grouper par provider
    if (!report.byProvider[provider]) {
      report.byProvider[provider] = {
        total: 0,
        success: 0,
        partial: 0,
        failed: 0,
        models: []
      };
    }
    
    report.byProvider[provider].total++;
    report.byProvider[provider][status]++;
    report.byProvider[provider].models.push({
      modelKey: result.modelKey,
      status,
      tests: {
        normal: tests.normal.success,
        streaming: tests.streaming.success,
        toolCalling: tests.toolCalling.skipped ? 'skipped' : tests.toolCalling.success
      }
    });
  });
  
  // Sauvegarder le rapport
  await fs.writeFile(REPORT_FILE, JSON.stringify(report, null, 2));
  
  return report;
}

/**
 * Affiche le rapport dans la console
 */
function displayReport(report) {
  console.log('\n' + '='.repeat(80));
  console.log('📊 RAPPORT DE TEST FINAL');
  console.log('='.repeat(80));
  
  console.log(`\n📈 RÉSUMÉ GLOBAL:`);
  console.log(`   Total: ${report.summary.total} modèles testés`);
  console.log(`   ✅ Succès complets: ${report.summary.success}`);
  console.log(`   ⚠️  Succès partiels: ${report.summary.partial}`);
  console.log(`   ❌ Échecs: ${report.summary.failed}`);
  
  console.log(`\n📋 PAR PROVIDER:`);
  for (const [provider, stats] of Object.entries(report.byProvider)) {
    console.log(`\n   🏢 ${provider}:`);
    console.log(`      Total: ${stats.total} | ✅ ${stats.success} | ⚠️ ${stats.partial} | ❌ ${stats.failed}`);
    
    // Afficher les modèles en échec
    const failedModels = stats.models.filter(m => m.status === 'failed');
    if (failedModels.length > 0) {
      console.log(`      Échecs: ${failedModels.map(m => m.modelKey).join(', ')}`);
    }
  }
  
  console.log(`\n💾 Rapport détaillé sauvegardé dans: ${REPORT_FILE}`);
}

/**
 * Fonction principale
 */
async function main() {
  console.log('🚀 Démarrage des tests de tous les providers/modèles...\n');
  
  if (options.provider) {
    console.log(`🎯 Provider spécifique: ${options.provider}`);
  }
  if (options.models) {
    console.log(`🎯 Modèles spécifiques: ${options.models.join(', ')}`);
  }
  if (options.force) {
    console.log(`🔄 Mode forcé: re-test de tous les modèles`);
  }
  
  // Charger les données
  const providers = await loadProviders();
  const cache = options.force ? {} : await loadCache();
  const combinations = extractCombinations(providers);
  
  console.log(`📊 ${combinations.length} combinaisons à tester\n`);
  
  const allResults = [];
  let skipped = 0;
  
  for (const combination of combinations) {
    const cacheKey = `${combination.provider}/${combination.modelKey}`;
    
    // Vérifier le cache
    if (cache[cacheKey] && !options.force) {
      console.log(`⏭️  Skipping ${combination.fullModelName} (already tested)`);
      allResults.push(cache[cacheKey]);
      skipped++;
      continue;
    }
    
    try {
      const result = await testCombination(combination);
      allResults.push(result);
      
      // Mettre à jour le cache
      cache[cacheKey] = result;
      await saveCache(cache);
      
      // Petit délai entre les tests
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      console.error(`❌ Erreur inattendue pour ${combination.fullModelName}:`, error.message);
      
      const errorResult = {
        provider: combination.provider,
        modelKey: combination.modelKey,
        fullModelName: combination.fullModelName,
        timestamp: new Date().toISOString(),
        status: 'failed',
        tests: {
          normal: { success: false, error: error.message },
          streaming: { success: false, error: 'Test not attempted due to previous error' },
          toolCalling: { success: false, error: 'Test not attempted due to previous error' }
        }
      };
      
      allResults.push(errorResult);
      cache[cacheKey] = errorResult;
      await saveCache(cache);
    }
  }
  
  if (skipped > 0) {
    console.log(`\n⏭️  ${skipped} modèles skippés (déjà testés). Utilisez --force pour les re-tester.`);
  }
  
  // Générer et afficher le rapport
  const report = await generateReport(allResults);
  displayReport(report);
}

// Exécuter si appelé directement
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('❌ Erreur fatale:', error);
    process.exit(1);
  });
}