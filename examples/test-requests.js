/**
 * Exemples de requêtes pour tester l'API Gateway LLM
 * 
 * Usage:
 * 1. Configurer les variables d'environnement
 * 2. Démarrer le serveur: npm run dev
 * 3. Exécuter: node examples/test-requests.js
 */

import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const API_KEY = process.env.TEST_API_KEY || 'test-api-key-123';

// Configuration axios
const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'X-API-Key': API_KEY,
    'Content-Type': 'application/json'
  },
  timeout: 30000
});

/**
 * Test de santé du service
 */
async function testHealth() {
  console.log('🔍 Testing health endpoint...');
  try {
    const response = await api.get('/health');
    console.log('✅ Health check passed:', response.data.status);
    console.log('📊 Services status:', response.data.services);
  } catch (error) {
    console.error('❌ Health check failed:', error.response?.data || error.message);
  }
}

/**
 * Test de la liste des modèles
 */
async function testModels() {
  console.log('\n📋 Testing models endpoint...');
  try {
    const response = await api.get('/v1/chat/models');
    console.log(`✅ Found ${response.data.data.length} models`);
  } catch (error) {
    console.error('❌ Models test failed:', error.response?.data || error.message);
  }
}

/**
 * Test de requête simple
 */
async function testSimpleChat() {
  console.log('\n💬 Testing simple chat completion...');
  try {
    const response = await api.post('/v1/chat/completions', {
      model: 'anthropic/claude-3-7-sonnet',
      messages: [
        { role: 'user', content: 'Say hello in French!' }
      ],
      max_tokens: 50
    });
    
    console.log('✅ Simple chat completed');
    console.log('🤖 Response:', response.data.choices[0].message.content);
    console.log('📊 Usage:', response.data.usage);
  } catch (error) {
    console.error('❌ Simple chat failed:', error.response?.data || error.message);
  }
}

/**
 * Test de streaming
 */
async function testStreamingChat() {
  console.log('\n🌊 Testing streaming chat completion...');
  try {
    const response = await api.post('/v1/chat/completions', {
      model: 'anthropic/claude-3-7-sonnet',
      messages: [
        { role: 'user', content: 'Count from 1 to 100 slowly' }
      ],
      stream: true,
      max_tokens: 200
    }, {
      responseType: 'stream'
    });

    console.log('✅ Streaming started...');
    let content = '';
    
    let buffer = '';
    let errorHandled = false;

    response.data.on('data', (chunk) => {
      if (errorHandled) return;
      buffer += chunk.toString();
      
      // Attempt to parse the buffer as a whole in case it's a JSON error object
      try {
        const jsonData = JSON.parse(buffer);
        if (jsonData.error) {
          console.error('❌ Streaming test failed with JSON error:', jsonData);
          errorHandled = true;
          response.data.destroy(); // Stop further processing
          return;
        }
        // If it parsed but wasn't an error, it's unexpected, but we'll let line processing try
      } catch (e) {
        // Not a complete JSON object, or it's SSE data, continue to line processing
      }

      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line for next chunk

      for (const line of lines) {
        if (errorHandled) break;
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            if (!errorHandled) {
              console.log('\n✅ Streaming completed');
              console.log('📝 Full content:', content);
            }
            errorHandled = true; // Mark as handled to prevent further processing
            return;
          }
          
          try {
            const parsed = JSON.parse(data);
            if (parsed.choices?.[0]?.delta?.content) {
              process.stdout.write(parsed.choices[0].delta.content);
              content += parsed.choices[0].delta.content;
            }
          } catch (e) {
            // Ignore parsing errors for non-JSON lines (e.g. comments, empty lines)
          }
        }
      }
    });

    response.data.on('error', (err) => {
      if (!errorHandled) {
        console.error('❌ Streaming connection error:', err.message);
        errorHandled = true;
      }
    });
    
    response.data.on('end', () => {
      if (!errorHandled && !content && !buffer.includes("[DONE]")) { // If stream ended abruptly without DONE
        console.error('❌ Streaming ended prematurely or with an unparsed error.');
        if (buffer.length > 0) {
            console.error('Remaining buffer:', buffer);
        }
      }
    });

  } catch (error) {
    // This catch block handles errors during the initial POST request (before streaming starts)
    console.error('❌ Streaming test setup failed:', error.response?.data || error.message);
  }
}

/**
 * Test avec tool calling
 */
