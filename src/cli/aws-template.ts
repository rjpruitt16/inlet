import { topicsFor } from "../core/kafka/records.js";
import type { InletFile } from "./deploy-config.js";

/** The handler names inside the bundle (index.js), from src/runtimes/aws. */
export const handlers = {
  http: "index.httpHandler",
  queue: "index.queueHandler",
  kafka: "index.kafkaHandler",
  reconcile: "index.reconcileHandler",
} as const;

export interface AwsFunctionNames {
  http: string;
  delivery: string;
  reconcile?: string;
}

export function functionNames(file: InletFile): AwsFunctionNames {
  const names: AwsFunctionNames = { http: `${file.deploy.name}-http`, delivery: `${file.deploy.name}-delivery` };
  if (file.config.delivery === "kafka") names.reconcile = `${file.deploy.name}-reconcile`;
  return names;
}

/**
 * Functions start with this placeholder so CloudFormation needs no S3
 * bucket; inlet deploy then uploads the real bundle with UpdateFunctionCode.
 * It answers 503 so a provider retries anything sent in between.
 */
const placeholder = [
  'const unavailable = async () => ({ statusCode: 503, body: "inlet is deploying" });',
  "exports.httpHandler = unavailable;",
  'exports.queueHandler = async () => { throw new Error("inlet is deploying"); };',
  "exports.kafkaHandler = exports.queueHandler;",
  "exports.reconcileHandler = async () => ({});",
].join("\n");

type Json = Record<string, unknown>;

/**
 * The CloudFormation template for one Inlet deployment.
 *
 * secretArns maps each Secrets Manager name in inlet.yml to its full ARN,
 * which the Kafka trigger and the IAM policy need.
 */
