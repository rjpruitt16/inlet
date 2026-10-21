import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { awsTemplate, deliveryGroup, eventsTopics, functionNames, kafkaTriggerId } from "../src/cli/aws-template.js";
import { deadLetterQueue, workerSecretNames, wranglerConfig } from "../src/cli/cloudflare.js";
import { awsSecretNames, parseInletFile } from "../src/cli/deploy-config.js";
import { init } from "../src/cli/init.js";
import { parseOptions } from "../src/cli/main.js";

const sqsFile = `
aquifer_url: https://aquifer.example.com
routes:
  - id: github-main
    path: /webhooks/github/main
    provider: github
    secret_ref: aws-secrets:inlet-github-webhook-secret
    destination: https://backend.example.com/github
deploy:
  platform: aws
  name: inlet-github
  region: us-east-2
`;

const kafkaFile = `
aquifer_url: https://aquifer.example.com
delivery: kafka
routes:
  - id: github-main
    path: /webhooks/github/main
    provider: github
    secret_ref: aws-secrets:inlet-github-webhook-secret
    destination: https://backend.example.com/github
  - id: stripe-main
    path: /webhooks/stripe/main
    provider: stripe
    secret_ref: aws-secrets:inlet-stripe-webhook-secret
    destination: https://backend.example.com/stripe
    events_topic: billing.events
deploy:
  platform: aws
  name: inlet-hooks
  kafka:
    brokers: broker-1.example.com:9093,broker-2.example.com:9093
    credentials_secret: inlet-kafka
`;

const arns = (names: string[]) =>
  arnMap([...names, "inlet-hooks-completion-key"]);
const arnMap = (names: string[]) =>
  new Map(names.map((name) => [name, `arn:aws:secretsmanager:us-east-2:123456789012:secret:${name}-AbCdEf`]));

test("the deploy block is read and kept out of INLET_CONFIG", () => {
  const file = parseInletFile(sqsFile);
  assert.deepEqual(file.deploy, { platform: "aws", name: "inlet-github", region: "us-east-2" });
  assert.ok(!file.runtimeYaml.includes("deploy"), "the runtime never sees deploy:");
  assert.equal(file.config.routes[0]?.id, "github-main");
  assert.deepEqual(awsSecretNames(file), ["inlet-github-webhook-secret"]);
});

test("the deploy block rejects settings that can't work", () => {
  assert.throws(() => parseInletFile(sqsFile.replace(/deploy:[\s\S]*/, "")), /needs a deploy: block/);
  assert.throws(() => parseInletFile(sqsFile.replace("name: inlet-github", "name: 9bad")), /deploy.name/);
  assert.throws(
    () => parseInletFile(sqsFile.replace("aws-secrets:inlet-github-webhook-secret", "GITHUB_SECRET")),
    /set secret_ref to aws-secrets/,
  );
  assert.throws(() => parseInletFile(kafkaFile.replace(/  kafka:[\s\S]*/, "")), /needs deploy.kafka/);
  assert.throws(
    () => parseInletFile(kafkaFile.replace("platform: aws", "platform: cloudflare").replace(/aws-secrets:/g, "")),
    /isn't available on Cloudflare yet/,
  );
});