async function testToolCalling() {
  console.log('\n🔧 Testing tool calling...');
  try {
    const response = await api.post('/v1/chat/completions', {
      model: 'anthropic/claude-3-7-sonnet',
      messages: [
        { role: 'user', content: 'What\'s 15 * 23? Use the calculator tool.' }
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
      tool_choice: 'auto'
    });
    
    console.log('✅ Tool calling completed');
    const message = response.data.choices[0].message;
    
    if (message.tool_calls) {
      console.log('🔧 Tool calls:', message.tool_calls);
    } else {
      console.log('🤖 Response:', message.content);
    }
  } catch (error) {
    console.error('❌ Tool calling failed:', error.response?.data || error.message);
  }
}

/**
 * Test avec tool calling en streaming
 */
async function testStreamingToolCalling() {
  console.log('\n🌊🔧 Testing streaming tool calling...');
  try {
    const response = await api.post('/v1/chat/completions', {
      model: 'anthropic/claude-3-7-sonnet',
      messages: [
        { role: 'user', content: 'What\'s 25 * 17? Then calculate 100 / 4. Use the calculator tool for both.' }
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
      stream: true
    }, {
      responseType: 'stream'
    });

    console.log('✅ Streaming tool calling started...');
    let content = '';
    let toolCalls = [];
    
    let buffer = '';
    let errorHandled = false;

    response.data.on('data', (chunk) => {
      if (errorHandled) return;
      buffer += chunk.toString();
      
      // Vérifier si c'est une erreur JSON
      try {
        const jsonData = JSON.parse(buffer);
        if (jsonData.error) {
          console.error('❌ Streaming tool calling failed with JSON error:', jsonData);
          errorHandled = true;
          response.data.destroy();
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
            if (!errorHandled) {
              console.log('\n✅ Streaming tool calling completed');
              if (content) {
                console.log('📝 Content:', content);
              }
              if (toolCalls.length > 0) {
                console.log('🔧 Tool calls detected:');
                toolCalls.forEach((call, index) => {
                  console.log(`   ${index + 1}. ${call.function.name}(${call.function.arguments})`);
                });
              }
            }
            errorHandled = true;
            return;
          }
          
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            
            // Gérer le contenu texte
            if (delta?.content) {
              process.stdout.write(delta.content);
              content += delta.content;
            }
            
            // Gérer les tool calls
            if (delta?.tool_calls) {
              delta.tool_calls.forEach((toolCall) => {
                const index = toolCall.index;
                
                // Initialiser l'outil si c'est le premier chunk
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
                  // Accumuler les arguments
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
                
                // Afficher en temps réel
                console.log(`\n🔧 Tool call ${index + 1}: ${toolCalls[index].function.name || 'loading...'}${toolCalls[index].function.arguments ? `(${toolCalls[index].function.arguments})` : ''}`);
              });
            }
          } catch (e) {
            // Ignorer les erreurs de parsing pour les lignes non-JSON
          }
        }
      }
    });

    response.data.on('error', (err) => {
      if (!errorHandled) {
        console.error('❌ Streaming tool calling connection error:', err.message);
        errorHandled = true;
      }
    });
    
    response.data.on('end', () => {
      if (!errorHandled && !content && toolCalls.length === 0 && !buffer.includes("[DONE]")) {
        console.error('❌ Streaming tool calling ended prematurely.');
        if (buffer.length > 0) {
          console.error('Remaining buffer:', buffer);
        }
      }
    });

  } catch (error) {
    console.error('❌ Streaming tool calling setup failed:', error.response?.data || error.message);
  }
}

/**
 * Test d'estimation de coût
 */
async function testCostEstimation() {
  console.log('\n💰 Testing cost estimation...');
  try {
    const response = await api.post('/v1/chat/estimate', {
      model: 'anthropic/claude-3-7-sonnet',
      messages: [
        { role: 'user', content: 'Write a short story about a robot learning to paint.' }
      ],
      max_tokens: 500
    });
    
    console.log('✅ Cost estimation completed');
    console.log('💵 Estimated cost:', `$${response.data.estimated_cost.toFixed(6)}`);
    console.log('🤖 Primary provider:', response.data.provider);
    console.log('📋 Model:', response.data.model);
    
    if (response.data.alternatives.length > 0) {
      console.log('🔄 Alternatives:');
      response.data.alternatives.forEach(alt => {
        console.log(`   - ${alt.provider}/${alt.model}: $${alt.estimated_cost.toFixed(6)}`);
      });
    }
  } catch (error) {
    console.error('❌ Cost estimation failed:', error.response?.data || error.message);
  }
}

/**
 * Test avec image (vision)
 */
async function testVision() {
  console.log('\n👁️ Testing vision capabilities...');
  
  // Image simple en base64 (1x1 pixel rouge)
  const redPixelBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
  
  try {
    const response = await api.post('/v1/chat/completions', {
      model: 'anthropic/claude-3-7-sonnet',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What color is this pixel?' },
            { 
              type: 'image_url', 
              image_url: { 
                url: `data:image/png;base64,${redPixelBase64}` 
              } 
            }
          ]
        }
      ],
      max_tokens: 50
    });
    
    console.log('✅ Vision test completed');
    console.log('👁️ Response:', response.data.choices[0].message.content);
  } catch (error) {
    console.error('❌ Vision test failed:', error.response?.data || error.message);
  }
}

/**
 * Test de fallback (avec un modèle inexistant)
 */
async function testFallback() {
  console.log('\n🔄 Testing fallback mechanism (requesting a non-existent model)...');
  try {
    const response = await api.post('/v1/chat/completions', {
      model: 'non-existent-model-should-fallback',
      messages: [
        { role: 'user', content: 'This should fallback to a working model' }
      ],
      max_tokens: 50
    });
    
    console.log('✅ Fallback test completed');
    console.log('🤖 Response:', response.data.choices[0].message.content);
    console.log('📋 Used model:', response.data.model);
  } catch (error) {
    console.error('❌ Fallback test failed:', error.response?.data || error.message);
  }
}

/**
 * Exécuter tous les tests
 */
async function runAllTests() {
  console.log('🚀 Starting LLM API Gateway tests...\n');
  
  //await testHealth();
  //await testModels();
  //await testSimpleChat();
  //await testStreamingChat();
  
  //await testToolCalling();
  await testStreamingToolCalling();
  //await testCostEstimation();
  //await testVision();
  //await testFallback();
  
  console.log('\n✅ All tests completed!');
}

// Exécuter les tests si ce fichier est appelé directement
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllTests().catch(console.error);
}

export {
  testHealth,
  testModels,
  testSimpleChat,
  testStreamingChat,
  testToolCalling,
  testStreamingToolCalling,
  testCostEstimation,
  testVision,
  testFallback,
  runAllTests
};
