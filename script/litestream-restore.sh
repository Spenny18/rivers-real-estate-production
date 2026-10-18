#!/bin/sh
# Restore the production database from the continuous backup (litestream.yml).
#
# Run ON the Fly machine:
#   fly ssh console -a luxury-homes-calgary -C "sh /app/script/litestream-restore.sh"            # latest
#   fly ssh console -a luxury-homes-calgary -C "sh /app/script/litestream-restore.sh 2026-10-18T15:00:00Z"   # as of a moment
#   fly ssh console -a luxury-homes-calgary -C "sh /app/script/litestream-restore.sh --check"    # restore to /tmp and verify only
#
# It writes /data/rivers.db.restore and checks it; storage.ts swaps that file
# in on the next boot (keeping the old one as rivers.db.replaced.<time>). Then
# restart the machine:  fly machine restart <id> -a luxury-homes-calgary
set -eu

export LITESTREAM_PREFIX="${BACKUP_S3_PREFIX:-rivers}"
DB="${DB_PATH:-/data/rivers.db}"
OUT="$DB.restore"
TS=""

case "${1:-}" in
  --check) OUT="/tmp/litestream-check.db" ;;
  "") ;;
  *) TS="$1" ;;
esac

rm -f "$OUT" "$OUT-wal" "$OUT-shm"
if [ -n "$TS" ]; then
  litestream restore -config /etc/litestream.yml -timestamp "$TS" -o "$OUT" "$DB"
else
  litestream restore -config /etc/litestream.yml -o "$OUT" "$DB"
fi

# The restored copy must open cleanly before it's used.
node -e '
const D = require("/app/node_modules/better-sqlite3");
const d = new D(process.argv[1], { readonly: true });
const ok = d.pragma("quick_check", { simple: true });
const n = (t) => { try { return d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; } catch { return "?"; } };
console.log(JSON.stringify({ quick_check: ok, contacts: n("crm_contacts"), leads: n("leads"), listings: n("mls_listings") }));
if (ok !== "ok") process.exit(1);
' "$OUT"

if [ "$OUT" = "/tmp/litestream-check.db" ]; then
  rm -f "$OUT"
  echo "Check passed: the continuous backup restores cleanly. Nothing was changed."
else
  echo "Restored to $OUT. Restart the machine to switch to it."
fi
