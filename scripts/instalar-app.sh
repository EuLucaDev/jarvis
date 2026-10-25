#!/bin/bash
# Compila o app Jarvis (Electron) e instala em /Applications.
# Uso: scripts/instalar-app.sh            (instala)
#      scripts/instalar-app.sh --reabrir  (usado pelo atualizador: espera o app fechar e abre de novo)
set -euo pipefail
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$PROJ/desktop-app"
cd "$APP_DIR"

# o app precisa saber onde está o projeto (para subir o servidor e se atualizar)
node -e "const f='package.json',p=require('./'+f);p.jarvis={projeto:process.argv[1]};require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')" "$PROJ"

[ -d node_modules ] || npm install --no-audit --no-fund
npx electron-builder --mac dir --publish never >/dev/null

BUILT="$(ls -d dist/mac*/Jarvis.app | head -1)"
# sem conta de desenvolvedor da Apple: assinatura local (ad hoc), suficiente para este Mac
codesign --force --deep --sign - "$BUILT"

if [ "${1:-}" = "--reabrir" ]; then
  for _ in $(seq 1 40); do pgrep -f "/Applications/Jarvis.app/Contents/MacOS/Jarvis" >/dev/null || break; sleep 0.5; done
fi
rm -rf /Applications/Jarvis.app
cp -R "$BUILT" /Applications/Jarvis.app
xattr -dr com.apple.quarantine /Applications/Jarvis.app 2>/dev/null || true
echo "Jarvis instalado em /Applications/Jarvis.app"
if [ "${1:-}" = "--reabrir" ] || [ "${1:-}" = "--abrir" ]; then open /Applications/Jarvis.app; fi
