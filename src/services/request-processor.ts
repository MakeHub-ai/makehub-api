import dotenv from 'dotenv';
import { supabase } from '../config/database.js';
import { get_encoding, type Tiktoken } from 'tiktoken';
import axios from 'axios';
import type { 
  RequestWithContentAndModel,
  RequestStatus,
  TransactionType
} from '../types/index.js';

// Charger les variables d'environnement
dotenv.config();

/**
 * Constantes de pricing pour les différentes méthodes de cache
 * Basées sur les spécifications OpenRouter
 */
const PRICING_MULTIPLIERS = {
  // Anthropic Claude
  ANTHROPIC_CACHE_READ: 0.1,    // 10% du prix normal
  ANTHROPIC_CACHE_WRITE: 1.25,  // 125% du prix normal

  // BEDROCK
  BEDROCK_CACHE_WRITE: 1.25,      // Cache création : 125% (100% + 25% premium)
  BEDROCK_CACHE_READ: 0.1,        // Cache lecture : 10%

  
  // OpenAI
  OPENAI_CACHE_READ_50: 0.5,    // 50% du prix normal
  OPENAI_CACHE_READ_75: 0.75,   // 75% du prix normal
  OPENAI_CACHE_WRITE: 0,        // Gratuit
  
  // DeepSeek
  DEEPSEEK_CACHE_READ: 0.1,     // 10% du prix normal
  DEEPSEEK_CACHE_WRITE: 1.0,    // 100% du prix normal (même prix)
  
  // Google Gemini
  GOOGLE_CACHE_READ: 0.1,      // 10% du prix normal
  GOOGLE_CACHE_WRITE: 0.1,     // 100% du prix normal (même prix)
  GOOGLE_CACHE_WRITE_STORAGE: 5/60, // 5 minutes de stockage sur 60 minutes
} as const;

/**
 * Types de méthodes de pricing supportées
 */
type PricingMethod = 
  | 'standard'
  | 'anthropic_cache'
  | 'openai_cache_50'
  | 'openai_cache_75'
  | 'deepseek_cache'
  | 'google_cache'
  | 'google_implicit'
  | 'google_explicit'
  | 'bedrock_cache';

/**
 * Interface pour les statistiques de traitement
 */
interface ProcessingStats {
  processed: number;
  errors: number;
  startTime: number;
  endTime?: number;
  duration?: number;
}

/**
 * Interface pour les résultats de calcul de tokens
 */
interface TokenCalculationResult {
  inputTokens: number;
  outputTokens: number;
  success: boolean;
  error?: string;
}

/**
 * Interface pour les résultats de calcul de coût
 */
interface CostCalculationResult {
  amount: number;
  success: boolean;
  error?: string;
}

/**
 * Cache pour les encoders tiktoken
 */
const encoderCache = new Map<string, Tiktoken>();

/**
 * Envoie une notification d'erreur à ntfy (asynchrone)
 * @param error - L'erreur qui s'est produite
 * @param context - Contexte de l'erreur (request_id, provider, etc.)
 */
async function notifyError(error: unknown, context: { 
  requestId?: string; 
  provider?: string; 
  model?: string; 
  pricingMethod?: string;
  operation?: string;
}): Promise<void> {
  const ntfyUrl = process.env.NTFY_ERROR_URL;
  if (!ntfyUrl) {
    return;
  }

  try {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const operation = context.operation || 'Request Processing';
    
    const body = `Operation: ${operation}\nRequest ID: ${context.requestId || 'unknown'}\nProvider: ${context.provider || 'unknown'}\nModel: ${context.model || 'unknown'}\nPricing Method: ${context.pricingMethod || 'unknown'}\nError: ${errorMessage}`;

    await axios.post(`${ntfyUrl}/errors`, body, {
      timeout: 5000,
      headers: {
        'Title': `Request Processor Error - ${context.provider || 'Unknown'}`,
        'Priority': 'high',
        'Tags': `error,request-processor,${context.provider || 'unknown'}`
      }
    });

  } catch (notifyError) {
    console.error('Failed to send error notification:', notifyError instanceof Error ? notifyError.message : 'Unknown error');
  }
}

/**
 * Calculate token costs with cache support based on pricing method
 * @param inputTokens - Nombre de tokens d'entrée
 * @param outputTokens - Nombre de tokens de sortie
 * @param cachedTokens - Nombre de tokens en cache (0 si pas de cache)
 * @param pricingMethod - Méthode de pricing à utiliser
 * @param inputPrice - Prix par token d'entrée (par 1000)
 * @param outputPrice - Prix par token de sortie (par 1000)
 * @returns Montant calculé
 */
