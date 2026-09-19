#!/bin/bash
cd /home/ely/.local/src/magi_AI

# ── Load environment ──────────────────────
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# ── Dedup check ──────────────────────────
if pgrep -f "electron \." > /dev/null || pgrep -f "electron /home/ely/magi-app" > /dev/null; then
  echo "MAGI already running."
  exit 0
fi

# ── Start backend if not running ─────────
if ! pgrep -f "node server.js" > /dev/null; then
  node server.js &
  NODE_PID=$!
  sleep 0.5
else
  NODE_PID=$(pgrep -f "node server.js")
fi

# ── Start SearXNG cleanly ────────────────
echo "Starting SearXNG containers..."
docker compose up -d
sleep 2

# ── Guaranteed Cleanup Function ──────────
cleanup() {
  echo "Shutting down MAGI stack..."
  kill $NODE_PID 2>/dev/null
  # Force down with a 2-second timeout to prevent Arch shutdown hangs
  docker compose down --timeout 2
  echo "Cleanup complete."
  exit 0
}

# Trap exit signals (normal exit, Ctrl+C, system termination) to run cleanup
trap cleanup EXIT SIGINT SIGTERM

# ── Launch Electron (foreground process) ─
echo "Launching UI..."
./node_modules/.bin/electron .
