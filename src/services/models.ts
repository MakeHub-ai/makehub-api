import { supabase } from '../config/database.js';
import { modelsCache, cacheUtils } from '../config/cache.js';
import type { 
  Model, 
  StandardRequest, 
  ProviderCombination,
  UserPreferences,
  ModelPerformanceMetrics,
  ModelVectorScore,
  ExtendedModelInfo,
} from '../types/index.js';

/**
 * Récupère tous les modèles disponibles
 * @returns Liste des modèles
 */
export async function getAllModels(): Promise<Model[]> {
  const cacheKey = cacheUtils.modelsKey();
  let models = cacheUtils.getAllModels();
  
  if (models) {
    return models;
  }
  
  const { data, error } = await supabase
    .from('models')
    .select('*')
    .order('provider', { ascending: true });
  
  if (error) {
    throw new Error(`Failed to fetch models: ${error.message}`);
  }
  
  if (!data) {
    throw new Error('No models data returned from database');
  }
  
  cacheUtils.setAllModels(data);
  return data;
}

/**
 * Récupère les modèles d'un provider spécifique
 * @param provider - Nom du provider
 * @returns Liste des modèles du provider
 */
export async function getModelsByProvider(provider: string): Promise<Model[]> {
  if (!provider || typeof provider !== 'string') {
    throw new Error('Provider name is required and must be a string');
  }

  const cachedModels = cacheUtils.getProviderModels(provider);
  
  if (cachedModels) {
    return cachedModels;
  }
  
  const { data, error } = await supabase
    .from('models')
    .select('*')
    .eq('provider', provider)
    .order('model_id', { ascending: true });
  
  if (error) {
    throw new Error(`Failed to fetch models for provider ${provider}: ${error.message}`);
  }
  
  const models = data || [];
  cacheUtils.setProviderModels(provider, models);
  return models;
}

/**
 * Récupère un modèle spécifique par son ID
 * @param modelId - ID du modèle
 * @returns Modèle trouvé
 */
export async function getModelById(modelId: string): Promise<Model> {
  if (!modelId || typeof modelId !== 'string') {
    throw new Error('Model ID is required and must be a string');
  }

  const allModels = await getAllModels();
  const model = allModels.find(m => m.model_id === modelId);
  
  if (!model) {
    throw new Error(`Model ${modelId} not found`);
  }
  
  return model;
}

/**
 * Récupère un modèle par son ID de provider
 * @param providerModelId - ID du modèle chez le provider
 * @returns Modèle trouvé
 */
export async function getModelByProviderModelId(providerModelId: string): Promise<Model | null> {
  if (!providerModelId || typeof providerModelId !== 'string') {
    return null;
  }

  const allModels = await getAllModels();
  return allModels.find(m => m.provider_model_id === providerModelId) || null;
}

/**
 * Interface pour les options de filtrage
 */
interface FilterOptions {
  requireToolCalling?: boolean;
  requireVision?: boolean;
  maxCostPerToken?: number;
  providers?: string[];
  ratio_sp?: number;
  metricsWindowSize?: number;
}

/**
 * Récupère les métriques de performance pour tous les providers d'un modèle en une seule requête SQL optimisée
 * @param modelId - ID du modèle
 * @param providers - Liste des providers à analyser
 * @param windowSize - Nombre de métriques récentes à analyser
 * @returns Map des métriques par provider
 */
async function getProviderMetricsBatch(
  modelId: string,
  providers: string[],
  windowSize: number = 10
): Promise<Map<string, ModelPerformanceMetrics>> {
  try {
    // Requête SQL optimisée avec window functions et agrégation
    const { data, error } = await supabase.rpc('get_provider_metrics_batch', {
      p_model_id: modelId,
      p_providers: providers,
      p_window_size: windowSize
    });

    if (error) {
      console.error('Error fetching batch metrics:', error);
      // Fallback vers la méthode simple si la fonction SQL n'existe pas
      return await getProviderMetricsFallback(modelId, providers, windowSize);
    }

    const metricsMap = new Map<string, ModelPerformanceMetrics>();
    
    if (data && Array.isArray(data)) {
      data.forEach((row: any) => {
        const key = `${row.provider}:${modelId}`;
        metricsMap.set(key, {
          throughput_median: row.throughput_median,
          latency_median: row.latency_median,
          sample_count: row.sample_count
        });
      });
    }

    return metricsMap;
  } catch (error) {
    console.error(`Error in batch metrics fetch for ${modelId}:`, error);
    return await getProviderMetricsFallback(modelId, providers, windowSize);
  }
}

