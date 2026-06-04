async (page) => {
  const observeSeconds = 26

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
    if (!(await toggle.isChecked().catch(() => false))) {
      await toggle.click({ force: true })
      await page.waitForTimeout(1500)
    }
  }

  async function ensureLiveDisabled() {
    const toggle = page.locator("#liveToggle")
    if ((await toggle.count().catch(() => 0)) && (await toggle.isChecked().catch(() => false))) {
      await toggle.click({ force: true })
      await page.waitForTimeout(800)
    }
  }

  function readRowInPage(sampleIndex) {
    const video = document.querySelector("video")
    const status = document.querySelector("#realVisionStatus")?.innerText.trim() || ""
    const rawText = (document.querySelector("#rawResponse") || document.querySelector("#raw"))?.innerText.trim() || ""
    let raw = null
    try {
      raw = rawText ? JSON.parse(rawText) : null
    } catch (_error) {
      raw = null
    }
    const event = raw?.event || {}
    const action = raw?.state_action || raw?.action || {}
    return {
      sample: sampleIndex,
      video_time: video ? Number(video.currentTime.toFixed(2)) : null,
      paused: video ? video.paused : null,
      status,
      stage: document.querySelector("#stage")?.innerText.trim() || "",
      guidance_source: document.querySelector("#guidanceSource")?.innerText.trim() || "",
      source_badge: document.querySelector("#eventSource")?.innerText.trim() || "",
      event_source: event.source || null,
      event_type: event.event_type || null,
      perception_mode: event.metadata?.perception_mode || null,
      vision_ready: event.metadata?.vision_ready ?? event.cpr_quality?.vision_ready ?? null,
      hand: event.cpr_quality?.hand_position ?? null,
      hand_basis: event.cpr_quality?.hand_position_basis ?? null,
      arm: event.cpr_quality?.arm_posture ?? null,
      rate: event.cpr_quality?.compression_rate ?? null,
      total: event.cpr_quality?.total_compressions ?? null,
      score: event.cpr_quality?.quality_score ?? null,
      confidence: event.cpr_quality?.confidence ?? null,
      action_intent: action.intent || null,
      reason_codes: action.reason_codes || action.reasonCodes || [],
    }
  }

  await page.waitForLoadState("domcontentloaded").catch(() => {})
  await ensureLiveDisabled()
  await clickVisibleText("跳到 CPR 调试状态")
  await page.waitForFunction(() => document.querySelector("#stage")?.innerText.trim() === "S7_CPR_LOOP", null, { timeout: 10000 }).catch(() => {})
  await ensureRealVisionEnabled()
  await page.waitForSelector("video", { timeout: 15000 })

  await page.evaluate(async () => {
    const video = document.querySelector("video")
    video.muted = true
    video.playsInline = true
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
  })

  const rows = []
  for (let i = 0; i <= observeSeconds; i += 1) {
    await page.waitForTimeout(1000)
    rows.push(await page.evaluate(readRowInPage, i))
  }

  await page.evaluate((visionContinuousRows) => {
    window.__visionContinuousRows = visionContinuousRows
    localStorage.setItem("visionContinuousRows", JSON.stringify(visionContinuousRows))
  }, rows)

  console.log(`VISION_CONTINUOUS_ROWS_JSON=${JSON.stringify(rows)}`)
}
