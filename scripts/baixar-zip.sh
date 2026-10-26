#!/bin/sh
# Espera a compilação do Jarvis terminar, baixa o zip para a Mesa e apaga tudo o que ficou guardado no GitHub
# (o GitHub é só a máquina que compila; nada fica publicado lá).
#   scripts/baixar-zip.sh            (a compilação mais recente)
#   scripts/baixar-zip.sh <id>       (uma compilação específica)
set -e
REPO=EuLucaDev/jarvis
RUN=${1:-$(gh run list -R $REPO -w "Compilar o Jarvis" -L 1 --json databaseId --jq '.[0].databaseId')}
gh run watch "$RUN" -R $REPO --exit-status --interval 30 > /dev/null
TMP=$(mktemp -d)
gh run download "$RUN" -R $REPO -n Jarvis-zip -D "$TMP"
mv "$TMP"/Jarvis-*.zip "$HOME/Desktop/"
rm -rf "$TMP"
gh api "repos/$REPO/actions/runs/$RUN/artifacts" --jq '.artifacts[].id' | while read -r a; do
  gh api -X DELETE "repos/$REPO/actions/artifacts/$a"
done
ls -la "$HOME"/Desktop/Jarvis-*.zip | tail -1
