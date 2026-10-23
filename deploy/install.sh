#!/usr/bin/env bash
set -euo pipefail
release_sha="${1:?Usage: bash deploy/install.sh <released-commit-sha>}"
install_root=/home/bek/.local/share/scrat-v2
release_path="$install_root/releases/$release_sha"
bash "$release_path/deploy/install-node.sh"
export PATH="/home/bek/.local/share/scrat/runtime/node-v24.22.1-linux-x64/bin:$install_root/bin:/home/bek/.local/share/scrat/runtime/docker:/usr/local/bin:/usr/bin:/bin"
bash "$release_path/deploy/assert-release.sh" "$release_sha" "$release_path"

cd "$release_path"
npm ci --no-audit --no-fund
node --env-file="$install_root/.env" deploy/prepare-tools.mjs
mkdir -p "$install_root/data" "$install_root/bin" "$install_root/backups" "$install_root/actions"
corepack enable --install-directory "$install_root/bin" pnpm
corepack prepare pnpm@11.7.0 --activate
ln -sfn "$install_root/data" data
ln -sfn "$install_root/.env" .env
[ -e "$install_root/scrat.local.json" ] || printf '{}\n' > "$install_root/scrat.local.json"
ln -sfn "$install_root/scrat.local.json" scrat.local.json
node src/config.ts # Fail on a bad scrat.local.json, an invalid manifest or a trigger clash while the old release is still running.
node src/sandbox.ts # Fail closed on missing bwrap/AppArmor/runtime before draining the old service.

# Stop/drain the existing sole worker before migrating or moving its release.
systemctl --user stop scrat.service
backup_path="$install_root/backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_path"
cp /home/bek/.config/systemd/user/scrat.service "$backup_path/scrat.service"
if [ -d /home/bek/.config/systemd/user/scrat.service.d ]; then
  mv /home/bek/.config/systemd/user/scrat.service.d "$backup_path/scrat.service.d"
fi
if [ -f "$backup_path/scrat.service.d/local.conf" ]; then
  mkdir -p /home/bek/.config/systemd/user/scrat.service.d
  cp "$backup_path/scrat.service.d/local.conf" /home/bek/.config/systemd/user/scrat.service.d/local.conf
fi
if [ -f "$install_root/data/scrat.sqlite" ]; then
  node --input-type=module -e 'import {DatabaseSync,backup} from "node:sqlite"; const db=new DatabaseSync(process.argv[1]); await backup(db,process.argv[2]); db.close();' "$install_root/data/scrat.sqlite" "$backup_path/scrat.sqlite"
  node --input-type=module -e 'import {DatabaseSync} from "node:sqlite"; const db=new DatabaseSync(process.argv[1]); db.exec("DROP TABLE IF EXISTS github_snapshots"); db.close();' "$install_root/data/scrat.sqlite"
fi
node deploy/migrate-subjects.mjs "$install_root/data/scrat.sqlite"
npm run db:push
ln -sfn "$release_path" "$install_root/current"
[ "$(readlink -f "$install_root/current")" = "$(readlink -f "$release_path")" ] || { printf 'current does not point to %s\n' "$release_path" >&2; exit 1; }
cp deploy/scrat.service /home/bek/.config/systemd/user/scrat.service
systemctl --user daemon-reload
systemctl --user enable --now scrat.service
systemctl --user show scrat.service -p ActiveState -p SubState -p MainPID -p NRestarts -p MemoryMax
printf 'Deployed %s\n' "$release_sha"
