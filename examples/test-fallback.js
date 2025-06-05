// Ce script teste le comportement de fallback pour les erreurs non-400
// Il utilise une clé API invalide pour générer une erreur 401
// Run this script with: node examples/test-fallback.js

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const API_KEY = 'invalid-api-key-should-trigger-401';

const requestBody = {
  model: "openai/gpt-4o",
  messages: [
    { role: "user", content: "Hello, who are you?" }
  ],
  provider: ["azure-eastus", "openai"], // Plusieurs providers pour tester le fallback
  stream: false,
  max_tokens: 100,
  temperature: 0.7
};

console.log('🧪 Test de fallback avec une clé API invalide (devrait générer 401)...');
console.log('📋 Providers demandés:', requestBody.provider);

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
    
    if (response.status === 401) {
      console.log('\n✅ Erreur 401 détectée - Le fallback devrait être tenté');
    } else if (response.status === 400) {
      console.log('\n❌ Erreur 400 détectée - Pas de fallback (normal)');
    } else {
      console.log(`\n📊 Erreur ${response.status} détectée - Le fallback devrait être tenté`);
    }
    
    throw new Error(`Server error: ${response.status}`);
  }
  
  const result = await response.json();
  console.log('\n✅ Succès! Réponse reçue:');
  console.log(JSON.stringify(result, null, 2));
})
.catch(error => {
  console.error("\n💥 Erreur finale:", error.message);
});
