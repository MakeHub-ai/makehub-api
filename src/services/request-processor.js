import dotenv from 'dotenv';
import { supabase } from '../config/database.js';
import { get_encoding } from 'tiktoken';

// Charger les variables d'environnement
dotenv.config();

/**
 * Calculate token costs based on provider and model from models table
 * @param {number} inputTokens 
 * @param {number} outputTokens 
 * @param {string} provider 
 * @param {string} model_id
 * @returns {Promise<number>} calculated amount
 */
async function calculateTokenCost(inputTokens, outputTokens, provider, model_id) {
  try {
    // Get pricing from models table
    const { data, error } = await supabase
      .from('models')
      .select('price_per_input_token, price_per_output_token')
      .eq('provider', provider)
      .eq('model_id', model_id)
      .single();
    
    if (error) throw error;
    
    return (inputTokens * data.price_per_input_token / 1000) + (outputTokens * data.price_per_output_token / 1000);
  } catch (error) {
    console.error(`Error calculating token cost for ${provider} model ${model_id}:`, error);
    throw new Error('Failed to calculate token cost - pricing data unavailable');
  }
}

/**
 * Calculate tokens using tiktoken with the appropriate tokenizer
 * @param {string} text - Content to tokenize
 * @param {string} tokenizer_name - Name of the tokenizer to use
 * @returns {number} - Token count
 */
function calculateTokens(text, tokenizer_name) {
  try {
    const enc = get_encoding(tokenizer_name);
    const tokens = enc.encode(text);
    enc.free();
    return tokens.length;
  } catch (error) {
    console.error(`Error calculating tokens with tokenizer ${tokenizer_name}:`, error);
    throw new Error(`Failed to calculate tokens with tokenizer ${tokenizer_name}`);
  }
}

/**
 * Process requests with status 'ready_to_compute'
 * @param {number} batchSize - Nombre de requêtes à traiter par lot (défaut: 10)
 * @param {number} timeLimit - Limite de temps en ms pour le traitement (défaut: 30000 ms = 30 sec)
 * @returns {Promise<{processed: number, errors: number}>} - Statistiques de traitement
 */
async function processReadyRequests(batchSize = 10, timeLimit = 30000) {
  const startTime = Date.now();
  let processedCount = 0;
  let errorCount = 0;
  try {
    console.log('Processing requests with status "ready_to_compute"');
    // Get requests that need processing
    const { data: requests, error } = await supabase
      .from('requests')
      .select(`
        *,
        requests_content(request_json, response_json),
        models!inner(tokenizer_name)
      `)
      .eq('status', 'ready_to_compute')
      .limit(batchSize); // Traiter par lots pour limiter l'utilisation de mémoire
    
    console.log(`Found ${requests?.length || 0} requests to process`);
    
    if (error) throw error;
    
    for (const request of requests) {
      // Vérifier si on a dépassé la limite de temps
      if (Date.now() - startTime > timeLimit) {
        console.log(`Limite de temps atteinte (${timeLimit}ms). Arrêt du traitement après ${processedCount} requêtes.`);
        break;
      }
      
      try {
        // Calculate tokens using tiktoken
        if (request.input_tokens === null || request.output_tokens === null) {
          const tokenizer_name = request.models.tokenizer_name;
          const requestJson = request.requests_content.request_json;
          const responseJson = request.requests_content.response_json;
          
          // Calculate input tokens
          const requestText = JSON.stringify(requestJson);
          const inputTokens = calculateTokens(requestText, tokenizer_name);
          
          // Calculate output tokens (if response exists)
          let outputTokens = 0;
          if (responseJson) {
            const responseText = JSON.stringify(responseJson);
            outputTokens = calculateTokens(responseText, tokenizer_name);
          }
          
          // Update request with calculated tokens
          const { error: updateError } = await supabase
            .from('requests')
            .update({
              input_tokens: inputTokens,
              output_tokens: outputTokens
            })
            .eq('request_id', request.request_id);
            
          if (updateError) throw updateError;
          
          request.input_tokens = inputTokens;
          request.output_tokens = outputTokens;
        }
        
        // Create transaction
        const amount = await calculateTokenCost(
          request.input_tokens, 
          request.output_tokens, 
          request.provider,
          request.model
        );
        
        const { error: transactionError } = await supabase
          .from('transactions')
          .insert({
            user_id: request.user_id,
            amount: amount,
            type: 'debit',
            request_id: request.request_id,
          });
        
        if (transactionError) throw transactionError;
        
        // Mettre à jour le status de la requête à 'completed'
        const { error: updateError } = await supabase
          .from('requests')
          .update({ status: 'completed' })
          .eq('request_id', request.request_id);
        
        if (updateError) {
          console.error(`Erreur lors de la mise à jour du statut pour la requête ${request.request_id}:`, updateError);
        } else {
          console.log(`Processed request ${request.request_id} for user ${request.user_id} - Status updated to 'completed'`);
          processedCount++; // Incrémenter le compteur de requêtes traitées
        }
      } catch (requestError) {
        console.error(`Error processing request ${request.request_id}:`, requestError);
        
        // Update request status to 'error'
        await supabase
          .from('requests')
          .update({ 
            status: 'error',
            error_message: requestError.message
          })
          .eq('request_id', request.request_id);
          
        errorCount++; // Incrémenter le compteur d'erreurs
      }
    }
    
    return { processed: processedCount, errors: errorCount };
  } catch (error) {
    console.error('Error processing requests:', error);
    return { processed: processedCount, errors: errorCount + 1 };
  }
}

/**
 * Run the processor periodically
 */
function startProcessor(intervalMinutes = 5) {
  console.log(`Starting request processor (checks every ${intervalMinutes} minutes)`);
  processReadyRequests();
  
  // Set up periodic execution
  setInterval(async () => {
    console.log(`Running scheduled request processing at ${new Date().toISOString()}`);
    await processReadyRequests();
  }, intervalMinutes * 60 * 1000);
}

// If running directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const interval = process.env.PROCESSOR_INTERVAL_MINUTES || 5;
  startProcessor(interval);
}

export { processReadyRequests, startProcessor };
