const scenarios = {
  collapse: {
    title: "成人突然倒地",
    completion: "你完成了成人倒地的关键急救流程。",
    reviews: [["现场安全", "先观察危险，再接近患者"], ["检查反应", "轻拍双肩并大声呼唤"], ["检查呼吸", "识别正常呼吸与濒死喘息"], ["呼叫支援", "拨打 120 并寻找 AED"], ["准备 CPR", "胸口中央、坚硬平面"]],
    nodes: [
      { type: "teach", kicker: "先学关键点", title: "商场里，一名成年人突然倒地。", description: "先不要冲上去。Copilot 会带你完成第一轮现场判断。", prompt: "第一原则：施救前先保证现场安全。", lessonTitle: "先停一秒，观察危险", lessonCopy: "快速查看车辆、电线、火源、坠落物和拥挤踩踏风险。确认你、患者和周围人不会继续受伤后再靠近。", tip: "记忆：先安全，再施救。" },
      { type: "choice", kicker: "情境判断", title: "现场没有明显危险，患者没有动作。", description: "你现在可以接近患者。", prompt: "来到患者身边后，下一步怎么做？", choices: [{ text: "轻拍双肩并大声呼唤", correct: true, title: "检查患者反应", feedback: "正确。轻拍双肩并大声呼唤，观察患者是否有反应。" }, { text: "先给患者喝一点水", correct: false, title: "不要给倒地者喂水", feedback: "患者意识不清时喂水可能造成误吸，应先检查反应。" }] },
      { type: "choice", kicker: "没有反应", title: "患者仍然没有反应。", description: "现在需要尽快确认是否存在正常呼吸。", prompt: "你要观察什么？", choices: [{ text: "观察胸廓，检查正常呼吸", correct: true, title: "检查正常呼吸", feedback: "正确。濒死喘息不属于正常呼吸，需要继续急救流程。" }, { text: "再等一会儿看他是否醒来", correct: false, title: "不要等待", feedback: "无反应时应立即检查正常呼吸并继续急救流程。" }] },
      { type: "practice", modality: "voice", kicker: "组织现场支援", title: "患者无反应，也没有正常呼吸。", description: "旁边有其他人，商场内可能配有 AED。", prompt: "请用一句清楚的话分配现场任务。", practiceText: "模拟说出：请你拨打 120，请你去取 AED。", successTitle: "指令清楚、对象明确", successCopy: "规则识别到呼叫 120 和寻找 AED 两个必要任务。真实接入后，Gemma 只负责把语音映射到封闭意图。" },
      { type: "practice", modality: "camera", kicker: "动作练习", title: "支援正在到位，不要等待救护车。", description: "患者仍无反应、无正常呼吸。", prompt: "打开摄像头，练习胸外按压准备姿势。", practiceText: "模拟视觉识别：胸口中央 · 手臂伸直", successTitle: "准备姿势达标", successCopy: "视觉观察结果满足规则阈值：手位居中、双臂伸直。真实版本将持续给出动作纠正。" }
    ]
  },
  choking: {
    title: "成人气道异物梗阻",
    completion: "你完成了严重气道梗阻的识别与处理练习。",
    reviews: [["识别表现", "无法说话、咳嗽或呼吸"], ["立即求助", "指定旁人拨打 120"], ["背部叩击", "肩胛骨之间有力叩击"], ["腹部冲击", "上腹部快速向内向上"], ["失去反应", "转入心脏骤停流程"]],
    nodes: [
      { type: "teach", kicker: "先学关键点", title: "餐厅里，一名成人突然抓住喉咙。", description: "他面露痛苦。你需要先判断是不是严重气道梗阻。", prompt: "先看他能不能有效咳嗽、说话和呼吸。", lessonTitle: "区分轻度与严重梗阻", lessonCopy: "能用力咳嗽时鼓励继续咳嗽；无法说话、无法有效咳嗽或无法呼吸，提示严重气道梗阻，需要立即行动。", tip: "不要仅凭“抓喉咙”就开始冲击，先确认呼吸和咳嗽能力。" },
      { type: "choice", kicker: "观察表现", title: "患者发不出声音，也无法有效咳嗽。", description: "他的呼吸明显困难。", prompt: "这时应该怎么判断？", choices: [{ text: "严重气道梗阻，立即呼救并处理", correct: true, title: "识别为严重气道梗阻", feedback: "正确。无法说话、有效咳嗽或呼吸时需要立即求助和处理。" }, { text: "让他坐下喝水缓一缓", correct: false, title: "不要喂水或等待", feedback: "严重气道梗阻可能快速恶化，喂水不能解除梗阻，还会延误处理。" }] },
      { type: "practice", modality: "voice", kicker: "现场组织", title: "患者仍然清醒，但无法呼吸。", description: "周围有其他顾客。", prompt: "请明确指定一人拨打 120。", practiceText: "模拟说出：穿蓝衣服的先生，请拨打 120。", successTitle: "求助指令有效", successCopy: "指令包含明确对象和拨打 120 的任务，避免所有人都以为别人会处理。" },
      { type: "practice", modality: "camera", kicker: "动作示范", title: "现在开始解除梗阻。", description: "Copilot 先展示动作区域，再观察你的模拟姿势。", prompt: "练习站位以及背部叩击方向。", practiceText: "模拟视觉识别：身体前倾 · 肩胛骨之间", successTitle: "动作区域正确", successCopy: "让患者身体前倾，在肩胛骨之间有力叩击；后续动作按当前审核规则交替进行。" },
      { type: "choice", kicker: "情况恶化", title: "患者突然失去反应。", description: "原有清醒患者处理流程需要停止。", prompt: "下一步是什么？", choices: [{ text: "安全放至地面，转入心脏骤停流程", correct: true, title: "立即切换急救流程", feedback: "正确。失去反应后应呼叫支援并按心脏骤停流程处理。" }, { text: "继续让患者站立并做腹部冲击", correct: false, title: "不要继续站立处理", feedback: "患者失去反应后无法保持站立，应安全放至地面并切换流程。" }] }
    ]
  },
  bleeding: {
    title: "严重出血",
    completion: "你完成了危险出血的识别与直接压迫练习。",
    reviews: [["现场防护", "避开持续危险并减少血液接触"], ["识别危险", "持续喷涌或大量流血"], ["直接压迫", "覆盖伤口并持续用力"], ["呼叫支援", "严重出血立即拨打 120"], ["持续观察", "保持压迫并关注意识呼吸"]],
    nodes: [
      { type: "teach", kicker: "先学关键点", title: "户外施工区，一人前臂大量出血。", description: "地面有工具，伤者神情紧张。", prompt: "先保护自己，再快速控制出血。", lessonTitle: "严重出血要争分夺秒", lessonCopy: "持续喷涌、快速浸透衣物或地面形成大量血迹，都提示危险出血。确认现场安全，尽量减少直接接触血液。", tip: "核心动作：覆盖伤口，持续、用力、直接压迫。" },
      { type: "choice", kicker: "情境判断", title: "血液持续涌出，衣物很快被浸透。", description: "这是可能危及生命的出血。", prompt: "最优先的动作是什么？", choices: [{ text: "用干净材料覆盖伤口并持续直接压迫", correct: true, title: "立即直接压迫", feedback: "正确。用足够力量持续压迫伤口，并让旁人呼叫急救。" }, { text: "反复掀开材料查看是否止住", correct: false, title: "不要频繁移开压迫材料", feedback: "反复掀开会破坏正在形成的凝血，应持续直接压迫并观察整体状态。" }] },
      { type: "practice", modality: "camera", kicker: "动作练习", title: "你已经覆盖伤口。", description: "现在需要保持稳定、持续的力量。", prompt: "用摄像头练习双手持续压迫姿势。", practiceText: "模拟视觉识别：双手重叠 · 垂直持续压迫", successTitle: "压迫姿势稳定", successCopy: "规则检测到手部位置稳定和持续受力。不要为了查看伤口频繁松开。" },
      { type: "practice", modality: "voice", kicker: "组织支援", title: "伤者脸色变白，现场仍在出血。", description: "你不能停止压迫去拿手机。", prompt: "请让旁人拨打 120，并说明严重出血。", practiceText: "模拟说出：请拨打 120，这里有人严重出血。", successTitle: "关键信息完整", successCopy: "语音意图包含急救电话和严重出血信息；规则允许推进，Gemma 仅负责表达增强。" },
      { type: "choice", kicker: "等待救援", title: "压迫后出血有所减少。", description: "救护人员仍在路上。", prompt: "现在应该怎么做？", choices: [{ text: "继续压迫并观察意识和呼吸", correct: true, title: "保持压迫与观察", feedback: "正确。不要因为出血减少就停止，持续观察伤者整体状态。" }, { text: "立即松手，让伤口透气", correct: false, title: "不要停止压迫", feedback: "松开可能导致再次大量出血，应持续压迫直到专业人员接手。" }] }
    ]
  }
};

