import { idempotencyKeyFor, resultFor, type EventRecord, type ResultRecord } from "./records.js";
import type { KafkaReconcileConfig, ProviderName } from "../types.js";

/**
 * The reconciler's view of Kafka. A runtime implements it with a real
 * client; tests use an in-memory log.
 */
export interface ReconcileLog {
  /**
   * Reads the events topic from the reconciler's cursor, in order within
   * each partition, stopping in each partition at the first event whose
   * reconcile_after is still in the future. Nothing moves the cursor until
   * commit() is called.
   */
  readOverdue(eventsTopic: string, now: Date): Promise<{ events: EventRecord[]; commit(): Promise<void> }>;
  /** Reads results written between two times. */
  readResults(resultsTopic: string, from: Date, to: Date): Promise<ResultRecord[]>;
  /** Appends to a topic, keyed for ordering. */
  write(topic: string, messages: Array<{ key: string; value: string; timestamp: number }>): Promise<void>;
}

export interface ReconcileSummary {
  checked: number;
  ok: number;
  redriven: number;
  gaveUp: number;
}

export type Decision =
  | { kind: "ok" }
  | { kind: "redrive"; newKey: boolean; reason: string }
  | { kind: "gave_up"; reason: string };

/**
 * What to do with one overdue copy of an event, given the results recorded
 * for it.
 *
 * - completed, dead_letter, or already redriven/gave up: nothing to do.
 * - failed: the destination never accepted it, so run it again with a new
 *   Aquifer key (the old key would come back as a duplicate of the failure).
 * - no terminal result: Aquifer may have lost the job, or it's still running.
 *   Resubmit with the same key, so Aquifer answers duplicate if it still has
 *   the job and only creates one if it doesn't.
 */
export function decide(event: EventRecord, results: ResultRecord[], maxRedrives: number): Decision {
  const mine = results.filter(
    (result) => result.delivery_id === event.delivery_id && result.redrive === event.redrive,
  );
  const statuses = new Set(mine.map((result) => result.status));
  if (
    statuses.has("completed") ||
    statuses.has("dead_letter") ||
    statuses.has("redriven") ||
    statuses.has("gave_up")
  ) {
    return { kind: "ok" };
  }
  const failed = statuses.has("failed");
  const reason = failed ? "failed" : statuses.has("owned") ? "no_completion" : "no_result";
  if (event.redrive >= maxRedrives) {
    return { kind: "gave_up", reason };
  }
  return { kind: "redrive", newKey: failed, reason };
}

export function redriveOf(event: EventRecord, newKey: boolean, reconcileAfterSeconds: number, now: Date): EventRecord {
  const keyGeneration = newKey ? event.key_generation + 1 : event.key_generation;
  return {
    ...event,
    redrive: event.redrive + 1,
    key_generation: keyGeneration,
    idempotency_key: idempotencyKeyFor(
      { provider: event.provider as ProviderName, routeId: event.route_id, eventId: event.event_id },
      keyGeneration,
    ),
    written_at: now.toISOString(),
    reconcile_after: new Date(now.getTime() + reconcileAfterSeconds * 1_000).toISOString(),
  };
}

/**
 * One reconciler pass over an events topic.
 *
 * Writes each redrive to the events topic before recording it as redriven,
 * and moves the cursor only after both. A crash in between leaves at worst a
 * second copy of the event, which Aquifer deduplicates by key.
 */
export async function reconcileTopic(
  eventsTopic: string,
  log: ReconcileLog,
  config: KafkaReconcileConfig,
  now = new Date(),
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { checked: 0, ok: 0, redriven: 0, gaveUp: 0 };
  const { events, commit } = await log.readOverdue(eventsTopic, now);
  if (events.length === 0) return summary;

  const byResultsTopic = new Map<string, EventRecord[]>();
  for (const event of events) {
    const group = byResultsTopic.get(event.results_topic) ?? [];
    group.push(event);
    byResultsTopic.set(event.results_topic, group);
  }

  for (const [resultsTopic, group] of byResultsTopic) {
    const from = new Date(Math.min(...group.map((event) => Date.parse(event.written_at))));
    const latest = Math.max(...group.map((event) => Date.parse(event.written_at)));
    const to = new Date(Math.min(now.getTime(), latest + config.searchWindowSeconds * 1_000));
    const results = await log.readResults(resultsTopic, from, to);

    const redrives: EventRecord[] = [];
    const outcomes: ResultRecord[] = [];
    for (const event of group) {
      summary.checked += 1;
      const decision = decide(event, results, config.maxRedrives);
      if (decision.kind === "ok") {
        summary.ok += 1;
      } else if (decision.kind === "gave_up") {
        summary.gaveUp += 1;
        outcomes.push(resultFor(event, "gave_up", "reconciler", { reason: decision.reason }, now));
      } else {
        summary.redriven += 1;
        redrives.push(redriveOf(event, decision.newKey, config.afterSeconds, now));
        outcomes.push(resultFor(event, "redriven", "reconciler", { reason: decision.reason }, now));
      }
    }

    await writeEvents(log, redrives, now);
    await log.write(
      resultsTopic,
      outcomes.map((result) => ({ key: result.delivery_id, value: JSON.stringify(result), timestamp: now.getTime() })),
    );
  }

  await commit();
  return summary;
}

async function writeEvents(log: ReconcileLog, events: EventRecord[], now: Date): Promise<void> {
  const byTopic = new Map<string, EventRecord[]>();
  for (const event of events) {
    const group = byTopic.get(event.events_topic) ?? [];
    group.push(event);
    byTopic.set(event.events_topic, group);
  }
  for (const [topic, group] of byTopic) {
    await log.write(
      topic,
      group.map((event) => ({ key: event.partition_key, value: JSON.stringify(event), timestamp: now.getTime() })),
    );
  }
}