function calculateTokenCostWithMethod(
  inputTokens: number,
  outputTokens: number,
  cachedTokens: number,
  pricingMethod: PricingMethod,
  inputPrice: number,
  outputPrice: number
): number {
  if (inputTokens < 0 || outputTokens < 0 || cachedTokens < 0) {
    throw new Error('Token counts must be non-negative');
  }

  // Calculate output cost (always the same)
  const outputCost = (outputTokens * outputPrice) / 1000;

  // Calculate input cost based on pricing method
  let inputCost: number;

  switch (pricingMethod) {
    case 'standard':
      // Standard pricing: no cache consideration
      inputCost = (inputTokens * inputPrice) / 1000;
      break;

    case 'anthropic_cache':
      // Anthropic: cached tokens at 10%, non-cached at 100%
      const anthropicCachedCost = (cachedTokens * inputPrice * PRICING_MULTIPLIERS.ANTHROPIC_CACHE_READ) / 1000;
      const anthropicNonCachedCost = (inputTokens * inputPrice) / 1000;
      inputCost = anthropicCachedCost + anthropicNonCachedCost;
      break;

    case 'openai_cache_50':
      // OpenAI: cached tokens at 50%, non-cached at 100%
      const openai50CachedCost = (cachedTokens * inputPrice * PRICING_MULTIPLIERS.OPENAI_CACHE_READ_50) / 1000;
      const openai50NonCachedCost = (inputTokens  * inputPrice) / 1000;
      inputCost = openai50CachedCost + openai50NonCachedCost;
      break;

    case 'openai_cache_75':
      // OpenAI: cached tokens at 75%, non-cached at 100%
      const openai75CachedCost = (cachedTokens * inputPrice * PRICING_MULTIPLIERS.OPENAI_CACHE_READ_75) / 1000;
      const openai75NonCachedCost = (inputTokens  * inputPrice) / 1000;
      inputCost = openai75CachedCost + openai75NonCachedCost;
      break;

    case 'deepseek_cache':
      // DeepSeek: cached tokens at 10%, non-cached at 100%
      const deepseekCachedCost = (cachedTokens * inputPrice * PRICING_MULTIPLIERS.DEEPSEEK_CACHE_READ) / 1000;
      const deepseekNonCachedCost = (inputTokens  * inputPrice) / 1000;
      inputCost = deepseekCachedCost + deepseekNonCachedCost;
      break;

    case 'bedrock_cache':
      // ✅ NOUVEAU : AWS Bedrock pricing avec cache creation et cache read
      // Cache creation tokens : 125% du prix standard (100% + 25% premium)
      //const bedrockCacheCreationCost = (cacheCreationTokens * inputPrice * PRICING_MULTIPLIERS.BEDROCK_CACHE_WRITE) / 1000;
      
      // Cache read tokens : 10% du prix standard
      const bedrockCacheReadCost = (cachedTokens * inputPrice * PRICING_MULTIPLIERS.BEDROCK_CACHE_READ) / 1000;
      
      // Tokens non-cachés : 100% du prix standard
      const bedrockNonCachedCost = (inputTokens * inputPrice) / 1000;
      
      inputCost = bedrockCacheReadCost + bedrockNonCachedCost;
      
      // Debug log pour Bedrock
      /**
      console.log(`💰 Bedrock pricing breakdown:
        - Cache creation: ${cacheCreationTokens} tokens × ${inputPrice} × 1.25 = $${bedrockCacheCreationCost.toFixed(6)}
        - Cache read: ${cachedTokens} tokens × ${inputPrice} × 0.1 = $${bedrockCacheReadCost.toFixed(6)}
        - Non-cached: ${bedrockNonCachedTokens} tokens × ${inputPrice} = $${bedrockNonCachedCost.toFixed(6)}
        - Total input: $${inputCost.toFixed(6)}`);
         */
      break;

    case 'google_cache':
    case 'google_implicit':
    case 'google_explicit':
      // Google: cached tokens at 25%, non-cached at 100%
      const googleCachedCost = (cachedTokens * inputPrice * PRICING_MULTIPLIERS.GOOGLE_CACHE_READ) / 1000;
      const googleNonCachedCost = (inputTokens  * inputPrice) / 1000;
      inputCost = googleCachedCost + googleNonCachedCost;
      break;

    default:
      throw new Error(`Unknown pricing method: ${pricingMethod}`);
  }

  return inputCost + outputCost;
}

