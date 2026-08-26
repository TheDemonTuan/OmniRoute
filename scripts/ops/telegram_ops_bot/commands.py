"""Command handler and dispatcher for Telegram Ops Bot.

Handles read-only operations (/status, /system, /containers, /omniroute, /deploy,
/logs, /backups, /security, /help), inline callbacks, redaction, and audit logging.
"""

import html
import logging
import time
from typing import Any, Dict, List, Optional, Tuple

from .github import GitHubClient as GitHubRestClient
from .github_actions import GitHubActionsManager
from .upstream import UpstreamManager
from .edge_approval import EdgeControlClient, EdgeControlError

from .config import BotConfig
from .metrics import MetricsCollector
from .security import (
    check_access,
    escape_html,
    redact_sensitive,
    truncate_message,
    verify_pin,
)
from .state import StateManager
from .telegram import TelegramClient, make_inline_keyboard


logger = logging.getLogger("telegram_ops_bot.commands")


class CommandDispatcher:
    """Dispatches incoming Telegram commands and interactive callbacks."""

    def __init__(
        self,
        config: BotConfig,
        state: StateManager,
        metrics: MetricsCollector,
        telegram: TelegramClient,
        github_client: Optional[GitHubRestClient] = None,
        actions_manager: Optional[GitHubActionsManager] = None,
        upstream_manager: Optional[UpstreamManager] = None,
        edge_client: Optional[EdgeControlClient] = None,
    ) -> None:
        self.config = config
        self.state = state
        self.metrics = metrics
        self.telegram = telegram
        self.github_client = github_client
        self.actions = actions_manager
        self.upstream = upstream_manager
        self.edge_client = edge_client

    def _format_uptime(self, seconds: float) -> str:
        """Format seconds into readable days, hours, minutes."""
        s = int(seconds)
        days, rem = divmod(s, 86400)
        hours, rem = divmod(rem, 3600)
        minutes, _ = divmod(rem, 60)
        if days > 0:
            return f"{days}d {hours}h {minutes}m"
        if hours > 0:
            return f"{hours}h {minutes}m"
        return f"{minutes}m"

    # --- Command Builders ---

    def handle_status(self) -> Tuple[str, Dict[str, Any]]:
        """Build status overview response."""
        host = self.metrics.get_host_metrics()
        omni = self.metrics.get_omniroute_info()
        containers = self.metrics.get_containers()
        running_c = sum(1 for c in containers if "healthy" in c.status.lower() or "running" in c.status.lower() or "up" in c.status.lower())

        open_breakers = [k for k, v in omni.circuit_breakers.items() if v == "OPEN"]
        breaker_txt = "🟢 All CLOSED" if not open_breakers else f"🔴 OPEN: {', '.join(open_breakers)}"

        msg = (
            "<b>🖥️ OmniRoute Ops Dashboard</b>\n\n"
            f"<b>OmniRoute Proxy:</b> <code>{escape_html(omni.status)}</code> (v{escape_html(omni.version)} : {omni.port})\n"
            f"<b>Active Requests:</b> <code>{omni.active_requests}</code>\n"
            f"<b>Circuit Breakers:</b> {breaker_txt}\n\n"
            f"<b>Host:</b> <code>{escape_html(host.hostname)}</code> (Up {self._format_uptime(host.uptime_seconds)})\n"
            f"<b>CPU:</b> <code>{host.cpu_usage_pct}%</code> (Load: {host.load_avg[0]:.2f}, {host.load_avg[1]:.2f})\n"
            f"<b>Memory:</b> <code>{host.mem_used_mb:.0f}/{host.mem_total_mb:.0f} MB ({host.mem_pct}%)</code>\n"
            f"<b>Disk:</b> <code>{host.disk_used_gb:.1f}/{host.disk_total_gb:.1f} GB ({host.disk_pct}%)</code>\n\n"
            f"<b>Containers:</b> <code>{running_c}/{len(containers)} healthy</code>"
        )

        keyboard = make_inline_keyboard([
            [("🔄 Refresh", "refresh:status"), ("📊 System", "view:system")],
            [("🐳 Containers", "view:containers"), ("⚡ OmniRoute", "view:omniroute")],
        ])
        return msg, keyboard

    def handle_system(self) -> Tuple[str, Dict[str, Any]]:
        """Build system metrics response."""
        h = self.metrics.get_host_metrics()
        msg = (
            "<b>📊 System Resource Metrics</b>\n\n"
            f"<b>Hostname:</b> <code>{escape_html(h.hostname)}</code>\n"
            f"<b>OS / Kernel:</b> <code>{escape_html(h.os_name)}</code>\n"
            f"<b>Uptime:</b> <code>{self._format_uptime(h.uptime_seconds)}</code>\n\n"
            f"<b>CPU Cores:</b> <code>{h.cpu_count}</code>\n"
            f"<b>CPU Utilization:</b> <code>{h.cpu_usage_pct}%</code>\n"
            f"<b>Load Average:</b> <code>{h.load_avg[0]:.2f} (1m), {h.load_avg[1]:.2f} (5m), {h.load_avg[2]:.2f} (15m)</code>\n\n"
            f"<b>Memory Total:</b> <code>{h.mem_total_mb:.1f} MB</code>\n"
            f"<b>Memory Used:</b> <code>{h.mem_used_mb:.1f} MB ({h.mem_pct}%)</code>\n"
            f"<b>Memory Free/Avail:</b> <code>{h.mem_free_mb:.1f} MB</code>\n\n"
            f"<b>Disk Total:</b> <code>{h.disk_total_gb:.2f} GB</code>\n"
            f"<b>Disk Used:</b> <code>{h.disk_used_gb:.2f} GB ({h.disk_pct}%)</code>\n"
            f"<b>Disk Free:</b> <code>{h.disk_free_gb:.2f} GB</code>"
        )
        keyboard = make_inline_keyboard([
            [("🔄 Refresh", "refresh:system"), ("🏠 Status", "view:status")],
        ])
        return msg, keyboard

    def handle_containers(self) -> Tuple[str, Dict[str, Any]]:
        """Build container status response."""
        containers = self.metrics.get_containers()
        lines = ["<b>🐳 Container Status</b>\n"]
        if not containers:
            lines.append("<i>No containers found or docker daemon query timed out.</i>\n<i>Tap 🔄 Refresh to retry.</i>\n")
        else:
            for c in containers:
                lines.append(
                    f"• <b>{escape_html(c.name)}</b> (<code>{escape_html(c.id)}</code>)\n"
                    f"   Status: <i>{escape_html(c.status)}</i>\n"
                    f"   Image: <code>{escape_html(c.image)}</code>\n"
                    f"   CPU: <code>{c.cpu_pct}%</code> | Mem: <code>{c.mem_usage_mb:.1f}MB</code>\n"
                )

        msg = "\n".join(lines)
        keyboard = make_inline_keyboard([
            [("🔄 Refresh", "refresh:containers"), ("📜 Logs", "view:logs")],
            [("🏠 Status", "view:status")],
        ])
        return msg, keyboard

    def handle_omniroute(self) -> Tuple[str, Dict[str, Any]]:
        """Build OmniRoute proxy details response."""
        info = self.metrics.get_omniroute_info()
        breakers = info.circuit_breakers or {}
        breaker_lines = []
        for provider, state in breakers.items():
            icon = "🟢" if state == "CLOSED" else ("🟡" if state == "HALF_OPEN" else "🔴")
            breaker_lines.append(f"   {icon} <b>{escape_html(provider)}:</b> <code>{escape_html(state)}</code>")

        breakers_str = "\n".join(breaker_lines) if breaker_lines else "   <i>No breakers active</i>"

        msg = (
            "<b>⚡ OmniRoute AI Proxy Engine</b>\n\n"
            f"<b>Status:</b> <code>{escape_html(info.status)}</code>\n"
            f"<b>Version:</b> <code>{escape_html(info.version)}</code>\n"
            f"<b>Listening Port:</b> <code>{info.port}</code>\n"
            f"<b>Active In-Flight Requests:</b> <code>{info.active_requests}</code>\n"
            f"<b>Accounts in Cooldown:</b> <code>{info.cooldown_accounts}</code>\n\n"
            f"<b>Provider Circuit Breakers:</b>\n{breakers_str}"
        )
        keyboard = make_inline_keyboard([
            [("🔄 Refresh", "refresh:omniroute"), ("🛡️ Security", "view:security")],
            [("♻️ Restart OmniRoute", "prepare:restart:app")],
            [("🏠 Status", "view:status")],
        ])
        return msg, keyboard

    def handle_deploy(self) -> Tuple[str, Dict[str, Any]]:
        """Build deployment and git release status response."""
        dep = self.metrics.get_deploy_info()
        gh = self.metrics.github_client

        gh_info_str = "<i>Not configured</i>"
        if gh and gh.is_configured():
            release = gh.get_latest_release()
            if release:
                gh_info_str = f"<code>{escape_html(release.get('tag_name', ''))}</code> ({escape_html(release.get('name', ''))})"
            else:
                gh_info_str = "<i>Configured (no release data available)</i>"

        msg = (
            "<b>🚀 Deployment & Version Information</b>\n\n"
            f"<b>Version:</b> <code>{escape_html(dep.version)}</code>\n"
            f"<b>Commit:</b> <code>{escape_html(dep.current_commit)}</code>\n"
            f"<b>Branch:</b> <code>{escape_html(dep.branch)}</code>\n"
            f"<b>Deploy Status:</b> <code>{escape_html(dep.status)}</code>\n"
            f"<b>Last Deployed:</b> <code>{escape_html(dep.last_deploy_time)}</code>\n"
            f"<b>Commit Message:</b> <code>{escape_html(dep.commit_message)}</code>\n\n"
            f"<b>GitHub Release:</b> {gh_info_str}"
        )
        keyboard = make_inline_keyboard([
            [("🔄 Refresh", "refresh:deploy"), ("⚡ OmniRoute", "view:omniroute")],
            [("🚀 Deploy", "prepare:deploy"), ("↩️ Rollback", "prepare:rollback")],
            [("🏠 Status", "view:status")],
        ])
        return msg, keyboard

    def handle_logs(self, target: Optional[str] = None) -> Tuple[str, Dict[str, Any]]:
        """Build redacted log tail response."""
        raw_logs = self.metrics.get_logs(service_or_container=target, lines=30)
        clean_logs = redact_sensitive(raw_logs)
        safe_logs = escape_html(clean_logs)

        header = f"<b>📜 Recent Logs ({escape_html(target or 'Active App')})</b>\n\n"
        # Reserve room for header and tags
        max_log_len = 4096 - len(header) - 30
        truncated_logs = truncate_message(safe_logs, max_length=max_log_len)

        msg = f"{header}<pre>{truncated_logs}</pre>"
        keyboard = make_inline_keyboard([
            [("🔄 Refresh Logs", "refresh:logs" if not target else f"view:logs:{target}"), ("🐳 Containers", "view:containers")],
            [("🏠 Status", "view:status")],
        ])
        return msg, keyboard

    def handle_backups(self) -> Tuple[str, Dict[str, Any]]:
        """Build backup information response."""
        b = self.metrics.get_backups_info()
        size_mb = round(b.size_bytes / (1024.0 * 1024.0), 2)
        msg = (
            "<b>💾 Database & Config Backups</b>\n\n"
            f"<b>Latest Backup:</b> <code>{escape_html(b.latest_backup_file)}</code>\n"
            f"<b>Timestamp:</b> <code>{escape_html(b.latest_backup_time)}</code>\n"
            f"<b>Size:</b> <code>{size_mb} MB</code>\n"
            f"<b>Status:</b> <code>{escape_html(b.status)}</code>\n"
            f"<b>Total Backups Retained:</b> <code>{b.total_backups}</code>"
        )
        keyboard = make_inline_keyboard([
            [("🔄 Refresh", "refresh:backups"), ("➕ Create backup", "prepare:backup")],
            [("📊 System", "view:system"), ("🏠 Status", "view:status")],
        ])
        return msg, keyboard

    def handle_security(self) -> Tuple[str, Dict[str, Any]]:
        """Build security summary response."""
        sec = self.metrics.get_security_metrics(state_manager=self.state)
        tunnels_str = ", ".join(sec.open_tunnels) if sec.open_tunnels else "None"

        recent_audits = self.state.get_recent_audit_logs(limit=5)
        audit_lines = []
        for a in recent_audits:
            cmd = escape_html(a.get("command", ""))
            st = escape_html(a.get("status", ""))
            ts = time.strftime("%H:%M:%S", time.gmtime(a.get("timestamp", 0)))
            audit_lines.append(f"   • <code>{ts}</code> - <b>{cmd}</b>: <i>{st}</i>")

        audit_str = "\n".join(audit_lines) if audit_lines else "   <i>No recent commands</i>"

        msg = (
            "<b>🛡️ Security & Access Posture</b>\n\n"
            f"<b>Host Firewall:</b> <code>{escape_html(sec.firewall_status)}</code>\n"
            f"<b>Locked Users:</b> <code>{sec.locked_users_count}</code>\n"
            f"<b>Failed Auth (24h):</b> <code>{sec.failed_auth_recent}</code>\n"
            f"<b>Open Breakers:</b> <code>{sec.circuit_breaker_open_count}</code>\n"
            f"<b>Active Tunnels:</b> <code>{escape_html(tunnels_str)}</code>\n\n"
            f"<b>Recent Audit Log:</b>\n{audit_str}"
        )
        keyboard = make_inline_keyboard([
            [("🔄 Refresh", "refresh:security"), ("🏠 Status", "view:status")],
        ])
        return msg, keyboard

    def handle_help(self) -> Tuple[str, Dict[str, Any]]:
        """Build help message."""
        msg = (
            "<b>🤖 OmniRoute Telegram Ops Bot Commands</b>\n\n"
            "<b>Available Read-Only Operations:</b>\n"
            "• <code>/status</code> - Operational dashboard & health overview\n"
            "• <code>/system</code> - Host CPU, RAM, Disk, Load metrics\n"
            "• <code>/containers</code> - Docker/Podman container status\n"
            "• <code>/omniroute</code> - AI Proxy engine status & circuit breakers\n"
            "• <code>/deploy</code> - Current release version, commit, & git status\n"
            "• <code>/logs [service]</code> - Tail recent sanitized service logs\n"
            "• <code>/backups</code> - SQLite database backup status\n"
            "• <code>/security</code> - Firewall, audit trails & security posture\n"
            "• <code>/upstream</code> - New upstream release commits and sync action\n"
            "• <code>/actions</code> - Production workflow runs and actions\n"
            "• <code>/prs</code> - Open sync pull requests\n"
            "• <code>/access [action]</code> - Cloudflare Edge approval state & operations\n"
            "• <code>/help</code> - Show this command list\n\n"
            "<i>Every command is owner-only and audited. Risky actions require confirmation.</i>"
        )
        keyboard = make_inline_keyboard([
            [("🏠 Status Dashboard", "view:status"), ("📊 System Metrics", "view:system")],
        ])
        return msg, keyboard

    def handle_upstream(self) -> Tuple[str, Dict[str, Any]]:
        """Show the active upstream release and fork comparison."""
        if not self.upstream:
            return "<b>⬆️ Upstream</b>\n\n<i>GitHub App is not configured.</i>", {}
        default_branch = self.upstream.get_upstream_default_branch()
        newest_branch = self.upstream.get_highest_upstream_release()
        if not newest_branch:
            return "<b>⬆️ Upstream</b>\n\nUnable to resolve an upstream release branch.", {}
        comparison = self.upstream.compare_commits(newest_branch, "prod", cross_upstream=True)
        commits = comparison.get("commits", [])[:10]
        lines = [
            "<b>⬆️ Upstream Status</b>",
            "",
            f"<b>Default branch:</b> <code>{escape_html(default_branch or 'unknown')}</code>",
            f"<b>Newest release branch:</b> <code>{escape_html(newest_branch)}</code>",
        ]
        if default_branch and newest_branch != default_branch:
            lines.append("<i>The newest release branch exists, but it is not the current default branch.</i>")
        lines.extend([
            f"<b>Newest vs prod:</b> <code>{escape_html(str(comparison.get('status', 'unknown')))}</code>",
            f"<b>Ahead / behind:</b> {comparison.get('ahead_by', 0)} / {comparison.get('behind_by', 0)}",
        ])
        for commit in commits:
            lines.append(
                f"• <code>{escape_html(str(commit.get('sha', ''))[:7])}</code> "
                f"{escape_html(str(commit.get('message', '')).splitlines()[0])}"
            )
        keyboard = make_inline_keyboard([
            [("🔄 Sync upstream", "prepare:sync"), ("🔁 Refresh", "refresh:upstream")],
            [("🏠 Status", "view:status")],
        ])
        return "\n".join(lines), keyboard

    def handle_actions(self) -> Tuple[str, Dict[str, Any]]:
        """Show recent runs for the two production workflows."""
        if not self.actions:
            return "<b>⚙️ GitHub Actions</b>\n\n<i>GitHub App is not configured.</i>", {}
        lines = ["<b>⚙️ GitHub Actions</b>", ""]
        for workflow in ("prod-deploy.yml", "prod-sync-upstream.yml"):
            payload = self.actions.list_runs(workflow, branch="prod", per_page=5)
            runs = payload.get("workflow_runs", []) if isinstance(payload, dict) else []
            lines.append(f"<b>{escape_html(workflow)}</b>")
            for run in runs[:5]:
                lines.append(
                    f"• <code>{run.get('id')}</code> {escape_html(str(run.get('status', '')))} / "
                    f"{escape_html(str(run.get('conclusion') or 'pending'))}"
                )
            if not runs:
                lines.append("• no runs")
        keyboard = make_inline_keyboard([
            [("🔨 Build only", "prepare:build"), ("🚀 Deploy", "prepare:deploy")],
            [("🔁 Refresh", "refresh:actions"), ("🏠 Status", "view:status")],
        ])
        return "\n".join(lines), keyboard

    def handle_prs(self) -> Tuple[str, Dict[str, Any]]:
        """List open sync pull requests targeting prod."""
        if not self.github_client or not self.config.github_repo:
            return "<b>🔀 Sync Pull Requests</b>\n\n<i>GitHub App is not configured.</i>", {}
        owner, repo = self.config.github_repo.split("/", 1)
        prs = self.github_client.get(
            f"/repos/{owner}/{repo}/pulls",
            params={"state": "open", "base": "prod", "per_page": 30},
        )
        sync_prs = [
            pr for pr in (prs if isinstance(prs, list) else [])
            if str(pr.get("head", {}).get("ref", "")).startswith("sync/upstream-")
        ]
        lines = ["<b>🔀 Sync Pull Requests</b>", ""]
        buttons: List[List[Tuple[str, str]]] = []
        for pr in sync_prs:
            number = int(pr["number"])
            lines.append(f"• <code>#{number}</code> {escape_html(str(pr.get('title', '')))}")
            buttons.append([(f"Merge #{number}", f"prepare:merge:{number}")])
        if not sync_prs:
            lines.append("No open sync pull request.")
        buttons.append([("🔁 Refresh", "refresh:prs"), ("🏠 Status", "view:status")])
        return "\n".join(lines), make_inline_keyboard(buttons)

    def handle_access(self, args: str = "") -> Tuple[str, Dict[str, Any]]:
        """Show edge approval status or execute access operations."""
        if not self.edge_client:
            msg = (
                "<b>🔐 Cloudflare Edge Approval Gateway</b>\n\n"
                "<i>Edge approval client is not configured (OPS_EDGE_PUBLIC_URL / OPS_EDGE_CONTROL_SECRET not set).</i>\n\n"
                "To enable edge approval, set the edge configuration in <code>/etc/omniroute/ops-bot.env</code>."
            )
            return msg, make_inline_keyboard([[("🏠 Status", "view:status")]])

        parts = args.split()
        subcmd = parts[0].lower() if parts else ""

        if subcmd == "reset" and len(parts) > 1:
            client_id = parts[1]
            try:
                res = self.edge_client.reset_access(client_id)
                msg = (
                    "<b>♻️ Edge Access Reset</b>\n\n"
                    f"<b>Client:</b> <code>{escape_html(client_id)}</code>\n"
                    f"<b>Status:</b> <code>{escape_html(str(res.get('status', 'UNKNOWN')))}</code>\n\n"
                    "<i>Client record deleted from Durable Object. Next request will prompt for approval.</i>"
                )
                return msg, make_inline_keyboard([[("🏠 Status", "view:status")]])
            except Exception as e:
                return (
                    f"❌ <b>Failed to reset access:</b> <code>{escape_html(str(e))}</code>",
                    make_inline_keyboard([[("🏠 Status", "view:status")]]),
                )

        if subcmd == "allow" and len(parts) > 1:
            client_id = parts[1]
            try:
                res = self.edge_client.send_decision(client_id, "allow")
                msg = (
                    "<b>✅ Edge Access Approved</b>\n\n"
                    f"<b>Client:</b> <code>{escape_html(client_id)}</code>\n"
                    f"<b>Status:</b> <code>{escape_html(str(res.get('status', 'APPROVED')))}</code>\n"
                    "<b>Duration:</b> 24 Hours"
                )
                return msg, make_inline_keyboard([[("🏠 Status", "view:status")]])
            except Exception as e:
                return (
                    f"❌ <b>Failed to approve access:</b> <code>{escape_html(str(e))}</code>",
                    make_inline_keyboard([[("🏠 Status", "view:status")]]),
                )

        if subcmd == "deny" and len(parts) > 1:
            client_id = parts[1]
            try:
                res = self.edge_client.send_decision(client_id, "deny")
                msg = (
                    "<b>❌ Edge Access Denied</b>\n\n"
                    f"<b>Client:</b> <code>{escape_html(client_id)}</code>\n"
                    f"<b>Status:</b> <code>{escape_html(str(res.get('status', 'DENIED')))}</code>\n"
                )
                return msg, make_inline_keyboard([[("🏠 Status", "view:status")]])
            except Exception as e:
                return (
                    f"❌ <b>Failed to deny access:</b> <code>{escape_html(str(e))}</code>",
                    make_inline_keyboard([[("🏠 Status", "view:status")]]),
                )

        # Overview
        msg = (
            "<b>🔐 Cloudflare Edge Approval Gateway</b>\n\n"
            f"<b>Edge URL:</b> <code>{escape_html(self.edge_client.edge_public_url)}</code>\n"
            "<b>Status:</b> 🟢 Active\n\n"
            "<b>Operations:</b>\n"
            "• <code>/access reset &lt;client_id&gt;</code> - Reset approval state for a key\n"
            "• <code>/access allow &lt;client_id&gt;</code> - Manually approve for 24h\n"
            "• <code>/access deny &lt;client_id&gt;</code> - Manually deny access"
        )
        return msg, make_inline_keyboard([[("🏠 Status", "view:status")]])

    def _execute_action(self, action_type: str, payload: Dict[str, Any]) -> str:
        """Execute one fixed allow-listed operation and return a redacted result."""
        try:
            if action_type == "sync" and self.actions:
                result = self.actions.dispatch_workflow("prod-sync-upstream.yml", "prod")
                return f"✅ Sync dispatched: <code>{escape_html(result['correlation_id'])}</code>"
            if action_type in {"build", "deploy"} and self.actions:
                result = self.actions.dispatch_workflow(
                    "prod-deploy.yml",
                    "prod",
                    inputs={"skip_deploy": "true" if action_type == "build" else "false"},
                )
                return f"✅ {escape_html(action_type)} dispatched: <code>{escape_html(result['correlation_id'])}</code>"
            if action_type == "merge" and self.upstream:
                number = int(payload.get("target", "0"))
                result = self.upstream.guarded_merge_sync_pr(number)
                return f"✅ Merge result: <code>{escape_html(str(result.get('message', result)))}</code>"
            if action_type == "rerun" and self.actions:
                result = self.actions.rerun_failed_jobs(int(payload.get("target", "0")))
                return f"✅ Rerun requested: <code>{escape_html(str(result))}</code>"
            if action_type == "cancel" and self.actions:
                result = self.actions.cancel_run(int(payload.get("target", "0")))
                return f"✅ Cancel requested: <code>{escape_html(str(result))}</code>"
            if action_type in {"backup", "restart", "rollback"}:
                result = self.metrics.perform_operation(
                    action_type,
                    str(payload.get("target", "")),
                )
                status = escape_html(str(result.get("status", "UNKNOWN")))
                details = result.get("error") or result.get("file") or result.get("service") or result.get("action")
                suffix = f": <code>{escape_html(str(details))}</code>" if details else ""
                icon = "✅" if status == "SUCCESS" else "❌"
                return f"{icon} {escape_html(action_type)} {status}{suffix}"
            return "⚠️ Operation is unavailable or not configured."
        except Exception as error:
            logger.exception("Operator action failed")
            return f"❌ Action failed: <code>{escape_html(redact_sensitive(str(error)))}</code>"

    # --- PIN & Nonce Verification ---

    def verify_operator_pin(self, user_id: int, pin: str) -> Tuple[bool, str]:
        """Verify operator PIN with scrypt and lockout guard."""
        if not self.config.pin_hash or not self.config.pin_salt:
            return False, "PIN protection is not configured; dangerous actions are disabled."

        is_locked, remaining = self.state.is_user_locked_out(user_id)
        if is_locked:
            return False, f"Account locked due to excessive failed attempts. Please wait {remaining} seconds."

        if verify_pin(pin, self.config.pin_hash, self.config.pin_salt):
            self.state.record_pin_success(user_id)
            return True, "PIN verified."

        is_now_locked, attempts, remaining_lockout = self.state.record_pin_failure(
            user_id=user_id,
            max_attempts=self.config.max_pin_attempts,
            lockout_duration_seconds=self.config.lockout_duration_seconds,
        )
        if is_now_locked:
            return False, f"Incorrect PIN. Account locked for {remaining_lockout} seconds."
        return False, f"Incorrect PIN. Attempt {attempts}/{self.config.max_pin_attempts}."

    # --- Dispatch entry points ---

    def dispatch_message(self, message: Dict[str, Any]) -> None:
        """Process incoming chat message."""
        user = message.get("from", {})
        user_id = user.get("id")
        chat = message.get("chat", {})
        chat_id = chat.get("id")
        chat_type = chat.get("type", "private")
        text = (message.get("text") or "").strip()

        if not text or not chat_id:
            return

        # Security check
        allowed, reason = check_access(
            user_id=user_id,
            chat_id=chat_id,
            chat_type=chat_type,
            allowed_user_ids=self.config.allowed_user_ids,
            allowed_chat_ids=self.config.allowed_chat_ids,
            require_private_chat=self.config.require_private_chat,
        )
        if not allowed:
            self.state.log_audit(
                user_id=user_id or 0,
                chat_id=chat_id,
                command=text.split()[0] if text else "unknown",
                status="DENIED",
                details=reason or "Access denied",
            )
            # Silent reject or brief rejection message
            if user_id in self.config.allowed_user_ids and self.config.require_private_chat and chat_type != "private":
                self.telegram.send_message(chat_id, f"⚠️ Access Denied: {reason}")
            return

        parts = text.split()
        raw_cmd = parts[0].lower()
        # Handle bot username mentions, e.g. /status@MyBot
        cmd = raw_cmd.split("@")[0]
        args = " ".join(parts[1:])
        audit_args = args
        if cmd == "/confirm":
            audit_args = f"{parts[1]} [REDACTED_PIN]" if len(parts) > 2 else "[REDACTED_PIN]"

        response_text = ""
        reply_markup = None

        if cmd == "/confirm":
            try:
                self.telegram.delete_message(chat_id, int(message.get("message_id", 0)))
            except Exception:
                pass
            if len(parts) != 3:
                response_text = "Usage: <code>/confirm NONCE PIN</code>"
            else:
                nonce, pin = parts[1], parts[2]
                valid_pin, pin_message = self.verify_operator_pin(user_id, pin)
                if not valid_pin:
                    response_text = f"❌ {escape_html(pin_message)}"
                else:
                    ok, consume_message, action = self.state.consume_pending_action(nonce, user_id)
                    if not ok or not action:
                        response_text = f"❌ {escape_html(consume_message)}"
                    else:
                        response_text = self._execute_action(action["action_type"], action.get("payload", {}))
        elif cmd in ("/status", "/start"):
            response_text, reply_markup = self.handle_status()
        elif cmd == "/system":
            response_text, reply_markup = self.handle_system()
        elif cmd == "/containers":
            response_text, reply_markup = self.handle_containers()
        elif cmd == "/omniroute":
            response_text, reply_markup = self.handle_omniroute()
        elif cmd == "/deploy":
            response_text, reply_markup = self.handle_deploy()
        elif cmd == "/logs":
            response_text, reply_markup = self.handle_logs(target=parts[1] if len(parts) > 1 else None)
        elif cmd == "/backups":
            response_text, reply_markup = self.handle_backups()
        elif cmd == "/security":
            response_text, reply_markup = self.handle_security()
        elif cmd == "/upstream":
            response_text, reply_markup = self.handle_upstream()
        elif cmd == "/actions":
            response_text, reply_markup = self.handle_actions()
        elif cmd == "/prs":
            response_text, reply_markup = self.handle_prs()
        elif cmd == "/access":
            response_text, reply_markup = self.handle_access(args)
        elif cmd == "/help":
            response_text, reply_markup = self.handle_help()
        else:
            response_text = (
                f"❓ Unknown command <code>{escape_html(cmd)}</code>.\n"
                "Use <code>/help</code> to view available commands."
            )
            reply_markup = make_inline_keyboard([[("📖 View Help", "view:help")]])

        self.state.log_audit(
            user_id=user_id,
            chat_id=chat_id,
            command=cmd,
            args=audit_args,
            status="SUCCESS",
            details="Command executed",
        )

        redacted_text = redact_sensitive(response_text)
        self.telegram.send_message(
            chat_id=chat_id,
            text=redacted_text,
            parse_mode="HTML",
            reply_markup=reply_markup,
        )

    def dispatch_callback_query(self, callback: Dict[str, Any]) -> None:
        """Process inline button callback query."""
        cb_id = callback.get("id", "")
        user = callback.get("from", {})
        user_id = user.get("id")
        msg = callback.get("message", {})
        chat = msg.get("chat", {})
        chat_id = chat.get("id")
        chat_type = chat.get("type", "private")
        message_id = msg.get("message_id")
        data = callback.get("data", "")

        # Access check
        allowed, reason = check_access(
            user_id=user_id,
            chat_id=chat_id,
            chat_type=chat_type,
            allowed_user_ids=self.config.allowed_user_ids,
            allowed_chat_ids=self.config.allowed_chat_ids,
            require_private_chat=self.config.require_private_chat,
        )
        if not allowed:
            self.telegram.answer_callback_query(cb_id, text=f"Unauthorized: {reason}", show_alert=True)
            return

        if data.startswith("access:"):
            parts = data.split(":")
            if len(parts) < 3:
                self.telegram.answer_callback_query(cb_id, text="Invalid access callback", show_alert=True)
                return

            if not self.edge_client:
                self.telegram.answer_callback_query(cb_id, text="Edge Gateway not configured", show_alert=True)
                return

            action_type = parts[1]
            client_id = parts[2]
            epoch_str = parts[3] if len(parts) > 3 else "1"

            if action_type == "info":
                self.telegram.answer_callback_query(
                    cb_id,
                    text=f"Client: {client_id}\nEpoch: {epoch_str}",
                    show_alert=True,
                )
                return

            try:
                if action_type == "allow":
                    self.edge_client.send_decision(
                        client_id,
                        action="allow",
                        duration_seconds=86400,
                        telegram_message_id=message_id,
                        actor=str(user_id),
                    )
                    self.telegram.answer_callback_query(cb_id, text="✅ Approved for 24h")
                    new_text = (
                        "<b>🔐 OmniRoute API Access</b>\n\n"
                        f"<b>Client:</b> <code>{escape_html(client_id)}...</code>\n\n"
                        "✅ <b>APPROVED (24 Hours)</b>\n"
                        f"<i>Approved by operator at {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}</i>"
                    )
                    new_markup = make_inline_keyboard([
                        [("❌ Revoke Access", f"access:deny:{client_id}:{epoch_str}"), ("♻️ Reset", f"access:reset:{client_id}")],
                        [("🏠 Status", "view:status")],
                    ])
                    self.state.log_audit(
                        user_id=user_id or 0,
                        chat_id=chat_id,
                        command="access:allow",
                        args=client_id,
                        status="SUCCESS",
                        details="Approved for 24h",
                    )
                elif action_type == "deny":
                    self.edge_client.send_decision(
                        client_id,
                        action="deny",
                        telegram_message_id=message_id,
                        actor=str(user_id),
                    )
                    self.telegram.answer_callback_query(cb_id, text="❌ Access Denied")
                    new_text = (
                        "<b>🔐 OmniRoute API Access</b>\n\n"
                        f"<b>Client:</b> <code>{escape_html(client_id)}...</code>\n\n"
                        "❌ <b>DENIED</b>\n"
                        f"<i>Access denied by operator at {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}</i>"
                    )
                    new_markup = make_inline_keyboard([
                        [("✅ Allow 24h", f"access:allow:{client_id}:{epoch_str}"), ("♻️ Reset", f"access:reset:{client_id}")],
                        [("🏠 Status", "view:status")],
                    ])
                    self.state.log_audit(
                        user_id=user_id or 0,
                        chat_id=chat_id,
                        command="access:deny",
                        args=client_id,
                        status="SUCCESS",
                        details="Access denied",
                    )
                elif action_type == "reset":
                    self.edge_client.reset_access(client_id, actor=str(user_id))
                    self.telegram.answer_callback_query(cb_id, text="♻️ Access Reset")
                    new_text = (
                        "<b>🔐 OmniRoute API Access</b>\n\n"
                        f"<b>Client:</b> <code>{escape_html(client_id)}...</code>\n\n"
                        "♻️ <b>ACCESS STATE RESET</b>\n"
                        "<i>Next client request will re-prompt for approval.</i>"
                    )
                    new_markup = make_inline_keyboard([
                        [("✅ Allow 24h", f"access:allow:{client_id}:1"), ("❌ Deny", f"access:deny:{client_id}:1")],
                        [("🏠 Status", "view:status")],
                    ])
                    self.state.log_audit(
                        user_id=user_id or 0,
                        chat_id=chat_id,
                        command="access:reset",
                        args=client_id,
                        status="SUCCESS",
                        details="Access reset",
                    )
                else:
                    self.telegram.answer_callback_query(cb_id, text=f"Unknown access action: {action_type}", show_alert=True)
                    return
            except Exception as err:
                self.telegram.answer_callback_query(cb_id, text=f"Edge Error: {err}", show_alert=True)
                return

            if message_id and chat_id:
                try:
                    redacted = redact_sensitive(new_text)
                    self.telegram.edit_message_text(
                        chat_id=chat_id,
                        message_id=message_id,
                        text=redacted,
                        parse_mode="HTML",
                        reply_markup=new_markup,
                    )
                except Exception as edit_err:
                    logger.debug("Failed editing message text for access callback: %s", edit_err)
            return

        self.telegram.answer_callback_query(cb_id, text="Updated")

        new_text = ""
        new_markup = None

        if data in ("refresh:status", "view:status"):
            new_text, new_markup = self.handle_status()
        elif data in ("refresh:system", "view:system"):
            new_text, new_markup = self.handle_system()
        elif data in ("refresh:containers", "view:containers"):
            new_text, new_markup = self.handle_containers()
        elif data in ("refresh:omniroute", "view:omniroute"):
            new_text, new_markup = self.handle_omniroute()
        elif data in ("refresh:deploy", "view:deploy"):
            new_text, new_markup = self.handle_deploy()
        elif data in ("refresh:logs", "view:logs") or data.startswith("view:logs:") or data.startswith("refresh:logs:"):
            target = data.split(":", 2)[2] if data.count(":") >= 2 else None
            new_text, new_markup = self.handle_logs(target=target)
        elif data in ("refresh:backups", "view:backups"):
            new_text, new_markup = self.handle_backups()
        elif data in ("refresh:security", "view:security"):
            new_text, new_markup = self.handle_security()
        elif data in ("refresh:upstream", "view:upstream"):
            new_text, new_markup = self.handle_upstream()
        elif data in ("refresh:actions", "view:actions"):
            new_text, new_markup = self.handle_actions()
        elif data in ("refresh:prs", "view:prs"):
            new_text, new_markup = self.handle_prs()
        elif data.startswith("prepare:"):
            parts = data.split(":")
            operation = parts[1]
            target = parts[2] if len(parts) > 2 else ""
            dangerous = operation in {"deploy", "merge", "rollback"} or (
                operation == "restart" and target != "app"
            )
            nonce = self.state.create_pending_action(
                user_id=user_id,
                action_type=operation,
                payload={"target": target, "dangerous": dangerous},
                ttl_seconds=60,
            )
            if dangerous:
                new_text = (
                    f"<b>🔐 Confirm {escape_html(operation)}</b>\n\n"
                    f"Target: <code>{escape_html(target or 'production')}</code>\n"
                    f"Send <code>/confirm {nonce} YOUR_PIN</code> within 60 seconds."
                )
                new_markup = make_inline_keyboard([[("Cancel", "view:status")]])
            else:
                new_text = f"Confirm <b>{escape_html(operation)}</b>?"
                new_markup = make_inline_keyboard([
                    [("✅ Confirm", f"execute:{nonce}"), ("Cancel", "view:status")]
                ])
        elif data.startswith("execute:"):
            nonce = data.split(":", 1)[1]
            ok, message, action = self.state.consume_pending_action(nonce, user_id)
            if not ok or not action:
                self.telegram.answer_callback_query(cb_id, text=message, show_alert=True)
                return
            if action.get("payload", {}).get("dangerous"):
                self.telegram.answer_callback_query(cb_id, text="PIN required", show_alert=True)
                return
            new_text = self._execute_action(action["action_type"], action.get("payload", {}))
            new_markup = make_inline_keyboard([[('🏠 Status', 'view:status')]])
        elif data == "view:help":
            new_text, new_markup = self.handle_help()
        else:
            return

        if message_id and chat_id:
            try:
                redacted = redact_sensitive(new_text)
                self.telegram.edit_message_text(
                    chat_id=chat_id,
                    message_id=message_id,
                    text=redacted,
                    parse_mode="HTML",
                    reply_markup=new_markup,
                )
            except Exception as e:
                logger.debug("Failed editing message text for callback %s: %s", data, e)
