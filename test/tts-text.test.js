import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeForTts,
  integerToChinese,
  digitsSpoken,
  phoneDigitsSpoken,
} from "../src/voice/ttsText.js";

// Regression for the sherpa VITS "数字降调/降速": Arabic digits drop F0 by ~an
// octave and decimals crawl digit-by-digit. We rewrite digits to Chinese reading
// words before synthesis. UI/log/assertions keep the original digits because this
// only runs at the synthesis entry points, never on the action payloads.

test("emergency phone in a dialing context is read per-digit with 幺", () => {
  assert.equal(
    normalizeForTts("我将为你拨打 120，请保持手机免提。现在准备胸外按压。"),
    "我将为你拨打 幺二零，请保持手机免提。现在准备胸外按压。"
  );
  assert.equal(normalizeForTts("需要立刻拨打 120。"), "需要立刻拨打 幺二零。");
  assert.equal(normalizeForTts("120 已经在呼叫中，保持手机免提。"), "幺二零 已经在呼叫中，保持手机免提。");
});

test("compression-rate digits become Chinese cardinals", () => {
  assert.equal(
    normalizeForTts("现在跟着节拍按，每分钟100到120次，先按30次再告诉我。"),
    "现在跟着节拍按，每分钟一百到一百二十次，先按三十次再告诉我。"
  );
  assert.equal(
    normalizeForTts("按压可以，继续保持 100 到 120 次每分钟。"),
    "按压可以，继续保持 一百 到 一百二十 次每分钟。"
  );
});

test("depth and timing digits", () => {
  assert.equal(
    normalizeForTts("手臂伸直，肩膀在手正上方，垂直向下压5到6厘米。"),
    "手臂伸直，肩膀在手正上方，垂直向下压五到六厘米。"
  );
  assert.equal(
    normalizeForTts("看他的胸口 5 到 10 秒，偶尔大口喘或者完全不动都算没有呼吸。"),
    "看他的胸口 五 到 十 秒，偶尔大口喘或者完全不动都算没有呼吸。"
  );
});

test("coordinates and long callback numbers do not crawl", () => {
  assert.equal(
    normalizeForTts("坐标31.230416,121.473701"),
    "坐标三十一点二三零四一六,一百二十一点四七三七零一"
  );
  assert.equal(normalizeForTts("回拨号码13800000000。"), "回拨号码幺三八零零零零零零零零。");
});

test("integerToChinese basics", () => {
  assert.equal(integerToChinese("5"), "五");
  assert.equal(integerToChinese("6"), "六");
  assert.equal(integerToChinese("10"), "十");
  assert.equal(integerToChinese("18"), "十八");
  assert.equal(integerToChinese("30"), "三十");
  assert.equal(integerToChinese("100"), "一百");
  assert.equal(integerToChinese("110"), "一百一十");
  assert.equal(integerToChinese("120"), "一百二十");
});

test("digitsSpoken reads each digit; phone digits use 幺 for 1", () => {
  assert.equal(digitsSpoken("120"), "一二零");
  assert.equal(phoneDigitsSpoken("120"), "幺二零");
  assert.equal(phoneDigitsSpoken("110"), "幺幺零");
  assert.equal(phoneDigitsSpoken("13800000000"), "幺三八零零零零零零零零");
});

test("digit-free text is untouched and normalize is idempotent", () => {
  const plain = "让他平躺在硬地面，双手掌根放在胸口中央。";
  assert.equal(normalizeForTts(plain), plain);

  const once = normalizeForTts("现在跟着节拍按，每分钟100到120次，先按30次再告诉我。");
  assert.equal(normalizeForTts(once), once);
});
