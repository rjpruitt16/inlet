import type { ConfirmationState, DeliveryEnvelope } from "../../core/types.js";

export interface DurableObjectIdLike {}

export interface DurableObjectStubLike {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): DurableObjectStubLike;
}

export interface DurableObjectStorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  transaction<T>(closure: (transaction: DurableObjectStorageLike) => Promise<T>): Promise<T>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
}

export interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
}

export interface CloudflareQueueLike<T = unknown> {
  send(body: T): Promise<void>;
}

export interface CloudflareFetcherLike {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

export interface CloudflareEnv {
  INLET_CONFIG: string;
  INLET_ORDERING: DurableObjectNamespaceLike;
  INLET_AQUIFER?: CloudflareFetcherLike;
  INLET_AQUIFER_TIMEOUT_MS?: string;
  INLET_DLQ?: CloudflareQueueLike;
  [binding: string]: unknown;
}

export interface StoredDelivery {
  envelope: DeliveryEnvelope;
  deduplicationId: string;
  attempt: number;
  confirmation?: ConfirmationState;
}
