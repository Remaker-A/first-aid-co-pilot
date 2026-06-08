package com.example.cpr_new.agent.copilot

sealed interface TurnResult {
    data class Success(val response: TurnResponse) : TurnResult
    data class Failure(val error: TransportError) : TurnResult
}

enum class TransportErrorKind {
    NETWORK,
    TIMEOUT,
    HTTP,
    PARSE,
    UNKNOWN,
}

data class TransportError(
    val kind: TransportErrorKind,
    val message: String,
    val httpStatus: Int? = null,
)

interface AgentTransport {
    suspend fun turn(request: TurnRequest): TurnResult
    suspend fun reset(sessionId: String)
    suspend fun health(): Boolean
}
