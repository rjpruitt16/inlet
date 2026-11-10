import {
  constantTimeEqual,
  sha256HexBytes,
  utf8,
  utf8String,
} from "../core/encoding.js";
import { PayloadError, VerificationError } from "../core/errors.js";
import type { ProviderAdapter, VerifiedWebhook, WebhookRequest } from "../core/types.js";
import { forwarded, requiredHeader, stringAt } from "./shared.js";

export class HeliusProvider implements ProviderAdapter {
  readonly name = "helius" as const;

  async verify(request: WebhookRequest, secret: string): Promise<VerifiedWebhook> {
    const authorization = requiredHeader(request, "authorization");
    if (!constantTimeEqual(utf8(authorization), utf8(secret))) {
      throw new VerificationError("Helius authorization verification failed");
    }

    const body = parseHeliusBody(request);
    const transactions = Array.isArray(body) ? body : [body];
    if (transactions.length === 0) {
      throw new PayloadError("Helius webhook body must contain a transaction");
    }

    const first = transactions[0];
    const signatures = transactions
      .map(transactionSignature)
      .filter((value): value is string => value !== undefined);
    const eventId =
      transactions.length === 1 && signatures[0]
        ? signatures[0]
        : `batch-${await sha256HexBytes(request.body)}`;
    const types = new Set(
      transactions
        .map((transaction) => stringAt(transaction, "type"))
        .filter((value): value is string => value !== undefined),
    );

    const result: VerifiedWebhook = {
      provider: this.name,
      eventId,
      eventType:
        types.size === 1
          ? [...types][0]!
          : types.size > 1
            ? "transaction.batch"
            : "transaction",
      body,
      // The Authorization value is deliberately not forwarded to the destination.
      forwardedHeaders: forwarded(request.headers, []),
    };
    const defaultUserId = first ? transactionIdentity(first) : undefined;
    if (defaultUserId !== undefined) result.defaultUserId = defaultUserId;
    return result;
  }
}

function parseHeliusBody(request: WebhookRequest): Record<string, unknown> | unknown[] {
  let body: unknown;
  try {
    body = JSON.parse(utf8String(request.body));
  } catch {
    throw new PayloadError("webhook body must contain valid JSON");
  }
  if (typeof body !== "object" || body === null) {
    throw new PayloadError("Helius webhook body must be a transaction or transaction array");
  }
  if (Array.isArray(body)) {
    if (!body.every((value) => typeof value === "object" && value !== null && !Array.isArray(value))) {
      throw new PayloadError("Helius webhook body must be a transaction or transaction array");
    }
    return body;
  }
  return body as Record<string, unknown>;
}

function transactionSignature(transaction: unknown): string | undefined {
  return stringAt(transaction, "signature") ?? firstStringAt(transaction, "transaction", "signatures");
}

function transactionIdentity(transaction: unknown): string | undefined {
  return stringAt(transaction, "feePayer")
    ?? firstRecordStringAt(transaction, "accountData", "account")
    ?? firstRecordStringAt(transaction, "nativeTransfers", "fromUserAccount")
    ?? firstRecordStringAt(transaction, "nativeTransfers", "toUserAccount")
    ?? firstRecordStringAt(transaction, "tokenTransfers", "fromUserAccount")
    ?? firstRecordStringAt(transaction, "tokenTransfers", "toUserAccount");
}

function firstStringAt(value: unknown, objectKey: string, arrayKey: string): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const nested = (value as Record<string, unknown>)[objectKey];
  if (typeof nested !== "object" || nested === null || Array.isArray(nested)) return undefined;
  const values = (nested as Record<string, unknown>)[arrayKey];
  return Array.isArray(values) && typeof values[0] === "string" && values[0].length > 0
    ? values[0]
    : undefined;
}

function firstRecordStringAt(value: unknown, arrayKey: string, property: string): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const values = (value as Record<string, unknown>)[arrayKey];
  if (!Array.isArray(values)) return undefined;
  return stringAt(values[0], property);
}
