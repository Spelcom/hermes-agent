"""Native Codex subscription WebRTC broker for Hermes voice.

Thin transport adapted from https://github.com/TheSmokeDev/hermes-talk,
talk_live_codex.py,
commit 790f6d283d4720302eda21f9086d4fc01be3ec0a. No community plugin is loaded.
The official CLI owns its ChatGPT sign-in; this module never opens auth files.

MIT License

Copyright (c) 2026 SmokeDev

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import subprocess
import tempfile
from collections.abc import Callable, Mapping

_log = logging.getLogger("hermes.voice_codex")

INSTALL_HINT = (
    "GPT-Live on the ChatGPT subscription runs through the Codex CLI: install it "
    "(`npm install -g @openai/codex`) and sign in with `codex login`"
)
REQUEST_TIMEOUT_S = 30.0
ANSWER_TIMEOUT_S = 30.0
STOP_TIMEOUT_S = 5.0
MAX_LINE_BYTES = 8 * 1024 * 1024
MAX_NOTIFICATIONS = 1024
DEFAULT_MODEL = "gpt-live-1-codex"
SKIP_INSTRUCTIONS = (
    "You are a silent relay for a voice session. Another agent, Hermes, carries out "
    "every request from that session. When you receive a <realtime_delegation> message "
    "or any other request, do not run anything, do not use tools, do not read files: "
    "reply with only the word: skip"
)
# The thread never needs a tool. Disable every tool family Codex can offer it.
LOCKDOWN_OVERRIDES = (
    'model_provider="openai"',
    'forced_login_method="chatgpt"',
    "analytics.enabled=false",
    "feedback.enabled=false",
    "project_doc_max_bytes=0",
    "features.apps=false",
    "features.shell_tool=false",
    "features.multi_agent=false",
    "features.plugins=false",
    "features.browser_use=false",
    "features.computer_use=false",
    'web_search="disabled"',
    "tools.view_image=false",
    "features.js_repl=false",
    "features.unified_exec=false",
    "features.apply_patch_freeform=false",
    "features.image_generation=false",
    "suppress_unstable_features_warning=true",
)
# Credentials the CLI would otherwise prefer over its ChatGPT login.
_API_KEY_ENV = frozenset({"OPENAI_API_KEY", "CODEX_API_KEY"})
_APPROVAL_REQUESTS = frozenset(
    {"item/commandExecution/requestApproval", "item/fileChange/requestApproval"}
)


class CodexLiveError(RuntimeError):
    """The Codex app-server could not start, sign in, or negotiate the call."""


def codex_binary(configured: str = "") -> str | None:
    from hermes_platform.resolver.codex import resolve_codex_binary
    return resolve_codex_binary(configured)


def _child_env(profile: str) -> dict[str, str]:
    from tools.environments.local import served_profile_child_env
    from hermes_constants import get_real_home
    env = served_profile_child_env(target_home=profile, inherit_credentials=False)
    # This external CLI must see its existing OS-user ChatGPT login, even if
    # terminal.home_mode selected a separate home for Hermes tool commands.
    env["HOME"] = get_real_home(env)
    return {name: value for name, value in env.items() if name.upper() not in _API_KEY_ENV}


class _ThreadedPipe:
    """asyncio-shaped wrapper over a blocking pipe, for loops that cannot spawn."""

    def __init__(self, handle):
        self._handle = handle

    def write(self, data: bytes) -> None:
        self._handle.write(data)

    async def drain(self) -> None:
        await asyncio.to_thread(self._handle.flush)

    async def readline(self) -> bytes:
        return await asyncio.to_thread(self._handle.readline)

    def close(self) -> None:
        self._handle.close()


class _ThreadedProcess:
    """``subprocess.Popen`` behind the slice of the asyncio process API used here.

    A Windows selector event loop cannot create subprocesses; some hosts run one.
    """

    def __init__(self, popen):
        self._popen = popen
        self.stdin = _ThreadedPipe(popen.stdin)
        self.stdout = _ThreadedPipe(popen.stdout)

    @property
    def returncode(self):
        return self._popen.returncode

    async def wait(self):
        return await asyncio.to_thread(self._popen.wait)

    def kill(self) -> None:
        self._popen.kill()


async def _spawn_with_threads(*args, env, cwd, **_ignored):
    popen = await asyncio.to_thread(
        subprocess.Popen, args,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env=env,
        cwd=cwd,
    )
    return _ThreadedProcess(popen)


class CodexAppServer:
    """One ``codex app-server`` child speaking JSON-RPC over stdio, for one Live call."""

    def __init__(self, *, binary: str | None = None, profile: str, spawn: Callable | None = None):
        self._profile = profile
        self._binary = binary
        self._spawn = spawn or asyncio.create_subprocess_exec
        self._proc = None
        self._reader = None
        self._workdir = None
        self._next_id = 0
        self._pending: dict[int, asyncio.Future] = {}
        self.notifications: asyncio.Queue = asyncio.Queue(maxsize=MAX_NOTIFICATIONS)
        self._closed = False

    async def start(self) -> None:
        binary = self._binary or codex_binary()
        if not binary:
            raise CodexLiveError(INSTALL_HINT)
        from hermes_constants import get_scratch_dir
        child_env = _child_env(self._profile)
        self._workdir = tempfile.TemporaryDirectory(
            prefix="hermes-voice-codex-", dir=get_scratch_dir(self._profile),
        )
        args = [binary, "app-server", "--listen", "stdio://", "--enable", "realtime_conversation"]
        for override in LOCKDOWN_OVERRIDES:
            args += ["-c", override]
        spawn_options = {
            "stdin": asyncio.subprocess.PIPE,
            "stdout": asyncio.subprocess.PIPE,
            "stderr": asyncio.subprocess.DEVNULL,
            "env": child_env,
            "cwd": self._workdir.name,
            "limit": MAX_LINE_BYTES,
        }
        try:
            try:
                self._proc = await self._spawn(*args, **spawn_options)
            except NotImplementedError:
                self._proc = await _spawn_with_threads(*args, **spawn_options)
        except OSError:
            await self.close()
            raise CodexLiveError(INSTALL_HINT) from None
        self._reader = asyncio.create_task(self._read())
        await self.request(
            "initialize",
            {
                "clientInfo": {"name": "hermes-voice", "version": "0"},
                "capabilities": {"experimentalApi": True},
            },
        )
        await self._write({"jsonrpc": "2.0", "method": "initialized"})

    @property
    def workdir(self) -> str:
        return self._workdir.name

    async def _write(self, message: dict) -> None:
        if self._proc is None or self._proc.stdin is None or self._closed:
            raise CodexLiveError("Codex app-server is not running")
        self._proc.stdin.write((json.dumps(message) + "\n").encode("utf-8"))
        await self._proc.stdin.drain()

    async def request(self, method: str, params: dict, *, timeout: float = REQUEST_TIMEOUT_S):
        if self._reader is not None and self._reader.done():
            raise CodexLiveError("Codex app-server exited")
        self._next_id += 1
        request_id = self._next_id
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        try:
            await self._write(
                {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
            )
            async with asyncio.timeout(timeout):
                return await future
        except TimeoutError:
            raise CodexLiveError(f"Codex app-server did not answer {method}") from None
        finally:
            self._pending.pop(request_id, None)

    async def _answer(self, message: Mapping) -> None:
        """Decline every approval and refuse every other request the thread makes."""

        if message.get("method") in _APPROVAL_REQUESTS:
            reply = {"jsonrpc": "2.0", "id": message["id"], "result": {"decision": "decline"}}
        else:
            reply = {
                "jsonrpc": "2.0",
                "id": message["id"],
                "error": {"code": -32601, "message": "refused by hermes-voice"},
            }
        with contextlib.suppress(Exception):
            await self._write(reply)

    async def _read(self) -> None:
        try:
            while True:
                line = await self._proc.stdout.readline()
                if not line:
                    break
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(message, dict):
                    continue
                if "method" in message and "id" in message:
                    await self._answer(message)
                elif "id" in message:
                    future = self._pending.get(message.get("id"))
                    if future is None or future.done():
                        continue
                    if "error" in message:
                        error = message.get("error")
                        text = error.get("message") if isinstance(error, Mapping) else None
                        future.set_exception(CodexLiveError(_safe_error(text)))
                    else:
                        future.set_result(message.get("result"))
                elif isinstance(message.get("method"), str):
                    if self.notifications.full():
                        self.notifications.get_nowait()
                    self.notifications.put_nowait(message)
        except asyncio.CancelledError:
            raise
        except (OSError, ValueError, asyncio.LimitOverrunError):
            _log.debug("codex app-server reader stopped", exc_info=True)
        finally:
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(CodexLiveError("Codex app-server exited"))
            if not self.notifications.full():
                self.notifications.put_nowait(None)

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        proc = self._proc
        if proc is not None:
            with contextlib.suppress(Exception):
                proc.stdin.close()
            try:
                async with asyncio.timeout(STOP_TIMEOUT_S):
                    await proc.wait()
            except (TimeoutError, OSError):
                with contextlib.suppress(ProcessLookupError, Exception):
                    proc.kill()
                with contextlib.suppress(Exception):
                    await proc.wait()
        if self._reader is not None:
            self._reader.cancel()
            await asyncio.gather(self._reader, return_exceptions=True)
        if self._workdir is not None:
            with contextlib.suppress(Exception):
                self._workdir.cleanup()


def _safe_error(text) -> str:
    """A fixed message for the failures users can act on; never the raw text."""

    low = str(text or "").lower()
    if "usage limit" in low or "hit your usage" in low:
        return (
            "GPT-Live on the ChatGPT subscription hit the plan's usage limit; "
            "wait for the limit to reset"
        )
    if "login" in low or "auth" in low or "unauthorized" in low:
        return f"The Codex CLI is not signed in to ChatGPT. {INSTALL_HINT}"
    if "unknown variant" in low or "unknown field" in low:
        return "This Codex CLI is too old for GPT-Live; update it (`npm install -g @openai/codex`)"
    return "Codex app-server refused the GPT-Live request"


class CodexLiveCall:
    """A negotiated subscription call: the app-server, its thread, and the SDP answer."""

    def __init__(self, server: CodexAppServer, thread_id: str, answer_sdp: str, session_id: str):
        self.server = server
        self.thread_id = thread_id
        self.answer_sdp = answer_sdp
        self.session_id = session_id
        self._stopped = False

    async def stop(self) -> None:
        if not self._stopped:
            self._stopped = True
            with contextlib.suppress(Exception):
                await self.server.request(
                    "thread/realtime/stop", {"threadId": self.thread_id}, timeout=STOP_TIMEOUT_S
                )
        await self.server.close()


async def negotiate_codex_call(
    sdp: str,
    instructions: str,
    voice: str,
    history: list | None = None,
    *,
    server: CodexAppServer | None = None,
    agent_model: str = "",
) -> CodexLiveCall:
    """Start a fenced Codex thread and exchange the WebRTC offer for its answer."""

    if server is None:
        raise ValueError("An explicitly profile-owned Codex server is required")
    try:
        await server.start()
        account = (await server.request("account/read", {}) or {}).get("account")
        if not isinstance(account, Mapping) or account.get("type") != "chatgpt":
            raise CodexLiveError(
                "The Codex CLI is not signed in with ChatGPT, so GPT-Live would not bill the "
                f"subscription. {INSTALL_HINT}. API credentials were not used."
            )
        effective = (await server.request("config/read", {}) or {}).get("config")
        servers = effective.get("mcp_servers") if isinstance(effective, Mapping) else None
        mcp_off = {
            f"mcp_servers.{json.dumps(name)}.enabled": False
            for name in (servers if isinstance(servers, Mapping) else {})
        }
        thread_params = {
            "cwd": server.workdir,
            "modelProvider": "openai",
            "runtimeWorkspaceRoots": [],
            "dynamicTools": [],
            "selectedCapabilityRoots": [],
            "ephemeral": True,
            "approvalPolicy": "untrusted",
            "sandbox": "read-only",
            "environments": [],
            "developerInstructions": SKIP_INSTRUCTIONS,
            "config": {"model_reasoning_effort": "low", **mcp_off},
        }
        if agent_model:
            thread_params["model"] = agent_model
        thread = await server.request("thread/start", thread_params)
        thread_id = ((thread or {}).get("thread") or {}).get("id")
        if not isinstance(thread_id, str) or not thread_id:
            raise CodexLiveError("Codex app-server did not create a thread")
        params = {
            "threadId": thread_id,
            "transport": {"type": "webrtc", "sdp": sdp},
            "outputModality": "audio",
            "version": "v3",
            "voice": voice,
            "prompt": instructions,
            "realtimeStartInstructions": SKIP_INSTRUCTIONS,
            "clientManagedHandoffs": True,
            "includeStartupContext": False,
            "realtimeEndInstructions": SKIP_INSTRUCTIONS,
            "flushTranscriptTailOnSessionEnd": False,
        }
        if history:
            items = []
            for item in history[-128:]:
                if not isinstance(item, dict) or item.get("role") not in {"user", "assistant"}:
                    continue
                parts = item.get("content") or []
                text = " ".join(str(part.get("text") or "") for part in parts if isinstance(part, dict))
                if text:
                    items.append({"role": item["role"], "text": text[:2000]})
            # Bounded below the native 8,192 token startup history limit.
            if sum(len(item["text"]) for item in items) <= 16000:
                params["initialItems"] = items
        await server.request("thread/realtime/start", params)
        answer = session_id = None
        async with asyncio.timeout(ANSWER_TIMEOUT_S):
            while answer is None:
                message = await server.notifications.get()
                if message is None:
                    raise CodexLiveError("Codex app-server exited during GPT-Live setup")
                method, body = message.get("method"), message.get("params") or {}
                if body.get("threadId") not in {None, thread_id}:
                    continue
                if method == "thread/realtime/started":
                    session_id = body.get("realtimeSessionId") or session_id
                elif method == "thread/realtime/sdp":
                    answer = body.get("sdp")
                elif method in {"thread/realtime/error", "thread/realtime/closed"}:
                    raise CodexLiveError(_safe_error(body.get("message") or body.get("reason")))
        if not isinstance(answer, str) or not answer:
            raise CodexLiveError("Codex app-server returned no SDP answer")
        return CodexLiveCall(server, thread_id, answer, session_id or thread_id)
    except TimeoutError:
        await server.close()
        raise CodexLiveError("Codex app-server did not answer the GPT-Live offer") from None
    except BaseException:
        await server.close()
        raise


# Process-local calls are intentionally opaque. An unknown id never targets a
# different worker's call, and neither profile switching nor a stale tab can stop
# another profile/session. The browser must attach a lease after negotiation.
ATTACH_TIMEOUT_S = 15.0
LEASE_IDLE_TIMEOUT_S = 45.0
CALL_TTL_S = 2 * 60 * 60.0
STARTUP_TIMEOUT_S = 90.0


class CallOwnershipError(ValueError):
    """Unknown call or mismatching owner; deliberately indistinguishable."""


class ManagedCall:
    def __init__(self, call_id: str, token: str, profile: str, session_id: str):
        self.call_id = call_id
        self.token = token
        self.profile = profile
        self.session_id = session_id
        self.call: CodexLiveCall | None = None
        self.attached = False
        self.stopped = False
        self.stop_task: asyncio.Task | None = None
        self.expiry_task: asyncio.Task | None = None
        self.monitor_task: asyncio.Task | None = None
        self.events: asyncio.Queue = asyncio.Queue(maxsize=MAX_NOTIFICATIONS)

    async def monitor(self):
        """Only the voice protocol reaches the client; never backing thread turns."""
        try:
            while not self.stopped:
                message = await self.call.server.notifications.get()
                if message is None:
                    break
                method = message.get("method", "")
                params = message.get("params") or {}
                if params.get("threadId") not in {None, self.call.thread_id}:
                    continue
                if not method.startswith("thread/realtime/"):
                    continue
                if method == "thread/realtime/error":
                    message = {"method": method, "params": {"threadId": self.call.thread_id,
                               "message": _safe_error(params.get("message"))}}
                elif method == "thread/realtime/closed":
                    reason = params.get("reason")
                    message = {"method": method, "params": {"threadId": self.call.thread_id,
                               "reason": "connection_lost" if reason and reason != "requested" else None}}
                if self.events.full():
                    # A lost handoff cannot safely be recovered by silently dropping it.
                    break
                self.events.put_nowait(message)
                if method in {"thread/realtime/error", "thread/realtime/closed"}:
                    break
        finally:
            if not self.events.full():
                self.events.put_nowait(None)
            await stop_managed_call(self)

    async def expire(self):
        try:
            await asyncio.sleep(ATTACH_TIMEOUT_S)
            if not self.attached:
                return
            await asyncio.sleep(max(0, CALL_TTL_S - ATTACH_TIMEOUT_S))
        finally:
            await stop_managed_call(self)


_calls: dict[str, ManagedCall] = {}
_profile_calls: dict[str, ManagedCall] = {}
_calls_lock = asyncio.Lock()


def get_managed_call(call_id: str, token: str, profile: str, session_id: str) -> ManagedCall:
    import secrets
    managed = _calls.get(call_id)
    if (managed is None or managed.stopped or managed.profile != profile
            or managed.session_id != session_id
            or not secrets.compare_digest(managed.token, token)):
        raise CallOwnershipError("Voice call not found")
    return managed


async def create_managed_call(sdp: str, *, profile: str, session_id: str,
                              instructions: str, voice: str, binary: str,
                              history: list | None = None, agent_model: str = "") -> dict:
    import secrets
    if not session_id or len(session_id) > 256:
        raise ValueError("A Hermes session_id is required for Codex voice")
    managed = ManagedCall(secrets.token_urlsafe(24), secrets.token_urlsafe(32), profile, session_id)
    async with _calls_lock:
        if profile in _profile_calls:
            raise CodexLiveError("This profile already has an active voice call")
        _profile_calls[profile] = managed
        _calls[managed.call_id] = managed
    server = CodexAppServer(binary=binary, profile=profile)
    try:
        async with asyncio.timeout(STARTUP_TIMEOUT_S):
            managed.call = await negotiate_codex_call(
                sdp, instructions, voice, history, server=server, agent_model=agent_model,
            )
        managed.expiry_task = asyncio.create_task(managed.expire())
        managed.monitor_task = asyncio.create_task(managed.monitor())
        return {
            "auth": "codex-subscription", "wire_protocol": "codex-v3",
            "session": {"id": managed.call.session_id},
            "transport": {"type": "webrtc", "sdp": managed.call.answer_sdp},
            "call_id": managed.call_id, "call_token": managed.token,
            "session_id": session_id, "profile": profile,
        }
    except TimeoutError:
        await server.close()
        await stop_managed_call(managed)
        raise CodexLiveError("Codex voice startup timed out") from None
    except BaseException:
        await server.close()
        await stop_managed_call(managed)
        raise


async def stop_managed_call(managed: ManagedCall) -> None:
    # ASGI disconnect cancellation must not cancel child teardown halfway through.
    if managed.stop_task is None:
        managed.stop_task = asyncio.create_task(_stop_managed_call(managed))
    await asyncio.shield(managed.stop_task)


async def _stop_managed_call(managed: ManagedCall) -> None:
    if managed.stopped:
        return
    managed.stopped = True
    # Retain the profile slot through child shutdown: a second call must never
    # overlap the old backing process while stop is still in progress.
    try:
        if managed.call is not None:
            await managed.call.stop()
    finally:
        async with _calls_lock:
            if _profile_calls.get(managed.profile) is managed:
                _profile_calls.pop(managed.profile, None)
            _calls.pop(managed.call_id, None)
        for task in (managed.expiry_task, managed.monitor_task):
            if task and task is not asyncio.current_task():
                task.cancel()
        if not managed.events.full():
            managed.events.put_nowait(None)