/**
 * Fallback method si la fonction SQL optimisée n'est pas disponible
 */
async function getProviderMetricsFallback(
  modelId: string,
  providers: string[],
  windowSize: number
): Promise<Map<string, ModelPerformanceMetrics>> {
  const metricsMap = new Map<string, ModelPerformanceMetrics>();
  
  for (const provider of providers) {
    try {
      const { data, error } = await supabase
        .from('metrics')
        .select(`
          throughput_tokens_s, 
          time_to_first_chunk,
          requests!inner(model, provider)
        `)
        .eq('requests.model', modelId)
        .eq('requests.provider', provider)
        .not('throughput_tokens_s', 'is', null)
        .not('time_to_first_chunk', 'is', null)
        .order('created_at', { ascending: false })
        .limit(windowSize);

      if (error || !data || data.length === 0) {
        metricsMap.set(`${provider}:${modelId}`, {
          throughput_median: null,
          latency_median: null,
          sample_count: 0
        });
        continue;
      }

      // Calculer les médianes
      const throughputs = data
        .map(d => d.throughput_tokens_s)
        .filter((t): t is number => t !== null && t !== undefined)
        .sort((a, b) => a - b);
      
      const latencies = data
        .map(d => d.time_to_first_chunk)
        .filter((l): l is number => l !== null && l !== undefined)
        .sort((a, b) => a - b);

      const getMedian = (arr: number[]): number => {
        const mid = Math.floor(arr.length / 2);
        return arr.length % 2 === 0 ? (arr[mid - 1] + arr[mid]) / 2 : arr[mid];
      };

      metricsMap.set(`${provider}:${modelId}`, {
        throughput_median: throughputs.length > 0 ? getMedian(throughputs) : null,
        latency_median: latencies.length > 0 ? getMedian(latencies) : null,
        sample_count: data.length
      });
    } catch (error) {
      console.error(`Error fetching metrics for ${provider}:${modelId}:`, error);
      metricsMap.set(`${provider}:${modelId}`, {
        throughput_median: null,
        latency_median: null,
        sample_count: 0
      });
    }
  }

  return metricsMap;
}

/**
 * Récupère l'historique de caching pour tous les providers d'un modèle en une seule requête
 * @param userId - ID de l'utilisateur
 * @param modelId - ID du modèle
 * @param providers - Liste des providers
 * @returns Map du statut de caching par provider
 */
async function getUserCachingHistoryBatch(
  userId: string,
  modelId: string,
  providers: string[]
): Promise<Map<string, boolean>> {
  try {
    const { data, error } = await supabase
      .from('requests')
      .select('provider, cached_tokens')
      .eq('user_id', userId)
      .eq('model', modelId)
      .in('provider', providers)
      .not('cached_tokens', 'is', null)
      .gt('cached_tokens', 0)
      .order('created_at', { ascending: false })
      .limit(5 * providers.length); // 5 par provider

    const cachingMap = new Map<string, boolean>();

    if (data && data.length > 0) {
      console.log(`📊 Caching history found for user ${userId}, model ${modelId}: ${data.length} entries`)
      for (const provider of providers) {
        console.log(`   - Provider: ${provider}`);
      }
    } else {
      console.log(`📊 No caching history found for user ${userId}, model ${modelId}`);
    }

    // Initialiser toutes les clés à false
    providers.forEach(provider => {
      cachingMap.set(`${provider}:${modelId}`, false);
    });

    if (!error && data && data.length > 0) {
      // Grouper par provider et vérifier s'il y a du caching
      const providerCaching = new Map<string, boolean>();
      data.forEach(row => {
        if (row.cached_tokens > 0) {
          providerCaching.set(row.provider, true);
        }
      });

      // Mettre à jour la map finale
      providerCaching.forEach((hasCaching, provider) => {
        cachingMap.set(`${provider}:${modelId}`, hasCaching);
      });
    }

    return cachingMap;
  } catch (error) {
    console.error(`Error checking caching history for user ${userId}, model ${modelId}:`, error);
    
    // Fallback: retourner false pour tous les providers
    const cachingMap = new Map<string, boolean>();
    providers.forEach(provider => {
      cachingMap.set(`${provider}:${modelId}`, false);
    });
    return cachingMap;
  }
}

