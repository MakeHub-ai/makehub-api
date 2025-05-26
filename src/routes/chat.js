import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { authMiddleware } from '../middleware/auth.js';
import { requestHandler } from '../services/request-handler.js';
import { z } from 'zod';

const chat = new Hono();

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
          url: z.string()
        }).optional()
      }))
    ]).optional(),
    tool_calls: z.array(z.object({
      id: z.string(),
      type: z.string(),
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
  ]).optional()
});

// Middleware d'authentification pour toutes les routes
chat.use('*', authMiddleware);

/**
 * POST /chat/completions
 * Endpoint principal pour les requêtes de chat completion
 */
chat.post('/completions', async (c) => {
  try {
    // 1. Validation de la requête
    const body = await c.req.json();
    const validatedRequest = chatCompletionSchema.parse(body);
    
    // 2. Récupérer les données d'authentification
    const authData = c.get('auth');
    const balance = c.get('balance');
    
    // 3. Traiter la requête
    const result = await requestHandler.handleChatCompletion(validatedRequest, authData);
      // 4. Retourner la réponse selon le mode
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
          
          for await (const chunk of result) {
            const sseData = `data: ${JSON.stringify(chunk)}\n\n`;
            // Éviter await pour réduire le buffering
            stream.write(sseData);
          }
          
          // Marquer la fin du stream
          stream.write('data: [DONE]\n\n');
        } catch (error) {
          console.error('Streaming error:', error);
          const errorChunk = {
            id: 'error',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: validatedRequest.model || 'unknown',
            choices: [{
              index: 0,
              delta: {},
              finish_reason: 'error'
            }],
            error: {
              message: error.message,
              type: 'internal_error'
            }
          };
          stream.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
          stream.write('data: [DONE]\n\n');
        }
      });
    } else {
      return c.json(result);
    }
    
  } catch (error) {
    console.error('Chat completion error:', error);
    
    // Erreurs de validation
    if (error instanceof z.ZodError) {
      return c.json({
        error: {
          message: 'Invalid request format',
          type: 'invalid_request_error',
          details: error.errors
        }
      }, 400);
    }
    
    // Erreurs métier
    if (error.status) {
      return c.json({
        error: {
          message: error.message,
          type: error.code || 'api_error',
          provider: error.provider
        }
      }, error.status);
    }
    
    // Erreurs génériques
    return c.json({
      error: {
        message: error.message || 'Internal server error',
        type: 'internal_error'
      }
    }, 500);
  }
});

/**
 * GET /chat/models
 * Liste les modèles disponibles
 */
chat.get('/models', async (c) => {
  try {
    const { getAllModels } = await import('../services/models.js');
    const models = await getAllModels();
    
    // Transformer au format OpenAI
    const openaiModels = models.map(model => ({
      id: model.model_id,
      object: 'model',
      created: Math.floor(new Date(model.created_at).getTime() / 1000),
      owned_by: model.provider,
      permission: [],
      root: model.model_id,
      parent: null
    }));
    
    return c.json({
      object: 'list',
      data: openaiModels
    });
    
  } catch (error) {
    console.error('Models list error:', error);
    return c.json({
      error: {
        message: 'Failed to fetch models',
        type: 'internal_error'
      }
    }, 500);
  }
});

/**
 * GET /chat/health
 * Vérification de santé des providers
 */
chat.get('/health', async (c) => {
  try {
    const { getProvidersHealth } = await import('../providers/index.js');
    const health = getProvidersHealth();
    
    return c.json({
      status: 'ok',
      providers: health,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Health check error:', error);
    return c.json({
      status: 'error',
      message: error.message,
      timestamp: new Date().toISOString()
    }, 500);
  }
});

/**
 * POST /chat/estimate
 * Estime le coût d'une requête sans l'exécuter
 */
chat.post('/estimate', async (c) => {
  try {
    const body = await c.req.json();
    const validatedRequest = chatCompletionSchema.parse(body);
    
    const authData = c.get('auth');
    
    // Obtenir les combinaisons de providers
    const { filterProviders } = await import('../services/models.js');
    const combinations = await filterProviders(validatedRequest, authData.userPreferences);
    
    if (combinations.length === 0) {
      return c.json({
        error: {
          message: 'No compatible providers found',
          type: 'invalid_request_error'
        }
      }, 400);
    }
    
    // Estimer le coût pour le premier provider (le plus prioritaire)
    const primaryCombination = combinations[0];
    const estimatedCost = requestHandler.estimateRequestCost(validatedRequest, primaryCombination);
    
    return c.json({
      estimated_cost: estimatedCost,
      currency: 'USD',
      provider: primaryCombination.provider,
      model: primaryCombination.modelId,
      alternatives: combinations.slice(1).map(combo => ({
        provider: combo.provider,
        model: combo.modelId,
        estimated_cost: requestHandler.estimateRequestCost(validatedRequest, combo)
      }))
    });
    
  } catch (error) {
    console.error('Cost estimation error:', error);
    
    if (error instanceof z.ZodError) {
      return c.json({
        error: {
          message: 'Invalid request format',
          type: 'invalid_request_error',
          details: error.errors
        }
      }, 400);
    }
    
    return c.json({
      error: {
        message: error.message || 'Failed to estimate cost',
        type: 'internal_error'
      }
    }, 500);
  }
});

export default chat;
