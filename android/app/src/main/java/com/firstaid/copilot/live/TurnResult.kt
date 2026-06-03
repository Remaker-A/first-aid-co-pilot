package com.firstaid.copilot.live

/**
 * Structured outcome of an [AgentTransport] turn.
 *
 * Normal connectivity failures are represented as [Failure] rather than thrown
 * exceptions, so the ViewModel can drive the offline-fallback behavior (a later
 * phase) without try/catch around the transport.
 *
 * [Success] means a well-formed HTTP response was received and parsed; the
 * server may still have reported an application error via [TurnResponse.ok] ==
 * false (e.g. a 404/500 JSON body), which the reducer maps to an error state
 * while keeping the connection considered reachable.
 */
sealed interface TurnResult {
    data class Success(val response: TurnResponse) : TurnResult

    data class Failure(val error: TransportError) : TurnResult
}

enum class TransportErrorKind {
    /** Host unreachable / connection refused / DNS failure. Drives Offline. */
    NETWORK,

    /** Socket/connect/read timeout. Drives Offline. */
    TIMEOUT,

    /** Reached the server but it returned a non-2xx status. Drives Error. */
    HTTP,

    /** Got a body but it could not be parsed as a turn response. Drives Error. */
    PARSE,

    /** Anything else not classified above. Drives Error. */
    UNKNOWN,
}

data class TransportError(
    val kind: TransportErrorKind,
    val message: String,
    val httpStatus: Int? = null,
)
