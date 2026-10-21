#!/bin/bash
# Instala o Jarvis para ligar sozinho com o Mac:
#  - com.jarvis.servidor: o servidor (porta 8000), reiniciado se cair
#  - com.jarvis.telas: no login, abre o HUD e as telas extras nos monitores
#  - ~/Applications/Jarvis.app: abre (ou reabre) as telas com um clique
set -euo pipefail

PROJ="$(cd "$(dirname "$0")/.." && pwd)"
UV="$(command -v uv || echo /opt/homebrew/bin/uv)"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs/Jarvis"
UIDN="$(id -u)"
PATHS="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

echo "→ Preparando o Jarvis em $PROJ"
[ -f "$PROJ/.env" ] || { echo "Falta o arquivo .env (copie de .env.example e cole a GEMINI_API_KEY)."; exit 1; }
(cd "$PROJ/frontend" && npm install --silent && npm run build --silent)
"$UV" sync --directory "$PROJ/backend" --quiet
mkdir -p "$AGENTS" "$LOGS"

# Para um servidor que esteja rodando à mão na porta 8000
if lsof -ti tcp:8000 >/dev/null 2>&1; then
  echo "→ Parando o servidor que estava rodando na porta 8000"
  kill $(lsof -ti tcp:8000) 2>/dev/null || true
  sleep 1
fi

plist() { # nome, keepalive(true/false), argumentos...
  local name="$1" keep="$2"; shift 2
  local args=""
  for a in "$@"; do args+="    <string>$a</string>"$'\n'; done
  cat > "$AGENTS/$name.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$name</string>
  <key>ProgramArguments</key>
  <array>
$args  </array>
  <key>WorkingDirectory</key><string>$PROJ/backend</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><$keep/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOGS/$name.log</string>
  <key>StandardErrorPath</key><string>$LOGS/$name.log</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$PATHS</string></dict>
</dict>
</plist>
PLIST
  launchctl bootout "gui/$UIDN/$name" 2>/dev/null || true
  launchctl bootstrap "gui/$UIDN" "$AGENTS/$name.plist"
}

echo "→ Instalando o servidor (liga com o Mac e volta se cair)"
plist com.jarvis.servidor true "$UV" run --directory "$PROJ/backend" uvicorn jarvis.app:app --host 127.0.0.1 --port 8000

echo "→ Instalando a abertura automática das telas no login"
plist com.jarvis.telas false "$UV" run --directory "$PROJ/backend" python -m jarvis.launcher --login

echo "→ Criando o app Jarvis em ~/Applications"
mkdir -p "$HOME/Applications"
rm -rf "$HOME/Applications/Jarvis.app"
osacompile -o "$HOME/Applications/Jarvis.app" -e "do shell script \"curl -s -m 3 http://localhost:8000/health >/dev/null || launchctl kickstart -k gui/$UIDN/com.jarvis.servidor; for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do curl -s -m 2 http://localhost:8000/health >/dev/null && break; sleep 2; done; curl -s -X POST http://localhost:8000/api/monitores/abrir >/dev/null\""

echo
echo "Pronto. O Jarvis liga sozinho quando você entrar no Mac."
echo "  HUD:     http://localhost:8000"
echo "  Painel:  http://localhost:8000/admin"
echo "  Logs:    $LOGS"
echo "  Reabrir as telas: app Jarvis em ~/Applications (ou no Launchpad)"
echo "  Sair da tela cheia: Cmd+Q na janela do Jarvis"