test("the SQS template has a FIFO queue, both functions and one public API", () => {
  const file = parseInletFile(sqsFile);
  const template = awsTemplate(file, arns(awsSecretNames(file))) as { Resources: Record<string, any> };
  const resources = template.Resources;

  assert.equal(resources.Queue.Properties.QueueName, "inlet-github.fifo");
  assert.equal(resources.Queue.Properties.FifoQueue, true);
  assert.equal(resources.HttpFunction.Properties.FunctionName, "inlet-github-http");
  assert.equal(resources.HttpFunction.Properties.Handler, "index.httpHandler");
  assert.equal(resources.DeliveryFunction.Properties.Handler, "index.queueHandler");
  assert.equal(resources.QueueTrigger.Properties.FunctionResponseTypes[0], "ReportBatchItemFailures");
  assert.equal(resources.Api.Properties.ProtocolType, "HTTP");
  assert.equal(resources.HttpFunctionLogs.Properties.LogGroupName, "/aws/lambda/inlet-github-http");
  assert.equal(resources.ReconcileFunction, undefined, "SQS mode has no reconciler");
  assert.ok(!JSON.stringify(resources).includes("deploy:"), "INLET_CONFIG has no deploy block");

  const secretGrant = resources.Role.Properties.Policies[0].PolicyDocument.Statement[0];
  assert.deepEqual(secretGrant.Resource, [
    "arn:aws:secretsmanager:us-east-2:123456789012:secret:inlet-github-webhook-secret-AbCdEf",
  ]);
});

test("the Kafka template has one trigger per events topic, the reconciler and its schedule", () => {
  const file = parseInletFile(kafkaFile);
  const template = awsTemplate(file, arns(awsSecretNames(file))) as { Resources: Record<string, any> };
  const resources = template.Resources;

  assert.deepEqual(eventsTopics(file), ["inlet.events", "billing.events"]);
  const main = resources[kafkaTriggerId("inlet.events")];
  const billing = resources[kafkaTriggerId("billing.events")];
  assert.deepEqual(main.Properties.Topics, ["inlet.events"]);
  assert.deepEqual(billing.Properties.Topics, ["billing.events"]);
  assert.notEqual(
    main.Properties.SelfManagedKafkaEventSourceConfig.ConsumerGroupId,
    billing.Properties.SelfManagedKafkaEventSourceConfig.ConsumerGroupId,
    "Lambda needs a consumer group per Kafka trigger",
  );
  assert.equal(deliveryGroup(file, "billing.events"), "inlet-hooks-delivery-billing.events");
  assert.deepEqual(main.Properties.SelfManagedEventSource.Endpoints.KafkaBootstrapServers, [
    "broker-1.example.com:9093",
    "broker-2.example.com:9093",
  ]);
  assert.equal(main.Properties.SourceAccessConfigurations[0].Type, "SASL_SCRAM_512_AUTH");
  assert.equal(resources.DeliveryFunction.Properties.Handler, "index.kafkaHandler");
  assert.deepEqual(resources.DeliveryFunction.Properties.Environment.Variables.INLET_PUBLIC_URL, {
    "Fn::GetAtt": ["Api", "ApiEndpoint"],
  });
  assert.equal(resources.ReconcileFunction.Properties.Handler, "index.reconcileHandler");
  assert.equal(resources.ReconcileSchedule.Properties.ScheduleExpression, "rate(5 minutes)");
  assert.deepEqual(resources.ReconcileSchedule.DependsOn, ["ReconcilePermission"], "the permission exists before the first firing");
  assert.deepEqual(resources.ReconcilePermission.Properties.SourceArn, {
    "Fn::Sub": "arn:${AWS::Partition}:events:${AWS::Region}:${AWS::AccountId}:rule/inlet-hooks-reconcile",
  });
  assert.equal(resources.Queue, undefined, "Kafka mode has no SQS queue");
  assert.deepEqual(functionNames(file), {
    http: "inlet-hooks-http",
    delivery: "inlet-hooks-delivery",
    reconcile: "inlet-hooks-reconcile",
  });
});

test("the Cloudflare config binds the ordered queue and dead-letter queue", () => {
  const file = parseInletFile(`
aquifer_url: https://aquifer.example.com
routes:
  - { id: github-main, path: /webhooks/github/main, provider: github, secret_ref: GITHUB_WEBHOOK_SECRET, destination: https://backend.example.com/github }
deploy:
  platform: cloudflare
  name: inlet-github
`);
  const config = wranglerConfig(file) as Record<string, any>;
  assert.equal(config.name, "inlet-github");
  assert.ok(String(config.main).endsWith("runtimes/cloudflare/runtime.js"));
  assert.equal(config.durable_objects.bindings[0].class_name, "InletQueueObject");
  assert.equal(config.queues.producers[0].queue, deadLetterQueue(file));
  assert.ok(!String(config.vars.INLET_CONFIG).includes("deploy"));
  assert.deepEqual(workerSecretNames(file), ["GITHUB_WEBHOOK_SECRET"]);
});

