export type ProviderName =
  | "github"
  | "shopify"
  | "stripe"
  | "anthropic"
  | "twilio"
  | "telegram"
  | "whatsapp"
  | "openai"
  | "slack";

export type HeadersRecord = Record<string, string>;

export interface WebhookRequest {
  method: string;
  path: string;
  url?: string;
  headers: HeadersRecord;
  body: Uint8Array;
}

export interface ProviderChallengeResponse {
  statusCode: number;
  headers: HeadersRecord;
  body: string;
}

export interface VerifiedWebhook {
  provider: ProviderName;
  eventId: string;
  eventType: string;
  defaultUserId?: string;
  body: unknown;
  forwardedHeaders: HeadersRecord;
}

export interface ProviderAdapter {
  readonly name: ProviderName;
  verify(request: WebhookRequest, secret: string, now?: Date): Promise<VerifiedWebhook>;
  verifyChallenge?(
    request: WebhookRequest,
    verificationSecret: string,
  ): Promise<ProviderChallengeResponse>;
  respondImmediately?(
    request: WebhookRequest,
    secret: string,
    now?: Date,
  ): Promise<ProviderChallengeResponse | undefined>;
}

export interface RouteConfig {
  id: string;
  path: string;
  provider: ProviderName;
  secretRef: string;
  verificationSecretRef?: string;
  publicUrl?: string;
  destination: string;
  fairnessKey?: string;
  completionUrl?: string;
  maxRetries?: number;
  executeWithinSeconds?: number;
  eventsTopic?: string;
  resultsTopic?: string;
}

export interface ConfirmationConfig {
  delayMs: number;
  jitterRatio: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

export type DeliveryMode = "sqs" | "kafka";

export interface KafkaReconcileConfig {
  /** An event with no terminal result this long after it was written is overdue. */
  afterSeconds: number;
  /** How far past an event's write time to look for its result. */
  searchWindowSeconds: number;
  /** Redrives before the reconciler records gave_up. */
  maxRedrives: number;
}

export interface KafkaConfig {
  eventsTopic: string;
  resultsTopic: string;
  reconcile: KafkaReconcileConfig;
}

export interface InletConfig {
  aquiferUrl: string;
  routes: RouteConfig[];
  confirmation: ConfirmationConfig;
  /** sqs (default) keeps today's SQS FIFO or Durable Object delivery. */
  delivery?: DeliveryMode;
  /** Present only when delivery is kafka. */
  kafka?: KafkaConfig;
}

export interface DeliveryEnvelope {
  version: 1;
  routeId: string;
  provider: ProviderName;
  eventId: string;
  eventType: string;
  userId: string;
  destination: string;
  completionUrl?: string;
  maxRetries?: number;
  executeBefore?: number;
  receivedAt: number;
  headers: HeadersRecord;
  bodyBase64: string;
  /** Overrides the default inlet:<provider>:<route>:<event> Aquifer key. */
  idempotencyKey?: string;
}

export interface SecretResolver {
  resolve(reference: string): Promise<string>;
}

export interface OrderedQueue {
  send(envelope: DeliveryEnvelope, groupId: string, deduplicationId: string): Promise<void>;
}

export interface QueueMessage<T> {
  id: string;
  body: T;
  attempt: number;
}

export type DeliveryAction =
  | { kind: "ack"; jobId: string; status: string }
  | { kind: "confirm"; delayMs: number; state: ConfirmationState }
  | { kind: "retry"; delayMs: number; reason: string }
  | { kind: "dead-letter"; reason: string; statusCode?: number };

export interface AquiferResponse {
  statusCode: number;
  headers: HeadersRecord;
  body: unknown;
}

export interface AquiferTransport {
  submit(envelope: DeliveryEnvelope): Promise<AquiferResponse>;
}

export interface ConfirmationState {
  jobId: string;
  successes: number;
}

export interface RandomSource {
  next(): number;
}