/**
 * Calcule le score vectoriel 3D pour un modèle
 */
async function calculateModelVectorScore(
  model: Model,
  ratioSp: number,
  allMetrics: Map<string, ModelPerformanceMetrics>,
  cachingMap: Map<string, boolean>,
  globalMinMax: {
    minPrice: number; 
    maxPrice: number;
    minThroughput: number; 
    maxThroughput: number;
    minLatency: number; 
    maxLatency: number;
  }
): Promise<ModelVectorScore> {
  const modelKey = `${model.provider}:${model.model_id}`;
  const metrics = allMetrics.get(modelKey);
  const hasCaching = cachingMap.get(modelKey) || false;
  
  // 1. Normaliser le prix (0-1, où 0 = moins cher)
  const totalPrice = model.price_per_input_token + model.price_per_output_token;
  const normalizedPrice = globalMinMax.maxPrice > globalMinMax.minPrice 
    ? (totalPrice - globalMinMax.minPrice) / (globalMinMax.maxPrice - globalMinMax.minPrice)
    : 0;

  // 2. Normaliser le throughput (0-1, où 1 = plus rapide)
  let normalizedThroughput = 0.5; // valeur par défaut si pas de métriques
  if (metrics?.throughput_median && globalMinMax.maxThroughput > globalMinMax.minThroughput) {
    normalizedThroughput = (metrics.throughput_median - globalMinMax.minThroughput) / 
                          (globalMinMax.maxThroughput - globalMinMax.minThroughput);
  }

  // 3. Normaliser la latence (0-1, où 1 = plus rapide, donc latence plus faible)
  let normalizedLatency = 0.5; // valeur par défaut
  if (metrics?.latency_median && globalMinMax.maxLatency > globalMinMax.minLatency) {
    normalizedLatency = 1 - ((metrics.latency_median - globalMinMax.minLatency) / 
                            (globalMinMax.maxLatency - globalMinMax.minLatency));
  }

  // 4. Calculer le point optimal selon ratio_sp
  const ratioNormalized = ratioSp / 100; // 0-1
  const optimalPrice = 1 - ratioNormalized;      // ratio_sp=0 → optimal prix=1 (bas prix)
  const optimalThroughput = ratioNormalized;     // ratio_sp=100 → optimal throughput=1
  const optimalLatency = ratioNormalized;        // ratio_sp=100 → optimal latence=1

  // 5. Distance euclidienne 3D
  const distance = Math.sqrt(
    Math.pow(normalizedPrice - optimalPrice, 2) +
    Math.pow(normalizedThroughput - optimalThroughput, 2) +
    Math.pow(normalizedLatency - optimalLatency, 2)
  );

  // 6. Boost pour le caching (réduire le score de 50%)
  const finalScore = hasCaching ? distance * 0.5 : distance;

  return {
    model,
    score: finalScore,
    normalizedPrice,
    normalizedThroughput,
    normalizedLatency,
    cachingBoost: hasCaching,
    hasSufficientMetrics: (metrics?.sample_count || 0) >= 3
  };
}

/**
 * Fonction helper pour estimer les tokens d'une requête
 */
function estimateTokensFromRequest(request: StandardRequest): number {
  let estimatedTokens = 0;
  
  request.messages?.forEach(message => {
    if (typeof message.content === 'string') {
      estimatedTokens += Math.ceil(message.content.length / 4);
    } else if (Array.isArray(message.content)) {
      message.content.forEach(item => {
        if (item.type === 'text' && item.text) {
          estimatedTokens += Math.ceil(item.text.length / 4);
        } else if (item.type === 'image_url') {
          estimatedTokens += 1000; // Estimation pour les images
        }
      });
    }
  });
  
  return estimatedTokens + (request.max_tokens || 1000);
}

