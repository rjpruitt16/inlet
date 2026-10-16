#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
RESOURCE_PREFIX=${RESOURCE_PREFIX:-inlet-cf-$(date +%Y%m%d%H%M%S)-$RANDOM}
FLY_ORG=${FLY_ORG:-}
FLY_REGION=${FLY_REGION:-iad}
VM_MEMORY_MB=${VM_MEMORY_MB:-256}
AQUIFER_VERSION=${AQUIFER_VERSION:-source}
AQUIFER_APP=${AQUIFER_APP:-aq-${RESOURCE_PREFIX#inlet-cf-}}
CONNECTOR_APP=${CONNECTOR_APP:-cf-${RESOURCE_PREFIX#inlet-cf-}}
WORKER_NAME=${WORKER_NAME:-$RESOURCE_PREFIX}
TUNNEL_NAME=${TUNNEL_NAME:-$RESOURCE_PREFIX}
VPC_SERVICE_NAME=${VPC_SERVICE_NAME:-aquifer-${RESOURCE_PREFIX#inlet-cf-}}
WEBHOOK_DESTINATION=${WEBHOOK_DESTINATION:-}
STATE_DIR="$ROOT_DIR/.inlet-quickstart/$RESOURCE_PREFIX"
STATE_FILE="$STATE_DIR/state.json"
WRANGLER_CONFIG="$STATE_DIR/wrangler.jsonc"
CONNECTOR_CONFIG="$STATE_DIR/fly.connector.toml"

if ! [[ "$RESOURCE_PREFIX" =~ ^[a-z0-9][a-z0-9-]{2,50}$ ]]; then
  echo "RESOURCE_PREFIX must contain 3-51 lowercase letters, numbers, or hyphens" >&2
  exit 1
fi

for variable_name in \
  CLOUDFLARE_ACCOUNT_ID \
  CLOUDFLARE_API_TOKEN \
  FLY_ORG \
  GITHUB_WEBHOOK_SECRET \
  WEBHOOK_DESTINATION; do
  if [ -z "${!variable_name:-}" ]; then
    echo "$variable_name is required" >&2
    exit 1
  fi
done
case "$WEBHOOK_DESTINATION" in
  http://*|https://*) ;;
  *)
    echo "WEBHOOK_DESTINATION must be an absolute HTTP or HTTPS URL" >&2
    exit 1
    ;;
esac

for command_name in curl flyctl git jq npm npx openssl; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "$command_name is required" >&2
    exit 1
  fi
done

flyctl auth whoami >/dev/null
npx --yes wrangler@latest whoami >/dev/null

if flyctl status --app "$AQUIFER_APP" >/dev/null 2>&1; then
  echo "refusing to manage existing Fly app: $AQUIFER_APP" >&2
  exit 1
fi
if flyctl status --app "$CONNECTOR_APP" >/dev/null 2>&1; then
  echo "refusing to manage existing Fly app: $CONNECTOR_APP" >&2
  exit 1
fi

mkdir -p "$STATE_DIR"

TUNNEL_ID=""
VPC_SERVICE_ID=""
WORKER_URL=""
AQUIFER_OWNED=false
CONNECTOR_OWNED=false
WORKER_OWNED=false
TUNNEL_OWNED=false
VPC_SERVICE_OWNED=false

save_state() {
  jq -n \
    --arg resource_prefix "$RESOURCE_PREFIX" \
    --arg aquifer_app "$AQUIFER_APP" \
    --arg connector_app "$CONNECTOR_APP" \
    --arg worker_name "$WORKER_NAME" \
    --arg worker_url "$WORKER_URL" \
    --arg tunnel_name "$TUNNEL_NAME" \
    --arg tunnel_id "$TUNNEL_ID" \
    --arg vpc_service_name "$VPC_SERVICE_NAME" \
    --arg vpc_service_id "$VPC_SERVICE_ID" \
    --arg wrangler_config "$WRANGLER_CONFIG" \
    --arg connector_config "$CONNECTOR_CONFIG" \
    --argjson aquifer_owned "$AQUIFER_OWNED" \
    --argjson connector_owned "$CONNECTOR_OWNED" \
    --argjson worker_owned "$WORKER_OWNED" \
    --argjson tunnel_owned "$TUNNEL_OWNED" \
    --argjson vpc_service_owned "$VPC_SERVICE_OWNED" \
    '{
      resource_prefix: $resource_prefix,
      aquifer_app: $aquifer_app,
      connector_app: $connector_app,
      worker_name: $worker_name,
      worker_url: $worker_url,
      tunnel_name: $tunnel_name,
      tunnel_id: $tunnel_id,
      vpc_service_name: $vpc_service_name,
      vpc_service_id: $vpc_service_id,
      wrangler_config: $wrangler_config,
      connector_config: $connector_config,
      aquifer_owned: $aquifer_owned,
      connector_owned: $connector_owned,
      worker_owned: $worker_owned,
      tunnel_owned: $tunnel_owned,
      vpc_service_owned: $vpc_service_owned
    }' > "$STATE_FILE"
}

show_cleanup_on_error() {
  local status=$?
  save_state
  printf '\nDeployment stopped. Remove only this run with:\n' >&2
  printf '  %q %q\n' "$ROOT_DIR/examples/cloudflare-fly/destroy-quickstart.sh" "$STATE_FILE" >&2
  exit "$status"
}
trap show_cleanup_on_error ERR
save_state

if [ -n "${AQUIFER_DIR:-}" ]; then
  AQUIFER_SOURCE=$AQUIFER_DIR
elif [ -x "$ROOT_DIR/../aquifer/examples/fly/deploy-quickstart.sh" ]; then
  AQUIFER_SOURCE="$ROOT_DIR/../aquifer"
else
  AQUIFER_SOURCE="$STATE_DIR/aquifer"
  git clone --depth 1 https://github.com/rjpruitt16/aquifer.git "$AQUIFER_SOURCE"
fi

AQUIFER_OWNED=true
save_state
APP_NAME="$AQUIFER_APP" \
FLY_ORG="$FLY_ORG" \
FLY_REGION="$FLY_REGION" \
VM_MEMORY_MB="$VM_MEMORY_MB" \
AQUIFER_VERSION="$AQUIFER_VERSION" \
"$AQUIFER_SOURCE/examples/fly/deploy-quickstart.sh"

TUNNEL_SECRET=$(openssl rand -base64 32)
TUNNEL_RESPONSE=$(curl --fail-with-body --silent --show-error \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel" \
  --request POST \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --header "Content-Type: application/json" \
  --data "$(jq -n --arg name "$TUNNEL_NAME" --arg secret "$TUNNEL_SECRET" \
    '{name: $name, config_src: "cloudflare", tunnel_secret: $secret}')")
TUNNEL_ID=$(jq -er '.result.id' <<<"$TUNNEL_RESPONSE")
TUNNEL_OWNED=true
save_state

TUNNEL_TOKEN_RESPONSE=$(curl --fail-with-body --silent --show-error \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/token" \
  --request GET \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN")
TUNNEL_TOKEN=$(jq -er '.result' <<<"$TUNNEL_TOKEN_RESPONSE")

cat > "$CONNECTOR_CONFIG" <<EOF
app = "$CONNECTOR_APP"
primary_region = "$FLY_REGION"

[processes]
  app = "tunnel --no-autoupdate run"

[[vm]]
  memory = "256mb"
  cpu_kind = "shared"
  cpus = 1
EOF

flyctl apps create "$CONNECTOR_APP" --org "$FLY_ORG" --yes
CONNECTOR_OWNED=true
save_state
printf 'TUNNEL_TOKEN=%s\n' "$TUNNEL_TOKEN" | \
  flyctl secrets import --app "$CONNECTOR_APP" --stage
flyctl deploy \
  --app "$CONNECTOR_APP" \
  --config "$CONNECTOR_CONFIG" \
  --image cloudflare/cloudflared:latest \
  --no-public-ips \
  --ha=false \
  --yes

for _ in $(seq 1 30); do
  TUNNEL_STATUS_RESPONSE=$(curl --fail-with-body --silent --show-error \
    "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID" \
    --request GET \
    --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN")
  if [ "$(jq -r '.result.status' <<<"$TUNNEL_STATUS_RESPONSE")" = "healthy" ]; then
    break
  fi
  sleep 2
done
if [ "$(jq -r '.result.status' <<<"$TUNNEL_STATUS_RESPONSE")" != "healthy" ]; then
  echo "Cloudflare tunnel did not become healthy" >&2
  exit 1
fi

if ! VPC_OUTPUT=$(npx --yes wrangler@latest vpc service create "$VPC_SERVICE_NAME" \
  --type http \
  --tunnel-id "$TUNNEL_ID" \
  --hostname "$AQUIFER_APP.flycast" \
  --http-port 80 2>&1); then
  printf '%s\n' "$VPC_OUTPUT" >&2
  false
fi
printf '%s\n' "$VPC_OUTPUT"
VPC_SERVICE_ID=$(sed -nE \
  's/.*Created VPC service: ([0-9a-f-]{36}).*/\1/p' <<<"$VPC_OUTPUT" | tail -n 1)
if [ -z "$VPC_SERVICE_ID" ]; then
  echo "could not read the VPC service ID from Wrangler output" >&2
  exit 1
fi
VPC_SERVICE_OWNED=true
save_state

DESTINATION_YAML=$(jq -Rn --arg value "$WEBHOOK_DESTINATION" '$value')
INLET_CONFIG=$(printf 'aquifer_url: http://%s.flycast\nroutes:\n  - id: github-main\n    path: /webhooks/github/main\n    provider: github\n    secret_ref: GITHUB_WEBHOOK_SECRET\n    destination: %s\n' \
  "$AQUIFER_APP" "$DESTINATION_YAML")
jq -n \
  --arg name "$WORKER_NAME" \
  --arg inlet_config "$INLET_CONFIG" \
  --arg service_id "$VPC_SERVICE_ID" \
  '{
    "$schema": "node_modules/wrangler/config-schema.json",
    name: $name,
    main: "../../dist/src/runtimes/cloudflare/runtime.js",
    compatibility_date: "2026-10-16",
    workers_dev: false,
    vars: {
      INLET_AQUIFER_TIMEOUT_MS: "5000",
      INLET_CONFIG: $inlet_config
    },
    durable_objects: {
      bindings: [{name: "INLET_ORDERING", class_name: "InletQueueObject"}]
    },
    migrations: [{tag: "v1", new_sqlite_classes: ["InletQueueObject"]}],
    vpc_services: [{binding: "INLET_AQUIFER", service_id: $service_id}]
  }' > "$WRANGLER_CONFIG"

npm ci --prefix "$ROOT_DIR"
npm run build --prefix "$ROOT_DIR"
WORKER_OWNED=true
save_state
if ! DEPLOY_OUTPUT=$(npx --yes wrangler@latest deploy --config "$WRANGLER_CONFIG" 2>&1); then
  printf '%s\n' "$DEPLOY_OUTPUT" >&2
  false
fi
printf '%s\n' "$DEPLOY_OUTPUT"
printf '%s' "$GITHUB_WEBHOOK_SECRET" | \
  npx --yes wrangler@latest secret put GITHUB_WEBHOOK_SECRET --config "$WRANGLER_CONFIG"

WORKER_SUBDOMAIN_RESPONSE=$(curl --fail-with-body --silent --show-error \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME/subdomain" \
  --request POST \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{"enabled":true}')
jq -e '.success == true' <<<"$WORKER_SUBDOMAIN_RESPONSE" >/dev/null
ACCOUNT_SUBDOMAIN_RESPONSE=$(curl --fail-with-body --silent --show-error \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain" \
  --request GET \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN")
ACCOUNT_SUBDOMAIN=$(jq -er '.result.subdomain' <<<"$ACCOUNT_SUBDOMAIN_RESPONSE")
WORKER_URL="https://$WORKER_NAME.$ACCOUNT_SUBDOMAIN.workers.dev"
save_state

trap - ERR
printf '\nCloudflare-to-Fly quick start is ready.\n'
printf 'Worker: %s\n' "${WORKER_URL:-$WORKER_NAME}"
printf 'Aquifer: http://%s.flycast (private)\n' "$AQUIFER_APP"
printf 'State: %s\n' "$STATE_FILE"
printf '\nRemove only these resources with:\n'
printf '  %q %q\n' "$ROOT_DIR/examples/cloudflare-fly/destroy-quickstart.sh" "$STATE_FILE"
