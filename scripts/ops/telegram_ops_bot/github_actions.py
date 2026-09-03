"""GitHub Actions workflow management with allowlist enforcement and correlation tracking.

Supports workflow run listing, job details, dispatching with correlation IDs,
rerunning failed jobs, run cancellation, and extracting redacted failed logs summaries.
Python 3.9 stdlib only.
"""

from __future__ import annotations

import os
import re
import time
import uuid
from typing import Any, Dict, List, Optional, Set, Union

from .github import (
    NOT_MODIFIED,
    GitHubClient,
    GitHubError,
    redact_sensitive,
)

# Mandatory workflow allowlist
DEFAULT_ALLOWED_WORKFLOWS: Set[str] = {
    "prod-deploy.yml",
    "ops-bot-sync.yml",
}

_ERROR_LOG_PATTERNS = [
    re.compile(r"(?i)\b(error|fatal|exception|failed|failure|panic|traceback)\b"),
    re.compile(r"^##\[error\]", re.IGNORECASE),
]


class WorkflowNotAllowedError(GitHubError):
    """Raised when an operation is requested on a workflow not in the allowlist."""


def generate_correlation_id(prefix: str = "ops") -> str:
    """Generate a unique correlation ID for tracking ops actions across systems."""
    ts = int(time.time())
    short_uuid = uuid.uuid4().hex[:8]
    return f"{prefix}-{ts}-{short_uuid}"


def normalize_workflow_name(workflow_id: Union[str, int]) -> str:
    """Extract standard workflow filename from path or name."""
    if isinstance(workflow_id, int):
        return str(workflow_id)
    return os.path.basename(str(workflow_id)).strip()


