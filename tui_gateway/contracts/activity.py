"""Read-only transfer evidence for workspace visualizations."""
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