const tutorialSlides = [
  { visual: "01", kicker: "WELCOME TO FIRSTAID COPILOT", title: "你来行动，\nCopilot 陪你练习。", copy: "选择一个真实感场景。系统会先示范关键动作，再让你亲自判断和练习。", callout: "训练模式不会拨打 120，也不会进入真实急救会话。" },
  { visual: "◉  ⌁  ✓", kicker: "THREE WAYS TO PRACTICE", title: "说出来、\n做出来、选出来。", copy: "语音用于表达现场决策，摄像头用于观察动作，点击选项用于训练关键判断。", callout: "看到对应提示时再打开麦克风或摄像头，练习更专注。" },
  { visual: "RULE", kicker: "SAFE BY DESIGN", title: "规则决定流程，\nAI 负责解释。", copy: "医疗步骤、对错和场景推进由可审核规则决定。Gemma 负责听懂你的话，并把反馈讲清楚。", callout: "Copilot 不会让大模型自由决定急救流程。" },
  { visual: "120", kicker: "PRACTICE ≠ EMERGENCY", title: "练习形成能力，\n真实现场立即求助。", copy: "你可以反复练习、尝试错误并查看复盘。真实紧急情况应优先拨打 120，并遵循专业人员指导。", callout: "首页的“使用指南”可以随时重新打开本教程。" }
];

