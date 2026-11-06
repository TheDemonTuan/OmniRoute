#!/usr/bin/env bash
set -euo pipefail
node --check scripts/dev/standalone-server-ws.mjs
node --test tests/unit/deployment-health.test.mjs
