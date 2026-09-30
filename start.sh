#!/bin/sh
# Open OpenFootball in your browser (Mac/Linux). Serves this folder on
# http://localhost:8000/ so the app can load players.csv and use all CPU cores.
cd "$(dirname "$0")" || exit 1
PORT=8000
URL="http://localhost:$PORT/"
( sleep 1; (open "$URL" || xdg-open "$URL") >/dev/null 2>&1 ) &
echo "OpenFootball is running at $URL (Ctrl+C to stop)"
exec python3 -m http.server "$PORT" --bind 127.0.0.1
