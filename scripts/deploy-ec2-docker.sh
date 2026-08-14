#!/usr/bin/env bash
set -Eeuo pipefail

: "${IMAGE_REF:?IMAGE_REF is required}"
: "${CONTAINER_NAME:?CONTAINER_NAME is required}"
: "${ENV_FILE:?ENV_FILE is required}"

CONTAINER_PORT="${CONTAINER_PORT:-3001}"
HOST_PORT="${HOST_PORT:-3001}"
BIND_ADDRESS="${BIND_ADDRESS:-0.0.0.0}"
HEALTHCHECK_PATH="${HEALTHCHECK_PATH:-/api/auth/status}"
HEALTHCHECK_TIMEOUT_SECONDS="${HEALTHCHECK_TIMEOUT_SECONDS:-60}"
PREVIOUS_CONTAINER="${CONTAINER_NAME}-previous"

if docker info >/dev/null 2>&1; then
    DOCKER=(docker)
elif command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
    DOCKER=(sudo -n docker)
else
    echo "Docker is not available for this user. Add the deploy user to the docker group or allow passwordless sudo for docker." >&2
    exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
    echo "Env file does not exist: $ENV_FILE" >&2
    exit 1
fi

if [ -n "${GHCR_TOKEN:-}" ]; then
    : "${GHCR_USER:?GHCR_USER is required when GHCR_TOKEN is set}"
    printf '%s\n' "$GHCR_TOKEN" | "${DOCKER[@]}" login ghcr.io -u "$GHCR_USER" --password-stdin >/dev/null
fi

"${DOCKER[@]}" pull "$IMAGE_REF"
"${DOCKER[@]}" rm -f "$PREVIOUS_CONTAINER" >/dev/null 2>&1 || true

had_previous=0
if "${DOCKER[@]}" container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
    had_previous=1
    "${DOCKER[@]}" rename "$CONTAINER_NAME" "$PREVIOUS_CONTAINER"
    "${DOCKER[@]}" stop "$PREVIOUS_CONTAINER" >/dev/null
fi

rollback() {
    local exit_code=$?

    if [ "$exit_code" -eq 0 ]; then
        return
    fi

    echo "Deployment failed. Rolling back to the previous container if available." >&2
    "${DOCKER[@]}" logs --tail 120 "$CONTAINER_NAME" >&2 || true
    "${DOCKER[@]}" rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

    if [ "$had_previous" -eq 1 ] && "${DOCKER[@]}" container inspect "$PREVIOUS_CONTAINER" >/dev/null 2>&1; then
        "${DOCKER[@]}" rename "$PREVIOUS_CONTAINER" "$CONTAINER_NAME" || true
        "${DOCKER[@]}" start "$CONTAINER_NAME" >/dev/null || true
    fi

    exit "$exit_code"
}

trap rollback EXIT

"${DOCKER[@]}" run -d \
    --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    --env-file "$ENV_FILE" \
    -p "${BIND_ADDRESS}:${HOST_PORT}:${CONTAINER_PORT}" \
    "$IMAGE_REF" >/dev/null

host_health_url="http://127.0.0.1:${HOST_PORT}${HEALTHCHECK_PATH}"
container_health_url="http://127.0.0.1:${CONTAINER_PORT}${HEALTHCHECK_PATH}"
deadline=$((SECONDS + HEALTHCHECK_TIMEOUT_SECONDS))

check_health() {
    if command -v curl >/dev/null 2>&1; then
        curl -fsS --max-time 2 "$host_health_url" >/dev/null
        return
    fi

    "${DOCKER[@]}" exec "$CONTAINER_NAME" node -e \
        'fetch(process.argv[1]).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))' \
        "$container_health_url"
}

until check_health; do
    if [ "$SECONDS" -ge "$deadline" ]; then
        echo "Healthcheck failed: $host_health_url" >&2
        exit 1
    fi

    sleep 2
done

trap - EXIT

if [ "$had_previous" -eq 1 ]; then
    "${DOCKER[@]}" rm "$PREVIOUS_CONTAINER" >/dev/null
fi

"${DOCKER[@]}" image prune -f --filter "until=168h" >/dev/null || true

if [ -n "${GHCR_TOKEN:-}" ]; then
    "${DOCKER[@]}" logout ghcr.io >/dev/null 2>&1 || true
fi

echo "Deployment finished: $IMAGE_REF"
