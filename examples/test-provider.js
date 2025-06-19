// This test script verifies the new 'provider' parameter functionality.
// It sends a POST request to the /v1/chat/completions endpoint with a 'provider' field.
// Run this script with: node examples/test-provider.js

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const API_KEY = process.env.API_KEY_MAKEHUB || 'test-api-key-123';


const requestBody = {
  model: "anthropic/claude-3-5-haiku",
  messages: [
    { role: "user", content: "Hello, who are you?" }
  ],
  provider: ["bedrock"], // Specify a single provider; can also be an array of providers
  stream: true,
  max_tokens: 50,
  temperature: 0.7
};

fetch(`${API_BASE_URL}/v1/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': `${API_KEY}`
  },
  body: JSON.stringify(requestBody)
})
.then(async response => {
  if (!response.ok) {
    // Lire le contenu de l'erreur pour avoir les détails
    let errorDetails = '';
    try {
      const errorBody = await response.json();
      errorDetails = JSON.stringify(errorBody, null, 2);
    } catch (e) {
      errorDetails = await response.text();
    }
    console.error(`\n🔴 Erreur HTTP ${response.status}:`);
    console.error(errorDetails);
    return;
  }

  // Gérer le streaming de la réponse
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  async function readStream() {
    try {
      const { done, value } = await reader.read();
      
      if (done) {
        console.log("\nStream finished");
        return;
      }
      
      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            console.log("\nReceived [DONE] signal");
            return;
          }
          try {
            const parsed = JSON.parse(data);
            if (parsed.choices && parsed.choices[0].delta.content) {
              process.stdout.write(parsed.choices[0].delta.content);
            }
          } catch (e) {
            // Ignore parsing errors for incomplete chunks
          }
        }
      }
      
      return readStream();
    } catch (error) {
      console.error('\n🔴 Erreur lors de la lecture du stream:', error);
    }
  }

  return readStream();
})
.catch(error => {
  console.error('🔴 Erreur de requête:', error);
});
