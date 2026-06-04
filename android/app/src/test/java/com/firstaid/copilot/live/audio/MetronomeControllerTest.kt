package com.firstaid.copilot.live.audio

import com.firstaid.copilot.live.HapticState
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Unit coverage for the audio metronome. The controller delegates all sound to a
 * [MetronomeAudio] seam, so these tests inject a fake and assert behaviour without
 * a real [android.media.AudioTrack] (and, by construction, without any Vibrator —
 * the controller has no vibration API surface at all).
 */
class MetronomeControllerTest {
    private class FakeMetronomeAudio : MetronomeAudio {
        val startedBpms = mutableListOf<Int>()
        val volumes = mutableListOf<Float>()
        var stopCount = 0
        var releaseCount = 0

        override fun start(bpm: Int) {
            startedBpms += bpm
        }

        override fun setVolume(volume: Float) {
            volumes += volume
        }

        override fun stop() {
            stopCount++
        }

        override fun release() {
            releaseCount++
        }
    }

    @Test
    fun apply_enabled_startsClickLoopAtBpmAtFullVolume() {
        val audio = FakeMetronomeAudio()
        val controller = MetronomeController(audio)

        controller.apply(HapticState(enabled = true, bpm = 110))

        assertEquals(listOf(110), audio.startedBpms)
        assertEquals(listOf(MetronomeController.FULL_VOLUME), audio.volumes)
        assertEquals(0, audio.stopCount)
    }

    @Test
    fun apply_sameBpmTwice_keepsLoopAliveWithoutRestart() {
        val audio = FakeMetronomeAudio()
        val controller = MetronomeController(audio)

        controller.apply(HapticState(enabled = true, bpm = 110))
        controller.apply(HapticState(enabled = true, bpm = 110))

        // Re-delivered/offline-fallback states must not restart (and never stop) the beat.
        assertEquals(listOf(110), audio.startedBpms)
        assertEquals(0, audio.stopCount)
    }

    @Test
    fun apply_disabled_stops() {
        val audio = FakeMetronomeAudio()
        val controller = MetronomeController(audio)

        controller.apply(HapticState(enabled = true, bpm = 110))
        controller.apply(HapticState(enabled = false, bpm = 110))

        assertEquals(1, audio.stopCount)
    }

    @Test
    fun apply_nullBpm_usesDefault() {
        val audio = FakeMetronomeAudio()
        val controller = MetronomeController(audio)

        controller.apply(HapticState(enabled = true, bpm = null))

        assertEquals(listOf(MetronomeController.DEFAULT_BPM), audio.startedBpms)
    }

    @Test
    fun setDucked_changesVolumeNotTempo() {
        val audio = FakeMetronomeAudio()
        val controller = MetronomeController(audio)
        controller.apply(HapticState(enabled = true, bpm = 110))
        audio.volumes.clear()

        controller.setDucked(true)
        controller.setDucked(false)

        assertEquals(
            listOf(MetronomeController.DUCKED_VOLUME, MetronomeController.FULL_VOLUME),
            audio.volumes,
        )
        // Ducking must never restart or stop the beat — only its volume changes.
        assertEquals(listOf(110), audio.startedBpms)
        assertEquals(0, audio.stopCount)
    }

    @Test
    fun setDucked_isIdempotent() {
        val audio = FakeMetronomeAudio()
        val controller = MetronomeController(audio)

        controller.setDucked(true)
        controller.setDucked(true)

        assertEquals(listOf(MetronomeController.DUCKED_VOLUME), audio.volumes)
    }

    @Test
    fun duckedState_persistsAcrossTempoChange() {
        val audio = FakeMetronomeAudio()
        val controller = MetronomeController(audio)

        controller.setDucked(true)
        controller.apply(HapticState(enabled = true, bpm = 110))
        controller.apply(HapticState(enabled = true, bpm = 120))

        assertEquals(listOf(110, 120), audio.startedBpms)
        assertEquals(
            listOf(
                MetronomeController.DUCKED_VOLUME,
                MetronomeController.DUCKED_VOLUME,
                MetronomeController.DUCKED_VOLUME,
            ),
            audio.volumes,
        )
    }

    @Test
    fun stop_thenRelease_delegateToAudio() {
        val audio = FakeMetronomeAudio()
        val controller = MetronomeController(audio)

        controller.apply(HapticState(enabled = true, bpm = 110))
        controller.stop()
        controller.release()

        assertEquals(1, audio.stopCount)
        assertEquals(1, audio.releaseCount)
    }
}
