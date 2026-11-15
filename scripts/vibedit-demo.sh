#!/bin/bash
# Start vibedit demo with a simple built-in HTML page (no external server needed)
# Usage: bash scripts/vibedit-demo.sh

set -e

DEMO_DIR="/tmp/shmakk-vibedit-demo"
mkdir -p "$DEMO_DIR"

cat > "$DEMO_DIR/index.html" << 'HTML'
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Vibedit Demo</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; background: #f5f5f5; padding: 2rem; }
    h1 { color: #333; margin-bottom: 1rem; }
    p { color: #666; max-width: 600px; line-height: 1.6; }
    .card { background: white; border-radius: 8px; padding: 1.5rem; margin-top: 1rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    button { background: #2563eb; color: white; border: none; padding: 0.5rem 1rem; border-radius: 4px; cursor: pointer; margin-top: 0.5rem; }
    .counter { font-size: 2rem; font-weight: bold; color: #2563eb; margin: 0.5rem 0; }
  </style>
</head>
<body>
  <h1>Vibedit Demo Page</h1>
  <p>This is a test page for vibedit. Click the puck (bottom-right corner) to open the chat overlay.</p>
  <div class="card">
    <h2>Counter Example</h2>
    <div class="counter" id="count">0</div>
    <button onclick="document.getElementById('count').textContent = parseInt(document.getElementById('count').textContent) + 1">Click me</button>
  </div>
  <div class="card">
    <h2>Try this in the chat:</h2>
    <p>"Make the counter red and bigger"</p>
    <p>"Change the heading to say something else"</p>
    <p>"Make the background dark"</p>
  </div>
</body>
</html>
HTML

echo "Demo page: $DEMO_DIR/index.html"
echo "Starting vibedit (static server + browser)..."
echo "Ctrl-C to stop"
echo ""

node "$(dirname "$0")/test-vibedit.js" "$DEMO_DIR/index.html" "$DEMO_DIR"

rm -rf "$DEMO_DIR"
echo "Cleaned up."
