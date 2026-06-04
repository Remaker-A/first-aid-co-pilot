async (page) => {
  await page.getByRole("button", { name: "一键急救" }).click();
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "跳到 CPR 调试状态" }).click();
  await page.waitForTimeout(1200);
  await page.locator("#realVisionToggle").check();

  const rows = [];
  for (let i = 0; i < 18; i += 1) {
    await page.waitForTimeout(2500);
    rows.push(await page.evaluate(() => {
      let raw = null;
      try {
        raw = JSON.parse(document.querySelector("#raw")?.textContent || "null");
      } catch {}
      const video = document.querySelector("#realVisionVideo");
      return {
        stage: document.querySelector("#stage")?.textContent,
        visionState: document.querySelector("#realVisionStateText")?.textContent,
        visionStatus: document.querySelector("#realVisionStatus")?.textContent,
        eventSource: raw?.event?.source,
        eventType: raw?.event?.event_type,
        perceptionMode: raw?.event?.metadata?.perception_mode,
        visionReady: raw?.event?.metadata?.vision_ready,
        poseCoverage: raw?.event?.metadata?.pose_coverage,
        frameStability: raw?.event?.metadata?.frame_stability,
        observedWindowMs: raw?.event?.metadata?.observed_window_ms,
        guidanceSource: raw?.guidance_source,
        intent: raw?.guidance_action?.intent,
        videoPaused: video?.paused,
        currentTime: Number(video?.currentTime || 0).toFixed(2),
        cprQuality: raw?.event?.cpr_quality || null,
      };
    }));
  }
  console.log(JSON.stringify(rows, null, 2));
}
