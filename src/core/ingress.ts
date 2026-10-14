import { bytesToBase64, sha256Hex } from "./encoding.js";
import { InletError } from "./errors.js";
import { resolveUserId } from "./fairness.js";
import { normalizeHeaders } from "./headers.js";
import type {
  DeliveryEnvelope,
  InletConfig,
  OrderedQueue,
  ProviderAdapter,
  ProviderName,
  SecretResolver,
  WebhookRequest,
} from "./types.js";

export interface IntakeResult {
  eventId: string;
  routeId: string;
  userId: string;
}

export class InletIntake {
  private readonly routesByPath: ReadonlyMap<string, InletConfig["routes"][number]>;

  constructor(
    config: InletConfig,
    private readonly providers: ReadonlyMap<ProviderName, ProviderAdapter>,
    private readonly secrets: SecretResolver,
    private readonly queue: OrderedQueue,
  ) {
    this.routesByPath = new Map(config.routes.map((route) => [route.path, route]));
  }

  async accept(input: WebhookRequest, now = new Date()): Promise<IntakeResult> {
    if (input.method.toUpperCase() !== "POST") {
      throw new InletError("webhook routes only accept POST", 405, "method_not_allowed");
    }

    const route = this.routesByPath.get(input.path);
    if (!route) {
      throw new InletError("webhook route not found", 404, "route_not_found");
    }
    const provider = this.providers.get(route.provider);
    if (!provider) {
      throw new InletError("webhook provider is unavailable", 500, "provider_unavailable");
    }

    const normalizedRequest = { ...input, headers: normalizeHeaders(input.headers) };
    const secret = await this.secrets.resolve(route.secretRef);
    const webhook = await provider.verify(normalizedRequest, secret, now);
    const userId = resolveUserId(route, webhook, normalizedRequest.headers);

    const envelope: DeliveryEnvelope = {
      version: 1,
      routeId: route.id,
      provider: route.provider,
      eventId: webhook.eventId,
      eventType: webhook.eventType,
      userId,
      destination: route.destination,
      receivedAt: now.getTime(),
      headers: {
        ...webhook.forwardedHeaders,
        "x-inlet-provider": route.provider,
        "x-inlet-event-id": webhook.eventId,
        "x-inlet-event-type": webhook.eventType,
        "x-inlet-route-id": route.id,
      },
      bodyBase64: bytesToBase64(input.body),
    };
    if (route.completionUrl !== undefined) envelope.completionUrl = route.completionUrl;
    if (route.maxRetries !== undefined) envelope.maxRetries = route.maxRetries;
    if (route.executeWithinSeconds !== undefined) {
      envelope.executeBefore = now.getTime() + route.executeWithinSeconds * 1_000;
    }

    const groupId = await sha256Hex(`${route.id}\0${userId}`);
    const deduplicationId = await sha256Hex(`${route.provider}\0${route.id}\0${webhook.eventId}`);
    await this.queue.send(envelope, groupId, deduplicationId);
    return { eventId: webhook.eventId, routeId: route.id, userId };
  }
}