/**
 * Filtre les providers pour un model_id donné et les trie selon les critères vectoriels 3D
 * @param request - Requête standardisée (DOIT contenir un model_id)
 * @param userId - ID de l'utilisateur (pour l'historique de caching)
 * @param userPreferences - Préférences utilisateur
 * @param filterOptions - Options de filtrage incluant ratio_sp
 * @returns Liste des providers triés par score vectoriel
 */
export async function filterProviders(
  request: StandardRequest, 
  userId: string,
  userPreferences: UserPreferences = {},
  filterOptions: FilterOptions = {}
): Promise<ProviderCombination[]> {
  
  const { 
    model: requestedModel,
    tools = null
  } = request;
  
  const {
    ratio_sp = 50,
    metricsWindowSize = 10
  } = filterOptions;
  
  // 1. Le model_id DOIT être spécifié
  if (!requestedModel || typeof requestedModel !== 'string') {
    throw new Error('model_id is required and must be specified');
  }
  
  //console.log(`🔍 Searching providers for model_id: "${requestedModel}"`);
  //console.log(`📋 Request requirements:`);
  //console.log(`   - Tools required: ${tools && tools.length > 0 ? 'YES' : 'NO'}`);
  
  const hasImages = request.messages?.some(m => 
    Array.isArray(m.content) && m.content.some(item => item.type === 'image_url')
  );
  //console.log(`   - Vision required: ${hasImages ? 'YES' : 'NO'}`);
  
  const totalTokens = estimateTokensFromRequest(request);
  //console.log(`   - Estimated tokens: ${totalTokens}`);
  
  // 2. Récupérer UNIQUEMENT les providers qui offrent ce model_id
  const allModels = await getAllModels();
  //console.log(`📊 Total models in database: ${allModels.length}`);
  
  // Vérifier les correspondances exactes
  const exactMatches = allModels.filter(model => model.model_id === requestedModel);
  const providerMatches = allModels.filter(model => model.provider_model_id === requestedModel);
  
  //console.log(`🎯 Exact model_id matches: ${exactMatches.length}`);
  if (exactMatches.length > 0) {
    console.log(`   Found in providers: ${exactMatches.map(m => m.provider).join(', ')}`);
  }
  
  //console.log(`🎯 Provider model_id matches: ${providerMatches.length}`);
  if (providerMatches.length > 0) {
    console.log(`   Found in providers: ${providerMatches.map(m => m.provider).join(', ')}`);
  }
  
  let availableModels = allModels.filter(model => {
    // Correspondance exacte sur model_id OU provider_model_id
    const modelMatch = model.model_id === requestedModel || model.provider_model_id === requestedModel;
    
    if (!modelMatch) {
      return false;
    }
    
    //console.log(`\n🔍 Checking provider: ${model.provider} (${model.model_id})`);
    
    // Filtres de compatibilité
    if (tools && tools.length > 0 && !model.support_tool_calling) {
      //console.log(`   ❌ Rejected: No tool calling support`);
      return false;
    }

    if (hasImages && !model.support_vision) {
      //console.log(`   ❌ Rejected: No vision support`);
      return false;
    }

    // Context window strict
    if (model.context_window && totalTokens > model.context_window) {
      //console.log(`   ❌ Rejected: Context window too small (${model.context_window} < ${totalTokens})`);
      return false;
    }
    
    /**
    console.log(`   ✅ Accepted: All requirements met`);
    console.log(`      - Tool calling: ${model.support_tool_calling ? 'YES' : 'NO'}`);
    console.log(`      - Vision: ${model.support_vision ? 'YES' : 'NO'}`);
    console.log(`      - Context window: ${model.context_window || 'unlimited'}`);
    console.log(`      - Base URL: ${model.base_url}`);
    console.log(`      - API Key name: ${model.api_key_name}`);
     */
    return true;
  });
  
  // 2.5. Filtrer par providers spécifiés dans la requête (si applicable)
  const requestProviders = request.provider;
  if (requestProviders) {
    const providerList = Array.isArray(requestProviders) ? requestProviders : [requestProviders];
    
    // Filtrer uniquement les modèles des providers spécifiés
    const beforeFilterCount = availableModels.length;
    availableModels = availableModels.filter(model => 
      providerList.includes(model.provider)
    );
    
    if (availableModels.length === 0) {
      console.log(`\n❌ ERROR: None of the specified providers support the model "${requestedModel}"`);
      console.log(`   - Requested providers: ${providerList.join(', ')}`);
      
      // Afficher quels providers supportent effectivement ce modèle
      const allSupportingProviders = [...exactMatches, ...providerMatches]
        .filter(model => {
          const modelMatch = model.model_id === requestedModel || model.provider_model_id === requestedModel;
          if (!modelMatch) return false;
          
          // Vérifier la compatibilité
          if (tools && tools.length > 0 && !model.support_tool_calling) return false;
          if (hasImages && !model.support_vision) return false;
          if (model.context_window && totalTokens > model.context_window) return false;
          
          return true;
        })
        .map(m => m.provider);
      
      if (allSupportingProviders.length > 0) {
        console.log(`   - Available providers for this model: ${allSupportingProviders.join(', ')}`);
      }
      
      throw new Error(`None of the specified providers [${providerList.join(', ')}] support model "${requestedModel}". Available providers: [${allSupportingProviders.join(', ')}]`);
    }
  }

  if (availableModels.length === 0) {
    console.log(`\n❌ DEBUG: No providers found. Possible reasons:`);
    
    if (exactMatches.length === 0 && providerMatches.length === 0) {
      console.log(`   1. Model "${requestedModel}" does not exist in database`);
      console.log(`   2. Check if the model_id or provider_model_id is correct`);
      
      // Suggérer des modèles similaires
      const similarModels = allModels.filter(m => 
        m.model_id.toLowerCase().includes(requestedModel.toLowerCase()) ||
        m.provider_model_id.toLowerCase().includes(requestedModel.toLowerCase())
      ).slice(0, 5);
      
      if (similarModels.length > 0) {
        console.log(`   3. Similar models found:`);
        similarModels.forEach(m => {
          console.log(`      - ${m.model_id} (provider: ${m.provider})`);
        });
      }
    } else {
      console.log(`   1. Model exists but failed compatibility checks:`);
      
      const allMatchingModels = [...exactMatches, ...providerMatches];
      allMatchingModels.forEach(model => {
        const reasons = [];
        if (tools && tools.length > 0 && !model.support_tool_calling) {
          reasons.push('no tool calling');
        }
        if (hasImages && !model.support_vision) {
          reasons.push('no vision');
        }
        if (model.context_window && totalTokens > model.context_window) {
          reasons.push(`context too small (${model.context_window})`);
        }
        
        if (reasons.length > 0) {
          console.log(`      - ${model.provider}: ${reasons.join(', ')}`);
        }
      });
    }
    
    throw new Error(`No provider available for model_id: ${requestedModel}. This model may not exist or may be incompatible with your request requirements (tool calling, vision, context window).`);
  }
  
  /**
  console.log(`📊 Found ${availableModels.length} providers for model_id: ${requestedModel}`);
  availableModels.forEach(model => {
    console.log(`   - ${model.provider} (${model.base_url})`);
  });
   */
  
  // 3. Récupérer les métriques de performance en batch (requête optimisée)
  const providers = availableModels.map(m => m.provider);
  const allMetrics = await getProviderMetricsBatch(requestedModel, providers, metricsWindowSize);

  // 4. Vérifier si AU MOINS UN des providers disponibles supporte le prompt caching
  const hasCacheSupportedModels = availableModels.some(model => model.support_input_cache);

  let cachingMap = new Map<string, boolean>();

  if (hasCacheSupportedModels) {
    console.log(`🔍 Found ${availableModels.filter(m => m.support_input_cache).length} models with cache support, checking history...`);
    
    // Récupérer l'historique de caching seulement si certains modèles supportent le cache
    cachingMap = await getUserCachingHistoryBatch(userId, requestedModel, providers);
    
    // Vérifier si l'utilisateur a un historique de cache
    const hasAnyHistoricalCache = Array.from(cachingMap.values()).some(Boolean);
    
    if (!hasAnyHistoricalCache) {
      
      // Pour les modèles qui supportent le cache mais n'ont pas d'historique,
      // les marquer comme ayant le potentiel de cache
      availableModels.forEach(model => {
        const key = `${model.provider}:${model.model_id}`;
        
        if (model.support_input_cache) {
          cachingMap.set(key, true);
          console.log(`🚀 ${model.provider} supports input caching for ${model.model_id} (intrinsic support)`);
        }
      });
    } else {
      console.log(`✅ Found existing caching history for user ${userId}`);
      
      // Compléter avec le support intrinsèque pour les modèles sans historique mais avec support
      availableModels.forEach(model => {
        const key = `${model.provider}:${model.model_id}`;
        
        if (model.support_input_cache && !cachingMap.get(key)) {
          cachingMap.set(key, true);
        }
      });
    }
  } else {
    // Aucun modèle ne supporte le cache → pas besoin de vérifier l'historique
    console.log(`📊 No models support input caching for ${requestedModel}, skipping cache history check`);
    
    // Initialiser avec false pour tous
    providers.forEach(provider => {
      cachingMap.set(`${provider}:${requestedModel}`, false);
    });
  }

  // 5. Calculer les min/max pour normalisation (entre providers du même modèle)
  const prices = availableModels.map(m => m.price_per_input_token + m.price_per_output_token);
  const throughputs = Array.from(allMetrics.values())
    .map(m => m.throughput_median)
    .filter(Boolean) as number[];
  const latencies = Array.from(allMetrics.values())
    .map(m => m.latency_median)
    .filter(Boolean) as number[];

  const globalMinMax = {
    minPrice: Math.min(...prices),
    maxPrice: Math.max(...prices),
    minThroughput: throughputs.length > 0 ? Math.min(...throughputs) : 0,
    maxThroughput: throughputs.length > 0 ? Math.max(...throughputs) : 1,
    minLatency: latencies.length > 0 ? Math.min(...latencies) : 0,
    maxLatency: latencies.length > 0 ? Math.max(...latencies) : 1000
  };

  // 6. Calculer les scores vectoriels 3D pour chaque provider
  const scoringPromises = availableModels.map(model =>
    calculateModelVectorScore(model, ratio_sp, allMetrics, cachingMap, globalMinMax)
  );
  const scoredModels = await Promise.all(scoringPromises);

  // 7. Trier par score (priorité absolue au caching, puis score vectoriel)
  scoredModels.sort((a: ModelVectorScore, b: ModelVectorScore) => {
    if (a.cachingBoost && !b.cachingBoost) return -1;
    if (!a.cachingBoost && b.cachingBoost) return 1;
    return a.score - b.score;
  });

  console.log(`🏆 Provider ranking for ${requestedModel}:`);
  scoredModels.forEach((scored, index) => {
    const metrics = allMetrics.get(`${scored.model.provider}:${scored.model.model_id}`);
    console.log(`   ${index + 1}. ${scored.model.provider} (score: ${scored.score.toFixed(3)}${scored.cachingBoost ? ' + CACHE' : ''}) - T:${metrics?.throughput_median?.toFixed(1) || 'N/A'} L:${metrics?.latency_median?.toFixed(0) || 'N/A'}ms`);
  });

  // 8. Convertir en ProviderCombination
  return scoredModels.map((scored: ModelVectorScore) => ({
    model: scored.model,
    provider: scored.model.provider,
    modelId: scored.model.model_id,
    providerModelId: scored.model.provider_model_id,
    baseUrl: scored.model.base_url,
    ApiKeyName: scored.model.api_key_name,
    adapter: scored.model.adapter,
    supportsToolCalling: scored.model.support_tool_calling,
    supportsVision: scored.model.support_vision,
    contextWindow: scored.model.context_window || 0,
    pricing: {
      inputToken: scored.model.price_per_input_token,
      outputToken: scored.model.price_per_output_token
    },
    extraParams: scored.model.extra_param || {}
  }));
}

