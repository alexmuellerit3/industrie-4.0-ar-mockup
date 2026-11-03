#!/usr/bin/env bash
# ==============================================================================
# sync-wiki.sh - Synchronisiert das lokale wiki/ Verzeichnis mit dem GitHub Wiki
# ==============================================================================

set -e

WIKI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/wiki"
TEMP_DIR="/tmp/gh_wiki_sync_$(date +%s)"

# Bestimme Wiki-Remote URL dynamisch aus der bestehenden Git-Origin-Konfiguration
ORIGIN_URL=$(git remote get-url origin 2>/dev/null || echo "https://github.com/alexmuellerit3/industrie-4.0-ar-mockup.git")
DEFAULT_WIKI_URL="${ORIGIN_URL%.git}.wiki.git"
WIKI_REPO_URL="${1:-$DEFAULT_WIKI_URL}"

echo "=== GitHub Wiki Synchronisation ==="
echo "Quellverzeichnis: ${WIKI_DIR}"
echo "Ziel-Repository:  $(echo "${WIKI_REPO_URL}" | sed -E 's/:[^@]+@/:***@/')"

if [ ! -d "${WIKI_DIR}" ]; then
  echo "Fehler: ${WIKI_DIR} existiert nicht!"
  exit 1
fi

rm -rf "${TEMP_DIR}"
mkdir -p "${TEMP_DIR}"

# Versuche bestehendes Wiki zu klonen, ansonsten erstelle neues Repo
if git clone "${WIKI_REPO_URL}" "${TEMP_DIR}" 2>/dev/null; then
  echo "Bestehendes Wiki erfolgreich geklont."
else
  echo "Wiki noch nicht initialisiert oder leer. Initialisiere lokales Wiki-Repo..."
  cd "${TEMP_DIR}"
  git init -b master
  git remote add origin "${WIKI_REPO_URL}"
fi

# Kopiere alle Markdown-Dateien aus wiki/
cd "${WIKI_DIR}"
cp -v *.md "${TEMP_DIR}/"

cd "${TEMP_DIR}"
git config user.name "Wiki Sync Bot"
git config user.email "wiki-sync@cps-i40.local"

git add -A
if git diff-index --quiet HEAD 2>/dev/null; then
  echo "Keine Änderungen vorhanden. Wiki ist bereits auf dem aktuellen Stand."
else
  git commit -m "docs(wiki): update project documentation from wiki/ source"
  echo "Pushe Änderungen ins GitHub Wiki..."
  if git push -u origin master; then
    echo "=== GitHub Wiki erfolgreich synchronisiert! ==="
  else
    echo "Hinweis: Falls der Push fehlschlägt, stellen Sie sicher, dass das Wiki im GitHub Webinterface"
    echo "unter https://github.com/alexmuellerit3/industrie-4.0-ar-mockup/wiki einmalig durch Klick auf"
    echo "'Create the first page' initialisiert wurde."
  fi
fi

rm -rf "${TEMP_DIR}"
