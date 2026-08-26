#!/usr/bin/env bash
#
# OmniRoute — Blue/Green deployment with SQLite single-writer discipline.
#
#   /opt/omniroute/deploy.sh ghcr.io/<owner>/omniroute@sha256:<64-hex>
#   /opt/omniroute/deploy.sh --status
#   /opt/omniroute/deploy.sh --rollback
#
# Why this is NOT the textbook blue/green:
#   OmniRoute keeps all state in $DATA_DIR/storage.sqlite and has no leader
#   election, so two permanently-live slots would run two copies of every
#   background job (auto-backup, cleanup, quota monitor) against one file.
#   Instead both slots overlap only across warm-up + stabilization, then the
#   old slot is STOPPED. Steady state is always exactly one writer.
#
#   Consequence, on purpose: there is no hot standby to auto-fail-over to.
#   The safety net is that Caddy is not switched until the new slot proves
#   healthy, and is switched straight back if it degrades while the old slot
#   is still running.
#
set -Eeuo pipefail

APP_DIR="/opt/omniroute"
COMPOSE="$APP_DIR/compose.yml"
DEPLOY_ENV="$APP_DIR/.deploy.env"
STATE_DIR="$APP_DIR/state"
ACTIVE_FILE="$STATE_DIR/active_slot"
PREV_IMAGE_FILE="$STATE_DIR/previous_image"
CADDY_ROUTE="$APP_DIR/caddy/active.caddy"

APP_PORT="${APP_PORT:-20128}"
READY_TIMEOUT="${READY_TIMEOUT:-300}"   # cold boot runs migrations + catalog rebuild
STABILIZE_SECONDS="${STABILIZE_SECONDS:-30}"
DRAIN_SECONDS="${DRAIN_SECONDS:-15}"    # let in-flight SSE/WS finish before stopping old

dc() { docker compose --env-file "$APP_DIR/.app.env" --env-file "$DEPLOY_ENV" -f "$COMPOSE" "$@"; }

log() { printf '%s  %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

# shellcheck source=infra/image-retention.sh
source "$APP_DIR/image-retention.sh"

service_for_slot() {
    case "$1" in
        blue)  echo "app-blue"  ;;
        green) echo "app-green" ;;
        *)     return 1 ;;
    esac
}

other_slot() {
    case "$1" in
        blue)  echo "green" ;;
        green) echo "blue"  ;;
        *)     return 1 ;;
    esac
}

read_env_var() {
    # read_env_var KEY -> value ("" if absent). Avoids sourcing the file.
    local key="$1"
    [[ -f "$DEPLOY_ENV" ]] || return 0
    sed -n "s/^${key}=//p" "$DEPLOY_ENV" | tail -n1
}

write_env() {
    printf 'BLUE_IMAGE=%s\nGREEN_IMAGE=%s\n' "$1" "$2" > "$DEPLOY_ENV.tmp"
    mv "$DEPLOY_ENV.tmp" "$DEPLOY_ENV"
}

# ─────────────────────────────────────────────────────────────────────────────
#  --status
# ─────────────────────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--status" ]]; then
    echo "active slot   : $(cat "$ACTIVE_FILE" 2>/dev/null || echo none)"
    echo "BLUE_IMAGE    : $(read_env_var BLUE_IMAGE)"
    echo "GREEN_IMAGE   : $(read_env_var GREEN_IMAGE)"
    echo "previous image: $(cat "$PREV_IMAGE_FILE" 2>/dev/null || echo none)"
    echo
    # Before the first deployment there is no .deploy.env, and `docker compose`
    # refuses a missing --env-file. Report that state instead of erroring.
    if [[ -f "$DEPLOY_ENV" ]]; then
        dc ps
    else
        echo "(not deployed yet — $DEPLOY_ENV does not exist)"
    fi
    exit 0
fi

# ─────────────────────────────────────────────────────────────────────────────
#  --rollback : redeploy the image the current ACTIVE slot replaced
# ─────────────────────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--rollback" ]]; then
    [[ -s "$PREV_IMAGE_FILE" ]] || die "no previous image recorded — nothing to roll back to"
    NEW_IMAGE="$(cat "$PREV_IMAGE_FILE")"
    log "Rolling back to $NEW_IMAGE"
else
    NEW_IMAGE="${1:-}"
fi

[[ -n "$NEW_IMAGE" ]] || die "usage: deploy.sh <ghcr.io/owner/image@sha256:...> | --status | --rollback"

# Immutable digest only. A moving tag would make "what is running" unknowable
# and would silently change what a restart brings back up.
[[ "$NEW_IMAGE" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]] \
    || die "not an immutable GHCR digest reference: $NEW_IMAGE"