let activeScenarioKey = "collapse";
let activeMode = "guided";
let currentNodeIndex = 0;
let pendingAdvance = false;
let tutorialIndex = 0;
let challengeResults = [];

const screens = [...document.querySelectorAll(".screen")];
const actionPanel = document.querySelector("#action-panel");
const feedbackCard = document.querySelector("#feedback-card");
const lessonCard = document.querySelector("#lesson-card");

function showScreen(name) {
  screens.forEach((screen) => screen.classList.toggle("active", screen.dataset.screen === name));
  window.scrollTo(0, 0);
}

function activeScenario() { return scenarios[activeScenarioKey]; }
function sessionNodes() { return activeMode === "challenge" ? activeScenario().nodes.filter((node) => node.type !== "teach") : activeScenario().nodes; }
function activeNode() { return sessionNodes()[currentNodeIndex]; }

function startSession(mode) {
  activeMode = mode;
  currentNodeIndex = 0;
  pendingAdvance = false;
  challengeResults = [];
  document.querySelector("#training-mode-label").innerHTML = `<i></i>${mode === "challenge" ? "挑战中" : "引导中"}`;
  renderNode();
  showScreen("training");
}

function renderNode() {
  const scenario = activeScenario();
  const node = activeNode();
  const nodes = sessionNodes();
  document.querySelector("#progress-label").textContent = `步骤 ${currentNodeIndex + 1} / ${nodes.length}`;
  document.querySelector("#progress-bar").style.width = `${((currentNodeIndex + 1) / nodes.length) * 100}%`;
  document.querySelector("#scene-kicker").textContent = node.kicker;
  document.querySelector("#scene-title").textContent = node.title;
  document.querySelector("#scene-description").textContent = node.description;
  document.querySelector("#copilot-prompt").textContent = node.prompt;
  feedbackCard.hidden = true;
  lessonCard.hidden = true;
  document.querySelector("#sensor-card").hidden = node.type === "teach";
  document.querySelector(".input-tabs").hidden = node.type === "teach";
  actionPanel.innerHTML = "";

  if (node.type === "teach") {
    lessonCard.hidden = false;
    document.querySelector("#lesson-title").textContent = node.lessonTitle;
    document.querySelector("#lesson-copy").textContent = node.lessonCopy;
    document.querySelector("#lesson-tip").textContent = node.tip;
    actionPanel.hidden = true;
    return;
  }

  if (node.type === "choice") {
    const ordered = currentNodeIndex % 2 === 0 ? node.choices : [...node.choices].reverse();
    ordered.forEach((choice, index) => {
      const button = document.createElement("button");
      button.className = "action-choice";
      button.innerHTML = `<span class="choice-index">${String.fromCharCode(65 + index)}</span><strong>${choice.text}</strong><span class="choice-arrow">→</span>`;
      button.addEventListener("click", () => evaluate(choice));
      actionPanel.appendChild(button);
    });
    setInputMode("action");
    return;
  }

  const button = document.createElement("button");
  button.className = "practice-action";
  const practicePrompt = activeMode === "challenge" ? (node.modality === "camera" ? "开始动作观察" : "开始语音识别") : node.practiceText;
  const practiceCaption = activeMode === "challenge" ? "不提供动作答案，结果将在复盘中显示 →" : "点击模拟识别结果 →";
  button.innerHTML = `<span>${node.modality === "camera" ? "▣" : "◉"}</span><strong>${practicePrompt}</strong><small>${practiceCaption}</small>`;
  button.addEventListener("click", () => completePractice(node));
  actionPanel.appendChild(button);
  setInputMode(node.modality);
}

