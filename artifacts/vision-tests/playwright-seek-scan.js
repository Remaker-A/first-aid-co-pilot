async (page) => {
  const seekSeconds = [0, 5, 10, 15, 20, 25, 30]
  const sampleWaitMs = 2500
  const positiveHoldSeconds = [20]
  const positiveHoldWaitMs = 6500

  async function clickVisibleText(text, timeoutMs = 2500) {
    const locators = [
      page.getByRole("button", { name: text }),
      page.getByText(text, { exact: true }),
    ]

    for (const locator of locators) {
      const first = locator.first()
      try {
        await first.waitFor({ state: "visible", timeout: timeoutMs })
        await first.click()
        await page.waitForTimeout(500)
        return true
      } catch (_error) {
        // Try the next locator form.
      }
    }

    return false
  }

  async function ensureRealVisionEnabled() {
    const toggle = page.locator("#realVisionToggle")
    await toggle.waitFor({ state: "attached", timeout: 15000 })

    const checked = await toggle.isChecked().catch(() => false)
    if (!checked) {
      await toggle.click({ force: true })
      await page.waitForTimeout(1500)
    }
  }

  async function ensureLiveDisabled() {
    const toggle = page.locator("#liveToggle")
    const attached = await toggle.count().catch(() => 0)
    if (!attached) {
      return
    }
    const checked = await toggle.isChecked().catch(() => false)
    if (checked) {
      await toggle.click({ force: true })
      await page.waitForTimeout(800)
    }
  }

  async function seekAndPlay(targetSecond) {
    return page.evaluate(async (seekSecond) => {
      const video = document.querySelector("video")
      if (!video) {
        throw new Error("No video element found")
      }

      video.muted = true
      video.playsInline = true

      if (video.readyState < 1) {
        await new Promise((resolve) => {
          const timer = window.setTimeout(resolve, 3000)
          video.addEventListener(
            "loadedmetadata",
            () => {
              window.clearTimeout(timer)
              resolve()
            },
            { once: true },
          )
        })
      }

      const duration = Number.isFinite(video.duration) ? video.duration : null
      const maxSeek = duration == null ? seekSecond : Math.max(0, duration - 0.25)
      const actualSeekSecond = Math.max(0, Math.min(seekSecond, maxSeek))

      if (Math.abs(video.currentTime - actualSeekSecond) > 0.2) {
        await new Promise((resolve) => {
          const timer = window.setTimeout(resolve, 2500)
          video.addEventListener(
            "seeked",
            () => {
              window.clearTimeout(timer)
              resolve()
            },
            { once: true },
          )
          video.currentTime = actualSeekSecond
        })
      }

      let playError = null
      try {
        await video.play()
      } catch (error) {
        playError = error && error.message ? error.message : String(error)
      }

      return {
        requested_seek_s: seekSecond,
        actual_seek_s: actualSeekSecond,
        duration_s: duration,
        play_error: playError,
      }
    }, targetSecond)
  }

  function readPerceptionRowInPage(seekInfo) {
    const video = document.querySelector("video")
    const status = document.querySelector("#realVisionStatus")
    const rawResponse = document.querySelector("#rawResponse") || document.querySelector("#raw")
    const rawText = rawResponse ? rawResponse.innerText.trim() : ""

    let rawJson = null
    let rawParseError = null
    try {
      rawJson = rawText ? JSON.parse(rawText) : null
    } catch (error) {
      rawParseError = error && error.message ? error.message : String(error)
    }

    const event = rawJson && rawJson.event ? rawJson.event : {}
    const metadata = event && event.metadata ? event.metadata : {}

    return {
      sample_kind: seekInfo.sample_kind || "scan",
      seek_s: seekInfo.requested_seek_s,
      actual_seek_s: seekInfo.actual_seek_s,
      duration_s: seekInfo.duration_s,
      play_error: seekInfo.play_error,
      stage: document.querySelector("#stage")?.innerText.trim() || "",
      source_badge: document.querySelector("#eventSource")?.innerText.trim() || "",
      guidance_source: document.querySelector("#guidanceSource")?.innerText.trim() || "",
      video_paused: video ? video.paused : null,
      video_current_time: video ? video.currentTime : null,
      real_vision_status: status ? status.innerText.trim() : "",
      event_source: event.source || null,
      perception_mode: metadata.perception_mode || null,
      vision_ready: Object.prototype.hasOwnProperty.call(metadata, "vision_ready")
        ? metadata.vision_ready
        : null,
      cpr_quality: event.cpr_quality || null,
      raw_parse_ok: Boolean(rawJson),
      raw_parse_error: rawParseError,
    }
  }

  await page.waitForLoadState("domcontentloaded").catch(() => {})
  await ensureLiveDisabled()
  await clickVisibleText("跳到 CPR 调试状态")
  await page.waitForFunction(() => document.querySelector("#stage")?.innerText.trim() === "S7_CPR_LOOP", null, { timeout: 10000 }).catch(() => {})
  await ensureRealVisionEnabled()
  await page.waitForSelector("video", { timeout: 15000 })

  const rows = []
  for (const seekSecond of seekSeconds) {
    const seekInfo = await seekAndPlay(seekSecond)
    await page.waitForTimeout(sampleWaitMs)

    const row = await page.evaluate(readPerceptionRowInPage, seekInfo)
    rows.push(row)
  }

  for (const seekSecond of positiveHoldSeconds) {
    const seekInfo = await seekAndPlay(seekSecond)
    await page.waitForTimeout(positiveHoldWaitMs)

    const row = await page.evaluate(readPerceptionRowInPage, {
      ...seekInfo,
      sample_kind: "positive_hold",
    })
    rows.push(row)
  }

  await page.evaluate((visionRows) => {
    window.__visionRows = visionRows
    localStorage.setItem("visionRows", JSON.stringify(visionRows))
  }, rows)

  console.log(`VISION_ROWS_JSON=${JSON.stringify(rows)}`)
}
