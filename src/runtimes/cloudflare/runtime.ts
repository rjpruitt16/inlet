import { FetchAquiferTransport } from "../../core/aquifer.js";
import { parseConfig } from "../../core/config.js";
import { deliverEnvelope } from "../../core/delivery.js";
import { InletError } from "../../core/errors.js";
import { InletIntake } from "../../core/ingress.js";
import type { DeliveryAction, InletConfig } from "../../core/types.js";
import { defaultProviders } from "../../providers/index.js";
import { CloudflareDurableQueue } from "./queue.js";
import { CloudflareSecretResolver } from "./secrets.js";
import type {
  CloudflareEnv,
  DurableObjectStateLike,
  StoredDelivery,
} from "./types.js";

const headKey = "head";
const tailKey = "tail";

export default {
  async fetch(request: Request, env: CloudflareEnv): Promise<Response> {
    try {
      const config = parseConfig(env.INLET_CONFIG);
      const intake = new InletIntake(
        config,
        defaultProviders(),
        new CloudflareSecretResolver(env),
        new CloudflareDurableQueue(env.INLET_ORDERING),
      );
      const url = new URL(request.url);
      const result = await intake.accept({
        method: request.method,
        path: url.pathname,
        headers: Object.fromEntries(request.headers.entries()),
        body: new Uint8Array(await request.arrayBuffer()),
      });
      return Response.json({ accepted: true, ...result }, { status: 202 });
    } catch (error) {
      if (error instanceof InletError) {
        return Response.json({ error: error.message, code: error.code }, { status: error.statusCode });
      }
      console.error("inlet intake failed", error);
      return Response.json(
        { error: "webhook intake unavailable", code: "intake_unavailable" },
        { status: 503 },
      );
    }
  },
};

export class InletQueueObject {
  private readonly config: InletConfig;
  private readonly aquifer: FetchAquiferTransport;

  constructor(
    private readonly state: DurableObjectStateLike,
    private readonly env: CloudflareEnv,
  ) {
    this.config = parseConfig(env.INLET_CONFIG);
    const timeoutMs = Number(env.INLET_AQUIFER_TIMEOUT_MS ?? "5000");
    this.aquifer = new FetchAquiferTransport(this.config.aquiferUrl, { timeoutMs });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/enqueue") {
      return new Response("not found", { status: 404 });
    }

    const value: unknown = await request.json();
    if (!isEnqueueRequest(value)) {
      return new Response("invalid queue message", { status: 400 });
    }

    // Schedule first. Durable Object events are serialized, so the alarm
    // cannot observe partial queue state, and a process interruption cannot
    // commit a message without already having a future wake-up.
    if ((await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(Date.now());
    }

    await this.state.storage.transaction(async (storage) => {
      const dedupKey = `dedup:${value.deduplicationId}`;
      if ((await storage.get<number>(dedupKey)) !== undefined) return;

      const tail = (await storage.get<number>(tailKey)) ?? 0;
      const sequence = tail + 1;
      await storage.put(messageKey(sequence), {
        envelope: value.envelope,
        deduplicationId: value.deduplicationId,
        attempt: 1,
      } satisfies StoredDelivery);
      await storage.put(tailKey, sequence);
      await storage.put(dedupKey, sequence);
      if ((await storage.get<number>(headKey)) === undefined) {
        await storage.put(headKey, sequence);
      }
    });

    return Response.json({ queued: true }, { status: 202 });
  }

  async alarm(): Promise<void> {
    const head = await this.state.storage.get<number>(headKey);
    const tail = await this.state.storage.get<number>(tailKey);
    if (head === undefined || tail === undefined || head > tail) return;

    const delivery = await this.state.storage.get<StoredDelivery>(messageKey(head));
    if (!delivery) {
      await this.advance(head, tail);
      return;
    }

    const action = await deliverEnvelope(
      delivery.envelope,
      delivery.attempt,
      this.aquifer,
      this.config.confirmation,
      new Date(),
      undefined,
      delivery.confirmation,
    );
    if (action.kind === "confirm") {
      await this.state.storage.setAlarm(Date.now() + action.delayMs);
      await this.state.storage.put(messageKey(head), {
        ...delivery,
        attempt: delivery.attempt + 1,
        confirmation: action.state,
      });
      return;
    }
    if (action.kind === "retry") {
      console.warn("inlet delivery retry scheduled", {
        reason: action.reason,
        attempt: delivery.attempt,
        delay_ms: action.delayMs,
      });
      await this.state.storage.setAlarm(Date.now() + action.delayMs);
      await this.state.storage.put(messageKey(head), {
        ...delivery,
        attempt: delivery.attempt + 1,
      });
      return;
    }

    if (action.kind === "dead-letter") {
      if (!this.env.INLET_DLQ) {
        console.error("inlet permanent delivery failure; no INLET_DLQ binding configured", action);
        await this.state.storage.setAlarm(Date.now() + this.config.confirmation.maxBackoffMs);
        return;
      }
      await this.env.INLET_DLQ.send({
        failed_at: Date.now(),
        reason: action.reason,
        status_code: action.statusCode,
        envelope: delivery.envelope,
      });
    }

    await this.state.storage.delete(`dedup:${delivery.deduplicationId}`);
    await this.state.storage.delete(messageKey(head));
    await this.advance(head, tail);
  }

  private async advance(head: number, tail: number): Promise<void> {
    const next = head + 1;
    if (next <= tail) {
      await this.state.storage.setAlarm(Date.now());
    }
    await this.state.storage.put(headKey, next);
  }
}

function messageKey(sequence: number): string {
  return `message:${sequence.toString().padStart(20, "0")}`;
}

function isEnqueueRequest(value: unknown): value is {
  envelope: StoredDelivery["envelope"];
  deduplicationId: string;
} {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { envelope?: unknown; deduplicationId?: unknown };
  return (
    typeof candidate.deduplicationId === "string" &&
    typeof candidate.envelope === "object" &&
    candidate.envelope !== null &&
    (candidate.envelope as { version?: unknown }).version === 1
  );
}