/**
 * Estime le coût d'une requête
 * @param request - Requête standardisée
 * @param model - Modèle sélectionné ou combination
 * @param cachedTokens - Nombre de tokens déjà en cache (optionnel)
 * @returns Coût estimé en USD
 */
export function estimateRequestCost(
  request: StandardRequest, 
  model: Model | ProviderCombination,
  cachedTokens?: number
): number {
  const messages = request.messages || [];
  let estimatedInputTokens = 0;
  
  // Estimer les tokens d'entrée
  messages.forEach(message => {
    if (typeof message.content === 'string') {
      estimatedInputTokens += Math.ceil(message.content.length / 4);
    } else if (Array.isArray(message.content)) {
      message.content.forEach(item => {
        if (item.type === 'text' && item.text) {
          estimatedInputTokens += Math.ceil(item.text.length / 4);
        } else if (item.type === 'image_url') {
          estimatedInputTokens += 1000;
        }
      });
    }
  });
  
  const estimatedOutputTokens = request.max_tokens || 1000;
  
  // Calculer le coût selon le type de modèle
  let inputPricing: number;
  let outputPricing: number;
  
  if ('pricing' in model) {
    inputPricing = model.pricing.inputToken;
    outputPricing = model.pricing.outputToken;
  } else {
    inputPricing = model.price_per_input_token;
    outputPricing = model.price_per_output_token;
  }
  
  // Calculer les tokens facturés en tenant compte du cache
  let billableInputTokens = estimatedInputTokens;
  
  if (cachedTokens && cachedTokens > 0) {
    // Les tokens cachés sont généralement facturés à 10% du prix normal (Anthropic)
    const cachedTokensCost = (cachedTokens * inputPricing * 0.1) / 1000;
    const nonCachedTokens = Math.max(0, estimatedInputTokens - cachedTokens);
    const nonCachedTokensCost = (nonCachedTokens * inputPricing) / 1000;
    const outputCost = (estimatedOutputTokens * outputPricing) / 1000;
    
    return parseFloat((cachedTokensCost + nonCachedTokensCost + outputCost).toFixed(6));
  }
  
  // Calcul standard sans cache
  const inputCost = (billableInputTokens * inputPricing) / 1000;
  const outputCost = (estimatedOutputTokens * outputPricing) / 1000;
  
  return parseFloat((inputCost + outputCost).toFixed(6));
}

