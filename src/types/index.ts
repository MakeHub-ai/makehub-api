/**
 * Index des exports de types
 */

// Database types
export type {
  Model,
  RequestRow,
  RequestContentRow,
  MetricsRow,
  TransactionRow,
  ApiKeyRow,
  WalletRow,
  RequestStatus,
  TransactionType,
  Database,
  RequestWithContent,
  RequestWithContentAndModel,
  ApiKeyWithWallet
} from './database.js';

// Request/Response types
export type {
  ChatMessage,
  ChatMessageContent,
  ToolCall,
  Tool,
  ToolChoice,
  StandardRequest,
  ChatCompletion,
  ChatCompletionChoice,
  ChatCompletionChunk,
  ChatCompletionChunkChoice,
  Usage,
  CompletionRequest,
  CompletionResponse,
  CompletionChoice,
  ModelInfo,
  ModelsList,
  ExtendedModelInfo,
  ExtendedModelsList,
  CostEstimate,
  ApiError,
  ProviderCombination,
  ModelPerformanceMetrics,
  ModelVectorScore,
} from './requests.js';


// Auth types
export type {
  User,
  ApiKey,
  AuthData,
  UserPreferences,
  HonoVariables,
  DatabaseConfig,
  CacheKey,
  AuthResponse,
  BalanceCheck
} from './auth.js';

// Adapter types
export type {
  AdapterConfig,
  AdapterInterface,
  AdapterType,
  AdapterErrorCode,
  OpenAIRequest,
  OpenAIResponse,
  StreamChunk,
  ValidationResult,
  AdapterMetrics
} from './adapters.js';

export { AdapterError } from './adapters.js';
