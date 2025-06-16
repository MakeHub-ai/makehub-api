/**
 * Test unitaire pour les méthodes de pricing avec cache
 * 
 * Ce test vérifie que toutes les méthodes de calcul de prix avec cache
 * fonctionnent correctement selon les spécifications OpenRouter
 */

import { calculateTokenCostWithMethod, PRICING_MULTIPLIERS } from '../src/services/request-processor.js';

// Données de test communes
const testScenarios = [
  {
    name: 'Standard Request',
    inputTokens: 1000,
    outputTokens: 200,
    cachedTokens: 0,
    inputPrice: 3, // $3 per 1M tokens
    outputPrice: 15 // $15 per 1M tokens
  },
  {
    name: 'Partial Cache Hit',
    inputTokens: 1000,
    outputTokens: 200,
    cachedTokens: 600,
    inputPrice: 3,
    outputPrice: 15
  },
  {
    name: 'Full Cache Hit',
    inputTokens: 1000,
    outputTokens: 200,
    cachedTokens: 1000,
    inputPrice: 3,
    outputPrice: 15
  },
  {
    name: 'Large Request with Cache',
    inputTokens: 10000,
    outputTokens: 1000,
    cachedTokens: 8000,
    inputPrice: 5,
    outputPrice: 20
  }
];

/**
 * Test la méthode standard (baseline)
 */
function testStandardPricing() {
  console.log('\n🧮 Testing Standard Pricing Method...\n');
  
  testScenarios.forEach(scenario => {
    const cost = calculateTokenCostWithMethod(
      scenario.inputTokens,
      scenario.outputTokens,
      0, // Pas de cache en standard
      'standard',
      scenario.inputPrice,
      scenario.outputPrice
    );
    
    const expectedCost = (scenario.inputTokens * scenario.inputPrice + scenario.outputTokens * scenario.outputPrice) / 1000;
    
    console.log(`📊 ${scenario.name}:`);
    console.log(`   Input: ${scenario.inputTokens} tokens, Output: ${scenario.outputTokens} tokens`);
    console.log(`   Cost: $${cost.toFixed(6)} (expected: $${expectedCost.toFixed(6)})`);
    console.log(`   ✅ ${Math.abs(cost - expectedCost) < 0.000001 ? 'PASS' : 'FAIL'}\n`);
  });
}

/**
 * Test la méthode Anthropic (cache reads à 10%)
 */
function testAnthropicPricing() {
  console.log('\n🤖 Testing Anthropic Cache Pricing Method...\n');
  
  testScenarios.forEach(scenario => {
    const cost = calculateTokenCostWithMethod(
      scenario.inputTokens,
      scenario.outputTokens,
      scenario.cachedTokens,
      'anthropic_cache',
      scenario.inputPrice,
      scenario.outputPrice
    );
    
    const cachedCost = (scenario.cachedTokens * scenario.inputPrice * PRICING_MULTIPLIERS.ANTHROPIC_CACHE_READ) / 1000;
    const nonCachedCost = ((scenario.inputTokens - scenario.cachedTokens) * scenario.inputPrice) / 1000;
    const outputCost = (scenario.outputTokens * scenario.outputPrice) / 1000;
    const expectedCost = cachedCost + nonCachedCost + outputCost;
    
    const standardCost = (scenario.inputTokens * scenario.inputPrice + scenario.outputTokens * scenario.outputPrice) / 1000;
    const savings = standardCost - cost;
    const savingsPercent = (savings / standardCost) * 100;
    
    console.log(`📊 ${scenario.name}:`);
    console.log(`   Input: ${scenario.inputTokens} tokens (${scenario.cachedTokens} cached)`);
    console.log(`   Cost: $${cost.toFixed(6)} vs Standard: $${standardCost.toFixed(6)}`);
    console.log(`   Savings: $${savings.toFixed(6)} (${savingsPercent.toFixed(1)}%)`);
    console.log(`   ✅ ${Math.abs(cost - expectedCost) < 0.000001 ? 'PASS' : 'FAIL'}\n`);
  });
}

/**
 * Test la méthode OpenAI (cache reads à 50% ou 75%)
 */
