"""Unit tests for the alerts subsystem: thresholds, debounce, cooldown, recovery, and persistence."""

import os
import tempfile
import time
import unittest

from scripts.ops.telegram_ops_bot.alerts import (
    ActionThresholds,
    AlertEvent,
    AlertManager,
    AlertSeverity,
    FileAlertPersistenceAdapter,
    InMemoryAlertPersistenceAdapter,
    ResourceThresholds,
    format_telegram_alert,
)


class TestAlertsSubsystem(unittest.TestCase):
    def test_alert_severity_ranks(self):
        self.assertGreater(AlertSeverity.CRITICAL.rank, AlertSeverity.WARNING.rank)
        self.assertGreater(AlertSeverity.WARNING.rank, AlertSeverity.INFO.rank)
        self.assertGreater(AlertSeverity.INFO.rank, AlertSeverity.RECOVERY.rank)

    def test_in_memory_persistence_adapter(self):
        adapter = InMemoryAlertPersistenceAdapter()
        self.assertIsNone(adapter.get_state("key1"))

        adapter.set_state("key1", {"active_severity": "WARNING", "count": 1})
        self.assertEqual(adapter.get_state("key1")["count"], 1)

        active = adapter.list_active_alerts()
        self.assertIn("key1", active)

        adapter.delete_state("key1")
        self.assertIsNone(adapter.get_state("key1"))
        self.assertEqual(len(adapter.list_active_alerts()), 0)

    def test_file_persistence_adapter(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            fpath = os.path.join(tmpdir, "alerts_state.json")
            adapter1 = FileAlertPersistenceAdapter(fpath)
            adapter1.set_state("cpu_alert", {"active_severity": "CRITICAL", "last_value": 95.0})

            # Verify saved to disk and reloadable by another instance
            self.assertTrue(os.path.exists(fpath))
            adapter2 = FileAlertPersistenceAdapter(fpath)
            state = adapter2.get_state("cpu_alert")
            self.assertIsNotNone(state)
            self.assertEqual(state["active_severity"], "CRITICAL")
            self.assertEqual(state["last_value"], 95.0)

            adapter2.delete_state("cpu_alert")
            self.assertIsNone(adapter2.get_state("cpu_alert"))

    def test_evaluate_metric_normal_no_alert(self):
        mgr = AlertManager()
        evt = mgr.evaluate_metric(
            alert_key="cpu",
            current_value=50.0,
            warning_threshold=80.0,
            critical_threshold=90.0,
        )
        self.assertIsNone(evt)

    def test_evaluate_metric_debounce(self):
        mgr = AlertManager(default_debounce_consecutive=2)

        # 1st time over threshold (debounced)
        evt1 = mgr.evaluate_metric(
            alert_key="cpu",
            current_value=85.0,
            warning_threshold=80.0,
            critical_threshold=90.0,
        )
        self.assertIsNone(evt1)

        # 2nd time over threshold (fires warning)
        evt2 = mgr.evaluate_metric(
            alert_key="cpu",
            current_value=86.0,
            warning_threshold=80.0,
            critical_threshold=90.0,
        )
        self.assertIsNotNone(evt2)
        self.assertEqual(evt2.severity, AlertSeverity.WARNING)

    def test_evaluate_metric_cooldown_and_escalation(self):
        mgr = AlertManager(default_debounce_consecutive=1, default_cooldown_seconds=600.0)

        # 1. First alert fires WARNING
        evt1 = mgr.evaluate_metric(
            alert_key="mem",
            current_value=82.0,
            warning_threshold=80.0,
            critical_threshold=90.0,
        )
        self.assertIsNotNone(evt1)
        self.assertEqual(evt1.severity, AlertSeverity.WARNING)

        # 2. Repeated WARNING within cooldown -> Suppressed (None)
        evt2 = mgr.evaluate_metric(
            alert_key="mem",
            current_value=85.0,
            warning_threshold=80.0,
            critical_threshold=90.0,
        )
        self.assertIsNone(evt2)

        # 3. Escalation to CRITICAL -> Bypasses cooldown and fires immediately!
        evt3 = mgr.evaluate_metric(
            alert_key="mem",
            current_value=95.0,
            warning_threshold=80.0,
            critical_threshold=90.0,
        )
        self.assertIsNotNone(evt3)
        self.assertEqual(evt3.severity, AlertSeverity.CRITICAL)

    def test_evaluate_metric_recovery(self):
        mgr = AlertManager(default_debounce_consecutive=1)

        # 1. Trigger alert
        evt_alert = mgr.evaluate_metric(
            alert_key="disk",
            current_value=92.0,
            warning_threshold=80.0,
            critical_threshold=90.0,
        )
        self.assertEqual(evt_alert.severity, AlertSeverity.CRITICAL)

        # 2. Value returns to normal -> Emits RECOVERY
        evt_rec = mgr.evaluate_metric(
            alert_key="disk",
            current_value=60.0,
            warning_threshold=80.0,
            critical_threshold=90.0,
        )
        self.assertIsNotNone(evt_rec)
        self.assertEqual(evt_rec.severity, AlertSeverity.RECOVERY)
        self.assertIn("RESOLVED", evt_rec.title)

        # 3. Subsequent normal evaluation -> Returns None (no duplicate recovery)
        evt_normal = mgr.evaluate_metric(
            alert_key="disk",
            current_value=55.0,
            warning_threshold=80.0,
            critical_threshold=90.0,
        )
        self.assertIsNone(evt_normal)

    def test_evaluate_rate_limit_lower_is_worse(self):
        mgr = AlertManager(
            action_thresholds=ActionThresholds(rate_limit_warning_pct=20.0, rate_limit_critical_pct=10.0),
            default_debounce_consecutive=1,
        )

        # Normal remaining (80%)
        self.assertIsNone(mgr.evaluate_rate_limit(remaining=4000, limit=5000))

        # Warning remaining (15% <= 20%)
        evt_warn = mgr.evaluate_rate_limit(remaining=750, limit=5000)
        self.assertIsNotNone(evt_warn)
        self.assertEqual(evt_warn.severity, AlertSeverity.WARNING)

        # Critical remaining (5% <= 10%) -> Escalates
        evt_crit = mgr.evaluate_rate_limit(remaining=250, limit=5000)
        self.assertIsNotNone(evt_crit)
        self.assertEqual(evt_crit.severity, AlertSeverity.CRITICAL)

    def test_evaluate_sync_lag(self):
        mgr = AlertManager(
            action_thresholds=ActionThresholds(sync_lag_warning_commits=5, sync_lag_critical_commits=15),
            default_debounce_consecutive=1,
        )

        self.assertIsNone(mgr.evaluate_sync_lag(behind_commits=3))

        evt = mgr.evaluate_sync_lag(behind_commits=8)
        self.assertIsNotNone(evt)
        self.assertEqual(evt.severity, AlertSeverity.WARNING)

    def test_evaluate_workflow_run_failure(self):
        mgr = AlertManager(
            action_thresholds=ActionThresholds(consecutive_workflow_failures=2),
        )

        # 1st failure (debounced)
        self.assertIsNone(mgr.evaluate_workflow_run("prod-deploy.yml", conclusion="failure", run_id=101))

        # 2nd consecutive failure (fires)
        evt = mgr.evaluate_workflow_run("prod-deploy.yml", conclusion="failure", run_id=102)
        self.assertIsNotNone(evt)
        self.assertEqual(evt.severity, AlertSeverity.CRITICAL)

        # Successful run -> Recovery
        evt_rec = mgr.evaluate_workflow_run("prod-deploy.yml", conclusion="success", run_id=103)
        self.assertIsNotNone(evt_rec)
        self.assertEqual(evt_rec.severity, AlertSeverity.RECOVERY)

    def test_evaluate_workflow_run_deduplication(self):
        mgr = AlertManager(
            action_thresholds=ActionThresholds(consecutive_workflow_failures=1),
        )

        # 1st failure fires
        evt1 = mgr.evaluate_workflow_run("prod-deploy.yml", conclusion="failure", run_id=201)
        self.assertIsNotNone(evt1)
        self.assertEqual(evt1.severity, AlertSeverity.CRITICAL)

        # Repeated polling of the exact same run_id returns None (no duplicate spam)
        self.assertIsNone(mgr.evaluate_workflow_run("prod-deploy.yml", conclusion="failure", run_id=201))
        self.assertIsNone(mgr.evaluate_workflow_run("prod-deploy.yml", conclusion="failure", run_id=201))

        # Distinct new failure fires
        evt2 = mgr.evaluate_workflow_run("prod-deploy.yml", conclusion="failure", run_id=202)
        self.assertIsNotNone(evt2)

        # Repeated polling of run_id 202 returns None
        self.assertIsNone(mgr.evaluate_workflow_run("prod-deploy.yml", conclusion="failure", run_id=202))

        # Recovery on new run_id 203 fires once
        evt_rec = mgr.evaluate_workflow_run("prod-deploy.yml", conclusion="success", run_id=203)
        self.assertIsNotNone(evt_rec)
        self.assertEqual(evt_rec.severity, AlertSeverity.RECOVERY)

        # Repeated polling of recovery run_id 203 returns None
        self.assertIsNone(mgr.evaluate_workflow_run("prod-deploy.yml", conclusion="success", run_id=203))

    def test_format_telegram_alert(self):
        evt = AlertEvent(
            alert_key="resource:cpu:server1",
            severity=AlertSeverity.CRITICAL,
            title="CPU Utilization (server1)",
            message="Current value 95.0% >= threshold 90.0%",
            current_value=95.0,
            threshold_value=90.0,
            unit="%",
            context={"host": "server1", "env": "prod"},
            timestamp=1724500000.0,
        )
        msg = format_telegram_alert(evt)
        self.assertIn("🚨", msg)
        self.assertIn("[CRITICAL]", msg)
        self.assertIn("CPU Utilization (server1)", msg)
        self.assertIn("`95.0%`", msg)
        self.assertIn("`host=server1`", msg)
        self.assertIn("UTC", msg)

        # Test recovery formatting
        rec_evt = AlertEvent(
            alert_key="resource:cpu:server1",
            severity=AlertSeverity.RECOVERY,
            title="RESOLVED: CPU Utilization (server1)",
            message="Metric recovered to normal: 45.0%",
            current_value=45.0,
            threshold_value=80.0,
            unit="%",
            timestamp=1724501000.0,
        )
        rec_msg = format_telegram_alert(rec_evt)
        self.assertIn("✅", rec_msg)
        self.assertIn("[RECOVERY]", rec_msg)


if __name__ == "__main__":
    unittest.main()
