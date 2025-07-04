// This test script verifies the new 'provider' parameter functionality.
// It sends a POST request to the /v1/chat/completions endpoint with a 'provider' field.
// Run this script with: node examples/test-provider.js

const API_BASE_URL = "http://localhost:3000"; // Change to your API base URL
const API_KEY = "your_api_key"; // Replace with your actual API key


const requestBody = {
  model: "google/family", // Replace with the actual model you want to test
  messages: [
    { role: "user", content: "Dans @/src/types/auth.ts , est ce que tu peux faire en sorte que quand il n'y a pas d'authentifiacrtion ou qu'il y a une authent invalide, ca renvoie une erreur a l'utilisateur, sans que ca ma throw l'erreur dans le terminal ??" }
  ],
  stream: true,
  max_tokens: 500,
};

console.log("Envoi de la requête à la base de l'API :", API_BASE_URL, '/v1/chat/completions');
console.log("Corps de la requête :", JSON.stringify(requestBody, null, 2));

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
