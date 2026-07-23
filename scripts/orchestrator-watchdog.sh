#!/usr/bin/env bash
#
# orchestrator-watchdog.sh
# ------------------------
# Self-heals the Postiz Temporal worker when it silently stops posting.
#
# Why this exists:
#   The orchestrator runs a Temporal worker inside a long-lived NestJS process
#   that ALSO serves an HTTP health port. If the worker's pollers die (Temporal
#   restarted underneath it, a fatal worker error, a bad reconnect state) the
#   process stays alive and "healthy" while no posts leave the queue. Docker's
#   `restart: always` and pm2 only act on process EXIT, so nothing restarts it —
#   it can sit dead for days. The /health/status endpoint doesn't catch this
#   either: it only checks that Temporal is REACHABLE, not that the worker is
#   pulling jobs.
#
# What this does:
#   Measures the actual symptom instead of guessing at internals — "is any post
#   stuck in QUEUE past its publish time?". If so, the publisher is stalled, so
#   it restarts the orchestrator pm2 process and (optionally) pings Slack.
#
# Install (run on the Postiz host, e.g. as a Coolify Scheduled Task or cron,
# every ~10 min):
#   */10 * * * * /path/to/orchestrator-watchdog.sh >> /var/log/postiz-watchdog.log 2>&1
#
# Test without touching anything:
#   ./orchestrator-watchdog.sh --check
#
# Config (env vars — all optional, sensible auto-detection/defaults):
#   POSTIZ_CONTAINER   App container running ghcr.io/gitroomhq/postiz-app (auto-detected by image)
#   PG_CONTAINER       Postgres container (auto-detected: name matches postiz + postgres)
#   PG_USER            Postgres user   (default: postiz-user)
#   PG_DB              Postgres db     (default: postiz-db-local)
#   PM2_PROCESS        pm2 process name to restart (default: orchestrator)
#   STALE_MINUTES      How overdue a QUEUE post must be to count as stuck (default: 20)
#   SLACK_WEBHOOK_URL  If set, posts an alert on restart
#   DRY_RUN=1          Detect + report, never restart (same as --check)

set -euo pipefail

# --- config -----------------------------------------------------------------
PG_USER="${PG_USER:-postiz-user}"
PG_DB="${PG_DB:-postiz-db-local}"
PM2_PROCESS="${PM2_PROCESS:-orchestrator}"
STALE_MINUTES="${STALE_MINUTES:-20}"
[ "${1:-}" = "--check" ] && DRY_RUN=1
DRY_RUN="${DRY_RUN:-0}"

log() { printf '%s watchdog: %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"; }

# --- locate containers (Coolify hashes names, so match by image/pattern) ----
detect_app_container() {
  docker ps --format '{{.Names}} {{.Image}}' \
    | awk '/postiz-app/ {print $1; exit}'
}
detect_pg_container() {
  # Prefer a container whose name looks like the postiz postgres, else any
  # postgres image that is NOT the temporal one.
  docker ps --format '{{.Names}} {{.Image}}' \
    | awk 'tolower($1) ~ /postiz/ && $2 ~ /postgres/ {print $1; exit}'
}

POSTIZ_CONTAINER="${POSTIZ_CONTAINER:-$(detect_app_container || true)}"
PG_CONTAINER="${PG_CONTAINER:-$(detect_pg_container || true)}"

if [ -z "${POSTIZ_CONTAINER}" ]; then
  log "ERROR: could not find the postiz app container. Set POSTIZ_CONTAINER=... "
  exit 1
fi
if [ -z "${PG_CONTAINER}" ]; then
  log "ERROR: could not find the postiz postgres container. Set PG_CONTAINER=... "
  exit 1
fi

# --- query: how many posts are stuck? ---------------------------------------
# QUEUE + not soft-deleted + publishDate is more than STALE_MINUTES in the past.
# A genuinely-failed post moves to state ERROR, so QUEUE-in-the-past == the
# worker never picked it up.
SQL="SELECT COUNT(*) FROM \"Post\"
     WHERE state = 'QUEUE'
       AND \"deletedAt\" IS NULL
       AND \"publishDate\" < NOW() - INTERVAL '${STALE_MINUTES} minutes';"

STUCK="$(docker exec "${PG_CONTAINER}" psql -U "${PG_USER}" -d "${PG_DB}" -tAc "${SQL}" | tr -d '[:space:]')"

if ! [[ "${STUCK}" =~ ^[0-9]+$ ]]; then
  log "ERROR: unexpected DB response: '${STUCK}' (check PG_USER/PG_DB/PG_CONTAINER)"
  exit 1
fi

log "app=${POSTIZ_CONTAINER} pg=${PG_CONTAINER} stuck_queue_posts=${STUCK} threshold=${STALE_MINUTES}m"

# --- act --------------------------------------------------------------------
if [ "${STUCK}" -eq 0 ]; then
  log "OK: publisher is draining the queue."
  exit 0
fi

if [ "${DRY_RUN}" = "1" ]; then
  log "STALLED: ${STUCK} post(s) stuck. DRY_RUN — not restarting."
  exit 0
fi

log "STALLED: ${STUCK} post(s) stuck past publish time. Restarting pm2 '${PM2_PROCESS}'..."
docker exec "${POSTIZ_CONTAINER}" pm2 restart "${PM2_PROCESS}"
log "Restarted pm2 '${PM2_PROCESS}'."

# --- notify (optional) ------------------------------------------------------
if [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
  MSG="⚠️ Postiz orchestrator was stalled — ${STUCK} post(s) stuck in QUEUE past publish time. Auto-restarted pm2 '${PM2_PROCESS}' on ${POSTIZ_CONTAINER}."
  # Prefer curl, fall back to wget; never fail the script on notify errors.
  if command -v curl >/dev/null 2>&1; then
    curl -sf -X POST -H 'Content-type: application/json' \
      --data "$(printf '{"text":"%s"}' "${MSG}")" "${SLACK_WEBHOOK_URL}" >/dev/null || log "WARN: Slack notify failed."
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O /dev/null --header='Content-type: application/json' \
      --post-data="$(printf '{"text":"%s"}' "${MSG}")" "${SLACK_WEBHOOK_URL}" || log "WARN: Slack notify failed."
  fi
fi

exit 0
