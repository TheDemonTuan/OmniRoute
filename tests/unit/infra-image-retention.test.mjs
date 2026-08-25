import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const helper = path.join(root, "infra/image-retention.sh");
const deploy = path.join(root, "infra/deploy.sh");
const workflow = path.join(root, ".github/workflows/prod-deploy.yml");
const bootstrap = path.join(root, "infra/bootstrap-vps.sh");

function runRetention(protectedImages) {
  const temp = mkdtempSync(path.join(tmpdir(), "omniroute-retention-"));
  const removed = path.join(temp, "removed");
  const docker = path.join(temp, "docker");

  writeFileSync(
    docker,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == "image inspect" ]]; then
  [[ "$3" != *"missing"* ]] || exit 1
  printf 'sha256:%s\\n' "\${3##*@sha256:}"
elif [[ "$1 $2" == "image ls" ]]; then
  cat <<'EOF'
ghcr.io/thedemontuan/omniroute|sha256:new
ghcr.io/thedemontuan/omniroute|sha256:previous
ghcr.io/thedemontuan/omniroute|sha256:old
ghcr.io/thedemontuan/other|sha256:foreign
EOF
elif [[ "$1 $2" == "image rm" ]]; then
  printf '%s\\n' "$3" >> "${removed}"
else
  exit 64
fi
`,
    { mode: 0o755 }
  );

  const script = `log() { :; }; source "$1"; prune_repository_images ghcr.io/thedemontuan/omniroute "${protectedImages.join('" "')}"`;
  execFileSync("bash", ["-c", script, "retention-test", helper], {
    env: { ...process.env, PATH: `${temp}:${process.env.PATH}` },
  });

  try {
    return readFileSync(removed, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

test("retention removes only unprotected digests from the requested repository", () => {
  assert.deepEqual(
    runRetention([
      "ghcr.io/thedemontuan/omniroute@sha256:new",
      "ghcr.io/thedemontuan/omniroute@sha256:previous",
    ]),
    ["ghcr.io/thedemontuan/omniroute@sha256:old"]
  );
});

test("retention fails closed when a protected image is unavailable", () => {
  assert.deepEqual(
    runRetention([
      "ghcr.io/thedemontuan/omniroute@sha256:new",
      "ghcr.io/thedemontuan/omniroute@sha256:missing",
    ]),
    []
  );
});

test("production deployment syncs and invokes repository-scoped retention", () => {
  const deploySource = readFileSync(deploy, "utf8");
  const workflowSource = readFileSync(workflow, "utf8");
  const bootstrapSource = readFileSync(bootstrap, "utf8");

  assert.match(deploySource, /source "\$APP_DIR\/image-retention\.sh"/);
  assert.match(deploySource, /prune_repository_images/);
  assert.match(workflowSource, /infra\/image-retention\.sh/);
  assert.match(
    workflowSource,
    /install -m 0644 \.staging\/infra\/image-retention\.sh image-retention\.sh\.new/
  );
  assert.match(bootstrapSource, /image-retention\.sh/);
  assert.match(deploySource, /OLD_ACTIVE_IMAGE=""/);
  assert.doesNotMatch(deploySource, /docker builder prune/);
});