mkdir -p "$STATE_DIR"
cd "$APP_DIR"

# ─────────────────────────────────────────────────────────────────────────────
#  DEPLOY LOCK — one deployment at a time, or the slot bookkeeping races.
# ─────────────────────────────────────────────────────────────────────────────
exec 9>"$STATE_DIR/deploy.lock"
flock -n 9 || die "another deployment is already running"

# ─────────────────────────────────────────────────────────────────────────────
#  HEALTH GATES
# ─────────────────────────────────────────────────────────────────────────────

# Docker-level: the image's own HEALTHCHECK probes /healthz (in-memory only).
wait_container_healthy() {
    local service="$1" timeout="$2" elapsed=0 cid status
    while (( elapsed < timeout )); do
        cid="$(dc ps -q "$service" || true)"
        if [[ -n "$cid" ]]; then
            status="$(docker inspect \
                --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
                "$cid" 2>/dev/null || echo missing)"
            case "$status" in
                healthy)      log "  $service: healthy"; return 0 ;;
                exited|dead)  log "  $service: $status"; return 1 ;;
            esac
            if (( elapsed % 30 == 0 )); then
                log "  $service: $status (${elapsed}s/${timeout}s)"
            fi
        fi
        sleep 5
        elapsed=$((elapsed + 5))
    done
    log "  $service: timed out after ${timeout}s"
    return 1
}

# Application-level: /api/monitoring/health must report status:"healthy".
# Deeper than /healthz — it confirms SQLite answered and the subsystems booted,
# which is what actually decides whether this build may take traffic.
# Probed from inside the container (bun is already there; no curl dependency).
# The port arrives via the environment, never interpolated into the script body.
PROBE_JS='const p=process.env.PROBE_PORT||"20128";'\
'const t=setTimeout(()=>process.exit(1),8000);'\
'fetch(`http://127.0.0.1:${p}/api/monitoring/health`)'\
'.then(r=>r.json())'\
'.then(j=>{clearTimeout(t);process.exit(j&&j.status==="healthy"?0:1);})'\
'.catch(()=>{clearTimeout(t);process.exit(1);});'

probe_app_ready() {
    local service="$1"
    dc exec -T -e "PROBE_PORT=$APP_PORT" "$service" bun -e "$PROBE_JS" >/dev/null 2>&1
}

wait_app_ready() {
    local service="$1" timeout="$2" elapsed=0
    while (( elapsed < timeout )); do
        if probe_app_ready "$service"; then
            log "  $service: /api/monitoring/health -> healthy"
            return 0
        fi
        sleep 5
        elapsed=$((elapsed + 5))
    done
    log "  $service: never reported healthy within ${timeout}s"
    return 1
}

# ─────────────────────────────────────────────────────────────────────────────
#  CADDY ROUTE
#
#  Exactly ONE upstream, always. The generic blue/green plan lists the standby
#  as a second upstream for automatic failover; here the standby is stopped, so
#  a second entry would only add a dead backend for Caddy to probe.
# ─────────────────────────────────────────────────────────────────────────────
generate_caddy_route() {
    local slot="$1"
    local upstream stamp
    upstream="$(service_for_slot "$slot"):$APP_PORT"
    stamp="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

    {
        printf '# active=%s\n' "$slot"
        printf '# generated by deploy.sh at %s — do not hand-edit\n\n' "$stamp"
        printf 'reverse_proxy %s {\n' "$upstream"
        printf '\tlb_policy first\n\n'
        printf '\thealth_uri /healthz\n'
        printf '\thealth_interval 5s\n'
        printf '\thealth_timeout 2s\n'
        printf '\thealth_fails 2\n'
        printf '\thealth_passes 2\n\n'
        printf '\tlb_try_duration 5s\n\n'
        printf '\t# -1 disables response buffering: required for SSE\n'
        printf '\t# (/v1/chat/completions stream:true) and the live WebSocket.\n'
        printf '\tflush_interval -1\n'
        printf '\t# Caddy holds a streaming response open this long after its\n'
        printf '\t# upstream leaves the config. Must be >= the app-side budget\n'
        printf '\t# (SHUTDOWN_TIMEOUT_MS=120s) plus stop_grace_period (150s) in\n'
        printf '\t# compose.yml, or Caddy would cut a stream the old slot is\n'
        printf '\t# still perfectly willing to finish.\n'
        printf '\tstream_close_delay 5m\n\n'
        printf '\theader_up X-Real-IP {http.request.header.CF-Connecting-IP}\n'
        printf '\theader_up X-Forwarded-For {http.request.header.CF-Connecting-IP}\n'
        printf '\theader_up X-Forwarded-Proto https\n'
        printf '}\n'
    } > "$CADDY_ROUTE.next"

    mv "$CADDY_ROUTE.next" "$CADDY_ROUTE"
}

