#!/bin/bash
# Assina um .app com o certificado próprio "Jarvis Local" (segredos MAC_CERT_P12/MAC_CERT_PASS) ou, sem eles, ad hoc.
# Sempre o mesmo certificado: as permissões do macOS (câmera, microfone, Acessibilidade) não caem a cada versão.
#   scripts/assinar-mac.sh caminho/App.app
set -euo pipefail
APP="$1"
KC="$RUNNER_TEMP/assinatura.keychain-db"
if [ -n "${MAC_CERT_P12:-}" ]; then
  if [ ! -f "$KC" ]; then
    echo "$MAC_CERT_P12" | base64 --decode > "$RUNNER_TEMP/c.p12"
    security create-keychain -p ci "$KC"
    security set-keychain-settings "$KC"
    security unlock-keychain -p ci "$KC"
    security import "$RUNNER_TEMP/c.p12" -k "$KC" -P "$MAC_CERT_PASS" -T /usr/bin/codesign
    security list-keychains -d user -s "$KC" $(security list-keychains -d user | tr -d '"')
    security set-key-partition-list -S apple-tool:,apple: -s -k ci "$KC" > /dev/null
    openssl pkcs12 -in "$RUNNER_TEMP/c.p12" -clcerts -nokeys -passin pass:"$MAC_CERT_PASS" -legacy -out "$RUNNER_TEMP/c.pem" 2>/dev/null \
      || openssl pkcs12 -in "$RUNNER_TEMP/c.p12" -clcerts -nokeys -passin pass:"$MAC_CERT_PASS" -out "$RUNNER_TEMP/c.pem"
    sudo security add-trusted-cert -d -r trustRoot -p codeSign -k /Library/Keychains/System.keychain "$RUNNER_TEMP/c.pem"
  fi
  codesign --force --deep --keychain "$KC" --sign "Jarvis Local" "$APP"
else
  codesign --force --deep --sign - "$APP"
fi
codesign --verify --deep "$APP"
codesign -dvv "$APP" 2>&1 | grep -E "Authority|Signature" || true
