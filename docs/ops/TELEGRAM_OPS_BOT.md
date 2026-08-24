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

The service removes any webhook for its dedicated token and uses Telegram long polling. It does
not require a new Caddy route, Cloudflare hostname, firewall rule, or inbound port.

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

## Rotation and emergency shutdown

To stop all remote operations immediately:

```bash
sudo systemctl disable --now omniroute-ops-bot
```

Then revoke the Telegram token in BotFather and suspend or uninstall the GitHub App. OmniRoute,
Caddy, Cloudflared, Redis, backups, and the blue/green deployment remain independent of this bot.