/**
 * Calculate token costs based on provider and model from models table (legacy function)
 * @param inputTokens - Nombre de tokens d'entrée
 * @param outputTokens - Nombre de tokens de sortie
 * @param provider - Nom du provider
 * @param model_id - ID du modèle
 * @returns Montant calculé
 */
async function calculateTokenCost(
  inputTokens: number, 
  outputTokens: number, 
  provider: string, 
  model_id: string
): Promise<number> {
  if (inputTokens < 0 || outputTokens < 0) {
    throw new Error('Token counts must be non-negative');
  }

  if (!provider || !model_id) {
    throw new Error('Provider and model_id are required');
  }

  try {
    // Get pricing from models table
    const { data, error } = await supabase
      .from('models')
      .select('price_per_input_token, price_per_output_token, pricing_method')
      .eq('provider', provider)
      .eq('model_id', model_id)
      .single();
    
    if (error) throw error;
    
    if (!data) {
      throw new Error(`No pricing data found for ${provider} model ${model_id}`);
    }

    // Use new method with cache support (0 cached tokens for legacy compatibility)
    return calculateTokenCostWithMethod(
      inputTokens,
      outputTokens,
      0, // No cached tokens for legacy calls
      (data.pricing_method || 'standard') as PricingMethod,
      data.price_per_input_token,
      data.price_per_output_token
    );
  } catch (error) {
    console.error(`Error calculating token cost for ${provider} model ${model_id}:`, error);
    throw new Error(`Failed to calculate token cost - pricing data unavailable: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Calculate tokens using tiktoken with the appropriate tokenizer
 * @param text - Content to tokenize
 * @param tokenizer_name - Name of the tokenizer to use
 * @returns Token count
 */
function calculateTokens(text: string, tokenizer_name: string): number {
  if (!text || typeof text !== 'string') {
    return 0;
  }

  if (!tokenizer_name || typeof tokenizer_name !== 'string') {
    throw new Error('Tokenizer name is required and must be a string');
  }

  try {
    // Vérifier le cache d'abord
    let enc = encoderCache.get(tokenizer_name);
    
    if (!enc) {
      enc = get_encoding(tokenizer_name as any);
      encoderCache.set(tokenizer_name, enc);
    }
    
    const tokens = enc.encode(text);
    return tokens.length;
  } catch (error) {
    console.error(`Error calculating tokens with tokenizer ${tokenizer_name}:`, error);
    throw new Error(`Failed to calculate tokens with tokenizer ${tokenizer_name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Libère tous les encoders du cache
 */
function freeAllEncoders(): void {
  for (const [name, encoder] of encoderCache.entries()) {
    try {
      encoder.free();
    } catch (error) {
      console.warn(`Failed to free encoder ${name}:`, error);
    }
  }
  encoderCache.clear();
}

/**
 * Calcule les tokens pour une requête donnée
 * @param request - Données de la requête
 * @param tokenizerName - Nom du tokenizer à utiliser
 * @returns Résultat du calcul des tokens
 */
function calculateRequestTokens(
  request: RequestWithContentAndModel, 
  tokenizerName: string
): TokenCalculationResult {
  try {
    const requestJson = request.requests_content.request_json;
    const responseJson = request.requests_content.response_json;
    
    // Calculate input tokens
    const requestText = JSON.stringify(requestJson);
    const inputTokens = calculateTokens(requestText, tokenizerName);
    
    // Calculate output tokens (if response exists)
    let outputTokens = 0;
    if (responseJson) {
      const responseText = JSON.stringify(responseJson);
      outputTokens = calculateTokens(responseText, tokenizerName);
    }
    
    return {
      inputTokens,
      outputTokens,
      success: true
    };
  } catch (error) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Calcule le coût pour une requête donnée avec support du cache et fallback
 * @param request - Données de la requête
 * @param inputTokens - Nombre de tokens d'entrée
 * @param outputTokens - Nombre de tokens de sortie
 * @returns Résultat du calcul du coût
 */
async function calculateRequestCost(
  request: RequestWithContentAndModel,
  inputTokens: number,
  outputTokens: number
): Promise<CostCalculationResult> {
  // Si cached_tokens est NULL, forcer la méthode standard
  const cachedTokens = request.cached_tokens;
  const pricingMethod = (cachedTokens === null) 
    ? 'standard' 
    : (request.models?.pricing_method || 'standard') as PricingMethod;

  // Utiliser 0 pour les calculs quand on force la méthode standard
  const effectiveCachedTokens = (cachedTokens === null) ? 0 : cachedTokens;
  
  try {
    // Vérifier qu'on a les informations de pricing du modèle
    if (!request.models || !request.models.pricing_method) {
      throw new Error('Missing model pricing information');
    }
    
    // Essayer d'utiliser la méthode de calcul avec cache
    const amount = calculateTokenCostWithMethod(
      inputTokens,
      outputTokens,
      effectiveCachedTokens,
      pricingMethod,
      request.models.price_per_input_token,
      request.models.price_per_output_token
    );
    
    // Log pour debug
    if (cachedTokens === null) {
      console.log(`🔄 Forcing standard pricing for ${request.request_id}`);
    } else if (cachedTokens > 0) {
      console.log(`💰 Cache pricing for ${request.request_id}: ${inputTokens} input, ${outputTokens} output, ${cachedTokens} cached, method: ${pricingMethod}, cost: $${amount.toFixed(6)}`);
    }
    
    return {
      amount,
      success: true
    };
  } catch (error) {
    // Log l'erreur et notifier via ntfy
    console.error(`Error in pricing method ${pricingMethod} for request ${request.request_id}:`, error);
    
    // Notification asynchrone vers ntfy
    notifyError(error, {
      requestId: request.request_id,
      provider: request.provider,
      model: request.model,
      pricingMethod: pricingMethod,
      operation: 'Cost Calculation'
    }).catch(console.error);
    
    try {
      // Fallback : utiliser la méthode standard (sans cache)
      console.log(`⚠️ Falling back to standard pricing for request ${request.request_id}`);
      
      const fallbackAmount = calculateTokenCostWithMethod(
        inputTokens,
        outputTokens,
        0, // Pas de cache en fallback
        'standard',
        request.models.price_per_input_token,
        request.models.price_per_output_token
      );
      
      console.log(`✅ Fallback pricing successful for ${request.request_id}: $${fallbackAmount.toFixed(6)} (standard method)`);
      
      return {
        amount: fallbackAmount,
        success: true
      };
    } catch (fallbackError) {
      // Si même le fallback échoue, on retourne une erreur
      console.error(`Fallback pricing failed for request ${request.request_id}:`, fallbackError);
      
      // Notification pour l'échec du fallback
      notifyError(fallbackError, {
        requestId: request.request_id,
        provider: request.provider,
        model: request.model,
        pricingMethod: 'standard',
        operation: 'Fallback Cost Calculation'
      }).catch(console.error);
      
      return {
        amount: 0,
        success: false,
        error: `Pricing failed with fallback: ${fallbackError instanceof Error ? fallbackError.message : 'Unknown error'}`
      };
    }
  }
}

/**
 * Process requests with status 'ready_to_compute'
 * @param batchSize - Nombre de requêtes à traiter par lot (défaut: 10)
 * @param timeLimit - Limite de temps en ms pour le traitement (défaut: 30000 ms = 30 sec)
 * @returns Statistiques de traitement
 */
async function processReadyRequests(
  batchSize: number = 10, 
  timeLimit: number = 30000
): Promise<ProcessingStats> {
  const stats: ProcessingStats = {
    processed: 0,
    errors: 0,
    startTime: Date.now()
  };

  try {
    
    // Validation des paramètres
    if (batchSize <= 0 || batchSize > 1000) {
      throw new Error('Batch size must be between 1 and 1000');
    }
    
    if (timeLimit <= 0 || timeLimit > 300000) { // Max 5 minutes
      throw new Error('Time limit must be between 1ms and 300000ms (5 minutes)');
    }
    
    // Get requests that need processing (exclusion des requêtes avec erreur pour double sécurité)
    const { data: requests, error } = await supabase
      .from('requests')
      .select(`
        request_id, user_id, transaction_id, api_key_name, provider, model, created_at, 
        input_tokens, output_tokens, status, streaming, error_message, cached_tokens,
        requests_content(request_json, response_json),
        models!inner(tokenizer_name, pricing_method, price_per_input_token, price_per_output_token)
      `)
      .eq('status', 'ready_to_compute')
      .is('error_message', null)
      .limit(batchSize);
    
    
    if (error) {
      throw new Error(`Failed to fetch requests: ${error.message}`);
    }
    
    if (!requests || requests.length === 0) {
      stats.endTime = Date.now();
      stats.duration = stats.endTime - stats.startTime;
      return stats;
    }
    
    const typedRequests = requests as unknown as RequestWithContentAndModel[];
    
    for (const request of typedRequests) {
      // Vérifier si on a dépassé la limite de temps
      if (Date.now() - stats.startTime > timeLimit) {
        break;
      }
      
      try {
        await processIndividualRequest(request, stats);
      } catch (requestError) {
        console.error(`Error processing request ${request.request_id}:`, requestError);
        
        // Update request status to 'error'
        await supabase
          .from('requests')
          .update({ 
            status: 'error' as RequestStatus,
            error_message: requestError instanceof Error ? requestError.message : 'Unknown error'
          })
          .eq('request_id', request.request_id);
          
        stats.errors++;
      }
    }
    
    stats.endTime = Date.now();
    stats.duration = stats.endTime - stats.startTime;
    
    
    return stats;
  } catch (error) {
    console.error('Error processing requests:', error);
    stats.endTime = Date.now();
    stats.duration = stats.endTime - stats.startTime;
    stats.errors++;
    return stats;
  }
}

/**
 * Traite une requête individuelle
 * @param request - Requête à traiter
 * @param stats - Statistiques à mettre à jour
 */
async function processIndividualRequest(
  request: RequestWithContentAndModel, 
  stats: ProcessingStats
): Promise<void> {
  // Vérifier la validité des données
  if (!request.requests_content) {
    throw new Error('Missing request content');
  }
  
  if (!request.models || !request.models.tokenizer_name) {
    throw new Error('Missing model or tokenizer information');
  }
  
  // Calculate tokens using tiktoken si nécessaire
  let finalInputTokens = request.input_tokens;
  let finalOutputTokens = request.output_tokens;
  
  if (finalInputTokens === null || finalOutputTokens === null) {
    const tokenResult = calculateRequestTokens(request, request.models.tokenizer_name);
    
    if (!tokenResult.success) {
      throw new Error(`Token calculation failed: ${tokenResult.error}`);
    }
    
    finalInputTokens = tokenResult.inputTokens;
    finalOutputTokens = tokenResult.outputTokens;
    
    // Update request with calculated tokens
    const updateData: any = {
      input_tokens: finalInputTokens,
      output_tokens: finalOutputTokens
    };
    
    // Préserver la valeur originale de cached_tokens (NULL ou nombre)
    if (request.cached_tokens !== undefined) {
      updateData.cached_tokens = request.cached_tokens;
    }
    
    const { error: updateError } = await supabase
      .from('requests')
      .update(updateData)
      .eq('request_id', request.request_id);
      
    if (updateError) {
      throw new Error(`Failed to update tokens: ${updateError.message}`);
    }
  }
  
  // Create transaction
  const costResult = await calculateRequestCost(request, finalInputTokens, finalOutputTokens);
  
  if (!costResult.success) {
    throw new Error(`Cost calculation failed: ${costResult.error}`);
  }
  
  const { data: transactionData, error: transactionError } = await supabase
    .from('transactions')
    .insert({
      user_id: request.user_id,
      amount: costResult.amount,
      type: 'debit' as TransactionType,
      request_id: request.request_id,
    })
    .select('id')
    .single();
  
  if (transactionError || !transactionData) {
    throw new Error(`Failed to create transaction: ${transactionError?.message || 'No transaction data returned'}`);
  }
  
  // Mettre à jour le status de la requête à 'completed' et associer la transaction
  const { error: updateError } = await supabase
    .from('requests')
    .update({ 
      status: 'completed' as RequestStatus,
      transaction_id: transactionData.id
    })
    .eq('request_id', request.request_id);
  
  if (updateError) {
    throw new Error(`Failed to update request status: ${updateError.message}`);
  }
  
  stats.processed++;
}

/**
 * Traite les requêtes en mode batch avec gestion d'erreurs avancée
 * @param options - Options de traitement
 * @returns Statistiques détaillées
 */
async function processRequestsBatch(options: {
  batchSize?: number;
  timeLimit?: number;
  retryFailedRequests?: boolean;
  maxRetries?: number;
} = {}): Promise<ProcessingStats & {
  retried: number;
  skipped: number;
  details: Array<{
    requestId: string;
    status: 'success' | 'error' | 'skipped';
    error?: string;
    processingTime: number;
  }>;
}> {
  const {
    batchSize = 10,
    timeLimit = 30000,
    retryFailedRequests = false,
    maxRetries = 3
  } = options;
  
  const stats = {
    processed: 0,
    errors: 0,
    retried: 0,
    skipped: 0,
    startTime: Date.now(),
    endTime: 0,
    duration: 0,
    details: [] as Array<{
      requestId: string;
      status: 'success' | 'error' | 'skipped';
      error?: string;
      processingTime: number;
    }>
  };
  
  try {
    // Récupérer les requêtes à traiter
    const statusesToProcess: RequestStatus[] = retryFailedRequests 
      ? ['ready_to_compute', 'error'] 
      : ['ready_to_compute'];
    
    const { data: requests, error } = await supabase
      .from('requests')
      .select(`
        *,
        requests_content(request_json, response_json),
        models!inner(tokenizer_name)
      `)
      .in('status', statusesToProcess)
      .limit(batchSize);
    
    if (error || !requests) {
      throw new Error(`Failed to fetch requests: ${error?.message || 'No data'}`);
    }
    
    for (const request of requests as RequestWithContentAndModel[]) {
      if (Date.now() - stats.startTime > timeLimit) {
        break;
      }
      
      const requestStartTime = Date.now();
      
      try {
        await processIndividualRequest(request, stats);
        
        stats.details.push({
          requestId: request.request_id,
          status: 'success',
          processingTime: Date.now() - requestStartTime
        });
        
        if (request.status === 'error') {
          stats.retried++;
        }
        
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        
        stats.details.push({
          requestId: request.request_id,
          status: 'error',
          error: errorMessage,
          processingTime: Date.now() - requestStartTime
        });
        
        stats.errors++;
      }
    }
    
  } catch (error) {
    console.error('Batch processing error:', error);
    stats.errors++;
  }
  
  stats.endTime = Date.now();
  stats.duration = stats.endTime - stats.startTime;
  
  return stats;
}

/**
 * Run the processor periodically
 * @param intervalMinutes - Intervalle en minutes entre les exécutions
 */
function startProcessor(intervalMinutes: number = 5): void {
  if (intervalMinutes <= 0 || intervalMinutes > 60) {
    throw new Error('Interval must be between 1 and 60 minutes');
  }
  
  
  // Exécution initiale
  processReadyRequests()
    .then(stats => {
      console.log(`Initial processing completed: ${stats.processed} processed, ${stats.errors} errors`);
    })
    .catch(error => {
      console.error('Initial processing failed:', error);
    });
  
  // Set up periodic execution
  const intervalId = setInterval(async () => {
    try {
      const stats = await processReadyRequests();
    } catch (error) {
      console.error('Scheduled processing failed:', error);
    }
  }, intervalMinutes * 60 * 1000);
  
  // Cleanup function
  const cleanup = () => {
    clearInterval(intervalId);
    freeAllEncoders();
  };
  
  // Handle process shutdown
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('SIGUSR2', cleanup); // For nodemon
}

/**
 * Récupère les statistiques de traitement
 * @returns Statistiques du processeur
 */
async function getProcessorStats(): Promise<{
  pendingRequests: number;
  errorRequests: number;
  completedToday: number;
  avgProcessingTime: number;
  cacheInfo: {
    encoders: number;
  };
}> {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Requêtes en attente
    const { count: pendingCount } = await supabase
      .from('requests')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'ready_to_compute');
    
    // Requêtes en erreur
    const { count: errorCount } = await supabase
      .from('requests')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'error');
    
    // Requêtes complétées aujourd'hui
    const { count: completedCount } = await supabase
      .from('requests')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'completed')
      .gte('created_at', today.toISOString());
    
    return {
      pendingRequests: pendingCount || 0,
      errorRequests: errorCount || 0,
      completedToday: completedCount || 0,
      avgProcessingTime: 0, // À implémenter avec des métriques détaillées
      cacheInfo: {
        encoders: encoderCache.size
      }
    };
  } catch (error) {
    console.error('Failed to get processor stats:', error);
    return {
      pendingRequests: 0,
      errorRequests: 0,
      completedToday: 0,
      avgProcessingTime: 0,
      cacheInfo: {
        encoders: encoderCache.size
      }
    };
  }
}

// If running directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const interval = parseInt(process.env.PROCESSOR_INTERVAL_MINUTES || '5');
  startProcessor(interval);
}

export { 
  processReadyRequests, 
  processRequestsBatch,
  startProcessor,
  getProcessorStats,
  freeAllEncoders,
  calculateTokens,
  calculateTokenCost,
  calculateTokenCostWithMethod,
  PRICING_MULTIPLIERS
};

// Export types for external use
export type { PricingMethod };
