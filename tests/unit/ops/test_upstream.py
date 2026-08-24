"""Unit tests for upstream release resolution, commit comparison, and guarded sync PR merging."""

import unittest
from unittest.mock import MagicMock

from scripts.ops.telegram_ops_bot.github import GitHubClient
from scripts.ops.telegram_ops_bot.upstream import (
    UpstreamManager,
    parse_semver,
    release_branch_from_sync_head,
    resolve_highest_semver,
    semver_sort_key,
)


class TestUpstreamManager(unittest.TestCase):
    def setUp(self):
        self.mock_client = MagicMock(spec=GitHubClient)
        self.upstream = UpstreamManager(
            client=self.mock_client,
            fork_owner="my-fork",
            fork_repo="OmniRoute",
            upstream_owner="diegosouzapw",
            upstream_repo="OmniRoute",
        )

    def test_parse_semver(self):
        self.assertEqual(parse_semver("release/v3.8.40"), (3, 8, 40, 1, ""))
        self.assertEqual(parse_semver("v3.10.1"), (3, 10, 1, 1, ""))
        self.assertEqual(parse_semver("3.9.0"), (3, 9, 0, 1, ""))
        self.assertEqual(parse_semver("release/v3.8.41-rc1"), (3, 8, 41, 0, "rc1"))
        self.assertIsNone(parse_semver("main"))
        self.assertIsNone(parse_semver("feat/my-feature"))

    def test_release_branch_from_sync_head(self):
        self.assertEqual(
            release_branch_from_sync_head("sync/upstream-release-v3.8.41"),
            "release/v3.8.41",
        )
        self.assertEqual(
            release_branch_from_sync_head("sync/upstream-v3.8.41"),
            "release/v3.8.41",
        )
        self.assertIsNone(release_branch_from_sync_head("feat/unrelated"))

    def test_resolve_highest_semver(self):
        branches = [
            "main",
            "release/v3.8.39",
            "release/v3.8.40",
            "release/v3.9.0",
            "release/v3.10.0",
            "release/v3.10.1-rc1",
            "release/v3.10.1",
            "feat/unrelated",
        ]
        highest = resolve_highest_semver(branches, prefix="release/v")
        self.assertEqual(highest, "release/v3.10.1")

        # Verify numeric comparison: v3.10.0 > v3.9.0
        subset = ["release/v3.9.0", "release/v3.10.0"]
        self.assertEqual(resolve_highest_semver(subset), "release/v3.10.0")

        # Verify release > prerelease
        rc_subset = ["release/v3.8.41-rc1", "release/v3.8.41"]
        self.assertEqual(resolve_highest_semver(rc_subset), "release/v3.8.41")

        # Empty or non-matching
        self.assertIsNone(resolve_highest_semver(["main", "dev"]))

    def test_get_upstream_default_branch(self):
        self.mock_client.get.return_value = {"default_branch": "release/v3.8.50"}

        branch = self.upstream.get_upstream_default_branch()

        self.assertEqual(branch, "release/v3.8.50")
        self.mock_client.get.assert_called_once_with("/repos/diegosouzapw/OmniRoute")

    def test_get_highest_upstream_release(self):
        self.mock_client.list_all.return_value = [
            {"name": "main"},
            {"name": "release/v3.8.40"},
            {"name": "release/v3.8.41"},
            {"name": "release/v3.8.39"},
        ]

        highest = self.upstream.get_highest_upstream_release()
        self.assertEqual(highest, "release/v3.8.41")
        self.mock_client.list_all.assert_called_with("/repos/diegosouzapw/OmniRoute/branches", per_page=100)

    def test_compare_commits(self):
        self.mock_client.get.return_value = {
            "status": "behind",
            "ahead_by": 0,
            "behind_by": 5,
            "total_commits": 5,
            "commits": [
                {
                    "sha": "abcdef1234567890",
                    "commit": {
                        "message": "feat(core): new feature\n\nExtended explanation",
                        "author": {"name": "Diego", "date": "2026-08-24T10:00:00Z"},
                    },
                }
            ],
            "html_url": "https://github.com/my-fork/OmniRoute/compare/prod...release/v3.8.41",
        }

        res = self.upstream.compare_commits(base="prod", head="release/v3.8.41")
        self.assertEqual(res["status"], "behind")
        self.assertEqual(res["behind_by"], 5)
        self.assertEqual(len(res["commits"]), 1)
        self.assertEqual(res["commits"][0]["sha"], "abcdef12")
        self.assertEqual(res["commits"][0]["message"], "feat(core): new feature")

    def test_check_upstream_release_freeze_active(self):
        self.mock_client.get.return_value = [
            {
                "number": 10500,
                "title": "❄️ Release freeze: release/v3.8.41",
                "html_url": "https://github.com/diegosouzapw/OmniRoute/issues/10500",
                "created_at": "2026-08-24T09:00:00Z",
            }
        ]

        freeze = self.upstream.check_upstream_release_freeze()
        self.assertTrue(freeze["frozen"])
        self.assertEqual(freeze["freeze_count"], 1)
        self.assertEqual(freeze["issues"][0]["number"], 10500)

    def test_check_upstream_release_freeze_inactive(self):
        self.mock_client.get.return_value = []
        freeze = self.upstream.check_upstream_release_freeze()
        self.assertFalse(freeze["frozen"])
        self.assertEqual(freeze["freeze_count"], 0)

    def test_check_upstream_base_red(self):
        self.mock_client.get.return_value = [
            {
                "number": 10501,
                "title": "🔴 Release branch not green: release/v3.8.40",
                "html_url": "https://github.com/diegosouzapw/OmniRoute/issues/10501",
                "created_at": "2026-08-24T09:30:00Z",
            }
        ]

        # Matching branch
        res_match = self.upstream.check_upstream_base_red(base_branch="release/v3.8.40")
        self.assertTrue(res_match["is_base_red"])
        self.assertEqual(len(res_match["matched_issues"]), 1)

        # Non-matching branch
        res_non_match = self.upstream.check_upstream_base_red(base_branch="release/v3.8.41")
        self.assertFalse(res_non_match["is_base_red"])
        self.assertEqual(len(res_non_match["matched_issues"]), 0)

    def _setup_mock_sync_pr(self, draft=False, mergeable=True, mergeable_state="clean", checks_fail=False):
        pr_payload = {
            "id": 101,
            "number": 42,
            "title": "sync: upstream v3.8.41",
            "state": "open",
            "draft": draft,
            "base": {"ref": "prod"},
            "head": {"ref": "sync/upstream-v3.8.41", "sha": "headsha123456"},
            "mergeable": mergeable,
            "mergeable_state": mergeable_state,
        }

        check_runs_payload = {
            "check_runs": [
                {
                    "name": "test-unit",
                    "status": "completed",
                    "conclusion": "failure" if checks_fail else "success",
                },
                {
                    "name": "test-vitest",
                    "status": "completed",
                    "conclusion": "success",
                },
            ]
        }

        status_payload = {"state": "success"}

        def mock_get(path, params=None, **kwargs):
            if path.endswith("/pulls/42"):
                return pr_payload
            elif path.endswith("/check-runs"):
                return check_runs_payload
            elif path.endswith("/status"):
                return status_payload
            elif path.endswith("/issues"):
                return []
            return {}

        self.mock_client.get.side_effect = mock_get
        self.mock_client.list_all.return_value = check_runs_payload["check_runs"]
        return pr_payload

    def test_inspect_sync_pr(self):
        self._setup_mock_sync_pr()
        inspection = self.upstream.inspect_sync_pr(42)

        self.mock_client.list_all.assert_called_once_with(
            "/repos/my-fork/OmniRoute/commits/headsha123456/check-runs",
            per_page=100,
        )
        self.assertEqual(inspection["pull_number"], 42)
        self.assertEqual(inspection["base_ref"], "prod")
        self.assertEqual(inspection["head_ref"], "sync/upstream-v3.8.41")
        self.assertTrue(inspection["checks_green"])
        self.assertEqual(inspection["checks_summary"]["total_check_runs"], 2)

    def test_guarded_merge_success(self):
        self._setup_mock_sync_pr()
        self.mock_client.put.return_value = {"sha": "mergesha999", "message": "Pull Request successfully merged"}

        result = self.upstream.guarded_merge_sync_pr(
            pull_number=42,
            check_freeze=False,
            check_base_red=False,
        )
        self.assertTrue(result["success"])
        self.assertTrue(result["merged"])
        self.assertEqual(result["sha"], "mergesha999")
        self.mock_client.put.assert_called_once()

    def test_guarded_merge_blocked_by_draft(self):
        self._setup_mock_sync_pr(draft=True)
        result = self.upstream.guarded_merge_sync_pr(pull_number=42)

        self.assertFalse(result["success"])
        self.assertFalse(result["merged"])
        self.assertTrue(any("draft" in r.lower() for r in result["blocked_reasons"]))
        self.mock_client.put.assert_not_called()

    def test_guarded_merge_blocked_by_failing_checks(self):
        self._setup_mock_sync_pr(checks_fail=True)
        result = self.upstream.guarded_merge_sync_pr(pull_number=42)

        self.assertFalse(result["success"])
        self.assertFalse(result["merged"])
        self.assertTrue(any("checks not green" in r.lower() for r in result["blocked_reasons"]))
        self.mock_client.put.assert_not_called()

    def test_guarded_merge_blocked_by_release_freeze(self):
        self._setup_mock_sync_pr()

        # Inject release freeze issue
        def mock_get(path, params=None, **kwargs):
            if path.endswith("/pulls/42"):
                return {
                    "id": 101, "number": 42, "state": "open", "draft": False,
                    "base": {"ref": "prod"}, "head": {"ref": "sync/upstream-v3.8.41", "sha": "h1"},
                    "mergeable": True, "mergeable_state": "clean",
                }
            elif path.endswith("/check-runs"):
                return {"check_runs": [{"name": "ci", "status": "completed", "conclusion": "success"}]}
            elif path.endswith("/status"):
                return {"state": "success"}
            elif path.endswith("/issues") and params and params.get("labels") == "release-freeze":
                return [{"number": 10500, "title": "❄️ Release freeze active"}]
            return []

        self.mock_client.get.side_effect = mock_get

        result = self.upstream.guarded_merge_sync_pr(pull_number=42, check_freeze=True)
        self.assertFalse(result["success"])
        self.assertTrue(any("release-freeze" in r.lower() for r in result["blocked_reasons"]))
        self.mock_client.put.assert_not_called()

        # With ignore_freeze=True, it should proceed to merge
        self.mock_client.put.return_value = {"sha": "m1"}
        res_ignored = self.upstream.guarded_merge_sync_pr(pull_number=42, ignore_freeze=True)
        self.assertTrue(res_ignored["success"])


if __name__ == "__main__":
    unittest.main()