function evaluate(choice) {
  if (activeMode === "challenge") {
    challengeResults.push({ label: activeNode().kicker, correct: choice.correct, title: choice.title, feedback: choice.feedback, action: choice.text });
    pendingAdvance = true;
    showRecordedFeedback();
    return;
  }
  pendingAdvance = choice.correct;
  showFeedback(choice.correct, choice.title, choice.feedback);
}

function completePractice(node) {
  if (activeMode === "challenge") {
    challengeResults.push({ label: node.kicker, correct: true, title: node.successTitle, feedback: node.successCopy, action: node.modality === "camera" ? "完成视觉动作" : "完成语音表达" });
    pendingAdvance = true;
    showRecordedFeedback();
    return;
  }
  pendingAdvance = true;
  showFeedback(true, node.successTitle, node.successCopy);
}

function showFeedback(correct, title, copy) {
  feedbackCard.classList.remove("recorded");
  feedbackCard.classList.toggle("wrong", !correct);
  document.querySelector("#feedback-icon").textContent = correct ? "✓" : "!";
  document.querySelector("#feedback-label").textContent = correct ? "规则评价 · 已掌握" : "规则评价 · 需要调整";
  document.querySelector("#feedback-title").textContent = title;
  document.querySelector("#feedback-copy").textContent = copy;
  document.querySelector("#feedback-next").textContent = correct ? "继续下一步 →" : "返回重试";
  feedbackCard.hidden = false;
}

function showRecordedFeedback() {
  feedbackCard.classList.remove("wrong");
  feedbackCard.classList.add("recorded");
  document.querySelector("#feedback-icon").textContent = "→";
  document.querySelector("#feedback-label").textContent = "挑战记录 · 已保存";
  document.querySelector("#feedback-title").textContent = "继续处理现场";
  document.querySelector("#feedback-copy").textContent = "本次行动已记录。为避免提示答案，对错与原因将在场景结束后统一复盘。";
  document.querySelector("#feedback-next").textContent = "继续现场 →";
  feedbackCard.hidden = false;
}

function setInputMode(mode) {
  document.querySelectorAll("[data-input]").forEach((button) => button.classList.toggle("active", button.dataset.input === mode));
  const card = document.querySelector("#sensor-card");
  const title = document.querySelector("#sensor-title");
  const caption = document.querySelector("#sensor-caption");
  const symbol = document.querySelector("#sensor-symbol");
  card.className = "sensor-card";
  if (mode === "voice") {
    card.classList.add("listening"); title.textContent = "语音练习已就绪"; caption.textContent = "说出现场决策，系统映射为封闭行动意图"; symbol.textContent = "◉";
  } else if (mode === "camera") {
    card.classList.add("camera"); title.textContent = "视觉动作练习已就绪"; caption.textContent = "摄像头只输出动作事实与置信度，不决定流程"; symbol.textContent = "▣";
  } else {
    title.textContent = "请选择你认为正确的下一步"; caption.textContent = activeMode === "challenge" ? "挑战中不会立即显示答案" : "点击选项后，Copilot 会解释为什么"; symbol.textContent = "⌁";
  }
  actionPanel.hidden = false;
}