/**
 * Récupère les statistiques des modèles
 * @returns Statistiques des modèles
 */
export async function getModelStats(): Promise<{
  totalModels: number;
  providerCounts: Record<string, number>;
  featuresSupport: {
    toolCalling: number;
    vision: number;
    streaming: number;
  };
  avgPricing: {
    inputToken: number;
    outputToken: number;
  };
}> {
  const allModels = await getAllModels();
  
  const providerCounts: Record<string, number> = {};
  let totalToolCalling = 0;
  let totalVision = 0;
  let totalInputPricing = 0;
  let totalOutputPricing = 0;
  
  allModels.forEach(model => {
    providerCounts[model.provider] = (providerCounts[model.provider] || 0) + 1;
    
    if (model.support_tool_calling) totalToolCalling++;
    if (model.support_vision) totalVision++;
    
    totalInputPricing += model.price_per_input_token;
    totalOutputPricing += model.price_per_output_token;
  });
  
  return {
    totalModels: allModels.length,
    providerCounts,
    featuresSupport: {
      toolCalling: totalToolCalling,
      vision: totalVision,
      streaming: allModels.length
    },
    avgPricing: {
      inputToken: allModels.length > 0 ? totalInputPricing / allModels.length : 0,
      outputToken: allModels.length > 0 ? totalOutputPricing / allModels.length : 0
    }
  };
}

