#!/bin/bash
# Keepalive for GitHub Codespaces
# Prevents idle shutdown by generating terminal activity every 5 minutes
# Usage: nohup bash .codespace-keepalive.sh &

INTERVAL=300  # 5 minutes (idle timeout is 30 min by default)

log() {
  echo "[$(date '+%H:%M:%S')] codespace-keepalive: $1"
}

log "started (interval: ${INTERVAL}s)"

while true; do
  sleep "$INTERVAL"
  # Touch a file in /tmp — this registers as filesystem activity
  touch /tmp/.codespace-keepalive
  # Also write to a log so you can verify it's running
  log "heartbeat"
done