caddy_validate() {
    dc exec -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
}

caddy_reload() {
    dc exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
}

# ─────────────────────────────────────────────────────────────────────────────
#  CURRENT STATE
# ─────────────────────────────────────────────────────────────────────────────
BLUE_IMAGE="$(read_env_var BLUE_IMAGE)"
GREEN_IMAGE="$(read_env_var GREEN_IMAGE)"
ACTIVE="$(cat "$ACTIVE_FILE" 2>/dev/null || true)"

case "$ACTIVE" in
    blue|green) TARGET="$(other_slot "$ACTIVE")" ;;
    *)          TARGET="blue"; ACTIVE="" ;;
esac

TARGET_SERVICE="$(service_for_slot "$TARGET")"

log "=============================================="
log "OmniRoute deployment"
log "  active slot : ${ACTIVE:-none (bootstrap)}"
log "  target slot : $TARGET"
log "  new image   : $NEW_IMAGE"
log "=============================================="

OLD_BLUE="$BLUE_IMAGE"
OLD_GREEN="$GREEN_IMAGE"

if [[ "$TARGET" == "blue" ]]; then
    BLUE_IMAGE="$NEW_IMAGE"
else
    GREEN_IMAGE="$NEW_IMAGE"
fi

# Compose interpolates both variables even for a single-service `up`, so the
# idle slot needs a syntactically valid image reference on first run.
[[ -n "$BLUE_IMAGE"  ]] || BLUE_IMAGE="$NEW_IMAGE"
[[ -n "$GREEN_IMAGE" ]] || GREEN_IMAGE="$NEW_IMAGE"

write_env "$BLUE_IMAGE" "$GREEN_IMAGE"

restore_env_and_fail() {
    write_env "$OLD_BLUE" "$OLD_GREEN"
    die "$1"
}

# ─────────────────────────────────────────────────────────────────────────────
#  SUPPORTING SERVICES
#  Redis must be up before a slot boots so the rate limiter attaches to it.
# ─────────────────────────────────────────────────────────────────────────────
log "Ensuring redis is up..."
dc up -d redis
wait_container_healthy redis 60 || restore_env_and_fail "redis did not become healthy"

# ─────────────────────────────────────────────────────────────────────────────
#  START THE TARGET SLOT  (overlap window opens here)
# ─────────────────────────────────────────────────────────────────────────────
log "Pulling $NEW_IMAGE ..."
if ! dc pull "$TARGET_SERVICE"; then
    # A failed pull is not automatically fatal. This host holds no standing GHCR
    # credential: the deploy workflow lends it one for a single run and logs out
    # afterwards (prod-deploy.yml steps 2.3b / 2.6). Today that costs nothing,
    # because the package is public and pulls anonymously — but the moment it is
    # switched to private, an operator running `deploy.sh --rollback` by hand
    # over SSH would have no way to authenticate. They do not need one: the
    # rollback target is the image this box was running minutes ago, the stopped
    # slot still references it so `docker image prune` leaves it alone, and it is
    # right there on local disk.
    if docker image inspect "$NEW_IMAGE" >/dev/null 2>&1; then
        log "Pull failed, but $NEW_IMAGE is present locally — continuing with the local copy."
    else
        restore_env_and_fail "docker pull failed and $NEW_IMAGE is not on this host"
    fi
fi

log "Starting $TARGET_SERVICE ..."
dc up -d --no-deps "$TARGET_SERVICE" || restore_env_and_fail "failed to start $TARGET_SERVICE"

log "Waiting for $TARGET_SERVICE to become healthy (timeout ${READY_TIMEOUT}s)..."
if ! wait_container_healthy "$TARGET_SERVICE" "$READY_TIMEOUT" \
   || ! wait_app_ready "$TARGET_SERVICE" 60; then
    log "NEW VERSION FAILED ITS HEALTH GATE — traffic was never switched."
    dc logs --tail=200 "$TARGET_SERVICE" || true
    log "Stopping the failed slot to restore single-writer state..."
    dc stop "$TARGET_SERVICE" || true
    dc rm -f "$TARGET_SERVICE" || true
    if [[ -n "$ACTIVE" ]]; then
        restore_env_and_fail "deployment aborted; $ACTIVE keeps serving"
    else
        restore_env_and_fail "bootstrap aborted; nothing is serving"
    fi
