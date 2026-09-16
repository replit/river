package river.pobserve

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import generatedOutput.pobserve.PEvents
import generatedOutput.pobserve.PTypes
import java.util.stream.Stream
import pobserve.commons.PObserveEvent
import pobserve.commons.Parser
import pobserve.runtime.events.PEvent

/**
 * Maps the JSONL execution traces emitted by testUtil/fixtures/trace.ts to
 * the P events of verification/p/PObs/RiverTraceSpecs.p.
 *
 * The parser is mode-selected via --parserConfiguration because each spec
 * partitions the stream differently (PObserve routes one monitor instance
 * per partition key):
 *
 *   session : eTAccepted,            key = sessionId|side   (AcceptedSeqContiguous)
 *   side    : eTEncoded,             key = side             (EncodedSeqDense)
 *   machine : eTSessionCreated/
 *             eTSessionTransition,   key = side|sessionId   (SessionStateConformance)
 *   stream  : eTAccepted minus
 *             control streams/acks,  key = sess|stream|side (StreamFlagDiscipline)
 *   global  : eTInvariantViolation/
 *             eTOutOfOrder,          key = "g"              (NoInvariantViolations)
 *
 * The trace's process-monotonic counter `n` is the ordering timestamp.
 */
class RiverTraceParser : Parser<PEvent<*>> {
  private var mode = "session"

  override fun setConfiguration(configuration: String?) {
    if (!configuration.isNullOrEmpty()) {
      mode = configuration
    }
  }

  override fun apply(logLine: Any): Stream<PObserveEvent<PEvent<*>>> {
    val line = logLine.toString()
    if (line.isBlank()) {
      return Stream.empty()
    }
    val j: JsonNode =
        try {
          MAPPER.readTree(line)
        } catch (e: Exception) {
          return Stream.empty()
        } ?: return Stream.empty()
    if (!j.hasNonNull("k")) {
      return Stream.empty()
    }

    val n = j.path("n").asLong()
    val k = j.path("k").asText()
    // every partition key is scoped by the run (process + generated case):
    // sessions/streams never span runs, and the ordering counter `n` is
    // per-process
    val run = j.path("run").asText("")
    val rawSide = j.path("side").asText()
    val side = "$run|$rawSide"
    val atServer = rawSide == "server"
    val sessionId = j.path("sessionId").asText("")

    var event: PEvent<*>? = null
    var key: String? = null

    when (mode) {
      "session" ->
          if (k == "acc") {
            event = PEvents.eTAccepted(frame(j, atServer, sessionId))
            key = "$sessionId|$side"
          }
      "side" ->
          if (k == "enc") {
            event = PEvents.eTEncoded(frame(j, atServer, sessionId))
            key = side
          }
      "machine" ->
          if (k == "screate" || k == "strans") {
            val s = PTypes.PTuple_atsrv_sssn_sname()
            s.atServer = atServer
            s.sessionId = sessionId
            s.sname = j.path("state").asText("")
            event =
                if (k == "screate") PEvents.eTSessionCreated(s)
                else PEvents.eTSessionTransition(s)
            key = "$side|$sessionId"
          }
      "stream" ->
          if (k == "acc") {
            val streamId = j.path("streamId").asText("")
            val flags = j.path("controlFlags").asLong(0)
            val isControl =
                streamId == "heartbeat" ||
                    streamId == "rehandshake" ||
                    (flags and ACK_BIT) != 0L
            if (!isControl) {
              event = PEvents.eTAccepted(frame(j, atServer, sessionId))
              key = "$sessionId|$streamId|$side"
            }
          }
      "global" ->
          if (k == "inv") {
            val v = PTypes.PTuple_atsrv_mssg()
            v.atServer = atServer
            v.message = j.path("message").asText("")
            event = PEvents.eTInvariantViolation(v)
            key = "g"
          } else if (k == "ooo") {
            event = PEvents.eTOutOfOrder(frame(j, atServer, sessionId))
            key = "g"
          }
      else -> throw IllegalArgumentException("unknown parser mode: $mode")
    }

    if (event == null) {
      return Stream.empty()
    }

    return Stream.of(PObserveEvent<PEvent<*>>(key, n, event, line))
  }

  private companion object {
    private val MAPPER = ObjectMapper()
    private const val ACK_BIT = 0b00001L
    private const val STREAM_OPEN_BIT = 0b00010L
    private const val STREAM_CANCEL_BIT = 0b00100L
    private const val STREAM_CLOSED_BIT = 0b01000L

    private fun frame(
        j: JsonNode,
        atServer: Boolean,
        sessionId: String,
    ): PTypes.PTuple_atsrv_seqn_ack_strm_sssn_isAck_Open_Close_cncl {
      val flags = j.path("controlFlags").asLong(0)
      val f = PTypes.PTuple_atsrv_seqn_ack_strm_sssn_isAck_Open_Close_cncl()
      f.atServer = atServer
      f.seqn = j.path("seq").asLong(-1)
      f.ack = j.path("ack").asLong(-1)
      f.streamId = j.path("streamId").asText("")
      f.sessionId = sessionId
      f.isAck = (flags and ACK_BIT) != 0L
      f.isOpen = (flags and STREAM_OPEN_BIT) != 0L
      f.isClose = (flags and STREAM_CLOSED_BIT) != 0L
      f.isCancel = (flags and STREAM_CANCEL_BIT) != 0L
      return f
    }
  }
}
