import { bytesToBase64, sha256Hex } from "./encoding.js";
import { InletError } from "./errors.js";
import { resolveUserId } from "./fairness.js";
import { normalizeHeaders } from "./headers.js";
import type {
  DeliveryEnvelope,
  InletConfig,
  OrderedQueue,
  ProviderAdapter,
  ProviderChallengeResponse,
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

    const { route, provider } = this.resolveRoute(input.path);

    const normalizedRequest = this.normalizeRequest(input, route.publicUrl);
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

  async challenge(input: WebhookRequest): Promise<ProviderChallengeResponse> {
    if (input.method.toUpperCase() !== "GET") {
      throw new InletError("webhook verification requires GET", 405, "method_not_allowed");
    }

    const { route, provider } = this.resolveRoute(input.path);
    if (!provider.verifyChallenge || !route.verificationSecretRef) {
      throw new InletError(
        "webhook provider does not support a verification challenge",
        405,
        "method_not_allowed",
      );
    }

    const verificationSecret = await this.secrets.resolve(route.verificationSecretRef);
    return provider.verifyChallenge(
      this.normalizeRequest(input, route.publicUrl),
      verificationSecret,
    );
  }

  async immediateResponse(
    input: WebhookRequest,
    now = new Date(),
  ): Promise<ProviderChallengeResponse | undefined> {
    const { route, provider } = this.resolveRoute(input.path);
    if (!provider.respondImmediately) return undefined;

    const secret = await this.secrets.resolve(route.secretRef);
    return provider.respondImmediately(
      this.normalizeRequest(input, route.publicUrl),
      secret,
      now,
    );
  }

  private resolveRoute(path: string): {
    route: InletConfig["routes"][number];
    provider: ProviderAdapter;
  } {
    const route = this.routesByPath.get(path);
    if (!route) {
      throw new InletError("webhook route not found", 404, "route_not_found");
    }
    const provider = this.providers.get(route.provider);
    if (!provider) {
      throw new InletError("webhook provider is unavailable", 500, "provider_unavailable");
    }
    return { route, provider };
  }

  private normalizeRequest(input: WebhookRequest, publicUrl?: string): WebhookRequest {
    const request: WebhookRequest = {
      ...input,
      headers: normalizeHeaders(input.headers),
    };
    const url = externallyVisibleUrl(input.url, publicUrl);
    if (url !== undefined) request.url = url;
    return request;
  }
}

function externallyVisibleUrl(requestUrl?: string, configuredUrl?: string): string | undefined {
  if (!configuredUrl) return requestUrl;
  if (!requestUrl) return configuredUrl;

  const configuredQuery = configuredUrl.indexOf("?");
  const configuredFragment = configuredUrl.indexOf("#");
  const configuredEnd = [configuredQuery, configuredFragment]
    .filter((index) => index >= 0)
    .reduce((lowest, index) => Math.min(lowest, index), configuredUrl.length);
  const requestQuery = requestUrl.indexOf("?");
  return configuredUrl.slice(0, configuredEnd)
    + (requestQuery >= 0 ? requestUrl.slice(requestQuery) : "");
}
