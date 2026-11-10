#!/usr/bin/env bash
set -u

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
STATE_FILE=${1:-}

for command_name in curl flyctl jq npx; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "$command_name is required" >&2
    exit 1
  fi
done

if [ -z "$STATE_FILE" ] || [ ! -f "$STATE_FILE" ]; then
  echo "usage: $0 path/to/state.json" >&2
  exit 1
fi
STATE_FILE=$(cd -- "$(dirname -- "$STATE_FILE")" && pwd)/$(basename -- "$STATE_FILE")
STATE_DIR=$(dirname -- "$STATE_FILE")
if ! jq -e '.resource_prefix and .aquifer_app and .connector_app and .worker_name' \
  "$STATE_FILE" >/dev/null; then
  echo "invalid quick-start state file" >&2
  exit 1
fi
# Cleanup removes STATE_DIR, so it must be this run's own directory.
RESOURCE_PREFIX=$(jq -r '.resource_prefix' "$STATE_FILE")
if [ "$STATE_DIR" != "$ROOT_DIR/.inlet-quickstart/$RESOURCE_PREFIX" ] || \
  [ "$(basename -- "$STATE_FILE")" != "state.json" ]; then
  echo "state file must be $ROOT_DIR/.inlet-quickstart/$RESOURCE_PREFIX/state.json" >&2
  exit 1
fi

AQUIFER_APP=$(jq -r '.aquifer_app // empty' "$STATE_FILE")
CONNECTOR_APP=$(jq -r '.connector_app // empty' "$STATE_FILE")
WORKER_NAME=$(jq -r '.worker_name // empty' "$STATE_FILE")
TUNNEL_ID=$(jq -r '.tunnel_id // empty' "$STATE_FILE")
VPC_SERVICE_ID=$(jq -r '.vpc_service_id // empty' "$STATE_FILE")
WRANGLER_CONFIG=$(jq -r '.wrangler_config // empty' "$STATE_FILE")
CONNECTOR_CONFIG=$(jq -r '.connector_config // empty' "$STATE_FILE")
AQUIFER_OWNED=$(jq -r '.aquifer_owned // false' "$STATE_FILE")
CONNECTOR_OWNED=$(jq -r '.connector_owned // false' "$STATE_FILE")
WORKER_OWNED=$(jq -r '.worker_owned // false' "$STATE_FILE")
TUNNEL_OWNED=$(jq -r '.tunnel_owned // false' "$STATE_FILE")
VPC_SERVICE_OWNED=$(jq -r '.vpc_service_owned // false' "$STATE_FILE")
FAILED=0

# Runs one cleanup step. On success it marks the resource no longer owned in
# the state file, so a rerun after a partial cleanup skips what's gone.
run_cleanup() {
  local owned_key=$1
  shift
  if ! "$@"; then
    FAILED=1
    return
  fi
  local updated
  if ! updated=$(jq --arg key "$owned_key" '.[$key] = false' "$STATE_FILE") || \
    ! printf '%s\n' "$updated" > "$STATE_FILE.tmp" || \
    ! mv "$STATE_FILE.tmp" "$STATE_FILE"; then
    echo "could not record $owned_key=false in $STATE_FILE" >&2
    FAILED=1
  fi
}

# Destroys a Fly app only when this token can see it. An app it can't see
# may still exist (a token without access gets the same "Could not find
# App" as a deleted app), so the state file is kept for a manual check.
destroy_fly_app() {
  local owned_key=$1 app=$2 apps
  if ! apps=$(flyctl apps list --json 2>/dev/null); then
    echo "could not list Fly apps to check $app" >&2
    FAILED=1
    return
  fi
  if jq -e --arg app "$app" 'any(.[]; (.Name // .name // .ID) == $app)' <<<"$apps" >/dev/null; then
    run_cleanup "$owned_key" flyctl apps destroy "$app" --yes
    return
  fi
  echo "Fly app $app is not visible to this token. If it is already deleted, set $owned_key to false in the state file and rerun." >&2
  FAILED=1
}

if [ "$WORKER_OWNED" = "true" ] && [ -n "$WORKER_NAME" ]; then
  run_cleanup worker_owned npx --yes wrangler@latest delete "$WORKER_NAME" --force
fi
if [ "$VPC_SERVICE_OWNED" = "true" ] && [ -n "$VPC_SERVICE_ID" ]; then
  run_cleanup vpc_service_owned npx --yes wrangler@latest vpc service delete "$VPC_SERVICE_ID"
fi
if [ "$CONNECTOR_OWNED" = "true" ] && [ -n "$CONNECTOR_APP" ]; then
  destroy_fly_app connector_owned "$CONNECTOR_APP"
fi
if [ "$TUNNEL_OWNED" = "true" ] && [ -n "$TUNNEL_ID" ]; then
  if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ] || [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    echo "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required to delete the tunnel" >&2
    FAILED=1
  else
    run_cleanup tunnel_owned curl --fail-with-body --silent --show-error \
      "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID?cascade=true" \
      --request DELETE \
      --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      --output /dev/null
  fi
fi
if [ "$AQUIFER_OWNED" = "true" ] && [ -n "$AQUIFER_APP" ]; then
  destroy_fly_app aquifer_owned "$AQUIFER_APP"
fi

if [ "$FAILED" -eq 0 ]; then
  rm -rf "$STATE_DIR"
  printf 'Removed quick-start resources recorded in %s\n' "$STATE_FILE"
else
  printf 'Cleanup was incomplete. State remains at %s\n' "$STATE_FILE" >&2
fi

exit "$FAILED"