/**
 * Invalide le cache des modèles
 */
export function invalidateModelsCache(): void {
  cacheUtils.invalidateModels();
}

/**
 * Recherche des modèles par critères
 * @param query - Critères de recherche
 * @returns Modèles correspondants
 */
export async function searchModels(query: {
  name?: string;
  provider?: string;
  supportsToolCalling?: boolean;
  supportsVision?: boolean;
  maxPricePerInputToken?: number;
  maxPricePerOutputToken?: number;
  minContextWindow?: number;
}): Promise<Model[]> {
  const allModels = await getAllModels();
  
  return allModels.filter(model => {
    if (query.name && !model.model_id.toLowerCase().includes(query.name.toLowerCase())) {
      return false;
    }
    
    if (query.provider && model.provider !== query.provider) {
      return false;
    }
    
    if (query.supportsToolCalling !== undefined && model.support_tool_calling !== query.supportsToolCalling) {
      return false;
    }
    
    if (query.supportsVision !== undefined && model.support_vision !== query.supportsVision) {
      return false;
    }
    
    if (query.maxPricePerInputToken !== undefined && model.price_per_input_token > query.maxPricePerInputToken) {
      return false;
    }
    
    if (query.maxPricePerOutputToken !== undefined && model.price_per_output_token > query.maxPricePerOutputToken) {
      return false;
    }
    
    if (query.minContextWindow !== undefined && (model.context_window || 0) < query.minContextWindow) {
      return false;
    }
    
    return true;
  });
}

