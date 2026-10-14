import { confirmationDelay, retryDelay, systemRandom } from "./backoff.js";
import { normalizeHeaders } from "./headers.js";
import type {
  AquiferTransport,
  ConfirmationConfig,
  ConfirmationState,
  DeliveryAction,
  DeliveryEnvelope,
  RandomSource,
} from "./types.js";

export async function deliverEnvelope(
  envelope: DeliveryEnvelope,
  attempt: number,
  aquifer: AquiferTransport,
  confirmation: ConfirmationConfig,
  now = new Date(),
  random: RandomSource = systemRandom,
  state?: ConfirmationState,
): Promise<DeliveryAction> {
  let response;
  try {
    response = await aquifer.submit(envelope);
  } catch (error) {
    return {
      kind: "retry",
      delayMs: retryDelay(attempt, {}, confirmation, now, random),
      reason: error instanceof Error ? `aquifer_unreachable: ${error.message}` : "aquifer_unreachable",
    };
  }

  const headers = normalizeHeaders(response.headers);
  const accepted = acceptedJob(response.statusCode, response.body);
  if (accepted) {
    const successes = state?.jobId === accepted.jobId ? state.successes + 1 : 1;
    if (accepted.duplicate && successes >= 2) {
      return { kind: "ack", jobId: accepted.jobId, status: accepted.status };
    }
    return {
      kind: "confirm",
      delayMs: confirmationDelay(confirmation, random),
      state: { jobId: accepted.jobId, successes },
    };
  }

  if (
    response.statusCode === 408 ||
    response.statusCode === 429 ||
    response.statusCode >= 500 ||
    (response.statusCode >= 200 && response.statusCode < 300)
  ) {
    return {
      kind: "retry",
      delayMs: retryDelay(attempt, headers, confirmation, now, random),
      reason: `aquifer_${response.statusCode}`,
    };
  }

  return {
    kind: "dead-letter",
    reason: errorMessage(response.body) ?? `Aquifer rejected the job with ${response.statusCode}`,
    statusCode: response.statusCode,
  };
}

function acceptedJob(
  statusCode: number,
  body: unknown,
): { jobId: string; status: string; duplicate: boolean } | undefined {
  if (!isRecord(body) || typeof body.job_id !== "string" || body.job_id.length === 0) {
    return undefined;
  }
  if (statusCode === 201) {
    return {
      jobId: body.job_id,
      status: typeof body.status === "string" ? body.status : "unknown",
      duplicate: false,
    };
  }
  if (statusCode === 200 && body.duplicate === true) {
    return {
      jobId: body.job_id,
      status: typeof body.status === "string" ? body.status : "unknown",
      duplicate: true,
    };
  }
  return undefined;
}

function errorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.error === "string") return value.error;
  if (typeof value.message === "string") return value.message;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
