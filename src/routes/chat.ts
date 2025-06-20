import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { authMiddleware } from '../middleware/auth.js';
import { requestHandler } from '../services/request-handler.js';
import { triggerWebhookAsync } from '../services/webhook-trigger.js';
import { z } from 'zod';
import type { Context } from 'hono';
import type { 
  HonoVariables, 
  StandardRequest,
  CompletionRequest,
  ChatCompletion,
  ChatCompletionChunk,
  ModelsList,
  ExtendedModelsList,
  CostEstimate,
  ApiError
} from '../types/index.js';

// Créer l'instance Hono avec les variables typées
const chat = new Hono<{ Variables: HonoVariables }>();

// Types littéraux pour les codes de statut HTTP compatibles avec Hono
type HttpStatus400 = 400;
type HttpStatus401 = 401;
type HttpStatus402 = 402;
type HttpStatus500 = 500;

// Schéma de validation pour les requêtes de chat completion
const chatCompletionSchema = z.object({
  model: z.string().optional(),
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.union([
      z.string(),
      z.array(z.object({
        type: z.string(),
        text: z.string().optional(),
        image_url: z.object({
          url: z.string(),
          detail: z.enum(['low', 'high', 'auto']).optional()
        }).optional()
      }))
    ]).optional(),
    tool_calls: z.array(z.object({
      id: z.string(),
      type: z.literal('function'),
      function: z.object({
        name: z.string(),
        arguments: z.string()
      })
    })).optional(),
    tool_call_id: z.string().optional()
  })),
  stream: z.boolean().optional().default(false),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  tools: z.array(z.object({
    type: z.literal('function'),
    function: z.object({
      name: z.string(),
      description: z.string().optional(),
      parameters: z.object({}).passthrough()
    })
  })).optional(),
  tool_choice: z.union([
    z.literal('auto'),
    z.literal('none'),
    z.object({
      type: z.literal('function'),
      function: z.object({
        name: z.string()
      })
    })
  ]).optional(),
  provider: z.union([z.string(), z.array(z.string())]).optional(),
  user: z.string().optional()
});

// Schéma de validation pour les requêtes de completion legacy
const completionSchema = z.object({
  model: z.string().optional(),
  prompt: z.union([z.string(), z.array(z.string())]),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  stream: z.boolean().optional().default(false),
  logprobs: z.number().int().min(0).max(5).optional(),
  echo: z.boolean().optional().default(false),
  best_of: z.number().int().min(1).optional(),
  logit_bias: z.object({}).passthrough().optional(),
  provider: z.union([z.string(), z.array(z.string())]).optional(),
  user: z.string().optional(),
  suffix: z.string().optional()
});

// Type pour les requêtes validées
type ValidatedChatRequest = z.infer<typeof chatCompletionSchema>;
type ValidatedCompletionRequest = z.infer<typeof completionSchema>;

// Fonctions utilitaires pour la vérification de type
function isAsyncGenerator(obj: any): obj is AsyncGenerator<ChatCompletionChunk> {
  return typeof obj === 'object' && obj !== null && Symbol.asyncIterator in obj;
}

function isChatCompletion(obj: any): obj is ChatCompletion {
  return typeof obj === 'object' && obj !== null && !(Symbol.asyncIterator in obj);
}

// Middleware d'authentification pour toutes les routes
chat.use('*', authMiddleware);

/**
 * Gère les erreurs de validation Zod
 */
function handleValidationError(error: z.ZodError): ApiError {
  return {
    error: {
      message: 'Invalid request format',
      type: 'invalid_request_error',
      details: error.errors.map(err => ({
        field: err.path.join('.'),
        message: err.message,
        code: err.code
      }))
    }
  };
}

/**
 * Gère les erreurs métier de l'application
 */
function handleBusinessError(error: unknown): { response: ApiError; status: 400 | 401 | 402 | 500 } {
  if (error && typeof error === 'object' && 'status' in error) {
    const businessError = error as { status: number; message: string; code?: string; provider?: string };
    
    // Mapper les status codes vers des littéraux
    let status: 400 | 401 | 402 | 500;
    if (businessError.status === 400) status = 400;
    else if (businessError.status === 401) status = 401;
    else if (businessError.status === 402) status = 402;
    else if (businessError.status >= 500) status = 500;
    else status = 400; // Default fallback
    
    return {
      response: {
        error: {
          message: businessError.message,
          type: businessError.code || 'api_error',
          provider: businessError.provider
        }
      },
      status
    };
  }

  return {
    response: {
      error: {
        message: error instanceof Error ? error.message : 'Internal server error',
        type: 'internal_error'
      }
    },
    status: 500
  };
}

