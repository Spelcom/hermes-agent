"""Read-only transfer and assignment evidence for workspace visualizations."""
from typing import Literal

from pydantic import Field

from .base import Params, Result
from .registry import method


class ActivityTransfersParams(Params):
    profile: str | None = None
    board: str | None = None
    since: float = Field(default=0, ge=0, allow_inf_nan=False)


class ActivityTransfer(Result):
    id: str
    kind: Literal['message', 'file']
    channel: Literal['bot_chat', 'kanban']
    status: Literal['settled', 'available']
    occurred_at: float
    from_profile: str | None
    from_origin: str | None
    to_profile: str
    task_id: str | None
    file_name: str | None
    content_type: str | None
    bytes: int | None


class ActivityTransfersResult(Result):
    transfers: list[ActivityTransfer]
    truncated: bool


method('activity.transfers', params=ActivityTransfersParams, result=ActivityTransfersResult,
       doc='Latest 100 actual settled Bot Chat receipts and available task files for this profile. '
           'Metadata only; availability does not assert worker delivery or reading. Seed IDs on first load.')


class ActivityTasksParams(Params):
    profile: str | None = None
    board: str | None = None
    limit: int = Field(default=20, ge=1, le=50)


class ActivityTaskChecklist(Result):
    done: int
    total: int
    source: Literal['task_body']


class ActivityTask(Result):
    task_id: str
    title: str
    status: str
    assignee: str
    active: bool
    run_id: int | None
    run_status: str | None
    run_outcome: str | None
    execution_session_id: str | None
    created_at: float | None
    started_at: float | None
    completed_at: float | None
    updated_at: float | None
    last_event_id: int
    checklist: ActivityTaskChecklist | None


class ActivityTasksResult(Result):
    profile: str
    board: str
    canonical_session_id: str | None
    captured_at: float
    revision: str
    tasks: list[ActivityTask]
    truncated: bool


method('activity.tasks', params=ActivityTasksParams, result=ActivityTasksResult,
       doc='Assigned nonarchived tasks, active claims first. active requires a matching running '
           'run and unexpired claim; assignment alone is not execution. Checklist counts are '
           'literal stored task-body checkboxes, never a percentage inferred from tools.')