fi

# ─────────────────────────────────────────────────────────────────────────────
#  BOOTSTRAP (no previous active slot)
# ─────────────────────────────────────────────────────────────────────────────
if [[ -z "$ACTIVE" ]]; then
    log "Bootstrap: pointing Caddy at $TARGET and starting the edge..."
    generate_caddy_route "$TARGET"
    dc pull caddy cloudflared
    dc up -d caddy cloudflared
    echo "$TARGET" > "$ACTIVE_FILE"
    log "=============================================="
    log "BOOTSTRAP SUCCESS — active=$TARGET"
    log "=============================================="
    exit 0
fi

# ─────────────────────────────────────────────────────────────────────────────
#  SWITCH TRAFFIC
# ─────────────────────────────────────────────────────────────────────────────
log "Preparing Caddy switch $ACTIVE -> $TARGET ..."
cp "$CADDY_ROUTE" "$CADDY_ROUTE.rollback"
generate_caddy_route "$TARGET"

# `caddy reload` below picks up Caddyfile edits, but nothing else re-reads the
# compose service definition — a change to ports, networks or extra_hosts would
# stay dormant until someone recreated the container by hand. `up -d` compares
# the config hash and is a no-op when the definition is unchanged, so this only
# costs an edge blip on the deploys that actually change it.
dc up -d caddy cloudflared

rollback_caddy() {
    mv "$CADDY_ROUTE.rollback" "$CADDY_ROUTE"
    caddy_reload || log "WARNING: Caddy reload during rollback failed — check 'docker compose logs caddy'"
}

if ! caddy_validate; then
    rollback_caddy
    restore_env_and_fail "Caddy config validation failed"
fi

if ! caddy_reload; then
    rollback_caddy
    restore_env_and_fail "Caddy reload failed"
fi

echo "$TARGET" > "$ACTIVE_FILE"
log "Traffic now on $TARGET."

# ─────────────────────────────────────────────────────────────────────────────
#  STABILIZATION — the old slot is still running, so rollback is still cheap.
# ─────────────────────────────────────────────────────────────────────────────
log "Stabilizing for ${STABILIZE_SECONDS}s..."
elapsed=0
while (( elapsed < STABILIZE_SECONDS )); do
    if ! probe_app_ready "$TARGET_SERVICE"; then
        log "New active slot degraded during stabilization — rolling traffic back to $ACTIVE."
        rollback_caddy
        echo "$ACTIVE" > "$ACTIVE_FILE"
        dc stop "$TARGET_SERVICE" || true
        restore_env_and_fail "rolled back to $ACTIVE"
    fi
    sleep 5
    elapsed=$((elapsed + 5))
done

rm -f "$CADDY_ROUTE.rollback"

# ─────────────────────────────────────────────────────────────────────────────
#  CLOSE THE OVERLAP — back to exactly one SQLite writer.
# ─────────────────────────────────────────────────────────────────────────────
OLD_SERVICE="$(service_for_slot "$ACTIVE")"
log "Draining ${DRAIN_SECONDS}s before stopping $OLD_SERVICE ..."
sleep "$DRAIN_SECONDS"

log "Stopping $OLD_SERVICE (single-writer discipline)..."
dc stop "$OLD_SERVICE" \
    || log "WARNING: could not stop $OLD_SERVICE — check it manually, two writers is not a safe steady state"

# Record what we replaced so --rollback has a target.
OLD_ACTIVE_IMAGE=""
if [[ "$ACTIVE" == "blue" ]]; then
    OLD_ACTIVE_IMAGE="$OLD_BLUE"
    echo "$OLD_ACTIVE_IMAGE" > "$PREV_IMAGE_FILE"
elif [[ "$ACTIVE" == "green" ]]; then
    OLD_ACTIVE_IMAGE="$OLD_GREEN"
    echo "$OLD_ACTIVE_IMAGE" > "$PREV_IMAGE_FILE"
fi

IMAGE_REPOSITORY="${NEW_IMAGE%@sha256:*}"
if [[ -n "$OLD_ACTIVE_IMAGE" && "$OLD_ACTIVE_IMAGE" != "$NEW_IMAGE" ]]; then
    prune_repository_images "$IMAGE_REPOSITORY" "$NEW_IMAGE" "$OLD_ACTIVE_IMAGE"
else
    prune_repository_images "$IMAGE_REPOSITORY" "$NEW_IMAGE"
fi

log "=============================================="
log "DEPLOYMENT SUCCESS"
log "  active  : $TARGET"
log "  stopped : $ACTIVE"
log "  image   : $NEW_IMAGE"
log "=============================================="
