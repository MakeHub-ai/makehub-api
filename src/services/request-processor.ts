import dotenv from 'dotenv';
import { supabase } from '../config/database.js';
import { get_encoding, type Tiktoken } from 'tiktoken';
import type { 
  RequestWithContentAndModel,
  RequestStatus,
  TransactionType
} from '../types/index.js';

// Charger les variables d'environnement
dotenv.config();

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
 * Calculate token costs based on provider and model from models table
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
      .select('price_per_input_token, price_per_output_token')
      .eq('provider', provider)
      .eq('model_id', model_id)
      .single();
    
    if (error) throw error;
    
    if (!data) {
      throw new Error(`No pricing data found for ${provider} model ${model_id}`);
    }

    const inputCost = (inputTokens * data.price_per_input_token) / 1000;
    const outputCost = (outputTokens * data.price_per_output_token) / 1000;
    
    return inputCost + outputCost;
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
 * Calcule le coût pour une requête donnée
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
  try {
    const amount = await calculateTokenCost(
      inputTokens, 
      outputTokens, 
      request.provider,
      request.model
    );
    
    return {
      amount,
      success: true
    };
  } catch (error) {
    return {
      amount: 0,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
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
        *,
        requests_content(request_json, response_json),
        models!inner(tokenizer_name)
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
    
    const typedRequests = requests as RequestWithContentAndModel[];
    
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
    const { error: updateError } = await supabase
      .from('requests')
      .update({
        input_tokens: finalInputTokens,
        output_tokens: finalOutputTokens
      })
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
  calculateTokenCost
};
