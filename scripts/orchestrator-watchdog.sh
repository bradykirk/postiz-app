#!/usr/bin/env bash
#
# orchestrator-watchdog.sh
# ------------------------
# Self-heals the Postiz Temporal worker when it silently stops posting, with a
# HARD LIMIT on how often it may act.
#
# Why this exists:
#   The orchestrator can be "up but idle" (boot-order race against Temporal,
#   dead pollers, a failed worker start). The process stays alive, so nothing
#   restarts it and posts sit in QUEUE. This script measures the symptom:
#   "is any post stuck in QUEUE past its publish time?".
#
# Why it is bounded (incident 2026-11-04 .. 2026-11-12):
#   The first version ran `pm2 restart orchestrator` every 5 minutes for as
#   long as any post was overdue. Three posts were overdue for a reason a
#   restart could not fix, so it restarted forever. pm2 only supervises the
#   `pnpm` wrapper: it killed the wrapper while the real node process (127
#   threads) was still alive, the replacement started next to it, the
#   container hit its PID limit (300) and every later start failed with
#   `spawn EAGAIN`. The watchdog turned a 3-post problem into an 8-day outage
#   (2,262 restarts).
#
#   So this version:
#     - restarts the CONTAINER (clean process table), never `pm2 restart`;
#     - waits COOLDOWN_MINUTES between restarts;
#     - never restarts again while the same posts are still stuck (a restart
#       that did not free them will not free them the next time either);
#     - spends at most MAX_RESTARTS restarts, then only alerts. The budget
#       comes back only when the queue is verifiably healthy again (no overdue
#       posts) or an operator runs `--reset`.
#
# Install (on the Postiz host, cron every 5 min):
#   */5 * * * * /usr/local/bin/postiz-orchestrator-watchdog.sh >> /var/log/postiz-watchdog.log 2>&1
#
# Usage:
#   orchestrator-watchdog.sh            normal run
#   orchestrator-watchdog.sh --check    detect + report, never restart
#   orchestrator-watchdog.sh --reset    clear the restart budget/state
#   orchestrator-watchdog.sh --test-alert   send one test alert and exit
#
# Config (env vars, all optional):
#   POSTIZ_CONTAINER   App container (auto-detected by image name postiz-app)
#   PG_CONTAINER       Postgres container (auto-detected: postiz + postgres)
#   PG_USER / PG_DB    Default: read POSTGRES_USER / POSTGRES_DB from the
#                      postgres container env, else postiz-user / postiz-db-local
#   STALE_MINUTES      How overdue a QUEUE post must be to count as stuck (20)
#   COOLDOWN_MINUTES   Minimum time between two restarts (30)
#   MAX_RESTARTS       Restarts allowed until the queue is healthy again (3)
#   STATE_DIR          Where the budget is stored (/var/lib/postiz-watchdog)
#   SLACK_WEBHOOK_URL  If set, alerts on restart and on giving up
#   CLICKUP_API_TOKEN  If set together with CLICKUP_LIST_ID, every alert also
#   CLICKUP_LIST_ID    creates a ClickUp task in that list (priority urgent),
#   CLICKUP_ASSIGNEE_ID  assigned to this ClickUp user id when it is set
#   WATCHDOG_ENV_FILE  Root-only file with KEY=VALUE lines for the alert
#                      settings above (default /etc/postiz-watchdog.env).
#                      Cron has no environment, so secrets live there, never
#                      in this script or the repository.
#   DRY_RUN=1          Same as --check

set -euo pipefail

STALE_MINUTES="${STALE_MINUTES:-20}"
COOLDOWN_MINUTES="${COOLDOWN_MINUTES:-30}"
MAX_RESTARTS="${MAX_RESTARTS:-3}"
STATE_DIR="${STATE_DIR:-/var/lib/postiz-watchdog}"
DRY_RUN="${DRY_RUN:-0}"
MODE="${1:-}"
[ "${MODE}" = "--check" ] && DRY_RUN=1

log() { printf '%s watchdog: %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"; }

for n in "${STALE_MINUTES}" "${COOLDOWN_MINUTES}" "${MAX_RESTARTS}"; do
  if ! [[ "${n}" =~ ^[0-9]+$ ]]; then
    log "ERROR: STALE_MINUTES, COOLDOWN_MINUTES and MAX_RESTARTS must be whole numbers."
    exit 1
  fi
done

# Alert settings come from the environment or from WATCHDOG_ENV_FILE. The file
# is parsed, not sourced: only the known keys are read and nothing in it runs.
WATCHDOG_ENV_FILE="${WATCHDOG_ENV_FILE:-/etc/postiz-watchdog.env}"
if [ -r "${WATCHDOG_ENV_FILE}" ]; then
  while IFS='=' read -r key value; do
    case "${key}" in
      SLACK_WEBHOOK_URL | CLICKUP_API_TOKEN | CLICKUP_LIST_ID | CLICKUP_ASSIGNEE_ID)
        # the environment wins over the file
        [ -n "${!key:-}" ] || printf -v "${key}" '%s' "${value}"
        ;;
    esac
  done < "${WATCHDOG_ENV_FILE}"
