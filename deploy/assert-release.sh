#!/usr/bin/env bash
set -euo pipefail
sha="${1:?Usage: bash deploy/assert-release.sh <sha> <release_path>}"
release_path="${2:?Usage: bash deploy/assert-release.sh <sha> <release_path>}"
repo=unblocklabs-ai/scrat

json_get() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j;try{j=JSON.parse(s)}catch{process.stderr.write("GitHub returned a body that is not JSON\n");process.exit(2)}const v=process.argv[1].split(".").reduce((o,k)=>o==null?o:o[k],j);process.stdout.write(v==null?"":String(v))})' "$1"
}

version=$(node -e 'process.stdout.write(String(require(process.argv[1]).version ?? ""))' "$release_path/package.json")
if [ -z "$version" ]; then
  echo "No version in $release_path/package.json" >&2
  exit 1
fi
tag="v$version"

response=$(curl -sS --max-time 30 -w '\n%{http_code}' -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$repo/git/ref/tags/$tag") || {
  echo "Cannot reach api.github.com to resolve tag $tag of $repo" >&2
  exit 1
}
status=${response##*$'\n'}
body=${response%$'\n'*}
case "$status" in
  200) ;;
  404)
    echo "Tag $tag does not exist in $repo: only a tagged release can be installed" >&2
    exit 1
    ;;
  403|429)
    echo "GitHub returned HTTP $status for tag $tag of $repo: unauthenticated API calls are rate-limited (60 per hour per IP), retry later" >&2
    exit 1
    ;;
  *)
    echo "GitHub returned HTTP $status for tag $tag of $repo" >&2
    exit 1
    ;;
esac

object_type=$(printf '%s' "$body" | json_get object.type)
commit=$(printf '%s' "$body" | json_get object.sha)
if [ "$object_type" = "tag" ]; then
  tag_body=$(curl -sS --max-time 30 -fH 'Accept: application/vnd.github+json' "https://api.github.com/repos/$repo/git/tags/$commit") || {
    echo "Cannot reach api.github.com to resolve annotated tag $tag of $repo" >&2
    exit 1
  }
  commit=$(printf '%s' "$tag_body" | json_get object.sha)
fi

if [ "$commit" != "$sha" ]; then
  echo "Tag $tag points to ${commit:-nothing}, not $sha: refusing to install a commit that is not the release" >&2
  exit 1
fi

echo "Release $tag verified: $sha"
