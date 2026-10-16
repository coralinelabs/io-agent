#!/bin/sh
# Qualify Linux production confinement without root on the host.
#
#   sh scripts/qualify-confinement.sh [RECEIPT] [SPEC ...]
#
# Builds the static-musl sandbox launcher where musl-gcc exists - a rootless
# podman container from the Node image io-agent is built with, which installs
# musl-tools for itself - then, as an ordinary user with umask 022, probes
# the running kernel through that launcher and runs the confinement-dependent
# specs (the ones that skip where no backend is usable) against it. Nothing on
# the host is installed or changed, and the production sandbox mode is not
# touched: a backend that does not enforce still fails closed, and the specs
# say so.
#
# Writes RECEIPT (default docs/confinement-validation.json): the kernel, its
# Landlock ABI, the launcher's probe verdict and sha256, the toolchain, and
# each spec's outcome. The container keeps podman's default security options
# (its seccomp profile admits the Landlock syscalls); none are loosened here.
# The host needs podman and python3, nothing else.
set -eu
here="$(cd "$(dirname "$0")/.." && pwd)"
receipt="${1:-$here/docs/confinement-validation.json}"
[ $# -gt 0 ] && shift
# the specs that need a confinement backend, and the real-backend ones (*.e2e.ts) under tests/sandbox and
# tests/shell/bash-sandbox, which the ordinary suite leaves out
specs="${*:-tests/io-agent/harness/host-sessions.spec.ts tests/io-agent/harness/host.spec.ts tests/workflow/workflow-ptc tests/shell/bash-sandbox tests/sandbox tests/ptc-runtime/ptc-runtime-node/runtime.spec.ts}"
# IO_AGENT_QUALIFY_IMAGE and _CPUS; their names before io-agent (PLUTO_*) are read when these are not set
image="${IO_AGENT_QUALIFY_IMAGE-${PLUTO_QUALIFY_IMAGE:-docker.io/library/node:22.23.3-bookworm}}"
image="${image:-docker.io/library/node:22.23.3-bookworm}"
cpus="${IO_AGENT_QUALIFY_CPUS-${PLUTO_QUALIFY_CPUS:-6}}"
command -v podman >/dev/null 2>&1 || { echo "qualify: rootless podman is needed" >&2; exit 1; }
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
cp "$here/scripts/qualify-confinement.receipt.cjs" "$out/receipt.cjs"

# shellcheck disable=SC2016 # expanded inside the container
podman run --rm --cpus="${cpus:-6}" -v "$here:/src:ro,Z" -v "$out:/out:Z" \
    -e SPECS="$specs" -e IMAGE="$image" "$image" sh -c '
set -eu
apt-get update -qq >/dev/null && apt-get install -y -qq musl-tools >/dev/null
useradd -m qualify
cp -r /src /home/qualify/io-agent && rm -rf /home/qualify/io-agent/.git /home/qualify/io-agent/node_modules
chown -R qualify /home/qualify /out
su qualify -c "
set -eu
umask 022
cd ~/io-agent
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack pnpm install --frozen-lockfile >/out/install.log 2>&1
corepack pnpm build >/out/build.log 2>&1
launcher=src/library/execution/native/prebuilds/linux-\$(node -p process.arch)/landlock-run
test -x \$launcher || { echo the launcher was not built >&2; exit 1; }
\$launcher --probe >/out/probe.txt 2>&1 && echo 0 >/out/probe.status || echo \$? >/out/probe.status
sha256sum \$launcher | cut -c1-64 >/out/launcher.sha256
musl-gcc --version 2>&1 | head -n 1 >/out/musl-gcc.txt || true
# the ABI the kernel answers landlock_create_ruleset(NULL, 0, VERSION) with
python3 -c \"import ctypes; print(ctypes.CDLL(None, use_errno=True).syscall(444, None, 0, 1))\" >/out/abi.txt
npx vitest run --config scripts/qualify-confinement.vitest.ts \$SPECS --reporter=json --outputFile=/out/results.json >/out/vitest.log 2>&1 || true
"
uname -r >/out/kernel.txt
node /out/receipt.cjs /out "$IMAGE" "$SPECS"
# the host user owns what it reads back (container root is that user)
chown -R root /out
'
mkdir -p "$(dirname "$receipt")"
cp "$out/receipt.json" "$receipt"
python3 - "$receipt" <<'EOF'
import json, sys
receipt = json.load(open(sys.argv[1]))
totals, launcher = receipt["totals"], receipt["launcher"]
print(f"qualify: {totals['passed']} passed, {totals['failed']} failed, {totals['skipped']} skipped; "
      f"launcher {launcher['probe']}, Landlock ABI {receipt['environment']['landlockAbi']}; {sys.argv[1]}")
sys.exit(1 if totals["failed"] or launcher["probe"] == "unusable" else 0)
EOF