fi

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/}"
  s="${s//$'\t'/ }"
  printf '%s' "${s}"
}

# notify <title> [details]. Never fails the script: an alert that cannot be
# sent is logged and the watchdog carries on.
notify() {
  local title="$1" details="${2:-}" payload status
  command -v curl >/dev/null 2>&1 || { log "WARN: curl not found - no alert sent."; return 0; }

  if [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
    curl -sf -m 10 -X POST -H 'Content-type: application/json' \
      --data "$(printf '{"text":"%s"}' "$(json_escape "${title} ${details}")")" \
      "${SLACK_WEBHOOK_URL}" >/dev/null || log "WARN: Slack notify failed."
  fi

  if [ -n "${CLICKUP_API_TOKEN:-}" ] && [ -n "${CLICKUP_LIST_ID:-}" ]; then
    if ! [[ "${CLICKUP_LIST_ID}" =~ ^[0-9]+$ ]] || ! [[ "${CLICKUP_ASSIGNEE_ID:-0}" =~ ^[0-9]+$ ]]; then
      log "WARN: CLICKUP_LIST_ID / CLICKUP_ASSIGNEE_ID must be numbers - no ClickUp alert sent."
      return 0
    fi
    payload="$(printf '{"name":"%s","description":"%s","priority":1,"assignees":[%s]}' \
      "$(json_escape "${title}")" \
      "$(json_escape "${details}")" \
      "${CLICKUP_ASSIGNEE_ID:-}")"
    # The token goes in a header read from stdin (-H @-), so it never shows up
    # in the process list.
    status="$(printf 'Authorization: %s\n' "${CLICKUP_API_TOKEN}" \
      | curl -s -m 15 -o /dev/null -w '%{http_code}' -X POST \
          -H @- -H 'Content-Type: application/json' --data "${payload}" \
          "https://api.clickup.com/api/v2/list/${CLICKUP_LIST_ID}/task" || true)"
    if [ "${status}" = "200" ]; then
      log "ClickUp alert task created."
    else
      log "WARN: ClickUp alert failed (HTTP ${status:-none})."
    fi
  fi
}

if [ "${MODE}" = "--test-alert" ]; then
  notify "Postiz watchdog: test alert" "This is a test from $(hostname). No action is needed. You can close this task."
  exit 0
fi

# --- state --------------------------------------------------------------------
mkdir -p "${STATE_DIR}"

# One run at a time: a slow `docker restart` must not overlap the next cron run.
if command -v flock >/dev/null 2>&1; then
  exec 9>"${STATE_DIR}/lock"
  if ! flock -n 9; then
    log "another run is in progress - skipping."
    exit 0
  fi
fi

read_state() { cat "${STATE_DIR}/$1" 2>/dev/null || printf '%s' "$2"; }
reset_state() { rm -f "${STATE_DIR}/restarts" "${STATE_DIR}/last_restart" "${STATE_DIR}/ids" "${STATE_DIR}/gave_up"; }

if [ "${MODE}" = "--reset" ]; then
  reset_state
  log "state reset by operator."
  exit 0
fi

# --- locate containers (Coolify hashes names, so match by image/pattern) -------
detect_app_container() {
  docker ps --format '{{.Names}} {{.Image}}' | awk '/postiz-app/ {print $1; exit}'
}
detect_pg_container() {
  docker ps --format '{{.Names}} {{.Image}}' \
    | awk 'tolower($1) ~ /postiz/ && $2 ~ /postgres/ {print $1; exit}'
}

POSTIZ_CONTAINER="${POSTIZ_CONTAINER:-$(detect_app_container || true)}"
PG_CONTAINER="${PG_CONTAINER:-$(detect_pg_container || true)}"

if [ -z "${POSTIZ_CONTAINER}" ]; then
  log "ERROR: could not find the postiz app container. Set POSTIZ_CONTAINER=..."
  exit 1
fi
if [ -z "${PG_CONTAINER}" ]; then
  log "ERROR: could not find the postiz postgres container. Set PG_CONTAINER=..."
  exit 1
fi

pg_env() {
  docker exec "${PG_CONTAINER}" printenv "$1" 2>/dev/null | tr -d '[:space:]' || true
}
PG_USER="${PG_USER:-$(pg_env POSTGRES_USER)}"
PG_USER="${PG_USER:-postiz-user}"
PG_DB="${PG_DB:-$(pg_env POSTGRES_DB)}"
PG_DB="${PG_DB:-postiz-db-local}"

# --- query: which posts are stuck? ----------------------------------------------
# QUEUE + not soft-deleted + publishDate more than STALE_MINUTES in the past.
# A post that genuinely failed moves to ERROR, so these were never picked up.
SQL="SELECT id FROM \"Post\"
     WHERE state = 'QUEUE'
       AND \"deletedAt\" IS NULL
       AND \"publishDate\" < NOW() - INTERVAL '${STALE_MINUTES} minutes'
     ORDER BY id;"

if ! RAW="$(docker exec "${PG_CONTAINER}" psql -U "${PG_USER}" -d "${PG_DB}" -tAc "${SQL}" 2>&1)"; then
  log "ERROR: DB query failed (check PG_USER/PG_DB/PG_CONTAINER): ${RAW}"
  exit 1
fi
IDS="$(printf '%s\n' "${RAW}" | tr -d ' \r' | grep -v '^$' | sort -u || true)"
if [ -z "${IDS}" ]; then STUCK=0; else STUCK="$(printf '%s\n' "${IDS}" | wc -l | tr -d '[:space:]')"; fi

# --- healthy: the only thing that gives the restart budget back -----------------
if [ "${STUCK}" -eq 0 ]; then
  if [ -e "${STATE_DIR}/restarts" ] || [ -e "${STATE_DIR}/gave_up" ]; then
    log "recovered: queue is draining again - restart budget restored."
    reset_state
  fi
  log "ok: no posts stuck in QUEUE > ${STALE_MINUTES}m"
  exit 0
fi

RESTARTS="$(read_state restarts 0)"
LAST="$(read_state last_restart 0)"
PREV_IDS="$(read_state ids '')"
NOW="$(date -u +%s)"
[[ "${RESTARTS}" =~ ^[0-9]+$ ]] || RESTARTS=0
[[ "${LAST}" =~ ^[0-9]+$ ]] || LAST=0

log "STALL: ${STUCK} post(s) overdue in QUEUE (app=${POSTIZ_CONTAINER}, restarts_used=${RESTARTS}/${MAX_RESTARTS})"

give_up() {
  log "NOT RESTARTING: $1. Manual check needed. Stuck ids: $(printf '%s' "${IDS}" | tr '\n' ' ')"
  if [ "${DRY_RUN}" != "1" ] && [ ! -e "${STATE_DIR}/gave_up" ]; then
    : > "${STATE_DIR}/gave_up"
    notify "Postiz watchdog gave up: ${STUCK} post(s) stuck in QUEUE" \
      "Reason: $1. The watchdog will not restart ${POSTIZ_CONTAINER} again until the queue is healthy or an operator runs --reset. Manual check needed. Stuck post ids: $(printf '%s' "${IDS}" | tr '\n' ' ')"
  fi
  exit 0
}

# 1. Cooldown: give the previous restart time to boot (~35 s+) and drain.
if [ "${LAST}" -gt 0 ] && [ $((NOW - LAST)) -lt $((COOLDOWN_MINUTES * 60)) ]; then
  log "cooldown: last restart was $(( (NOW - LAST) / 60 ))m ago (< ${COOLDOWN_MINUTES}m) - waiting."
  exit 0
fi

# 2. A restart that did not free these posts will not free them now.
if [ "${LAST}" -gt 0 ]; then
  NEW_IDS="$(comm -23 <(printf '%s\n' "${IDS}") <(printf '%s\n' "${PREV_IDS}" | sort -u) || true)"
  if [ -z "${NEW_IDS}" ]; then
    give_up "the same posts are still stuck after the last restart"
  fi
fi

# 3. Hard budget. Only a healthy queue or --reset gives it back.
if [ "${RESTARTS}" -ge "${MAX_RESTARTS}" ]; then
  give_up "restart budget used (${RESTARTS}/${MAX_RESTARTS})"
fi

if [ "${DRY_RUN}" = "1" ]; then
  log "DRY_RUN: would restart container ${POSTIZ_CONTAINER}."
  exit 0
fi

# --- act ------------------------------------------------------------------------
# Record the attempt BEFORE acting, so a restart that hangs or fails still
# counts against the budget.
printf '%s\n' "$((RESTARTS + 1))" > "${STATE_DIR}/restarts"
printf '%s\n' "${NOW}" > "${STATE_DIR}/last_restart"
printf '%s\n' "${IDS}" > "${STATE_DIR}/ids"

log "restarting container ${POSTIZ_CONTAINER} (restart $((RESTARTS + 1))/${MAX_RESTARTS})..."
if docker restart "${POSTIZ_CONTAINER}" >/dev/null 2>&1; then
  log "container restarted"
  notify "Postiz orchestrator stalled: container restarted ($((RESTARTS + 1))/${MAX_RESTARTS})" \
    "${STUCK} post(s) were stuck in QUEUE more than ${STALE_MINUTES} minutes past their publish time. The watchdog restarted ${POSTIZ_CONTAINER}. Check that the posts publish. Stuck post ids: $(printf '%s' "${IDS}" | tr '\n' ' ')"
else
  log "ERROR: docker restart ${POSTIZ_CONTAINER} failed."
  notify "Postiz watchdog: docker restart FAILED" \
    "docker restart ${POSTIZ_CONTAINER} failed with ${STUCK} post(s) stuck in QUEUE. Manual check needed."
fi

exit 0