function renderCompletion() {
  const scenario = activeScenario();
  const isChallenge = activeMode === "challenge";
  const score = isChallenge ? challengeResults.filter((result) => result.correct).length : scenario.reviews.length;
  const total = isChallenge ? challengeResults.length : scenario.reviews.length;
  document.querySelector("#complete-score").textContent = score;
  document.querySelector("#complete-total").textContent = `/ ${total}`;
  document.querySelector("#complete-mode").textContent = isChallenge ? "情境挑战复盘" : "引导练习复盘";
  document.querySelector("#complete-title").innerHTML = `你完成了<br />${scenario.title}`;
  document.querySelector("#complete-copy").textContent = isChallenge ? `规则记录了 ${total} 次现场行动，现在集中查看需要巩固的步骤。` : scenario.completion;
  const reviewItems = isChallenge
    ? challengeResults.map((result) => ({ title: result.label, copy: result.correct ? result.title : `${result.title}：${result.feedback}`, correct: result.correct }))
    : scenario.reviews.map((item) => ({ title: item[0], copy: item[1], correct: true }));
  document.querySelector("#review-list").innerHTML = reviewItems.map((item, index) => `<div class="${item.correct ? "" : "missed"}"><span>${String(index + 1).padStart(2, "0")}</span><p><strong>${item.title}</strong><small>${item.copy}</small></p><i>${item.correct ? "✓" : "!"}</i></div>`).join("");
}

function renderTutorial() {
  const slide = tutorialSlides[tutorialIndex];
  document.querySelector("#tutorial-visual").textContent = slide.visual;
  document.querySelector("#tutorial-kicker").textContent = slide.kicker;
  document.querySelector("#tutorial-title").innerHTML = slide.title.replace("\n", "<br />");
  document.querySelector("#tutorial-copy").textContent = slide.copy;
  document.querySelector("#tutorial-callout").textContent = slide.callout;
  document.querySelectorAll("#tutorial-progress i").forEach((dot, index) => dot.classList.toggle("active", index === tutorialIndex));
  document.querySelector("#tutorial-next").innerHTML = tutorialIndex === tutorialSlides.length - 1 ? "开始选择场景 <span>→</span>" : "下一步 <span>→</span>";
}

function openTutorial() { tutorialIndex = 0; renderTutorial(); showScreen("tutorial"); }
function closeTutorial() { localStorage.setItem("practiceTutorialSeen", "1"); showScreen("home"); }

document.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action], [data-input]");
  if (!target) return;
  if (target.dataset.input) return setInputMode(target.dataset.input);
  const action = target.dataset.action;
  if (action === "open-scenarios" || action === "back-scenarios") showScreen("scenarios");
  if (action === "go-home") showScreen("home");
  if (action === "open-tutorial") openTutorial();
  if (action === "close-tutorial") closeTutorial();
  if (action === "start-scenario") {
    activeScenarioKey = target.dataset.scenario || activeScenarioKey;
    document.querySelector("#mode-scenario-title").textContent = activeScenario().title;
    showScreen("mode-select");
  }
  if (action === "choose-mode") startSession(target.dataset.mode);
  if (action === "restart") startSession(activeMode);
  if (action === "exit-training") showScreen("scenarios");
});

document.querySelector("#lesson-next").addEventListener("click", () => { currentNodeIndex += 1; renderNode(); });
document.querySelector("#feedback-next").addEventListener("click", () => {
  if (!pendingAdvance) { feedbackCard.hidden = true; return; }
  if (currentNodeIndex === sessionNodes().length - 1) { renderCompletion(); showScreen("complete"); return; }
  currentNodeIndex += 1; renderNode();
});
document.querySelector("#tutorial-next").addEventListener("click", () => {
  if (tutorialIndex === tutorialSlides.length - 1) { localStorage.setItem("practiceTutorialSeen", "1"); showScreen("scenarios"); return; }
  tutorialIndex += 1; renderTutorial();
});

if (localStorage.getItem("practiceTutorialSeen")) showScreen("home"); else openTutorial();
