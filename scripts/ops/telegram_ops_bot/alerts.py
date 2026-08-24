"""Alerts subsystem with resource/action thresholds, debounce, cooldown, and persistence.

Supports CPU/memory/disk resource monitoring, action thresholds (consecutive failures,
rate limits, sync lag), debouncing transient spikes, cooldown windows for active alerts,
automatic recovery detection and notifications, and pluggable state persistence.
Python 3.9 stdlib only.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Optional, Union


class AlertSeverity(str, Enum):
    """Alert severity levels."""

    INFO = "INFO"
    WARNING = "WARNING"
    CRITICAL = "CRITICAL"
    RECOVERY = "RECOVERY"

    @property
    def rank(self) -> int:
        """Numeric rank for severity comparison."""
        ranks = {
            AlertSeverity.RECOVERY: 0,
            AlertSeverity.INFO: 1,
            AlertSeverity.WARNING: 2,
            AlertSeverity.CRITICAL: 3,
        }
        return ranks.get(self, 0)


@dataclass
class AlertEvent:
    """Represents an alert event to be dispatched to notification channels."""

    alert_key: str
    severity: AlertSeverity
    title: str
    message: str
    current_value: Optional[float] = None
    threshold_value: Optional[float] = None
    unit: str = ""
    context: Dict[str, Any] = field(default_factory=dict)
    timestamp: float = field(default_factory=time.time)

    def to_dict(self) -> Dict[str, Any]:
        """Convert alert event to a dictionary."""
        d = asdict(self)
        d["severity"] = self.severity.value
        return d


@dataclass
class ResourceThresholds:
    """Threshold settings for system resources."""

    cpu_warning_pct: float = 80.0
    cpu_critical_pct: float = 90.0
    memory_warning_pct: float = 80.0
    memory_critical_pct: float = 90.0
    disk_warning_pct: float = 80.0
    disk_critical_pct: float = 90.0


@dataclass
class ActionThresholds:
    """Threshold settings for operational actions and states."""

    consecutive_workflow_failures: int = 2
    rate_limit_warning_pct: float = 20.0  # % remaining
    rate_limit_critical_pct: float = 10.0
    sync_lag_warning_commits: int = 5
    sync_lag_critical_commits: int = 15
    workflow_delay_warning_seconds: float = 1800.0
    workflow_delay_critical_seconds: float = 3600.0


class AlertPersistenceAdapter(ABC):
    """Abstract base adapter for persisting alert state across restarts."""

    @abstractmethod
    def get_state(self, key: str) -> Optional[Dict[str, Any]]:
        """Retrieve state dict for a given alert key."""
        pass

    @abstractmethod
    def set_state(self, key: str, state: Dict[str, Any]) -> None:
        """Save state dict for a given alert key."""
        pass

    @abstractmethod
    def delete_state(self, key: str) -> None:
        """Delete state for a given alert key."""
        pass

    @abstractmethod
    def list_active_alerts(self) -> Dict[str, Dict[str, Any]]:
        """List all currently active alert states."""
        pass

    @abstractmethod
    def clear_all(self) -> None:
        """Clear all stored alert states."""
        pass


class InMemoryAlertPersistenceAdapter(AlertPersistenceAdapter):
    """In-memory alert state storage (for unit tests and ephemeral processes)."""

    def __init__(self) -> None:
        self._store: Dict[str, Dict[str, Any]] = {}

    def get_state(self, key: str) -> Optional[Dict[str, Any]]:
        return self._store.get(key)

    def set_state(self, key: str, state: Dict[str, Any]) -> None:
        self._store[key] = dict(state)

    def delete_state(self, key: str) -> None:
        self._store.pop(key, None)

    def list_active_alerts(self) -> Dict[str, Dict[str, Any]]:
        return {k: v for k, v in self._store.items() if v.get("active_severity") is not None}

    def clear_all(self) -> None:
        self._store.clear()


class FileAlertPersistenceAdapter(AlertPersistenceAdapter):
    """JSON file-based persistence adapter with atomic file writes."""

    def __init__(self, file_path: str) -> None:
        self.file_path = os.path.abspath(file_path)
        self._store: Dict[str, Dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        if os.path.isfile(self.file_path):
            try:
                with open(self.file_path, "r", encoding="utf-8") as f:
                    self._store = json.load(f)
            except Exception:
                self._store = {}
        else:
            self._store = {}

    def _save(self) -> None:
        dir_name = os.path.dirname(self.file_path)
        if dir_name and not os.path.exists(dir_name):
            os.makedirs(dir_name, exist_ok=True)

        # Atomic write via temporary file
        fd, temp_path = tempfile.mkstemp(prefix="alert_state_", suffix=".json", dir=dir_name)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(self._store, f, indent=2)
            os.replace(temp_path, self.file_path)
        except Exception:
            if os.path.exists(temp_path):
                try:
                    os.remove(temp_path)
                except OSError:
                    pass
            raise

    def get_state(self, key: str) -> Optional[Dict[str, Any]]:
        self._load()
        return self._store.get(key)

    def set_state(self, key: str, state: Dict[str, Any]) -> None:
        self._load()
        self._store[key] = dict(state)
        self._save()

    def delete_state(self, key: str) -> None:
        self._load()
        if key in self._store:
            del self._store[key]
            self._save()

    def list_active_alerts(self) -> Dict[str, Dict[str, Any]]:
        self._load()
        return {k: v for k, v in self._store.items() if v.get("active_severity") is not None}

    def clear_all(self) -> None:
        self._store = {}
        self._save()


class StateManagerAlertPersistenceAdapter(AlertPersistenceAdapter):
    """Alert persistence adapter backed by SQLite StateManager."""

    def __init__(self, state_manager: Any) -> None:
        self.state_manager = state_manager

    def get_state(self, key: str) -> Optional[Dict[str, Any]]:
        data = self.state_manager.get_alert_state(key)
        if not data:
            return None
        meta = data.get("metadata")
        if isinstance(meta, dict) and "alert_key" in meta:
            return meta
        state_str = data.get("state")
        is_active = state_str not in (None, "", "RESOLVED", "NORMAL")
        res: Dict[str, Any] = {
            "alert_key": key,
            "active_severity": state_str if is_active else None,
            "last_fired_at": float(data.get("last_notified", 0.0)),
            "consecutive_triggers": 1 if is_active else 0,
        }
        if isinstance(meta, dict):
            res.update(meta)
        return res

    def set_state(self, key: str, state: Dict[str, Any]) -> None:
        severity = state.get("active_severity")
        state_str = str(severity) if severity else "RESOLVED"
        timestamp = float(state.get("last_fired_at", 0.0)) or time.time()
        self.state_manager.set_alert_state(
            alert_key=key,
            state=state_str,
            metadata=state,
            timestamp=timestamp,
        )

    def delete_state(self, key: str) -> None:
        self.state_manager.delete_alert_state(key)

    def list_active_alerts(self) -> Dict[str, Dict[str, Any]]:
        all_states = self.state_manager.list_alert_states()
        active: Dict[str, Dict[str, Any]] = {}
        for key in all_states.keys():
            st = self.get_state(key)
            if st and st.get("active_severity") is not None:
                active[key] = st
        return active

    def clear_all(self) -> None:
        self.state_manager.clear_all_alert_states()


class AlertManager:
    """Manages alert evaluation with debounce, cooldown, and recovery lifecycle."""

    def __init__(
        self,
        persistence_adapter: Optional[AlertPersistenceAdapter] = None,
        resource_thresholds: Optional[ResourceThresholds] = None,
        action_thresholds: Optional[ActionThresholds] = None,
        default_cooldown_seconds: float = 900.0,
        default_debounce_consecutive: int = 1,
    ) -> None:
        self.persistence = persistence_adapter or InMemoryAlertPersistenceAdapter()
        self.resource_thresholds = resource_thresholds or ResourceThresholds()
        self.action_thresholds = action_thresholds or ActionThresholds()
        self.default_cooldown_seconds = default_cooldown_seconds
        self.default_debounce_consecutive = default_debounce_consecutive

    def evaluate_metric(
        self,
        alert_key: str,
        current_value: float,
        warning_threshold: float,
        critical_threshold: float,
        title: str = "",
        unit: str = "",
        higher_is_worse: bool = True,
        debounce_consecutive: Optional[int] = None,
        cooldown_seconds: Optional[float] = None,
        context: Optional[Dict[str, Any]] = None,
    ) -> Optional[AlertEvent]:
        """Evaluate a numeric metric against warning and critical thresholds.

        Handles debouncing, cooldown, escalation, and recovery detection.
        """
        debounce_target = (
            debounce_consecutive if debounce_consecutive is not None else self.default_debounce_consecutive
        )
        cooldown = cooldown_seconds if cooldown_seconds is not None else self.default_cooldown_seconds

        # Determine target severity from thresholds
        severity: Optional[AlertSeverity] = None
        threshold_val: Optional[float] = None

        if higher_is_worse:
            if current_value >= critical_threshold:
                severity = AlertSeverity.CRITICAL
                threshold_val = critical_threshold
            elif current_value >= warning_threshold:
                severity = AlertSeverity.WARNING
                threshold_val = warning_threshold
        else:
            # Lower is worse (e.g. remaining quota/rate limits)
            if current_value <= critical_threshold:
                severity = AlertSeverity.CRITICAL
                threshold_val = critical_threshold
            elif current_value <= warning_threshold:
                severity = AlertSeverity.WARNING
                threshold_val = warning_threshold

        now = time.time()
        state = self.persistence.get_state(alert_key) or {
            "alert_key": alert_key,
            "active_severity": None,
            "consecutive_triggers": 0,
            "last_fired_at": 0.0,
            "first_triggered_at": 0.0,
            "last_value": current_value,
        }

        prev_severity_str = state.get("active_severity")
        prev_severity = AlertSeverity(prev_severity_str) if prev_severity_str else None
        last_fired_at = float(state.get("last_fired_at", 0.0))
        consecutive = int(state.get("consecutive_triggers", 0))

        # Condition 1: Normal / Safe (No threshold exceeded)
        if severity is None:
            if prev_severity is not None:
                # Recovery triggered!
                recovery_event = AlertEvent(
                    alert_key=alert_key,
                    severity=AlertSeverity.RECOVERY,
                    title=f"RESOLVED: {title or alert_key}",
                    message=f"Metric recovered to normal: {current_value:.1f}{unit} (Warning threshold: {warning_threshold:.1f}{unit})",
                    current_value=current_value,
                    threshold_value=warning_threshold,
                    unit=unit,
                    context=context or {},
                    timestamp=now,
                )
                state["active_severity"] = None
                state["consecutive_triggers"] = 0
                state["last_value"] = current_value
                self.persistence.set_state(alert_key, state)
                return recovery_event
            else:
                # Normal and was normal: reset any pending debounce count
                if consecutive > 0:
                    state["consecutive_triggers"] = 0
                    self.persistence.set_state(alert_key, state)
                return None

        # Condition 2: Threshold exceeded
        consecutive += 1
        state["consecutive_triggers"] = consecutive
        state["last_value"] = current_value

        # Check debounce
        if consecutive < debounce_target:
            self.persistence.set_state(alert_key, state)
            return None

        # Check cooldown vs escalation
        is_escalation = prev_severity is None or severity.rank > prev_severity.rank
        time_since_last_fired = now - last_fired_at
        in_cooldown = (not is_escalation) and (time_since_last_fired < cooldown)

        if in_cooldown:
            # Suppressed by cooldown
            self.persistence.set_state(alert_key, state)
            return None

        # Fire alert
        operator_str = ">=" if higher_is_worse else "<="
        event = AlertEvent(
            alert_key=alert_key,
            severity=severity,
            title=title or f"{severity.value}: {alert_key}",
            message=f"Current value {current_value:.1f}{unit} {operator_str} threshold {threshold_val:.1f}{unit}",
            current_value=current_value,
            threshold_value=threshold_val,
            unit=unit,
            context=context or {},
            timestamp=now,
        )

        state["active_severity"] = severity.value
        state["last_fired_at"] = now
        self.persistence.set_state(alert_key, state)
        return event

    def evaluate_condition(
        self,
        alert_key: str,
        is_failing: bool,
        failure_severity: AlertSeverity = AlertSeverity.WARNING,
        title: str = "",
        failure_message: str = "",
        recovery_message: str = "",
        debounce_consecutive: Optional[int] = None,
        cooldown_seconds: Optional[float] = None,
        context: Optional[Dict[str, Any]] = None,
    ) -> Optional[AlertEvent]:
        """Evaluate a boolean health condition with debounce, cooldown, and recovery."""
        debounce_target = (
            debounce_consecutive if debounce_consecutive is not None else self.default_debounce_consecutive
        )
        cooldown = cooldown_seconds if cooldown_seconds is not None else self.default_cooldown_seconds

        now = time.time()
        state = self.persistence.get_state(alert_key) or {
            "alert_key": alert_key,
            "active_severity": None,
            "consecutive_triggers": 0,
            "last_fired_at": 0.0,
        }

        prev_severity_str = state.get("active_severity")
        prev_severity = AlertSeverity(prev_severity_str) if prev_severity_str else None
        last_fired_at = float(state.get("last_fired_at", 0.0))
        consecutive = int(state.get("consecutive_triggers", 0))

        if not is_failing:
            if prev_severity is not None:
                # Recovery!
                rec_event = AlertEvent(
                    alert_key=alert_key,
                    severity=AlertSeverity.RECOVERY,
                    title=f"RESOLVED: {title or alert_key}",
                    message=recovery_message or "Condition returned to healthy state.",
                    context=context or {},
                    timestamp=now,
                )
                state["active_severity"] = None
                state["consecutive_triggers"] = 0
                self.persistence.set_state(alert_key, state)
                return rec_event
            else:
                if consecutive > 0:
                    state["consecutive_triggers"] = 0
                    self.persistence.set_state(alert_key, state)
                return None

        # Condition failing
        consecutive += 1
        state["consecutive_triggers"] = consecutive

        if consecutive < debounce_target:
            self.persistence.set_state(alert_key, state)
            return None

        is_escalation = prev_severity is None or failure_severity.rank > prev_severity.rank
        in_cooldown = (not is_escalation) and ((now - last_fired_at) < cooldown)

        if in_cooldown:
            self.persistence.set_state(alert_key, state)
            return None

        event = AlertEvent(
            alert_key=alert_key,
            severity=failure_severity,
            title=title or f"{failure_severity.value}: {alert_key}",
            message=failure_message or f"Condition failure detected for {alert_key}.",
            context=context or {},
            timestamp=now,
        )

        state["active_severity"] = failure_severity.value
        state["last_fired_at"] = now
        self.persistence.set_state(alert_key, state)
        return event

    def evaluate_cpu(self, percent: float, host: str = "ops-server") -> Optional[AlertEvent]:
        """Evaluate host CPU utilization percentage."""
        return self.evaluate_metric(
            alert_key=f"resource:cpu:{host}",
            current_value=percent,
            warning_threshold=self.resource_thresholds.cpu_warning_pct,
            critical_threshold=self.resource_thresholds.cpu_critical_pct,
            title=f"CPU Utilization ({host})",
            unit="%",
            higher_is_worse=True,
            context={"host": host, "resource": "cpu"},
        )

    def evaluate_memory(self, percent: float, host: str = "ops-server") -> Optional[AlertEvent]:
        """Evaluate host memory utilization percentage."""
        return self.evaluate_metric(
            alert_key=f"resource:memory:{host}",
            current_value=percent,
            warning_threshold=self.resource_thresholds.memory_warning_pct,
            critical_threshold=self.resource_thresholds.memory_critical_pct,
            title=f"Memory Utilization ({host})",
            unit="%",
            higher_is_worse=True,
            context={"host": host, "resource": "memory"},
        )

    def evaluate_disk(self, percent: float, mount: str = "/", host: str = "ops-server") -> Optional[AlertEvent]:
        """Evaluate disk partition utilization percentage."""
        return self.evaluate_metric(
            alert_key=f"resource:disk:{host}:{mount}",
            current_value=percent,
            warning_threshold=self.resource_thresholds.disk_warning_pct,
            critical_threshold=self.resource_thresholds.disk_critical_pct,
            title=f"Disk Usage ({host} {mount})",
            unit="%",
            higher_is_worse=True,
            context={"host": host, "mount": mount, "resource": "disk"},
        )

    def evaluate_rate_limit(self, remaining: int, limit: int, resource: str = "core") -> Optional[AlertEvent]:
        """Evaluate GitHub API rate limit remaining percentage."""
        if limit <= 0:
            return None
        pct_remaining = (remaining / limit) * 100.0
        return self.evaluate_metric(
            alert_key=f"action:rate_limit:{resource}",
            current_value=pct_remaining,
            warning_threshold=self.action_thresholds.rate_limit_warning_pct,
            critical_threshold=self.action_thresholds.rate_limit_critical_pct,
            title=f"GitHub API Rate Limit ({resource})",
            unit="%",
            higher_is_worse=False,  # lower % remaining is worse
            context={"remaining": remaining, "limit": limit, "resource": resource},
        )

    def evaluate_sync_lag(
        self,
        behind_commits: int,
        upstream_branch: str = "release/v*",
    ) -> Optional[AlertEvent]:
        """Evaluate upstream commit synchronization lag."""
        return self.evaluate_metric(
            alert_key="action:sync_lag",
            current_value=float(behind_commits),
            warning_threshold=float(self.action_thresholds.sync_lag_warning_commits),
            critical_threshold=float(self.action_thresholds.sync_lag_critical_commits),
            title="Upstream Sync Lag",
            unit=" commits",
            higher_is_worse=True,
            context={"behind_commits": behind_commits, "upstream_branch": upstream_branch},
        )

    def evaluate_workflow_run(
        self,
        workflow_id: str,
        conclusion: str,
        run_id: int,
    ) -> Optional[AlertEvent]:
        """Evaluate workflow completion status and trigger alert on consecutive failures."""
        is_failed = conclusion in ("failure", "timed_out")
        return self.evaluate_condition(
            alert_key=f"workflow:{workflow_id}",
            is_failing=is_failed,
            failure_severity=AlertSeverity.CRITICAL if conclusion == "failure" else AlertSeverity.WARNING,
            title=f"Workflow Run Failure: {workflow_id}",
            failure_message=f"Workflow {workflow_id} run #{run_id} finished with conclusion '{conclusion}'.",
            recovery_message=f"Workflow {workflow_id} run #{run_id} succeeded.",
            debounce_consecutive=self.action_thresholds.consecutive_workflow_failures,
            context={"workflow_id": workflow_id, "run_id": run_id, "conclusion": conclusion},
        )

    def evaluate_workflow_delay(
        self,
        workflow_id: str,
        duration_seconds: float,
        run_id: Optional[int] = None,
    ) -> Optional[AlertEvent]:
        """Evaluate workflow run delay/duration against thresholds."""
        return self.evaluate_metric(
            alert_key=f"workflow:delay:{workflow_id}",
            current_value=duration_seconds,
            warning_threshold=self.action_thresholds.workflow_delay_warning_seconds,
            critical_threshold=self.action_thresholds.workflow_delay_critical_seconds,
            title=f"Workflow Run Delay: {workflow_id}",
            unit="s",
            higher_is_worse=True,
            context={"workflow_id": workflow_id, "run_id": run_id},
        )


def format_telegram_alert(event: AlertEvent) -> str:
    """Format an AlertEvent into a Telegram-ready Markdown message."""
    emoji_map = {
        AlertSeverity.CRITICAL: "🚨",
        AlertSeverity.WARNING: "⚠️",
        AlertSeverity.INFO: "ℹ️",
        AlertSeverity.RECOVERY: "✅",
    }
    emoji = emoji_map.get(event.severity, "📢")
    utc_time_str = datetime.fromtimestamp(event.timestamp, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    lines = [
        f"{emoji} **[{event.severity.value}] {event.title}**",
        "",
        f"📝 {event.message}",
    ]

    if event.current_value is not None and event.threshold_value is not None:
        lines.append(f"📊 **Value**: `{event.current_value:.1f}{event.unit}` | **Threshold**: `{event.threshold_value:.1f}{event.unit}`")

    if event.context:
        ctx_parts = [f"`{k}={v}`" for k, v in event.context.items() if k not in ("raw", "data")]
        if ctx_parts:
            lines.append(f"🏷️ **Context**: {', '.join(ctx_parts)}")

    lines.append(f"🕒 **Time**: `{utc_time_str}`")
    return "\n".join(lines)
