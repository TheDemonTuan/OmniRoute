"""Upstream sync and guarded merge management for OmniRoute fork.

Handles semver resolution for release/v* branches, commit comparison between
fork and upstream, release-freeze and base-red issue detection on upstream,
sync PR inspection, and safety-guarded merging (base=prod, head=sync/upstream-*,
green checks, not draft, mergeable, no release-freeze).
Python 3.9 stdlib only.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Pattern, Tuple

from .github import GitHubClient, GitHubError

_SEMVER_REGEX: Pattern[str] = re.compile(
    r"^(?:(?:release/)?v)?(?P<major>\d+)\.(?P<minor>\d+)\.(?P<patch>\d+)(?:-(?P<prerelease>[0-9A-Za-z.-]+))?$"
)


def parse_semver(version_str: str) -> Optional[Tuple[int, int, int, int, str]]:
    """Parse semver string into sortable tuple: (major, minor, patch, is_release_flag, prerelease).

    Non-prerelease versions sort higher than prereleases of the same version.
    """
    match = _SEMVER_REGEX.match(version_str.strip())
    if not match:
        return None

    major = int(match.group("major"))
    minor = int(match.group("minor"))
    patch = int(match.group("patch"))
    prerelease = match.group("prerelease") or ""
    # 1 for final release, 0 for prerelease (so final release sorts higher)
    is_release_flag = 1 if not prerelease else 0

    return (major, minor, patch, is_release_flag, prerelease)


def semver_sort_key(branch_name: str) -> Tuple[int, int, int, int, str]:
    """Sort key function for semver branch/tag names."""
    parsed = parse_semver(branch_name)
    if parsed is None:
        return (-1, -1, -1, -1, branch_name)
    return parsed


def release_branch_from_sync_head(head_ref: str) -> Optional[str]:
    """Derive the upstream release branch encoded by a sync workflow branch."""
    prefix = "sync/upstream-"
    if not head_ref.startswith(prefix):
        return None
    encoded_ref = head_ref[len(prefix):]
    if encoded_ref.startswith("release-v"):
        return f"release/{encoded_ref[len('release-') :]}"
    if encoded_ref.startswith("v") and parse_semver(encoded_ref):
        return f"release/{encoded_ref}"
    return None


def resolve_highest_semver(
    branch_names: List[str],
    prefix: str = "release/v",
) -> Optional[str]:
    """Find the highest semver branch/tag name from a list of strings.

    Args:
        branch_names: List of branch or tag names (e.g. ['release/v3.8.40', 'release/v3.10.1']).
        prefix: Required prefix filter (e.g. 'release/v' or 'v').

    Returns:
        Highest semver branch name, or None if no matching branches.
    """
    matching = [b for b in branch_names if b.startswith(prefix) and parse_semver(b) is not None]
    if not matching:
        return None

    matching.sort(key=semver_sort_key, reverse=True)
    return matching[0]


@dataclass
class GuardCheckResult:
    """Result of a single merge guard check."""

    name: str
    passed: bool
    reason: str
    details: Dict[str, Any] = field(default_factory=dict)


class UpstreamManager:
    """Manages upstream synchronization, release checks, and guarded PR merges."""

    def __init__(
        self,
        client: GitHubClient,
        fork_owner: str,
        fork_repo: str,
        upstream_owner: str = "diegosouzapw",
        upstream_repo: str = "OmniRoute",
    ) -> None:
        self.client = client
        self.fork_owner = fork_owner
        self.fork_repo = fork_repo
        self.upstream_owner = upstream_owner
        self.upstream_repo = upstream_repo

    def get_upstream_default_branch(self) -> Optional[str]:
        """Return the branch GitHub currently presents as upstream's default."""
        repository = self.client.get(f"/repos/{self.upstream_owner}/{self.upstream_repo}")
        default_branch = repository.get("default_branch") if isinstance(repository, dict) else None
        return str(default_branch) if default_branch else None

    def get_highest_upstream_release(self, prefix: str = "release/v") -> Optional[str]:
        """Fetch all upstream branches and resolve the highest semver release branch."""
        path = f"/repos/{self.upstream_owner}/{self.upstream_repo}/branches"
        branches_data = self.client.list_all(path, per_page=100)
        branch_names = [b["name"] for b in branches_data if isinstance(b, dict) and "name" in b]
        return resolve_highest_semver(branch_names, prefix=prefix)

    def compare_commits(
        self,
        base: str,
        head: str,
        cross_upstream: bool = False,
    ) -> Dict[str, Any]:
        """Compare commits between base and head.

        Args:
            base: Base commit/branch (e.g. 'prod' or 'release/v3.8.40').
            head: Head commit/branch (e.g. 'sync/upstream-v3.8.40').
            cross_upstream: If True, compares fork head against upstream base.

        Returns:
            Dict with status ('ahead', 'behind', 'identical', 'diverged'), counts, and commit summaries.
        """
        if cross_upstream:
            owner = self.fork_owner
            repo = self.fork_repo
            compare_spec = f"{self.upstream_owner}:{base}...{head}"
        else:
            owner = self.fork_owner
            repo = self.fork_repo
            compare_spec = f"{base}...{head}"

        path = f"/repos/{owner}/{repo}/compare/{compare_spec}"
        resp = self.client.get(path)

        commits_summary = []
        for c in resp.get("commits", []):
            commit_obj = c.get("commit", {})
            commits_summary.append(
                {
                    "sha": c.get("sha", "")[:8],
                    "full_sha": c.get("sha", ""),
                    "message": commit_obj.get("message", "").splitlines()[0] if commit_obj.get("message") else "",
                    "author": commit_obj.get("author", {}).get("name", ""),
                    "date": commit_obj.get("author", {}).get("date", ""),
                }
            )

        return {
            "status": resp.get("status", "unknown"),
            "ahead_by": resp.get("ahead_by", 0),
            "behind_by": resp.get("behind_by", 0),
            "total_commits": resp.get("total_commits", len(commits_summary)),
            "commits": commits_summary,
            "html_url": resp.get("html_url"),
        }

    def check_upstream_release_freeze(self) -> Dict[str, Any]:
        """Check if there is an active release-freeze marker issue on upstream repo.

        Per Hard Rule #21: An open issue with label 'release-freeze' indicates an
        active release reconciliation/cycle freeze.
        """
        path = f"/repos/{self.upstream_owner}/{self.upstream_repo}/issues"
        params = {"labels": "release-freeze", "state": "open"}
        issues = self.client.get(path, params=params)

        freeze_issues = []
        if isinstance(issues, list):
            for iss in issues:
                # Exclude pull requests which GitHub returns in issues endpoint
                if "pull_request" in iss:
                    continue
                freeze_issues.append(
                    {
                        "number": iss.get("number"),
                        "title": iss.get("title"),
                        "html_url": iss.get("html_url"),
                        "created_at": iss.get("created_at"),
                    }
                )

        is_frozen = len(freeze_issues) > 0
        return {
            "frozen": is_frozen,
            "freeze_count": len(freeze_issues),
            "issues": freeze_issues,
        }

    def check_upstream_base_red(self, base_branch: Optional[str] = None) -> Dict[str, Any]:
        """Check if upstream has open base-red issue(s) indicating broken release branch.

        Per Hard Rule base-green check: Deduplicated issues titled
        '🔴 Release branch not green: <branch>' with label 'base-red'.
        """
        path = f"/repos/{self.upstream_owner}/{self.upstream_repo}/issues"
        params = {"labels": "base-red", "state": "open"}
        issues = self.client.get(path, params=params)

        base_red_issues = []
        matched_issues = []
        if isinstance(issues, list):
            for iss in issues:
                if "pull_request" in iss:
                    continue
                title = iss.get("title", "")
                issue_info = {
                    "number": iss.get("number"),
                    "title": title,
                    "html_url": iss.get("html_url"),
                    "created_at": iss.get("created_at"),
                }
                base_red_issues.append(issue_info)

                if base_branch:
                    expected_title = f"Release branch not green: {base_branch}"
                    normalized_title = title.lstrip("🔴 ").strip()
                    if normalized_title.casefold() == expected_title.casefold():
                        matched_issues.append(issue_info)

        is_red = len(matched_issues) > 0 if base_branch else len(base_red_issues) > 0
        return {
            "is_base_red": is_red,
            "matched_issues": matched_issues,
            "all_base_red_issues": base_red_issues,
        }

    def inspect_sync_pr(self, pull_number: int) -> Dict[str, Any]:
        """Inspect a sync PR for merge readiness, CI status, and guard conditions."""
        path = f"/repos/{self.fork_owner}/{self.fork_repo}/pulls/{pull_number}"
        pr = self.client.get(path)

        head_sha = pr.get("head", {}).get("sha", "")
        base_ref = pr.get("base", {}).get("ref", "")
        head_ref = pr.get("head", {}).get("ref", "")
        state = pr.get("state", "closed")
        draft = pr.get("draft", False)
        mergeable = pr.get("mergeable")
        mergeable_state = pr.get("mergeable_state", "unknown")

        # Check every paginated CI check-run for the head commit.
        check_runs: List[Dict[str, Any]] = []
        if head_sha:
            cr_path = f"/repos/{self.fork_owner}/{self.fork_repo}/commits/{head_sha}/check-runs"
            try:
                check_runs = self.client.list_all(cr_path, per_page=100)
            except GitHubError:
                pass

        # Check legacy commit status
        combined_status_state: Optional[str] = None
        if head_sha:
            cs_path = f"/repos/{self.fork_owner}/{self.fork_repo}/commits/{head_sha}/status"
            try:
                cs_resp = self.client.get(cs_path)
                if isinstance(cs_resp, dict):
                    combined_status_state = cs_resp.get("state")
            except GitHubError:
                pass

        # Evaluate overall checks green status
        checks_green = True
        failed_checks = []
        pending_checks = []

        for cr in check_runs:
            status = cr.get("status")
            conclusion = cr.get("conclusion")
            name = cr.get("name", "unnamed-check")

            if status != "completed":
                pending_checks.append(name)
                checks_green = False
            elif conclusion not in ("success", "neutral", "skipped"):
                failed_checks.append({"name": name, "conclusion": conclusion})
                checks_green = False

        if combined_status_state and combined_status_state not in ("success",):
            if combined_status_state == "pending":
                pending_checks.append("combined-status")
                checks_green = False
            elif combined_status_state in ("failure", "error"):
                failed_checks.append({"name": "combined-status", "conclusion": combined_status_state})
                checks_green = False

        return {
            "pull_number": pull_number,
            "title": pr.get("title", ""),
            "state": state,
            "draft": draft,
            "base_ref": base_ref,
            "head_ref": head_ref,
            "head_sha": head_sha,
            "mergeable": mergeable,
            "mergeable_state": mergeable_state,
            "checks_green": checks_green,
            "checks_summary": {
                "total_check_runs": len(check_runs),
                "failed_checks": failed_checks,
                "pending_checks": pending_checks,
                "combined_status": combined_status_state,
            },
            "html_url": pr.get("html_url", ""),
            "raw_pr": pr,
        }

    def guarded_merge_sync_pr(
        self,
        pull_number: int,
        allowed_base: str = "prod",
        allowed_head_prefix: str = "sync/upstream-",
        merge_method: str = "squash",
        check_freeze: bool = True,
        check_base_red: bool = True,
        ignore_freeze: bool = False,
        ignore_base_red: bool = False,
    ) -> Dict[str, Any]:
        """Execute a guarded merge of a sync PR enforcing all safety invariants.

        Guards enforced:
          1. PR must be open.
          2. PR base ref must exactly equal `allowed_base` (e.g. 'prod').
          3. PR head ref must start with `allowed_head_prefix` (e.g. 'sync/upstream-').
          4. PR must NOT be a draft.
          5. PR must be mergeable (mergeable is True, not dirty/conflict).
          6. All CI status checks must be green.
          7. Upstream must not have an active release-freeze marker issue (unless ignored).
          8. Upstream base must not be marked base-red (unless ignored).

        Returns:
            Dict indicating whether merge succeeded or list of blocking reasons.
        """
        inspection = self.inspect_sync_pr(pull_number)
        guards: List[GuardCheckResult] = []

        # Guard 1: PR Open
        is_open = inspection["state"] == "open"
        guards.append(
            GuardCheckResult(
                name="pr_open",
                passed=is_open,
                reason="PR is open" if is_open else f"PR is not open (state='{inspection['state']}')",
            )
        )

        # Guard 2: Base branch
        base_match = inspection["base_ref"] == allowed_base
        guards.append(
            GuardCheckResult(
                name="base_branch",
                passed=base_match,
                reason=f"Base branch matches '{allowed_base}'"
                if base_match
                else f"Base branch '{inspection['base_ref']}' does not match required '{allowed_base}'",
            )
        )

        # Guard 3: Head branch prefix
        head_match = inspection["head_ref"].startswith(allowed_head_prefix)
        guards.append(
            GuardCheckResult(
                name="head_branch",
                passed=head_match,
                reason=f"Head branch starts with '{allowed_head_prefix}'"
                if head_match
                else f"Head branch '{inspection['head_ref']}' does not match prefix '{allowed_head_prefix}'",
            )
        )

        # Guard 4: Not Draft
        not_draft = not inspection["draft"]
        guards.append(
            GuardCheckResult(
                name="not_draft",
                passed=not_draft,
                reason="PR is ready for review (not draft)" if not_draft else "PR is currently marked as draft",
            )
        )

        # Guard 5: Mergeable
        is_mergeable = inspection["mergeable"] is True and inspection["mergeable_state"] not in ("dirty", "conflicting")
        guards.append(
            GuardCheckResult(
                name="mergeable",
                passed=is_mergeable,
                reason="PR is mergeable without conflicts"
                if is_mergeable
                else f"PR is not cleanly mergeable (mergeable={inspection['mergeable']}, state='{inspection['mergeable_state']}')",
            )
        )

        # Guard 6: CI Checks Green
        checks_green = inspection["checks_green"]
        failed_names = [f["name"] for f in inspection["checks_summary"]["failed_checks"]]
        pending_names = inspection["checks_summary"]["pending_checks"]
        checks_reason = "All CI checks are green"
        if not checks_green:
            parts = []
            if failed_names:
                parts.append(f"failed: {failed_names}")
            if pending_names:
                parts.append(f"pending: {pending_names}")
            checks_reason = f"CI checks not green ({', '.join(parts)})"

        guards.append(
            GuardCheckResult(
                name="checks_green",
                passed=checks_green,
                reason=checks_reason,
                details=inspection["checks_summary"],
            )
        )

        # Guard 7: Upstream Release Freeze
        if check_freeze and not ignore_freeze:
            freeze_res = self.check_upstream_release_freeze()
            no_freeze = not freeze_res["frozen"]
            freeze_reason = "No upstream release-freeze active"
            if not no_freeze:
                freeze_titles = [i["title"] for i in freeze_res["issues"]]
                freeze_reason = f"Upstream has active release-freeze marker issue: {freeze_titles}"
            guards.append(
                GuardCheckResult(
                    name="release_freeze",
                    passed=no_freeze,
                    reason=freeze_reason,
                    details=freeze_res,
                )
            )

        # Guard 8: Upstream Base-Red
        if check_base_red and not ignore_base_red:
            upstream_base = release_branch_from_sync_head(inspection["head_ref"])
            base_red_res = self.check_upstream_base_red(base_branch=upstream_base)
            not_base_red = not base_red_res["is_base_red"]
            base_red_reason = "Upstream base branch is green"
            if not not_base_red:
                red_titles = [i["title"] for i in base_red_res["matched_issues"]]
                base_red_reason = f"Upstream base branch has active base-red issue: {red_titles}"
            guards.append(
                GuardCheckResult(
                    name="base_green",
                    passed=not_base_red,
                    reason=base_red_reason,
                    details=base_red_res,
                )
            )

        # Check all guards
        failed_guards = [g for g in guards if not g.passed]
        passed_guards = [g for g in guards if g.passed]

        if failed_guards:
            return {
                "success": False,
                "merged": False,
                "pull_number": pull_number,
                "blocked_reasons": [g.reason for g in failed_guards],
                "failed_guards": [{"name": g.name, "reason": g.reason} for g in failed_guards],
                "passed_guards": [{"name": g.name, "reason": g.reason} for g in passed_guards],
            }

        # Perform actual merge via API
        merge_path = f"/repos/{self.fork_owner}/{self.fork_repo}/pulls/{pull_number}/merge"
        merge_body = {
            "merge_method": merge_method,
            "commit_title": f"chore(sync): merge sync PR #{pull_number} into {allowed_base}",
        }

        merge_response = self.client.put(merge_path, json_data=merge_body)
        return {
            "success": True,
            "merged": True,
            "pull_number": pull_number,
            "sha": merge_response.get("sha"),
            "message": merge_response.get("message", "Successfully merged"),
            "guards_passed": [{"name": g.name, "reason": g.reason} for g in passed_guards],
        }