class GitHubActionsManager:
    """Manages GitHub Actions workflows for production operations."""

    def __init__(
        self,
        client: GitHubClient,
        owner: str,
        repo: str,
        allowed_workflows: Optional[Set[str]] = None,
    ) -> None:
        self.client = client
        self.owner = owner
        self.repo = repo
        self.allowed_workflows = set(allowed_workflows or DEFAULT_ALLOWED_WORKFLOWS)
        # ETag + last payload per distinct run listing. The alert loop asks for
        # the same two listings every cycle; with If-None-Match an unchanged
        # listing comes back as 304, which GitHub does not bill against the
        # installation rate limit.
        self._runs_etags: Dict[str, str] = {}
        self._runs_cache: Dict[str, Dict[str, Any]] = {}

    def validate_workflow(self, workflow_id: Union[str, int]) -> str:
        """Validate that a workflow is in the allowlist.

        Returns:
            Normalized workflow filename or ID string.

        Raises:
            WorkflowNotAllowedError: If workflow is not allowed.
        """
        norm_name = normalize_workflow_name(workflow_id)
        if norm_name not in self.allowed_workflows:
            raise WorkflowNotAllowedError(
                f"Workflow '{workflow_id}' is not in the allowed workflows: {sorted(self.allowed_workflows)}"
            )
        return norm_name

    def list_runs(
        self,
        workflow_id: Union[str, int],
        branch: Optional[str] = None,
        status: Optional[str] = None,
        event: Optional[str] = None,
        per_page: int = 30,
        page: int = 1,
    ) -> Dict[str, Any]:
        """List runs for an allowed workflow."""
        wf_name = self.validate_workflow(workflow_id)
        path = f"/repos/{self.owner}/{self.repo}/actions/workflows/{wf_name}/runs"
        params: Dict[str, Any] = {
            "per_page": min(per_page, 100),
            "page": max(page, 1),
        }
        if branch:
            params["branch"] = branch
        if status:
            params["status"] = status
        if event:
            params["event"] = event

        cache_key = "|".join(
            [
                wf_name,
                branch or "",
                status or "",
                event or "",
                str(params["per_page"]),
                str(params["page"]),
            ]
        )
        response = self.client.get(path, params=params, etag=self._runs_etags.get(cache_key))

        if response is NOT_MODIFIED:
            return self._runs_cache.get(cache_key, {"total_count": 0, "workflow_runs": []})

        if isinstance(response, dict):
            # last_etag is client-wide, and the alert thread can call this while
            # an operator's /actions is in flight, so an ETag can land under the
            # wrong key. That costs a cache miss and nothing else: ETags are
            # per-resource, so a foreign one simply fails to match and GitHub
            # answers 200 with the real body. Not worth a lock held across a
            # network call, which is the blocking the alert thread just escaped.
            new_etag = getattr(self.client, "last_etag", None)
            if isinstance(new_etag, str) and new_etag:
                self._runs_etags[cache_key] = new_etag
            self._runs_cache[cache_key] = response
        return response

    def get_run(self, run_id: int) -> Dict[str, Any]:
        """Get details for a specific workflow run."""
        path = f"/repos/{self.owner}/{self.repo}/actions/runs/{run_id}"
        return self.client.get(path)

    def list_jobs(self, run_id: int) -> List[Dict[str, Any]]:
        """List all jobs for a specific workflow run."""
        path = f"/repos/{self.owner}/{self.repo}/actions/runs/{run_id}/jobs"
        response = self.client.get(path)
        if isinstance(response, dict) and "jobs" in response:
            return response["jobs"]
        elif isinstance(response, list):
            return response
        return []

    def dispatch_workflow(
        self,
        workflow_id: Union[str, int],
        ref: str,
        inputs: Optional[Dict[str, Any]] = None,
        correlation_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Dispatch an allowed workflow run with correlation tracking.

        Args:
            workflow_id: Name of workflow (e.g. 'prod-deploy.yml').
            ref: Git reference (branch or tag, e.g. 'main', 'prod').
            inputs: Optional workflow inputs dictionary.
            correlation_id: Optional correlation tracking ID. If None, generated.

        Returns:
            Dict containing dispatch confirmation and correlation ID.
        """
        wf_name = self.validate_workflow(workflow_id)
        cid = correlation_id or generate_correlation_id()

        payload_inputs = {
            key: "true" if value is True else "false" if value is False else str(value)
            for key, value in (inputs or {}).items()
        }
        payload_inputs["ops_request_id"] = cid

        body = {
            "ref": ref,
            "inputs": payload_inputs,
        }

        path = f"/repos/{self.owner}/{self.repo}/actions/workflows/{wf_name}/dispatches"
        self.client.post(path, json_data=body)

        return {
            "dispatched": True,
            "workflow": wf_name,
            "ref": ref,
            "correlation_id": cid,
            "inputs": payload_inputs,
        }

    def rerun_failed_jobs(self, run_id: int) -> Dict[str, Any]:
        """Rerun only failed jobs for a workflow run."""
        path = f"/repos/{self.owner}/{self.repo}/actions/runs/{run_id}/rerun-failed-jobs"
        res = self.client.post(path)
        return {"rerun": True, "run_id": run_id, "response": res}

    def cancel_run(self, run_id: int) -> Dict[str, Any]:
        """Cancel a currently running workflow run."""
        path = f"/repos/{self.owner}/{self.repo}/actions/runs/{run_id}/cancel"
        res = self.client.post(path)
        return {"cancelled": True, "run_id": run_id, "response": res}

    def get_job_logs(self, job_id: int) -> str:
        """Fetch raw logs for a job and redact sensitive tokens."""
        path = f"/repos/{self.owner}/{self.repo}/actions/jobs/{job_id}/logs"
        try:
            raw_logs = self.client.get(path, headers={"Accept": "application/vnd.github+json"})
            if not isinstance(raw_logs, str):
                raw_logs = str(raw_logs)
            return redact_sensitive(raw_logs)
        except GitHubError as e:
            return f"[Failed to fetch job logs for job {job_id}: {e}]"

    def get_failed_logs_summary(
        self,
        run_id: int,
        max_lines_per_step: int = 25,
        max_total_chars: int = 2500,
    ) -> Dict[str, Any]:
        """Analyze a workflow run and produce a concise redacted failure summary.

        Args:
            run_id: GitHub Actions workflow run ID.
            max_lines_per_step: Maximum error lines to extract per failed step.
            max_total_chars: Maximum characters for overall summary.

        Returns:
            Dict with run ID, failed jobs, failed steps, error lines, and Telegram summary text.
        """
        jobs = self.list_jobs(run_id)
        failed_jobs_info: List[Dict[str, Any]] = []

        for job in jobs:
            conclusion = job.get("conclusion")
            status = job.get("status")

            # Check if job failed or timed out
            is_failed = conclusion in ("failure", "timed_out", "cancelled") or (
                status == "completed" and conclusion != "success" and conclusion != "skipped"
            )

            if not is_failed:
                continue

            job_id = job.get("id")
            job_name = job.get("name", f"job-{job_id}")
            steps = job.get("steps", [])

            failed_steps_info: List[Dict[str, Any]] = []
            for step in steps:
                step_conclusion = step.get("conclusion")
                if step_conclusion in ("failure", "timed_out", "cancelled"):
                    failed_steps_info.append(
                        {
                            "step_name": step.get("name", "Unknown Step"),
                            "step_number": step.get("number"),
                            "conclusion": step_conclusion,
                        }
                    )

            # Try to extract log error lines if job_id available
            error_lines: List[str] = []
            log_tail: List[str] = []
            if job_id:
                logs_text = self.get_job_logs(job_id)
                if logs_text and not logs_text.startswith("[Failed to fetch"):
                    lines = [ln.strip() for ln in logs_text.splitlines() if ln.strip()]
                    # Filter lines matching error patterns
                    for ln in lines:
                        if any(pat.search(ln) for pat in _ERROR_LOG_PATTERNS):
                            error_lines.append(ln)

                    # Keep tail lines as context
                    log_tail = lines[-max_lines_per_step:]

            # Limit error lines
            condensed_errors = error_lines[-max_lines_per_step:] if error_lines else log_tail[-10:]

            failed_jobs_info.append(
                {
                    "job_id": job_id,
                    "job_name": job_name,
                    "conclusion": conclusion,
                    "failed_steps": failed_steps_info,
                    "error_lines": condensed_errors,
                    "log_tail": log_tail[-5:] if log_tail else [],
                }
            )

        has_failures = len(failed_jobs_info) > 0

        # Build formatted summary text
        summary_lines = [f"📊 **Workflow Run #{run_id} Failure Analysis**\n"]
        if not has_failures:
            summary_lines.append("✅ No failed jobs found in this run.")
        else:
            summary_lines.append(f"❌ Found {len(failed_jobs_info)} failed job(s):\n")
            for fj in failed_jobs_info:
                summary_lines.append(f"• **Job**: `{fj['job_name']}` (ID: `{fj['job_id']}`) [{fj['conclusion']}]")
                if fj["failed_steps"]:
                    steps_str = ", ".join(f"`{s['step_name']}`" for s in fj["failed_steps"])
                    summary_lines.append(f"  Failed Steps: {steps_str}")
                if fj["error_lines"]:
                    summary_lines.append("  **Error Snippet**:")
                    snippet = "\n".join(f"    > {ln}" for ln in fj["error_lines"][:10])
                    summary_lines.append(snippet)
                summary_lines.append("")

        full_summary_text = "\n".join(summary_lines)
        if len(full_summary_text) > max_total_chars:
            full_summary_text = full_summary_text[: max_total_chars - 30] + "\n... [truncated]"

        return {
            "run_id": run_id,
            "has_failures": has_failures,
            "failed_jobs_count": len(failed_jobs_info),
            "failed_jobs": failed_jobs_info,
            "summary_text": redact_sensitive(full_summary_text),
        }
