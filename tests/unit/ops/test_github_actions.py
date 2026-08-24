"""Unit tests for GitHub Actions management with allowlist and correlation tracking."""

import json
import unittest
from unittest.mock import MagicMock

from scripts.ops.telegram_ops_bot.github import GitHubClient, GitHubError
from scripts.ops.telegram_ops_bot.github_actions import (
    GitHubActionsManager,
    WorkflowNotAllowedError,
    generate_correlation_id,
    normalize_workflow_name,
)


class TestGitHubActionsManager(unittest.TestCase):
    def setUp(self):
        self.mock_client = MagicMock(spec=GitHubClient)
        self.manager = GitHubActionsManager(
            client=self.mock_client,
            owner="my-fork",
            repo="OmniRoute",
        )

    def test_workflow_allowlist_validation(self):
        # Allowed workflows
        self.assertEqual(self.manager.validate_workflow("prod-deploy.yml"), "prod-deploy.yml")
        self.assertEqual(self.manager.validate_workflow(".github/workflows/prod-sync-upstream.yml"), "prod-sync-upstream.yml")

        # Disallowed workflows
        with self.assertRaises(WorkflowNotAllowedError):
            self.manager.validate_workflow("ci.yml")

        with self.assertRaises(WorkflowNotAllowedError):
            self.manager.validate_workflow("nightly-security.yml")

    def test_custom_allowed_workflows(self):
        custom_manager = GitHubActionsManager(
            client=self.mock_client,
            owner="my-fork",
            repo="OmniRoute",
            allowed_workflows={"custom-deploy.yml"},
        )
        self.assertEqual(custom_manager.validate_workflow("custom-deploy.yml"), "custom-deploy.yml")
        with self.assertRaises(WorkflowNotAllowedError):
            custom_manager.validate_workflow("prod-deploy.yml")

    def test_correlation_id_generation(self):
        cid1 = generate_correlation_id(prefix="ops-test")
        cid2 = generate_correlation_id(prefix="ops-test")
        self.assertTrue(cid1.startswith("ops-test-"))
        self.assertNotEqual(cid1, cid2)

    def test_list_runs(self):
        self.mock_client.get.return_value = {"total_count": 1, "workflow_runs": [{"id": 123}]}

        runs = self.manager.list_runs(
            workflow_id="prod-deploy.yml",
            branch="prod",
            status="completed",
            event="workflow_dispatch",
            per_page=10,
            page=2,
        )

        self.assertEqual(runs["total_count"], 1)
        self.mock_client.get.assert_called_once_with(
            "/repos/my-fork/OmniRoute/actions/workflows/prod-deploy.yml/runs",
            params={"per_page": 10, "page": 2, "branch": "prod", "status": "completed", "event": "workflow_dispatch"},
        )

    def test_get_run_and_list_jobs(self):
        self.mock_client.get.return_value = {"id": 12345, "status": "completed"}
        run_data = self.manager.get_run(12345)
        self.assertEqual(run_data["id"], 12345)
        self.mock_client.get.assert_called_with("/repos/my-fork/OmniRoute/actions/runs/12345")

        self.mock_client.get.return_value = {"jobs": [{"id": 99, "name": "build"}]}
        jobs = self.manager.list_jobs(12345)
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["name"], "build")

    def test_dispatch_workflow_with_correlation_id(self):
        self.mock_client.post.return_value = {}

        result = self.manager.dispatch_workflow(
            workflow_id="prod-sync-upstream.yml",
            ref="prod",
            inputs={"target_branch": "release/v3.8.40"},
            correlation_id="test-cid-1234",
        )

        self.assertTrue(result["dispatched"])
        self.assertEqual(result["correlation_id"], "test-cid-1234")
        self.assertEqual(result["inputs"]["ops_request_id"], "test-cid-1234")
        self.assertEqual(result["inputs"]["target_branch"], "release/v3.8.40")

        self.mock_client.post.assert_called_once_with(
            "/repos/my-fork/OmniRoute/actions/workflows/prod-sync-upstream.yml/dispatches",
            json_data={
                "ref": "prod",
                "inputs": {
                    "target_branch": "release/v3.8.40",
                    "ops_request_id": "test-cid-1234",
                },
            },
        )

    def test_dispatch_workflow_coerces_all_input_values_to_strings(self):
        self.mock_client.post.return_value = {}

        result = self.manager.dispatch_workflow(
            workflow_id="prod-deploy.yml",
            ref="prod",
            inputs={"skip_deploy": True, "attempt": 2},
            correlation_id="test-cid-strings",
        )

        self.assertEqual(
            result["inputs"],
            {
                "skip_deploy": "true",
                "attempt": "2",
                "ops_request_id": "test-cid-strings",
            },
        )

    def test_rerun_and_cancel(self):
        self.mock_client.post.return_value = {}
        res_rerun = self.manager.rerun_failed_jobs(1001)
        self.assertTrue(res_rerun["rerun"])
        self.mock_client.post.assert_called_with("/repos/my-fork/OmniRoute/actions/runs/1001/rerun-failed-jobs")

        res_cancel = self.manager.cancel_run(1001)
        self.assertTrue(res_cancel["cancelled"])
        self.mock_client.post.assert_called_with("/repos/my-fork/OmniRoute/actions/runs/1001/cancel")

    def test_get_failed_logs_summary_no_failures(self):
        self.mock_client.get.return_value = {
            "jobs": [
                {"id": 1, "name": "test", "conclusion": "success", "status": "completed", "steps": []},
            ]
        }
        summary = self.manager.get_failed_logs_summary(555)
        self.assertFalse(summary["has_failures"])
        self.assertEqual(summary["failed_jobs_count"], 0)
        self.assertIn("No failed jobs found", summary["summary_text"])

    def test_get_failed_logs_summary_with_failures_and_redaction(self):
        jobs_payload = {
            "jobs": [
                {
                    "id": 200,
                    "name": "deploy-job",
                    "conclusion": "failure",
                    "status": "completed",
                    "steps": [
                        {"name": "Checkout", "number": 1, "conclusion": "success"},
                        {"name": "Deploy script", "number": 2, "conclusion": "failure"},
                    ],
                }
            ]
        }

        def mock_get(path, headers=None, **kwargs):
            if path.endswith("/jobs"):
                return jobs_payload
            elif path.endswith("/logs"):
                return (
                    "2026-08-24T12:00:00Z Initializing step\n"
                    "2026-08-24T12:00:01Z Running deploy with token ghp_supersecrettoken1234567890abcdef\n"
                    "2026-08-24T12:00:02Z ##[error] Fatal: Connection refused to production endpoint\n"
                    "2026-08-24T12:00:03Z Error: deploy failed with exit code 1"
                )
            return {}

        self.mock_client.get.side_effect = mock_get

        summary = self.manager.get_failed_logs_summary(777)
        self.assertTrue(summary["has_failures"])
        self.assertEqual(summary["failed_jobs_count"], 1)

        failed_job = summary["failed_jobs"][0]
        self.assertEqual(failed_job["job_name"], "deploy-job")
        self.assertEqual(len(failed_job["failed_steps"]), 1)
        self.assertEqual(failed_job["failed_steps"][0]["step_name"], "Deploy script")

        # Check redaction in summary text
        summary_text = summary["summary_text"]
        self.assertNotIn("ghp_supersecrettoken", summary_text)
        self.assertIn("Fatal: Connection refused", summary_text)
        self.assertIn("Deploy script", summary_text)


if __name__ == "__main__":
    unittest.main()
