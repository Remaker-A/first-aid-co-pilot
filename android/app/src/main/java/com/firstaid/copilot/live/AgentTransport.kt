package com.firstaid.copilot.live

/**
 * The D3 transport abstraction seam between the Live ViewModel and the agent.
 *
 * The ViewModel only ever talks to this interface, so the current
 * [HttpAgentTransport] (thin client posting to the Node `/api/turn` server) can
 * later be swapped for an on-device `InProcessAgentTransport` without any
 * UI/ViewModel changes. Implementations must be safe to call from a coroutine;
 * they own their own threading (e.g. [kotlinx.coroutines.Dispatchers.IO]).
 *
 * Contract notes for any implementation:
 *  - [turn] must not throw for ordinary connectivity failures; it returns
 *    [TurnResult.Failure] so the caller can drive offline fallback.
 *  - [reset] is best-effort and should not throw on connectivity failures.
 *  - [health] returns false (never throws) when the agent is unreachable.
 */
interface AgentTransport {
    suspend fun turn(request: TurnRequest): TurnResult

    suspend fun reset(sessionId: String)

    suspend fun health(): Boolean
}
