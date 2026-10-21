import { confirmationDelay, systemRandom } from "../backoff.js";
import { deliverEnvelope } from "../delivery.js";
import type {
  AquiferTransport,
  ConfirmationConfig,
  ConfirmationState,
  DeliveryEnvelope,
  RandomSource,
} from "../types.js";
import { envelopeFromEventRecord, resultFor, type EventRecord, type ResultRecord } from "./records.js";

export interface KafkaDispatchDeps {
  aquifer: AquiferTransport;
  confirmation: ConfirmationConfig;
  completionUrlFor(record: EventRecord): Promise<string>;
  /** Milliseconds left before the invocation must return. */
  remainingMs(): number;
  sleep?(ms: number): Promise<void>;
  random?: RandomSource;
}

export interface KafkaDispatchOutcome {
  /** owned and dead_letter results, each with the results topic it belongs on. */
  results: Array<{ topic: string; result: ResultRecord }>;
  /**
   * Records Aquifer hasn't confirmed yet. When this is non-empty the caller
   * must fail the batch so Kafka delivers it again; records already
   * confirmed are resubmitted too, and Aquifer answers them as duplicates.
   */
  unfinished: EventRecord[];
}

// Room left for writing results and returning before the invocation ends.
const returnMarginMs = 5_000;
// Confirmation rounds after the first: a 201 on a confirmation means Aquifer
// replaced a lost job, which needs another matching duplicate.
const maxConfirmationRounds = 3;

interface Pending {
  record: EventRecord;
  envelope: DeliveryEnvelope;
  state: ConfirmationState;
  attempt: number;
}

/**
 * Submits a batch of events to Aquifer and confirms each one.
 *
 * Events with the same route and user are submitted one at a time, in log
 * order, so Aquifer accepts them in order. Different users go in parallel.
 * The confirmation wait is taken once for the whole batch rather than once
 * per event, which matters because a Kafka partition mixes many users.
 */
export async function dispatchEvents(
  records: EventRecord[],
  deps: KafkaDispatchDeps,
): Promise<KafkaDispatchOutcome> {
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? systemRandom;
  const results: KafkaDispatchOutcome["results"] = [];
  const unfinished: EventRecord[] = [];

  const groups = new Map<string, EventRecord[]>();
  for (const record of records) {
    const key = `${record.route_id}\0${record.user_id}`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }

  // First submission, in order within each group.
  const pendingByGroup = await Promise.all(
    Array.from(groups.values(), async (group) => {
      const pending: Pending[] = [];
      for (let index = 0; index < group.length; index += 1) {
        const record = group[index]!;
        const envelope = envelopeFromEventRecord(record, await deps.completionUrlFor(record));
        let attempt = 1;
        for (;;) {
          const action = await deliverEnvelope(envelope, attempt, deps.aquifer, deps.confirmation, new Date(), random);
          if (action.kind === "confirm") {
            pending.push({ record, envelope, state: action.state, attempt: attempt + 1 });
            break;
          }
          if (action.kind === "ack") {
            results.push({ topic: record.results_topic, result: resultFor(record, "owned", "dispatch", { job_id: action.jobId }) });
            break;
          }
          if (action.kind === "dead-letter") {
            const details: { reason: string; response_status?: number } = { reason: action.reason };
            if (action.statusCode !== undefined) details.response_status = action.statusCode;
            results.push({ topic: record.results_topic, result: resultFor(record, "dead_letter", "dispatch", details) });
            break;
          }
          // Retry. Later events in this group must wait behind this one.
          if (deps.remainingMs() < action.delayMs + returnMarginMs) {
            unfinished.push(...group.slice(index));
            return pending;
          }
          await sleep(action.delayMs);
          attempt += 1;
        }
      }
      return pending;
    }),
  );

  // Confirmation rounds, one shared wait per round.
  let pending = pendingByGroup.flat();
  for (let round = 0; pending.length > 0 && round < maxConfirmationRounds; round += 1) {
    const delayMs = confirmationDelay(deps.confirmation, random);
    if (deps.remainingMs() < delayMs + returnMarginMs) break;
    await sleep(delayMs);

    const next: Pending[] = [];
    await Promise.all(
      groupPending(pending).map(async (group) => {
        for (const item of group) {
          const action = await deliverEnvelope(
            item.envelope,
            item.attempt,
            deps.aquifer,
            deps.confirmation,
            new Date(),
            random,
            item.state,
          );
          if (action.kind === "ack") {
            results.push({ topic: item.record.results_topic, result: resultFor(item.record, "owned", "dispatch", { job_id: action.jobId }) });
          } else if (action.kind === "confirm") {
            next.push({ ...item, state: action.state, attempt: item.attempt + 1 });
          } else if (action.kind === "dead-letter") {
            const details: { reason: string; response_status?: number } = { reason: action.reason };
            if (action.statusCode !== undefined) details.response_status = action.statusCode;
            results.push({ topic: item.record.results_topic, result: resultFor(item.record, "dead_letter", "dispatch", details) });
          } else {
            // A failed confirmation doesn't count; keep the state and try again.
            next.push({ ...item, attempt: item.attempt + 1 });
          }
        }
      }),
    );
    pending = next;
  }
  unfinished.push(...pending.map((item) => item.record));

  return { results, unfinished };
}

function groupPending(pending: Pending[]): Pending[][] {
  const groups = new Map<string, Pending[]>();
  for (const item of pending) {
    const key = `${item.record.route_id}\0${item.record.user_id}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return Array.from(groups.values());
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