/**
 * Extrait le ratio performance/prix de l'en-tête
 */
function getPricePerformanceRatio(c: Context): number {
  const headerValue = c.req.header('X-Price-Performance-Ratio');
  if (headerValue) {
    const ratio = parseInt(headerValue, 10);
    if (!isNaN(ratio) && ratio >= 0 && ratio <= 100) {
      return ratio;
    }
  }
  return 50; // Valeur par défaut
}

/**
 * Extrait la liste des providers depuis l'en-tête, la query ou le body
 */
function getProviders(c: Context, body: any): string | string[] | undefined {
  // 1. Header (priorité la plus haute)
  const headerValue = c.req.header('X-Provider');
  if (headerValue) {
    try {
      // Essayer de parser comme JSON (pour les listes)
      const parsed = JSON.parse(headerValue);
      if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
        return parsed;
      }
    } catch (e) {
      // Si ce n'est pas un JSON valide, le traiter comme une chaîne simple
      return headerValue;
    }
    return headerValue;
  }

  // 2. Query parameter
  const queryValue = c.req.query('provider');
  if (queryValue) {
    return queryValue;
  }

  // 3. Body (déjà géré par Zod, mais on le retourne pour la cohérence)
  return body.provider;
}

/**
 * POST /chat/completions
 * Endpoint principal pour les requêtes de chat completion
 */
chat.post('/completions', async (c: Context<{ Variables: HonoVariables }>) => {
  try {
    // 1. Validation de la requête
    const body = await c.req.json();
    const validatedRequest: ValidatedChatRequest = chatCompletionSchema.parse(body);
    
    // 2. Récupérer les données d'authentification (typées automatiquement)
    const authData = c.get('auth');
    const balance = c.get('balance');
    
    // 3. Récupérer les paramètres avancés
    const ratioSp = getPricePerformanceRatio(c);
    const providers = getProviders(c, validatedRequest);

    // 4. Convertir vers le format StandardRequest
    const standardRequest: StandardRequest = {
      model: validatedRequest.model,
      messages: validatedRequest.messages,
      stream: !!validatedRequest.stream,
      max_tokens: validatedRequest.max_tokens,
      temperature: validatedRequest.temperature,
      top_p: validatedRequest.top_p,
      frequency_penalty: validatedRequest.frequency_penalty,
      presence_penalty: validatedRequest.presence_penalty,
      stop: validatedRequest.stop,
      tools: validatedRequest.tools,
      tool_choice: validatedRequest.tool_choice,
      provider: providers,
      user: validatedRequest.user
    };
    
    // 5. Traiter la requête
    const result = await requestHandler.handleChatCompletion(standardRequest, authData, { ratio_sp: ratioSp });
    
    // 6. Retourner la réponse selon le mode
    if (validatedRequest.stream) {
      // Définir les headers pour le streaming SSE
      c.header('Content-Type', 'text/event-stream');
      c.header('Cache-Control', 'no-cache');
      c.header('Connection', 'keep-alive');
      c.header('X-Accel-Buffering', 'no'); // Nginx
      
      return stream(c, async (stream) => {
        try {
          // Initialiser le stream SSE
          stream.writeln('');
          
          // Type guard pour vérifier que c'est un générateur
          if (isAsyncGenerator(result)) {
            const generator = result;
            
            for await (const chunk of generator) {
              const sseData = `data: ${JSON.stringify(chunk)}\n\n`;
              stream.write(sseData);
            }
          } else {
            throw new Error('Expected streaming response but got static response');
          }
          
          // Marquer la fin du stream
          stream.write('data: [DONE]\n\n');
        } catch (error) {
          console.error('Streaming error:', error);
          const errorChunk: ChatCompletionChunk = {
            id: 'error',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: validatedRequest.model || 'unknown',
            choices: [{
              index: 0,
              delta: {},
              finish_reason: null
            }],
            usage: undefined
          };
          stream.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
          stream.write('data: [DONE]\n\n');
        } finally {
          // Ne déclencher le webhook que si le streaming s'est bien passé (pas d'erreur)
          // Le webhook sera déclenché depuis request-handler lors du log de succès
        }
      });
    } else {
      // Type guard pour vérifier que c'est une ChatCompletion
      if (isChatCompletion(result)) {
        return c.json(result);
      } else {
        throw new Error('Expected static response but got streaming response');
      }
    }
    
  } catch (error) {
    // Erreurs de validation
    if (error instanceof z.ZodError) {
      const validationError = handleValidationError(error);
      return c.json(validationError, 400);
    }
    
    // Erreurs métier
    const { response, status } = handleBusinessError(error);
    return c.json(response, status);
  }
});

