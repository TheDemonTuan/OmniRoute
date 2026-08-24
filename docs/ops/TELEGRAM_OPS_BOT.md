---
title: Telegram Ops Bot
---

# Telegram Ops Bot

The fork's Telegram Ops Bot is a private, host-level operations service. It is separate from the
Telegram chat and Mini App integration in `src/lib/telegram/` and remains available while the
OmniRoute application container restarts.

## Security model

- Use a dedicated BotFather token, not the chat bot token.
- The service accepts updates only when both the Telegram user ID and private chat ID match the
  configured owner.
- The bot exposes a fixed command set. It cannot execute arbitrary shell commands, paths, Docker
  services, pull requests, or workflows.
- Destructive actions use an expiring one-time confirmation and a scrypt-hashed PIN.
- GitHub access uses an installation token minted from a GitHub App private key. Installation
  tokens are cached in memory only.
- The service runs as `omniroute-ops`; privileged host actions go through the root-owned,
  allow-listed `omniroute_opsctl.py` helper configured in `infra/sudoers/omniroute-ops-bot`.
- Database restore, firewall changes, SSH-key changes, package installation, and Docker pruning are
  intentionally unavailable.

## Files on the VPS

| Path                                            | Purpose                                                           |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| `/opt/omniroute/ops-bot/current/`               | Versioned bot source installed by the production deploy           |
| `/var/lib/omniroute-ops/ops.sqlite`             | Telegram offset, audit trail, pending actions, and alert state    |
| `/etc/omniroute/ops-bot.env`                    | Telegram IDs, bot token, GitHub App IDs, thresholds, and PIN hash |
| `/etc/omniroute/github-app.pem`                 | GitHub App private key                                            |
| `/usr/local/sbin/omniroute-opsctl`              | Fixed-operation privileged helper                                 |
| `/etc/systemd/system/omniroute-ops-bot.service` | systemd unit                                                      |

All secret files must be root-owned and mode `0640`, with group `omniroute-ops`.

## GitHub App permissions

Install the GitHub App only on `TheDemonTuan/OmniRoute` with these repository permissions:

- Metadata: read
- Actions: read and write
- Checks: read
- Commit statuses: read
- Pull requests: read and write
- Contents: read and write

Contents write is required only for GitHub's merge pull request endpoint. The bot additionally
restricts merges to non-draft, green `sync/upstream-*` pull requests targeting `prod`.

## Configuration

Copy `infra/ops-bot.env.example` to `/etc/omniroute/ops-bot.env` and fill the values. Generate the
PIN material locally without storing the plaintext PIN:

```bash
read -rsp 'Operations PIN: ' OPS_PIN; echo
OPS_PIN="$OPS_PIN" python3 - <<'PY'
import os
from scripts.ops.telegram_ops_bot.security import hash_pin
pin_hash, pin_salt = hash_pin(os.environ.pop("OPS_PIN"))
print(f"OPS_PIN_SCRYPT_HASH_B64={pin_hash}")
print(f"OPS_PIN_SALT_B64={pin_salt}")
PY
unset OPS_PIN
```

Despite the historical variable suffix, the current values are hexadecimal scrypt output and
salt, matching `security.py` exactly.

Find the owner IDs by sending a message to the new bot while temporarily running the bot in
configuration-check mode, or via Telegram's `getUpdates` endpoint. Configure both IDs; never rely
on usernames because they can change.

Validate and start the service:

```bash
sudo systemctl daemon-reload
sudo -u omniroute-ops /opt/omniroute/ops-bot/current/main.py --check-config
sudo systemctl enable --now omniroute-ops-bot
sudo systemctl status omniroute-ops-bot
sudo journalctl -u omniroute-ops-bot -n 100 --no-pager
```

## Update intake: webhook or polling

`OPS_TELEGRAM_MODE` selects how updates arrive. Both modes share the same command handling,
authorization, and alerting.

An existing `/etc/omniroute/ops-bot.env` is never overwritten by a deploy, so a box provisioned
before webhook support has no `OPS_TELEGRAM_MODE` line and keeps long polling — the code default
is `polling`, deliberately, so shipping this could not change how a running bot receives commands.
Webhook mode starts when you add the variables below by hand and restart the service.