export function awsTemplate(file: InletFile, secretArns: ReadonlyMap<string, string>): Json {
  const kafka = file.config.delivery === "kafka";
  const names = functionNames(file);
  const resources: Json = {};
  const routeSecretArns = file.config.routes.flatMap((route) =>
    [route.secretRef, route.verificationSecretRef]
      .filter((ref): ref is string => ref !== undefined && ref.startsWith("aws-secrets:"))
      .map((ref) => requireArn(secretArns, ref.slice("aws-secrets:".length))),
  );

  const statements: Json[] = [
    {
      Effect: "Allow",
      Action: "secretsmanager:GetSecretValue",
      Resource: unique([
        ...routeSecretArns,
        ...(kafka ? [requireArn(secretArns, file.deploy.kafka!.credentialsSecret), { Ref: "CompletionSecret" }] : []),
      ]),
    },
  ];
  if (!kafka) {
    statements.push(
      {
        Effect: "Allow",
        Action: ["sqs:SendMessage"],
        Resource: [{ "Fn::GetAtt": ["Queue", "Arn"] }, { "Fn::GetAtt": ["DeadLetterQueue", "Arn"] }],
      },
      {
        Effect: "Allow",
        Action: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"],
        Resource: { "Fn::GetAtt": ["Queue", "Arn"] },
      },
    );
  }

  resources.Role = {
    Type: "AWS::IAM::Role",
    Properties: {
      AssumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
      },
      ManagedPolicyArns: [{ "Fn::Sub": "arn:${AWS::Partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" }],
      Policies: [{ PolicyName: "inlet", PolicyDocument: { Version: "2012-10-17", Statement: statements } }],
    },
  };

  const sharedEnv: Json = { INLET_CONFIG: file.runtimeYaml };
  if (kafka) {
    const settings = file.deploy.kafka!;
    Object.assign(sharedEnv, {
      INLET_KAFKA_BROKERS: settings.brokers.join(","),
      INLET_KAFKA_SASL_MECHANISM: settings.saslMechanism,
      INLET_KAFKA_SECRET_REF: `aws-secrets:${requireArn(secretArns, settings.credentialsSecret)}`,
      INLET_COMPLETION_SECRET_REF: { "Fn::Sub": "aws-secrets:${CompletionSecret}" },
    });
    resources.CompletionSecret = {
      Type: "AWS::SecretsManager::Secret",
      Properties: {
        Description: `Signs Inlet completion URLs for ${file.deploy.name}`,
        GenerateSecretString: { PasswordLength: 48, ExcludePunctuation: true },
      },
    };
  } else {
    Object.assign(sharedEnv, { INLET_QUEUE_URL: { Ref: "Queue" }, INLET_DLQ_URL: { Ref: "DeadLetterQueue" } });
    resources.DeadLetterQueue = {
      Type: "AWS::SQS::Queue",
      Properties: { QueueName: `${file.deploy.name}-dead-letter.fifo`, FifoQueue: true, MessageRetentionPeriod: 1_209_600 },
    };
    resources.Queue = {
      Type: "AWS::SQS::Queue",
      Properties: {
        QueueName: `${file.deploy.name}.fifo`,
        FifoQueue: true,
        VisibilityTimeout: 180,
        MessageRetentionPeriod: 1_209_600,
      },
    };
  }

  addFunction(resources, "HttpFunction", names.http, handlers.http, 30, sharedEnv);
  addFunction(
    resources,
    "DeliveryFunction",
    names.delivery,
    kafka ? handlers.kafka : handlers.queue,
    kafka ? 300 : 30,
    kafka ? { ...sharedEnv, INLET_PUBLIC_URL: { "Fn::GetAtt": ["Api", "ApiEndpoint"] } } : sharedEnv,
  );

  // Quick-create HTTP API: one $default route, all methods, auto-deployed.
  resources.Api = {
    Type: "AWS::ApiGatewayV2::Api",
    Properties: {
      Name: file.deploy.name,
      ProtocolType: "HTTP",
      Target: { "Fn::GetAtt": ["HttpFunction", "Arn"] },
    },
  };
  resources.ApiPermission = {
    Type: "AWS::Lambda::Permission",
    Properties: {
      Action: "lambda:InvokeFunction",
      FunctionName: { Ref: "HttpFunction" },
      Principal: "apigateway.amazonaws.com",
      SourceArn: { "Fn::Sub": "arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${Api}/*" },
    },
  };

  if (kafka) {
    const settings = file.deploy.kafka!;
    const accessType = { "scram-sha-512": "SASL_SCRAM_512_AUTH", "scram-sha-256": "SASL_SCRAM_256_AUTH", plain: "BASIC_AUTH" }[
      settings.saslMechanism
    ];
    // Lambda's Kafka trigger takes one topic, so one trigger per events topic.
    eventsTopics(file).forEach((topic, index) => {
      resources[`KafkaTrigger${index}`] = {
        Type: "AWS::Lambda::EventSourceMapping",
        Properties: {
          FunctionName: { Ref: "DeliveryFunction" },
          Topics: [topic],
          SelfManagedEventSource: { Endpoints: { KafkaBootstrapServers: settings.brokers } },
          SourceAccessConfigurations: [{ Type: accessType, URI: requireArn(secretArns, settings.credentialsSecret) }],
          SelfManagedKafkaEventSourceConfig: { ConsumerGroupId: `${file.deploy.name}-delivery` },
          StartingPosition: "TRIM_HORIZON",
          BatchSize: 100,
        },
      };
    });
    addFunction(resources, "ReconcileFunction", names.reconcile!, handlers.reconcile, 240, {
      ...sharedEnv,
      INLET_KAFKA_RECONCILER_GROUP: `${file.deploy.name}-reconciler`,
    });
    // Named, so the invoke permission can name it and be created first;
    // otherwise the rule's first firing races the permission and fails.
    const ruleName = `${file.deploy.name}-reconcile`;
    resources.ReconcileSchedule = {
      Type: "AWS::Events::Rule",
      DependsOn: ["ReconcilePermission"],
      Properties: {
        Name: ruleName,
        ScheduleExpression: "rate(5 minutes)",
        Targets: [{ Arn: { "Fn::GetAtt": ["ReconcileFunction", "Arn"] }, Id: "reconcile" }],
      },
    };
    resources.ReconcilePermission = {
      Type: "AWS::Lambda::Permission",
      Properties: {
        Action: "lambda:InvokeFunction",
        FunctionName: { Ref: "ReconcileFunction" },
        Principal: "events.amazonaws.com",
        SourceArn: { "Fn::Sub": `arn:\${AWS::Partition}:events:\${AWS::Region}:\${AWS::AccountId}:rule/${ruleName}` },
      },
    };
  } else {
    resources.QueueTrigger = {
      Type: "AWS::Lambda::EventSourceMapping",
      Properties: {
        FunctionName: { Ref: "DeliveryFunction" },
        EventSourceArn: { "Fn::GetAtt": ["Queue", "Arn"] },
        BatchSize: 10,
        FunctionResponseTypes: ["ReportBatchItemFailures"],
        ScalingConfig: { MaximumConcurrency: 10 },
      },
    };
  }

  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: `Inlet ${file.config.delivery === "kafka" ? "Kafka" : "SQS"} deployment ${file.deploy.name} (managed by inlet deploy)`,
    Resources: resources,
    Outputs: {
      WebhookBaseUrl: { Value: { "Fn::GetAtt": ["Api", "ApiEndpoint"] } },
    },
  };
}

export function eventsTopics(file: InletFile): string[] {
  if (file.config.delivery !== "kafka") return [];
  return unique(file.config.routes.map((route) => topicsFor(file.config, route).eventsTopic));
}

export function resultsTopics(file: InletFile): string[] {
  if (file.config.delivery !== "kafka") return [];
  return unique(file.config.routes.map((route) => topicsFor(file.config, route).resultsTopic));
}

function addFunction(
  resources: Json,
  logicalId: string,
  functionName: string,
  handler: string,
  timeout: number,
  environment: Json,
): void {
  // The stack owns each log group, so inlet destroy removes the logs too.
  resources[`${logicalId}Logs`] = {
    Type: "AWS::Logs::LogGroup",
    DeletionPolicy: "Delete",
    Properties: { LogGroupName: `/aws/lambda/${functionName}`, RetentionInDays: 14 },
  };
  resources[logicalId] = {
    Type: "AWS::Lambda::Function",
    DependsOn: [`${logicalId}Logs`],
    Properties: {
      FunctionName: functionName,
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
      MemorySize: 256,
      Timeout: timeout,
      Handler: handler,
      Role: { "Fn::GetAtt": ["Role", "Arn"] },
      Code: { ZipFile: placeholder },
      Environment: { Variables: environment },
    },
  };
}

function requireArn(arns: ReadonlyMap<string, string>, name: string): string {
  const arn = arns.get(name);
  if (arn === undefined) throw new Error(`no ARN resolved for secret ${name}`);
  return arn;
}

function unique<T>(values: T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
