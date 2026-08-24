"""Main service orchestrator and long-polling runner for Telegram Ops Bot.

Handles lifecycle management, signal traps, update fetching, and error recovery.
"""

import logging
import signal
import sys
import time
from typing import Any, Optional

from .alerts import AlertManager, StateManagerAlertPersistenceAdapter
from .commands import CommandDispatcher
from .config import BotConfig, load_config_from_env
from .github import GitHubClient as GitHubRestClient
from .github_actions import GitHubActionsManager
from .metrics import GitHubClient, MetricsCollector
from .upstream import UpstreamManager
from .security import redact_sensitive
from .state import StateManager
from .telegram import TelegramClient, TelegramError, TelegramUnauthorizedError


logger = logging.getLogger("telegram_ops_bot")


class TelegramOpsBot:
    """Core daemon managing the long-polling lifecycle."""

    def __init__(self, config: BotConfig) -> None:
        self.config = config
        self._running = False

        self.state = StateManager(db_path=config.db_path)
        self.telegram = TelegramClient(
            bot_token=config.bot_token,
            max_retries=config.max_retries,
            retry_backoff=config.retry_backoff,
            rate_limit_per_minute=config.rate_limit_per_minute,
        )
        legacy_github = GitHubClient(token=config.github_token, repo=config.github_repo)
        github_rest = None
        actions = None
        upstream = None
        if config.github_repo and (
            config.github_token
            or (config.github_app_id and config.github_installation_id and config.github_private_key_file)
        ):
            private_key = None
            if config.github_private_key_file:
                with open(config.github_private_key_file, "r", encoding="utf-8") as key_file:
                    private_key = key_file.read()
            github_rest = GitHubRestClient(
                token=config.github_token,
                app_id=config.github_app_id,
                private_key=private_key,
                installation_id=config.github_installation_id,
            )
            owner, repo = config.github_repo.split("/", 1)
            upstream_owner, upstream_repo = config.github_upstream_repo.split("/", 1)
            actions = GitHubActionsManager(github_rest, owner, repo)
            upstream = UpstreamManager(
                github_rest,
                owner,
                repo,
                upstream_owner=upstream_owner,
                upstream_repo=upstream_repo,
            )
        self.metrics = MetricsCollector(opsctl_path=config.opsctl_path, github_client=legacy_github)
        self.actions = actions
        self.dispatcher = CommandDispatcher(
            config=self.config,
            state=self.state,
            metrics=self.metrics,
            telegram=self.telegram,
            github_client=github_rest,
            actions_manager=actions,
            upstream_manager=upstream,
        )
        self.alerts = AlertManager(
            resource_thresholds=config.get_resource_thresholds(),
            action_thresholds=config.get_action_thresholds(),
            persistence_adapter=StateManagerAlertPersistenceAdapter(self.state),
            default_cooldown_seconds=config.alert_cooldown_seconds,
            default_debounce_consecutive=config.alert_debounce_consecutive,
        )
        self._next_alert_eval = 0.0

    def _evaluate_alerts(self) -> None:
        """Evaluate local resource alerts and send only transitions/recoveries."""
        now = time.time()
        if now < self._next_alert_eval:
            return
        self._next_alert_eval = now + self.config.alert_eval_interval_seconds
        try:
            host = self.metrics.get_host_metrics()
            events = [
                self.alerts.evaluate_cpu(host.cpu_usage_pct, host.hostname),
                self.alerts.evaluate_memory(host.mem_pct, host.hostname),
                self.alerts.evaluate_disk(host.disk_pct, "/", host.hostname),
            ]
            if self.actions:
                for workflow in ("prod-deploy.yml", "prod-sync-upstream.yml"):
                    payload = self.actions.list_runs(workflow, branch="prod", per_page=1)
                    runs = payload.get("workflow_runs", []) if isinstance(payload, dict) else []
                    if not runs:
                        continue
                    run = runs[0]
                    run_id = int(run.get("id", 0))
                    status = str(run.get("status", ""))
                    conclusion = str(run.get("conclusion") or "")
                    if status == "completed" and conclusion:
                        events.append(self.alerts.evaluate_workflow_run(workflow, conclusion, run_id))
                    elif status in {"queued", "in_progress"}:
                        created = str(run.get("created_at") or "")
                        try:
                            from datetime import datetime, timezone
                            started_at = datetime.fromisoformat(created.replace("Z", "+00:00"))
                            duration = (datetime.now(timezone.utc) - started_at).total_seconds()
                            events.append(self.alerts.evaluate_workflow_delay(workflow, duration, run_id))
                        except (TypeError, ValueError):
                            pass
            chat_id = self.config.owner_chat_id
            if chat_id is None:
                return
            for event in events:
                if event is None:
                    continue
                icon = "✅" if event.severity.value == "RECOVERY" else "🚨"
                self.telegram.send_message(
                    chat_id,
                    f"{icon} <b>{event.title}</b>\n{event.message}",
                    parse_mode="HTML",
                )
        except Exception as error:
            logger.warning("Alert evaluation failed: %s", redact_sensitive(str(error)))

    def start(self) -> None:
        """Start the long-polling event loop."""
        errors = self.config.validate()
        if errors:
            for err in errors:
                logger.error("Configuration error: %s", err)
            raise ValueError(f"Invalid configuration: {'; '.join(errors)}")

        logger.info("Verifying Telegram bot credentials...")
        try:
            bot_info = self.telegram.get_me()
            self.telegram.delete_webhook(drop_pending_updates=False)
            logger.info(
                "Connected to Telegram API successfully as @%s (id=%s)",
                bot_info.get("username", "unknown"),
                bot_info.get("id", "unknown"),
            )
        except TelegramUnauthorizedError as e:
            logger.error("Authentication failed with Telegram API: %s", e)
            raise
        except TelegramError as e:
            logger.warning("Could not reach Telegram during initial probe: %s. Continuing loop...", e)

        self._running = True
        offset = self.state.get_offset()
        logger.info("Starting Telegram long polling from offset %d...", offset)

        while self._running:
            try:
                self._evaluate_alerts()
                updates = self.telegram.get_updates(
                    offset=offset,
                    timeout=self.config.poll_timeout,
                )

                for update in updates:
                    update_id = update.get("update_id")
                    if update_id is not None:
                        offset = max(offset, update_id + 1)
                        self.state.set_offset(offset)

                    try:
                        if "message" in update:
                            self.dispatcher.dispatch_message(update["message"])
                        elif "callback_query" in update:
                            self.dispatcher.dispatch_callback_query(update["callback_query"])
                    except Exception as handler_err:
                        logger.error("Error processing update %s: %s", update_id, handler_err, exc_info=True)

            except TelegramUnauthorizedError as err:
                logger.critical("Bot token invalid or revoked: %s", err)
                self._running = False
                break
            except TelegramError as err:
                logger.warning("Transient Telegram API error: %s. Retrying...", redact_sensitive(str(err)))
                time.sleep(2.0)
            except Exception as err:
                logger.error("Unexpected error in polling loop: %s", redact_sensitive(str(err)), exc_info=True)
                time.sleep(2.0)

            if self.config.poll_interval > 0:
                time.sleep(self.config.poll_interval)

        logger.info("Telegram Ops Bot stopped cleanly.")

    def stop(self) -> None:
        """Signal the polling loop to terminate gracefully."""
        logger.info("Stopping Telegram Ops Bot...")
        self._running = False


def main(config_override: Optional[BotConfig] = None) -> int:
    """CLI and process entry point."""
    config = config_override or load_config_from_env()

    log_level_name = config.log_level or "INFO"
    log_level = getattr(logging, log_level_name.upper(), logging.INFO)
    logging.basicConfig(
        level=log_level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    validation_errors = config.validate()
    if validation_errors:
        for err in validation_errors:
            logger.error("Configuration validation failed: %s", err)
        return 1
    if config_override is None and "--check-config" in sys.argv[1:]:
        logger.info("Telegram Ops Bot configuration is valid")
        return 0

    bot = TelegramOpsBot(config)

    def _signal_handler(signum: int, frame: Any) -> None:
        signame = signal.Signals(signum).name if hasattr(signal, "Signals") else str(signum)
        logger.info("Received signal %s. Initiating graceful shutdown...", signame)
        bot.stop()

    try:
        signal.signal(signal.SIGINT, _signal_handler)
        signal.signal(signal.SIGTERM, _signal_handler)
    except (ValueError, AttributeError):
        pass

    try:
        bot.start()
        return 0
    except KeyboardInterrupt:
        bot.stop()
        return 0
    except Exception as e:
        logger.critical("Fatal error: %s", e, exc_info=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
