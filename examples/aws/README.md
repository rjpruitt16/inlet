# Deploy Inlet On AWS

The recommended shape is one stack per webhook provider. Each stack has two Lambda functions built from the same Dockerfile, one SQS FIFO queue, and one dead-letter queue:

```text
provider -> API Gateway -> intake Lambda -> SQS FIFO -> delivery Lambda -> Aquifer
```

The split keeps provider acknowledgement fast while the delivery Lambda waits for Aquifer confirmation and retries. Separate provider stacks isolate signing secrets, queue pressure, concurrency, and failures.

## Prerequisites

- Docker
- AWS CLI credentials for the target account
- AWS SAM CLI
- A provider signing secret in AWS Secrets Manager
- Network access from both Lambdas to `AquiferUrl`

Need a small Aquifer instance for evaluation first? The [Aquifer AWS quick start](https://github.com/rjpruitt16/aquifer/tree/main/examples/aws) installs the latest verified release on a CIDR-restricted one-vCPU EC2 test node. Its public endpoint is plain HTTP for narrow testing; it is not a production Aquifer topology.

## Deploy A Provider

From the repository root:

```bash
sam build --template-file examples/aws/template.image.yaml
sam deploy --guided --resolve-image-repos
```

SAM builds the root Lambda `Dockerfile`, creates and manages the ECR repositories, and prompts for:

- `AquiferUrl`, such as `https://aquifer.internal.example`
- `Provider`: `github`, `shopify`, `stripe`, or `anthropic`
- `RouteId`, such as `github-main`
- `RoutePath`, such as `/webhooks/github/main`
- `Destination`, the trusted backend URL Aquifer should call
- `WebhookSecretArn`, the provider signing secret ARN

Use a provider-specific stack name such as `inlet-github`. After deployment, append `RoutePath` to the `WebhookBaseUrl` output and configure that URL at the provider.

Repeat the deployment with a different stack name and secret for each provider. SAM remembers guided values in `samconfig.toml`; do not commit environment-specific secrets or account details.

The checked-in SAM template is the deployment contract. An AWS MCP server can help a coding agent inspect CloudFormation failures, IAM policy errors, and Lambda logs in your account, but deploying Inlet does not depend on an MCP server.

## Networking

The template does not impose a VPC. If Aquifer is private, add the appropriate Lambda `VpcConfig` and security-group rules, or route through a tightly controlled gateway. Do not make Aquifer a public caller-controlled relay just to make networking easier.

## Multi-Route Alternative

[`template.yaml`](template.yaml) is the existing zip-based template. It accepts the complete `INLET_CONFIG` YAML and can host multiple provider routes in one deployment. Use it when fewer stacks matter more than provider-level isolation.