test("parseOptions reads --key value, --key=value and flags, keeping = inside values", () => {
  assert.deepEqual(parseOptions(["--platform", "aws", "--destination=https://b.example/hook?a=b", "--force"]), {
    platform: "aws",
    destination: "https://b.example/hook?a=b",
    force: true,
  });
});

test("parseOptions rejects unknown options and missing values", () => {
  assert.throws(() => parseOptions(["--fiel", "x.yml"]), /unknown option: --fiel/);
  assert.throws(() => parseOptions(["--file", "--delete-secrets"]), /--file needs a value/);
  assert.throws(() => parseOptions(["--force=yes"]), /doesn't take a value/);
});

test("Kafka mode signs completions with a named secret that outlives the stack", () => {
  const file = parseInletFile(kafkaFile);
  const template = awsTemplate(file, arns(awsSecretNames(file))) as { Resources: Record<string, any> };
  assert.equal(template.Resources.CompletionSecret, undefined, "not a stack resource, so destroy keeps it");
  assert.match(
    template.Resources.DeliveryFunction.Properties.Environment.Variables.INLET_COMPLETION_SECRET_REF,
    /^aws-secrets:arn:aws:secretsmanager:.*:secret:inlet-hooks-completion-key-/,
  );
});

test("deploy names fit AWS and Cloudflare limits", () => {
  assert.throws(() => parseInletFile(sqsFile.replace("name: inlet-github", `name: a${"b".repeat(54)}`)), /at most 54/);
  assert.throws(() => parseInletFile(sqsFile.replace("name: inlet-github", "name: inlet-")), /can't end with a hyphen/);
  assert.throws(
    () => parseInletFile(sqsFile.replace("aws-secrets:inlet-github-webhook-secret", "\"aws-secrets:\"")),
    /set secret_ref to aws-secrets/,
  );
});

test("deploy config checks verification secrets too, and the Lambda environment size", () => {
  const whatsapp = sqsFile
    .replace("provider: github", "provider: whatsapp")
    .replace("    destination:", "    verification_secret_ref: env:VERIFY\n    destination:");
  assert.throws(() => parseInletFile(whatsapp), /set verification_secret_ref to aws-secrets/);

  const big = parseInletFile(sqsFile);
  big.runtimeYaml += `# ${"x".repeat(5000)}\n`;
  assert.throws(() => awsTemplate(big, arns(awsSecretNames(big))), /over Lambda's 4 KB limit/);
});

test("init with every option writes a file deploy can read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "inlet-init-"));
  const path = join(dir, "inlet.yml");
  await init({
    file: path,
    platform: "aws",
    delivery: "kafka",
    provider: "shopify",
    name: "inlet-shop",
    path: "/webhooks/shopify/main",
    destination: "https://backend.example.com/shopify",
    "aquifer-url": "https://aquifer.example.com",
    region: "us-east-2",
    "kafka-brokers": "broker.example.com:9093",
    "kafka-sasl": "scram-sha-256",
    "kafka-secret": "shop-kafka",
  });
  const file = parseInletFile(await readFile(path, "utf8"));
  assert.equal(file.config.delivery, "kafka");
  assert.equal(file.config.routes[0]?.secretRef, "aws-secrets:inlet-shop-webhook-secret");
  assert.deepEqual(file.deploy.kafka, {
    brokers: ["broker.example.com:9093"],
    saslMechanism: "scram-sha-256",
    credentialsSecret: "shop-kafka",
    partitions: 6,
  });
  await assert.rejects(init({ file: path }), /already exists/);
});
