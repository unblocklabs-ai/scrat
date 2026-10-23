#!/usr/bin/env bash
set -euo pipefail
scrat_runtime=/home/bek/.local/share/scrat/runtime
scrat_node="$scrat_runtime/node-v24.22.1-linux-x64"
scrat_binary_sha=e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb
mkdir -p "$scrat_runtime"
if [ ! -e "$scrat_node" ]; then
  scrat_free=$(df -PB1 "$scrat_runtime" | awk 'NR==2 { print $4 }')
  [ "$scrat_free" -ge 536870912 ] || { echo 'Node staging requires 512 MiB free' >&2; exit 1; }
  scrat_stage=$(mktemp -d "$scrat_runtime/.node-security-20261022.XXXXXX")
  curl -fL --retry 2 --max-time 90 -o "$scrat_stage/node.tar.xz" \
    https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.xz
  printf '%s  %s\n' 6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6 \
    "$scrat_stage/node.tar.xz" | sha256sum --check -
  tar -xJf "$scrat_stage/node.tar.xz" -C "$scrat_stage"
  [ "$("$scrat_stage/node-v24.22.1-linux-x64/bin/node" --version)" = v24.22.1 ]
  mv "$scrat_stage/node-v24.22.1-linux-x64" "$scrat_node"
fi
printf '%s  %s\n' "$scrat_binary_sha" "$scrat_node/bin/node" | sha256sum --check -
[ "$("$scrat_node/bin/node" --version)" = v24.22.1 ]
printf 'Staged official Node 24.22.1; no service was restarted.\n'