**`webhook` (what the example env file configures).** Telegram POSTs each update to
`https://<host>/tg-ops/<OPS_WEBHOOK_PATH_SECRET>`, which Cloudflare Tunnel and Caddy forward to the
bot's listener on the host. Two independent checks guard it: the path segment is a secret, and
`X-Telegram-Bot-Api-Secret-Token` must match `OPS_WEBHOOK_SECRET_TOKEN` under a constant-time
compare. Anything else gets 404 or 401 with no body logged, because an update body can contain a
PIN.

Caddy runs in a container, so it cannot reach `127.0.0.1` on the host. `compose.yml` maps
`host.docker.internal:host-gateway` for the Caddy service and the listener binds
`OPS_WEBHOOK_HOST` (use `0.0.0.0`); `bootstrap-vps.sh` opens the port to `172.16.0.0/12` only, so
it stays closed to the internet under the default-deny policy.

Every delivery is acknowledged with 200 as soon as it is queued, and handled on a worker thread.
This is not an optimization: `rollback` is allowed 420 seconds, and answering Telegram only after
it finished would exceed the delivery timeout and earn a redelivery of the same `update_id` — a
second, unrequested run of a destructive action. The persisted offset in `bot_state` rejects any
`update_id` already seen.

**`polling`.** The bot deletes any webhook for its token and long-polls instead, needing only
outbound connectivity — no Caddy route, Cloudflare hostname, firewall rule, or inbound port.

**Which to run.** Webhook mode depends on cloudflared and Caddy, which are exactly the services
this bot exists to restart. If inbound breaks, outgoing alerts still arrive, but commands do not.
Recover by switching modes over SSH:

```bash
sudo sed -i 's/^OPS_TELEGRAM_MODE=.*/OPS_TELEGRAM_MODE=polling/' /etc/omniroute/ops-bot.env
sudo systemctl restart omniroute-ops-bot
```

Verify a webhook registration with Telegram's own view of it:

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

`url` should be the configured endpoint, `pending_update_count` should settle at 0, and
`last_error_message` should be absent.

## Commands

Read-only commands include `/status`, `/system`, `/containers`, `/omniroute`, `/deploy`,
`/upstream`, `/actions`, `/prs`, `/logs`, `/backups`, `/security`, and `/help`.

Actions are shown as inline buttons. Backup creation, failed-job rerun, cancellation, and an
OmniRoute restart require a second confirmation. Production deploy, sync-PR merge, rollback, and
restart of Caddy, Cloudflared, or Redis additionally require the configured PIN within 60 seconds.

Database restore is deliberately not implemented. Restore remains an SSH-only maintenance
procedure from `infra/README.md`.

## Alerts

The service polls local resources and GitHub Actions, persists state, and sends transition-based
alerts. Defaults include CPU/load/RAM pressure sustained for five minutes, swap use, disk at 80%
and 90%, container exit/unhealthy/restart, Actions queue delay, Actions excessive duration,
failure, and recovery. Identical alerts use a 30-minute cooldown to avoid message storms.

Evaluation runs on its own thread rather than in front of the update loop, so an operator command
never waits behind an `opsctl` spawn and two GitHub API calls. Those listing calls are conditional
(`If-None-Match`); an unchanged listing returns 304, which GitHub does not bill against the
installation rate limit.

Set `OPS_ALERT_ACTIONS_DELAY_*` above the real build time, not below it. A production build takes
5-17 minutes, so a 300-second warning threshold fires on every healthy deploy and trains you to
ignore the channel. The shipped defaults are 1800s warning / 3600s critical.

Tune the cost of alerting with `OPS_ALERT_INTERVAL_SECONDS`: each evaluation is one `sudo opsctl
system` spawn plus two GitHub calls. `OPS_ALERT_DEBOUNCE_CONSECUTIVE` multiplies it — interval 60s
with debounce 5 means a resource alert fires after five sustained minutes.

## Rotation and emergency shutdown

To stop all remote operations immediately:

```bash
sudo systemctl disable --now omniroute-ops-bot
```

Then revoke the Telegram token in BotFather and suspend or uninstall the GitHub App. OmniRoute,
Caddy, Cloudflared, Redis, backups, and the blue/green deployment remain independent of this bot.
