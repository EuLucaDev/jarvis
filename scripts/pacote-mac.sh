#!/bin/sh
# Monta o instalador do Mac ("Instalar Jarvis.pkg"): coloca o Jarvis.app em /Applications e abre ao terminar.
#   scripts/pacote-mac.sh <caminho/Jarvis.app> <versão> <saída.pkg>
set -e
APP="$1"; V="$2"; SAIDA="$3"
AQUI="$(cd "$(dirname "$0")/.." && pwd)/packaging/mac"
TMP="$(mktemp -d)"
mkdir -p "$TMP/raiz/Applications"
ditto "$APP" "$TMP/raiz/Applications/Jarvis.app"
# não "mudar de lugar": sem isto, o instalador atualiza uma cópia solta do app (ex.: na Mesa) em vez de Aplicativos
pkgbuild --analyze --root "$TMP/raiz" "$TMP/componentes.plist"
plutil -replace 0.BundleIsRelocatable -bool NO "$TMP/componentes.plist"
pkgbuild --root "$TMP/raiz" --component-plist "$TMP/componentes.plist" --scripts "$AQUI/scripts" \
  --identifier com.lpc.jarvis --version "$V" --install-location / "$TMP/jarvis-app.pkg"
sed "s/version=\"0\"/version=\"$V\"/" "$AQUI/distribuicao.xml" > "$TMP/distribuicao.xml"
productbuild --distribution "$TMP/distribuicao.xml" --resources "$AQUI/recursos" --package-path "$TMP" "$SAIDA"
rm -rf "$TMP"
