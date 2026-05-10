#!/bin/bash
# whatsapp-module start script
# Kills any process on port 3000, then starts the server in foreground.
# Close the terminal or press Ctrl+C to stop.

PORT=3000
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Stopping anything on port $PORT..."
lsof -ti :$PORT 2>/dev/null | xargs kill -9 2>/dev/null
sleep 1

echo "Starting WhatsApp Module..."
echo "Web UI:  http://localhost:$PORT"
echo "API:     http://localhost:$PORT/api/docs"
echo "Press Ctrl+C to stop."
echo ""

cd "$DIR" && node server.js
