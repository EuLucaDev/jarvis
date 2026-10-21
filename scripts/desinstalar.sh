#!/bin/bash
# Remove a inicialização automática (o projeto, a memória e os ajustes ficam intactos).
UIDN="$(id -u)"
for n in com.jarvis.telas com.jarvis.servidor; do
  launchctl bootout "gui/$UIDN/$n" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$n.plist"
done
pkill -f "Application Support/Jarvis/chrome-" 2>/dev/null || true
rm -rf "$HOME/Applications/Jarvis.app"
echo "Inicialização automática removida. Para rodar à mão: uv run --directory backend uvicorn jarvis.app:app --port 8000"
