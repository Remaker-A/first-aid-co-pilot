async (page) => {
  const sampleMs = 80
  const maxSamples = 260

  await page.waitForLoadState("domcontentloaded").catch(() => {})
  const rows = await page.evaluate(async ({ sampleMs, maxSamples }) => {
    const video = document.querySelector("video")
    if (!video) {
      throw new Error("No video element found")
    }
    const queryVideo = new URLSearchParams(location.search).get("vision_video")
    if (!video.currentSrc && queryVideo) {
      const url = new URL(queryVideo, location.href)
      video.src = url.pathname + url.search
      video.load()
    }

    const [{ FilesetResolver, PoseLandmarker }, metricsModule] = await Promise.all([
      import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35"),
      import("/vision/cprMetrics.js"),
    ])
    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm",
    )
    const landmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
      },
      runningMode: "VIDEO",
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    })
    const tracker = metricsModule.createCprMetricsTracker({
      minConfidence: 0.75,
      mirrorX: false,
      handPositionReference: "calibrated",
    })

    video.muted = true
    video.playsInline = true
    video.loop = true
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("video ready timeout")), 6000)
        video.addEventListener(
          "loadeddata",
          () => {
            clearTimeout(timer)
            resolve()
          },
          { once: true },
        )
      })
    }
    video.currentTime = 0
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2500)
      video.addEventListener(
        "seeked",
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    })
    await video.play().catch(() => {})

    const trackedRows = []
    let lastT = -1
    const start = performance.now()
    while (trackedRows.length < maxSamples) {
      await new Promise((resolve) => setTimeout(resolve, sampleMs))
      if (video.paused) {
        await video.play().catch(() => {})
      }
      const now = performance.now()
      const videoTimeMs = video.currentTime * 1000
      if (videoTimeMs <= lastT) {
        tracker.reset()
      }
      lastT = videoTimeMs
      const result = landmarker.detectForVideo(video, now)
      const landmarks = result?.landmarks?.[0] || null
      if (!landmarks?.length) {
        trackedRows.push({ t: Math.round(videoTimeMs), no_pose: true })
        continue
      }
      const q = tracker.update(landmarks, now)
      const p = (i) => landmarks[i] || {}
      const avg = (...values) => values.reduce((sum, value) => sum + value, 0) / values.length
      const ls = p(11)
      const rs = p(12)
      const le = p(13)
      const re = p(14)
      const lw = p(15)
      const rw = p(16)
      const lh = p(23)
      const rh = p(24)
      const shoulderWidth = Math.hypot((rs.x ?? 0) - (ls.x ?? 0), (rs.y ?? 0) - (ls.y ?? 0))
      const wristY = avg(lw.y ?? 0, rw.y ?? 0)
      const elbowY = avg(le.y ?? 0, re.y ?? 0)
      const shoulderY = avg(ls.y ?? 0, rs.y ?? 0)
      const hipY = avg(lh.y ?? 0, rh.y ?? 0)
      trackedRows.push({
        t: Math.round(videoTimeMs),
        elapsed: Math.round(now - start),
        wrist_y: Number(wristY.toFixed(5)),
        elbow_y: Number(elbowY.toFixed(5)),
        shoulder_y: Number(shoulderY.toFixed(5)),
        hip_y: Number(hipY.toFixed(5)),
        shoulder_width: Number(shoulderWidth.toFixed(5)),
        confidence: q.confidence,
        ready: q.vision_ready,
        stability: q.frame_stability,
        hand: q.hand_position,
        arm: q.arm_posture,
        started: q.compressions_started,
        total: q.total_compressions,
        rate: q.compression_rate,
        avg_rate: q.average_rate,
        interruption: q.interruption_seconds,
      })
    }
    landmarker.close?.()
    window.__cprTraceRows = trackedRows
    localStorage.setItem("cprTraceRows", JSON.stringify(trackedRows))
    return trackedRows
  }, { sampleMs, maxSamples })

  const summary = {
    samples: rows.length,
    detected: rows.filter((row) => !row.no_pose).length,
    ready: rows.filter((row) => row.ready).length,
    started: rows.filter((row) => row.started).length,
    total_max: Math.max(0, ...rows.map((row) => row.total || 0)),
    rates: rows.map((row) => row.rate).filter((rate) => rate != null),
    hands: [...new Set(rows.map((row) => row.hand).filter(Boolean))],
    arms: [...new Set(rows.map((row) => row.arm).filter(Boolean))],
    first: rows.slice(0, 8),
    last: rows.slice(-8),
  }
  console.log(`CPR_TRACE_SUMMARY=${JSON.stringify(summary)}`)
}
