#!/usr/bin/env bash
# Sets the version everywhere it is declared:
#   scripts/bump-version.sh 0.2.0
set -euo pipefail
v="${1:?usage: scripts/bump-version.sh X.Y.Z}"
[[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || { echo "invalid version: $v" >&2; exit 1; }
cd "$(dirname "$0")/.."

# workspace version in Cargo.toml (first `version = ` line, under [workspace.package])
perl -0pi -e "s/(\[workspace\.package\]\nversion = )\"[^\"]*\"/\${1}\"$v\"/" Cargo.toml
perl -pi -e "s/\"version\": \"[^\"]*\"/\"version\": \"$v\"/ if \$. < 6" desktop/tauri.conf.json
(cd web && npm version "$v" --no-git-tag-version --allow-same-version > /dev/null)
cargo update --workspace --quiet

echo "version set to $v. Next:"
echo "  git commit -am \"Release $v\" && git tag -a v$v -m v$v && git push --follow-tags"