/**
 * POST /chat/completion
 * Endpoint legacy pour les requêtes de completion (format OpenAI legacy)
 */
chat.post('/completion', async (c: Context<{ Variables: HonoVariables }>) => {
  try {
    // 1. Validation de la requête
    const body = await c.req.json();
    const validatedRequest: ValidatedCompletionRequest = completionSchema.parse(body);
    
    // 2. Récupérer les données d'authentification
    const authData = c.get('auth');
    const balance = c.get('balance');
    
    // 3. Convertir la requête de completion en format chat completion
    const prompts = Array.isArray(validatedRequest.prompt) 
      ? validatedRequest.prompt 
      : [validatedRequest.prompt];
    
    // Traiter chaque prompt séparément si multiple
    const results: any[] = [];
    
    for (const prompt of prompts) {
      // Convertir le prompt en format chat completion
      const chatRequest: StandardRequest = {
        model: validatedRequest.model,
        messages: [
          { role: 'user', content: prompt }
        ],
        max_tokens: validatedRequest.max_tokens,
        temperature: validatedRequest.temperature,
        top_p: validatedRequest.top_p,
        frequency_penalty: validatedRequest.frequency_penalty,
        presence_penalty: validatedRequest.presence_penalty,
        stop: validatedRequest.stop,
        stream: !!validatedRequest.stream,
        provider: validatedRequest.provider,
        user: validatedRequest.user
      };
      
      // 4. Traiter la requête avec le handler existant
      const result = await requestHandler.handleChatCompletion(chatRequest, authData);
      
      // 5. Convertir la réponse au format completion legacy
      if (validatedRequest.stream) {
        // Pour le streaming, on doit retourner immédiatement
        if (prompts.length > 1) {
          throw new Error('Streaming is not supported with multiple prompts');
        }
        
        c.header('Content-Type', 'text/event-stream');
        c.header('Cache-Control', 'no-cache');
        c.header('Connection', 'keep-alive');
        c.header('X-Accel-Buffering', 'no');
        
        return stream(c, async (stream) => {
          try {
            stream.writeln('');
            
            if (isAsyncGenerator(result)) {
              const generator = result;
              
              for await (const chunk of generator) {
                // Convertir chunk de chat completion en format completion
                const completionChunk = {
                  id: chunk.id,
                  object: 'text_completion',
                  created: chunk.created,
                  model: chunk.model,
                  choices: chunk.choices?.map((choice, index) => ({
                    text: choice.delta?.content || '',
                    index: index,
                    logprobs: null,
                    finish_reason: choice.finish_reason
                  })) || []
                };
                
                const sseData = `data: ${JSON.stringify(completionChunk)}\n\n`;
                stream.write(sseData);
              }
            }
            
            stream.write('data: [DONE]\n\n');
          } catch (error) {
            console.error('Completion streaming error:', error);
            const errorChunk = {
              id: 'error',
              object: 'text_completion',
              created: Math.floor(Date.now() / 1000),
              model: validatedRequest.model || 'unknown',
              choices: [{
                text: '',
                index: 0,
                logprobs: null,
                finish_reason: null
              }]
            };
            stream.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
            stream.write('data: [DONE]\n\n');
          } finally {
            // Ne déclencher le webhook que si le streaming s'est bien passé (pas d'erreur)
            // Le webhook sera déclenché depuis request-handler lors du log de succès
          }
        });
      } else {
        // Convertir réponse de chat completion en format completion
        if (isChatCompletion(result)) {
          const chatCompletion = result;
          const completionResult = {
            id: chatCompletion.id,
            object: 'text_completion',
            created: chatCompletion.created,
            model: chatCompletion.model,
            choices: chatCompletion.choices?.map((choice, index) => ({
              text: choice.message?.content || '',
              index: index,
              logprobs: null,
              finish_reason: choice.finish_reason
            })) || [],
            usage: chatCompletion.usage
          };
          
          results.push(completionResult);
        }
      }
    }
    
    // Pour les requêtes non-streaming avec multiple prompts
    if (!validatedRequest.stream) {
      // Si un seul prompt, retourner directement l'objet
      if (results.length === 1) {
        return c.json(results[0]);
      }
      
      // Si plusieurs prompts, retourner un tableau
      return c.json({
        id: `cmpl-${Date.now()}`,
        object: 'text_completion',
        created: Math.floor(Date.now() / 1000),
        model: validatedRequest.model || 'unknown',
        choices: results.flatMap((result, batchIndex) => 
          result.choices.map((choice: any) => ({
            ...choice,
            index: batchIndex * results.length + choice.index
          }))
        ),
        usage: results.reduce((acc, result) => ({
          prompt_tokens: (acc.prompt_tokens || 0) + (result.usage?.prompt_tokens || 0),
          completion_tokens: (acc.completion_tokens || 0) + (result.usage?.completion_tokens || 0),
          total_tokens: (acc.total_tokens || 0) + (result.usage?.total_tokens || 0)
        }), {})
      });
    }
    
  } catch (error) {
    console.error('Completion error:', error);
    
    // Erreurs de validation
    if (error instanceof z.ZodError) {
      const validationError = handleValidationError(error);
      return c.json(validationError, 400);
    }
    
    // Erreurs métier
    const { response, status } = handleBusinessError(error);
    return c.json(response, status);
  }
});