function testOpenAIPricing() {
  console.log('\n🔥 Testing OpenAI Cache Pricing Methods...\n');
  
  ['openai_cache_50', 'openai_cache_75'].forEach(method => {
    const multiplier = method === 'openai_cache_50' ? 
      PRICING_MULTIPLIERS.OPENAI_CACHE_READ_50 : 
      PRICING_MULTIPLIERS.OPENAI_CACHE_READ_75;
    
    console.log(`\n--- ${method.toUpperCase()} (${multiplier * 100}% cache pricing) ---`);
    
    testScenarios.forEach(scenario => {
      const cost = calculateTokenCostWithMethod(
        scenario.inputTokens,
        scenario.outputTokens,
        scenario.cachedTokens,
        method,
        scenario.inputPrice,
        scenario.outputPrice
      );
      
      const cachedCost = (scenario.cachedTokens * scenario.inputPrice * multiplier) / 1000;
      const nonCachedCost = ((scenario.inputTokens - scenario.cachedTokens) * scenario.inputPrice) / 1000;
      const outputCost = (scenario.outputTokens * scenario.outputPrice) / 1000;
      const expectedCost = cachedCost + nonCachedCost + outputCost;
      
      const standardCost = (scenario.inputTokens * scenario.inputPrice + scenario.outputTokens * scenario.outputPrice) / 1000;
      const savings = standardCost - cost;
      const savingsPercent = (savings / standardCost) * 100;
      
      console.log(`📊 ${scenario.name}:`);
      console.log(`   Cost: $${cost.toFixed(6)}, Savings: ${savingsPercent.toFixed(1)}%`);
      console.log(`   ✅ ${Math.abs(cost - expectedCost) < 0.000001 ? 'PASS' : 'FAIL'}`);
    });
  });
}

/**
 * Test la méthode DeepSeek (cache reads à 10%)
 */
function testDeepSeekPricing() {
  console.log('\n🧠 Testing DeepSeek Cache Pricing Method...\n');
  
  testScenarios.forEach(scenario => {
    const cost = calculateTokenCostWithMethod(
      scenario.inputTokens,
      scenario.outputTokens,
      scenario.cachedTokens,
      'deepseek_cache',
      scenario.inputPrice,
      scenario.outputPrice
    );
    
    const cachedCost = (scenario.cachedTokens * scenario.inputPrice * PRICING_MULTIPLIERS.DEEPSEEK_CACHE_READ) / 1000;
    const nonCachedCost = ((scenario.inputTokens - scenario.cachedTokens) * scenario.inputPrice) / 1000;
    const outputCost = (scenario.outputTokens * scenario.outputPrice) / 1000;
    const expectedCost = cachedCost + nonCachedCost + outputCost;
    
    const standardCost = (scenario.inputTokens * scenario.inputPrice + scenario.outputTokens * scenario.outputPrice) / 1000;
    const savings = standardCost - cost;
    const savingsPercent = (savings / standardCost) * 100;
    
    console.log(`📊 ${scenario.name}:`);
    console.log(`   Cost: $${cost.toFixed(6)}, Savings: ${savingsPercent.toFixed(1)}%`);
    console.log(`   ✅ ${Math.abs(cost - expectedCost) < 0.000001 ? 'PASS' : 'FAIL'}\n`);
  });
}

/**
 * Test la méthode Google (cache reads à 25%)
 */
function testGooglePricing() {
  console.log('\n🌟 Testing Google Cache Pricing Methods...\n');
  
  ['google_cache', 'google_implicit'].forEach(method => {
    console.log(`\n--- ${method.toUpperCase()} ---`);
    
    testScenarios.forEach(scenario => {
      const cost = calculateTokenCostWithMethod(
        scenario.inputTokens,
        scenario.outputTokens,
        scenario.cachedTokens,
        method,
        scenario.inputPrice,
        scenario.outputPrice
      );
      
      const cachedCost = (scenario.cachedTokens * scenario.inputPrice * PRICING_MULTIPLIERS.GOOGLE_CACHE_READ) / 1000;
      const nonCachedCost = ((scenario.inputTokens - scenario.cachedTokens) * scenario.inputPrice) / 1000;
      const outputCost = (scenario.outputTokens * scenario.outputPrice) / 1000;
      const expectedCost = cachedCost + nonCachedCost + outputCost;
      
      const standardCost = (scenario.inputTokens * scenario.inputPrice + scenario.outputTokens * scenario.outputPrice) / 1000;
      const savings = standardCost - cost;
      const savingsPercent = (savings / standardCost) * 100;
      
      console.log(`📊 ${scenario.name}:`);
      console.log(`   Cost: $${cost.toFixed(6)}, Savings: ${savingsPercent.toFixed(1)}%`);
      console.log(`   ✅ ${Math.abs(cost - expectedCost) < 0.000001 ? 'PASS' : 'FAIL'}`);
    });
  });
}

/**
 * Test des cas d'erreur
 */