/**
 * Helper function to get the quantisation priority for sorting
 * @param quantisation - Quantisation string
 * @returns Priority number (higher = better)
 */
function getQuantisationPriority(quantisation: string | null): number {
  if (!quantisation) return 0;
  
  const q = quantisation.toLowerCase();
  if (q.includes('fp32')) return 5;
  if (q.includes('fp16')) return 4;
  if (q.includes('fp8')) return 3;
  if (q.includes('int8')) return 2;
  if (q.includes('int4')) return 1;
  return 0;
}

/**
 * Récupère tous les modèles avec la structure étendue et fusion par model_id
 * @returns Liste des modèles avec informations fusionnées
 */
export async function getExtendedModels(): Promise<ExtendedModelInfo[]> {
  const allModels = await getAllModels();
  
  // Grouper les modèles par model_id
  const modelGroups = new Map<string, Model[]>();
  
  allModels.forEach(model => {
    const key = model.model_id;
    if (!modelGroups.has(key)) {
      modelGroups.set(key, []);
    }
    modelGroups.get(key)!.push(model);
  });
  
  // Transformer chaque groupe en ExtendedModelInfo
  const extendedModels: ExtendedModelInfo[] = [];
  
  modelGroups.forEach((models, modelId) => {
    // Extraire l'organisation (partie avant "/")
    const organisation = modelId.includes('/') ? modelId.split('/')[0] : 'unknown';
    
    // Calculer les moyennes de prix et diviser par 1000
    const avgInputPrice = models.reduce((sum, m) => sum + m.price_per_input_token, 0) / models.length / 1000;
    const avgOutputPrice = models.reduce((sum, m) => sum + m.price_per_output_token, 0) / models.length / 1000;
    
    // Trouver la quantisation maximale
    const maxQuantisation = models.reduce((best, current) => {
      const currentPriority = getQuantisationPriority(current.quantisation);
      const bestPriority = getQuantisationPriority(best);
      return currentPriority > bestPriority ? current.quantisation : best;
    }, null as string | null);
    
    // Trouver le contexte maximum
    const maxContext = Math.max(...models.map(m => m.context_window || 0));
    
    // OR logique pour assistant_ready
    const assistantReady = models.some(m => m.support_tool_calling);
    
    // Prendre le premier display_name non-null trouvé, sinon utiliser model_id
    const displayName = models.find(m => m.display_name)?.display_name || modelId;
    
    // Prendre le premier provider comme provider_name
    const providerName = models[0].provider;
    
    // Liste des providers disponibles
    const providersAvailable = models.map(m => m.provider);
    
    extendedModels.push({
      id: modelId,
      model_id: modelId,
      organisation: organisation,
      price_per_input_token: avgInputPrice ? parseFloat(avgInputPrice.toFixed(8)) : null,
      price_per_output_token: avgOutputPrice ? parseFloat(avgOutputPrice.toFixed(8)) : null,
      price_per_input_token_cached: avgInputPrice ? parseFloat((avgInputPrice * 0.1).toFixed(8)) : null,
      quantisation: maxQuantisation,
      context: maxContext > 0 ? Math.round(maxContext) : null,
      assistant_ready: assistantReady,
      support_input_cache: models.some(m => m.support_input_cache),
      support_vision: models.some(m => m.support_vision),
      display_name: displayName,
      providers_available: providersAvailable
    });
  });
  
  // Trier par model_id pour un ordre cohérent
  extendedModels.sort((a, b) => a.model_id.localeCompare(b.model_id));

  console.log('all models:', extendedModels);
  
  return extendedModels;
}