/**
 * GET /chat/models ou /models
 * Liste les modèles disponibles avec informations étendues
 */
chat.get('/models', async (c: Context<{ Variables: HonoVariables }>) => {
  try {
    const { getExtendedModels } = await import('../services/models.js');
    const extendedModels = await getExtendedModels();
    
    const response: ExtendedModelsList = {
      object: 'list',
      data: extendedModels
    };
    
    return c.json(response);
    
  } catch (error) {
    console.error('Extended models list error:', error);
    const errorResponse: ApiError = {
      error: {
        message: 'Failed to fetch models',
        type: 'internal_error'
      }
    };
    return c.json(errorResponse, 500);
  }
});

/**
 * POST /chat/estimate
 * Estime le coût d'une requête sans l'exécuter
 */
chat.post('/estimate', async (c: Context<{ Variables: HonoVariables }>) => {
  try {
    const body = await c.req.json();
    const validatedRequest: ValidatedChatRequest = chatCompletionSchema.parse(body);
    
    const authData = c.get('auth');
    
    // Récupérer les providers
    const providers = getProviders(c, validatedRequest);

    // Convertir vers StandardRequest
    const standardRequest: StandardRequest = {
      model: validatedRequest.model,
      messages: validatedRequest.messages,
      stream: !!validatedRequest.stream,
      max_tokens: validatedRequest.max_tokens,
      temperature: validatedRequest.temperature,
      top_p: validatedRequest.top_p,
      frequency_penalty: validatedRequest.frequency_penalty,
      presence_penalty: validatedRequest.presence_penalty,
      stop: validatedRequest.stop,
      tools: validatedRequest.tools,
      tool_choice: validatedRequest.tool_choice,
      provider: providers,
      user: validatedRequest.user
    };
    
    // Obtenir le ratio depuis l'en-tête
    const ratioSp = getPricePerformanceRatio(c);

    // Obtenir les combinaisons de providers
    const { filterProviders } = await import('../services/models.js');
    const combinations = await filterProviders(standardRequest, authData.user.id, authData.userPreferences, {
      ratio_sp: ratioSp
      // providers est déjà dans standardRequest, donc pas besoin de le passer ici
    });


    
    if (combinations.length === 0) {
      const errorResponse: ApiError = {
        error: {
          message: 'No compatible providers found',
          type: 'invalid_request_error'
        }
      };
      return c.json(errorResponse, 400);
    }
    
    // Estimer le coût pour le premier provider (le plus prioritaire)
    const primaryCombination = combinations[0];
    const estimatedCost = requestHandler.estimateRequestCost(standardRequest, primaryCombination);
    
    const response: CostEstimate = {
      estimated_cost: estimatedCost,
      currency: 'USD',
      provider: primaryCombination.provider,
      model: primaryCombination.modelId,
      alternatives: combinations.slice(1).map(combo => ({
        provider: combo.provider,
        model: combo.modelId,
        estimated_cost: requestHandler.estimateRequestCost(standardRequest, combo)
      }))
    };
    
    return c.json(response);
    
  } catch (error) {
    console.error('Cost estimation error:', error);
    
    if (error instanceof z.ZodError) {
      const validationError = handleValidationError(error);
      return c.json(validationError, 400);
    }
    
    const { response, status } = handleBusinessError(error);
    return c.json(response, status);
  }
});

export default chat;