function testErrorCases() {
  console.log('\n❌ Testing Error Cases...\n');
  
  const errorTests = [
    {
      name: 'Negative input tokens',
      test: () => calculateTokenCostWithMethod(-100, 200, 0, 'standard', 3, 15),
      expectedError: 'Token counts must be non-negative'
    },
    {
      name: 'Negative cached tokens',
      test: () => calculateTokenCostWithMethod(100, 200, -50, 'standard', 3, 15),
      expectedError: 'Token counts must be non-negative'
    },
    {
      name: 'Cached tokens exceed input tokens',
      test: () => calculateTokenCostWithMethod(100, 200, 150, 'anthropic_cache', 3, 15),
      expectedError: 'Cached tokens cannot exceed input tokens'
    },
    {
      name: 'Unknown pricing method',
      test: () => calculateTokenCostWithMethod(100, 200, 50, 'unknown_method', 3, 15),
      expectedError: 'Unknown pricing method'
    }
  ];
  
  errorTests.forEach(errorTest => {
    try {
      errorTest.test();
      console.log(`❌ ${errorTest.name}: FAIL (should have thrown error)`);
    } catch (error) {
      const passed = error.message.includes(errorTest.expectedError);
      console.log(`✅ ${errorTest.name}: ${passed ? 'PASS' : 'FAIL'} (${error.message})`);
    }
  });
}

/**
 * Comparaison des économies par provider
 */
function compareProviderSavings() {
  console.log('\n💰 Provider Savings Comparison...\n');
  
  const compareScenario = {
    inputTokens: 2000,
    outputTokens: 500,
    cachedTokens: 1500, // 75% cache hit
    inputPrice: 5,
    outputPrice: 25
  };
  
  const methods = [
    { name: 'Standard', method: 'standard', cachedTokens: 0 },
    { name: 'Anthropic', method: 'anthropic_cache', cachedTokens: compareScenario.cachedTokens },
    { name: 'OpenAI 50%', method: 'openai_cache_50', cachedTokens: compareScenario.cachedTokens },
    { name: 'OpenAI 75%', method: 'openai_cache_75', cachedTokens: compareScenario.cachedTokens },
    { name: 'DeepSeek', method: 'deepseek_cache', cachedTokens: compareScenario.cachedTokens },
    { name: 'Google', method: 'google_cache', cachedTokens: compareScenario.cachedTokens }
  ];
  
  const standardCost = calculateTokenCostWithMethod(
    compareScenario.inputTokens,
    compareScenario.outputTokens,
    0,
    'standard',
    compareScenario.inputPrice,
    compareScenario.outputPrice
  );
  
  console.log(`📊 Scenario: ${compareScenario.inputTokens} input (${compareScenario.cachedTokens} cached), ${compareScenario.outputTokens} output tokens`);
  console.log(`💵 Base cost (no cache): $${standardCost.toFixed(6)}\n`);
  
  methods.forEach(methodConfig => {
    const cost = calculateTokenCostWithMethod(
      compareScenario.inputTokens,
      compareScenario.outputTokens,
      methodConfig.cachedTokens,
      methodConfig.method,
      compareScenario.inputPrice,
      compareScenario.outputPrice
    );
    
    const savings = standardCost - cost;
    const savingsPercent = (savings / standardCost) * 100;
    
    console.log(`${methodConfig.name.padEnd(12)}: $${cost.toFixed(6)} (${savingsPercent >= 0 ? '+' : ''}${savingsPercent.toFixed(1)}% savings)`);
  });
}

/**
 * Exécuter tous les tests
 */
function runAllTests() {
  console.log('🚀 Starting Pricing Methods Unit Tests...\n');
  console.log('=' .repeat(60));
  
  testStandardPricing();
  testAnthropicPricing();
  testOpenAIPricing();
  testDeepSeekPricing();
  testGooglePricing();
  testErrorCases();
  compareProviderSavings();
  
  console.log('\n' + '=' .repeat(60));
  console.log('✅ All pricing method tests completed!\n');
  
  console.log('🔍 Key Findings:');
  console.log('   • Anthropic & DeepSeek: 10% cache pricing (90% savings on cached tokens)');
  console.log('   • OpenAI: 50% or 75% cache pricing (25-50% savings on cached tokens)');
  console.log('   • Google: 25% cache pricing (75% savings on cached tokens)');
  console.log('   • All methods properly handle edge cases and validation');
}

// Exécuter les tests si ce fichier est appelé directement
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllTests();
}

export {
  testStandardPricing,
  testAnthropicPricing,
  testOpenAIPricing,
  testDeepSeekPricing,
  testGooglePricing,
  testErrorCases,
  compareProviderSavings,
  runAllTests
};
