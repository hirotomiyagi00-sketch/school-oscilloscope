/**
 * ==========================================================================
 * アプリケーション統合コントローラー (app.js)
 * ==========================================================================
 * 【なぜこのファイルが必要なのか】
 * - 音声解析モジュール (audio.js)、Canvas描画エンジン (oscilloscope.js)、
 *   テーママネージャー (themes.js) を連携させ、ユーザーのボタン操作や
 *   スライダー変更を即座にアプリ全体に反映させるため。
 * - 生徒がいつでも実験画像を名前・条件付きで保存できるよう、
 *   モーダル制御と合成PNG画像出力処理を行う。
 * ==========================================================================
 */

import { 
  initAudio, 
  getAudioData, 
  setGain,
  getGain,
  setNoiseGateThreshold,
  getNoiseGateThreshold,
  detectPitch,
  getNoteDetails,
  startTone,
  stopTone,
  setToneFrequency,
  setToneType,
  setLoopbackEnabled
} from "./audio.js";
import { OscilloscopeRenderer } from "./oscilloscope.js";
import { setTheme, getCurrentTheme } from "./themes.js";
import {
  initSyncEngine,
  startTeacherRoom,
  joinRoom,
  leaveRoom,
  getCurrentRoomCode,
  broadcastConfig
} from "./sync.js";

// --- DOM要素の参照取得 ---
const canvas = document.getElementById("oscilloscopeCanvas");
const startOverlay = document.getElementById("startOverlay");
const btnStart = document.getElementById("btnStart");
const btnFreeze = document.getElementById("btnFreeze");
const freezeIcon = document.getElementById("freezeIcon");
const freezeText = document.getElementById("freezeText");
const freezeIndicator = document.getElementById("freezeIndicator");
const timeDivSelect = document.getElementById("timeDivSelect");
const voltsDivSelect = document.getElementById("voltsDivSelect");
const noiseGateSlider = document.getElementById("noiseGateSlider");
const gateLine = document.getElementById("gateLine");
const gateValText = document.getElementById("gateValText");
const meterFill = document.getElementById("meterFill");
const studentParamControls = document.getElementById("studentParamControls");

// OSD要素
const osdGain = document.getElementById("osdGain");
const osdWidth = document.getElementById("osdWidth");
const osdTimeDiv = document.getElementById("osdTimeDiv");
const osdVoltsDiv = document.getElementById("osdVoltsDiv");
const osdFreq = document.getElementById("osdFreq");

// 先生モード・認証・コントロールパネル要素
const btnOpenTeacherAuth = document.getElementById("btnOpenTeacherAuth");
const teacherModeBadge = document.getElementById("teacherModeBadge");
const teacherAuthModal = document.getElementById("teacherAuthModal");
const inputTeacherPasscode = document.getElementById("inputTeacherPasscode");
const alertTeacherAuth = document.getElementById("alertTeacherAuth");
const btnCancelTeacherAuth = document.getElementById("btnCancelTeacherAuth");
const btnSubmitTeacherAuth = document.getElementById("btnSubmitTeacherAuth");

const teacherPanelModal = document.getElementById("teacherPanelModal");
const btnCloseTeacherPanel = document.getElementById("btnCloseTeacherPanel");
const btnLockTeacherMode = document.getElementById("btnLockTeacherMode");
const btnApplyTeacherSettings = document.getElementById("btnApplyTeacherSettings");

// 生徒配布用URL生成・コピー要素
const btnCopyCurrentConfigLink = document.getElementById("btnCopyCurrentConfigLink");
const shareUrlPreview = document.getElementById("shareUrlPreview");
const toastNotification = document.getElementById("toastNotification");
const btnPresetLinkCopies = document.querySelectorAll(".btn-preset-link-copy");

const scenePresetButtons = document.querySelectorAll(".btn-scene-preset");
const teacherGainBadge = document.getElementById("teacherGainBadge");
const btnGainQuicks = document.querySelectorAll(".btn-gain-quick");
const teacherGainSlider = document.getElementById("teacherGainSlider");
const teacherWidthBadge = document.getElementById("teacherWidthBadge");
const btnWidthQuicks = document.querySelectorAll(".btn-width-quick");
const teacherTimeDivSelect = document.getElementById("teacherTimeDivSelect");
const teacherVoltsDivSelect = document.getElementById("teacherVoltsDivSelect");
const teacherGateValText = document.getElementById("teacherGateValText");
const teacherGateLine = document.getElementById("teacherGateLine");
const teacherMeterFill = document.getElementById("teacherMeterFill");
const teacherGateSlider = document.getElementById("teacherGateSlider");
const teacherThemeSelect = document.getElementById("teacherThemeSelect");
const chkUnlockStudentControls = document.getElementById("chkUnlockStudentControls");

// 生徒側ルーム参加関連
const btnOpenJoinRoom = document.getElementById("btnOpenJoinRoom");
const roomStatusBadge = document.getElementById("roomStatusBadge");
const currentRoomText = document.getElementById("currentRoomText");
const joinRoomModal = document.getElementById("joinRoomModal");
const inputJoinRoomCode = document.getElementById("inputJoinRoomCode");
const alertJoinRoom = document.getElementById("alertJoinRoom");
const btnCancelJoinRoom = document.getElementById("btnCancelJoinRoom");
const btnSubmitJoinRoom = document.getElementById("btnSubmitJoinRoom");

// 先生側ルーム配信＆QR関連
const btnStartRoom = document.getElementById("btnStartRoom");
const roomInitialArea = document.getElementById("roomInitialArea");
const roomActiveArea = document.getElementById("roomActiveArea");
const teacherRoomCodeDisplay = document.getElementById("teacherRoomCodeDisplay");
const btnShowQRModal = document.getElementById("btnShowQRModal");
const btnCloseRoom = document.getElementById("btnCloseRoom");

const qrModal = document.getElementById("qrModal");
const qrCanvas = document.getElementById("qrCanvas");
const qrRoomCodeText = document.getElementById("qrRoomCodeText");
const btnCloseQRModal = document.getElementById("btnCloseQRModal");

// パスコード変更
const inputNewPasscode = document.getElementById("inputNewPasscode");
const btnSaveNewPasscode = document.getElementById("btnSaveNewPasscode");

// モーダル関連の要素
const btnSaveImage = document.getElementById("btnSaveImage");
const saveModal = document.getElementById("saveModal");
const inputStudentName = document.getElementById("inputStudentName");
const inputExperimentCond = document.getElementById("inputExperimentCond");
const alertName = document.getElementById("alertName");
const alertCond = document.getElementById("alertCond");
const btnCancelModal = document.getElementById("btnCancelModal");
const btnConfirmSave = document.getElementById("btnConfirmSave");

// --- 波形比較＆手動位相シフト関連の要素 ---
const btnSaveSlotA = document.getElementById("btnSaveSlotA");
const btnClearSlotA = document.getElementById("btnClearSlotA");
const statusA = document.getElementById("statusA");
const btnSaveSlotB = document.getElementById("btnSaveSlotB");
const btnClearSlotB = document.getElementById("btnClearSlotB");
const statusB = document.getElementById("statusB");
const btnModeOverlay = document.getElementById("btnModeOverlay");
const btnModeSplit = document.getElementById("btnModeSplit");
const phaseSlider = document.getElementById("phaseSlider");
const phaseValText = document.getElementById("phaseValText");
const btnPhaseLeft = document.getElementById("btnPhaseLeft");
const btnPhaseRight = document.getElementById("btnPhaseRight");
const btnPhaseReset = document.getElementById("btnPhaseReset");

// --- 画面切り替えタブ関連の要素 ---
const tabBtnWave = document.getElementById("tabBtnWave");
const tabBtnTuner = document.getElementById("tabBtnTuner");
const tabBtnGenerator = document.getElementById("tabBtnGenerator");
const sectionWave = document.getElementById("sectionWave");
const sectionTuner = document.getElementById("sectionTuner");
const sectionGenerator = document.getElementById("sectionGenerator");

// --- 【タブ2】チューナー関連の要素 ---
const tunerSolfege = document.getElementById("tunerSolfege");
const tunerNoteName = document.getElementById("tunerNoteName");
const tunerFrequency = document.getElementById("tunerFrequency");
const tunerStandardFreq = document.getElementById("tunerStandardFreq");
const tunerNeedle = document.getElementById("tunerNeedle");
const tunerCents = document.getElementById("tunerCents");
const tunerStatusMsg = document.getElementById("tunerStatusMsg");
const tunerNoteDisplay = document.querySelector(".tuner-note-display");

// --- 【タブ3】基準音ジェネレーター関連の要素 ---
const presetButtons = document.querySelectorAll(".btn-preset");
const genFreqDisplay = document.getElementById("genFreqDisplay");
const genNoteDisplay = document.getElementById("genNoteDisplay");
const genFreqSlider = document.getElementById("genFreqSlider");
const waveChips = document.querySelectorAll(".chip-wave");
const btnToggleTone = document.getElementById("btnToggleTone");
const tonePlayIcon = document.getElementById("tonePlayIcon");
const tonePlayText = document.getElementById("tonePlayText");
const btnLoopback = document.getElementById("btnLoopback");

// レンダラーのインスタンス化
const renderer = new OscilloscopeRenderer(canvas);

// 状態変数
let isRunning = false;
let isFrozen = false;
let lastAudioData = null;
let currentTab = "wave"; // "wave" | "tuner" | "generator"
let isTonePlaying = false;
let currentToneFreq = 440;
let currentToneType = "sine";
let isLoopbackActive = false;

/**
 * 簡易周波数推定関数（ゼロクロス周期法）
 * 【なぜ周波数を表示するのか】
 * 中学生が「高い音＝振動数（Hz）が大きい」という関係を即座に確認できるようにするため。
 * 
 * @param {Float32Array} buffer - 音声バッファ
 * @param {number} sampleRate - サンプリングレート
 * @returns {number|null} 推定周波数（Hz）
 */
function estimateFrequency(buffer, sampleRate) {
  let crossings = 0;
  let firstIndex = -1;
  let lastIndex = -1;

  for (let i = 0; i < buffer.length - 1; i++) {
    if (buffer[i] <= 0 && buffer[i + 1] > 0) {
      if (firstIndex === -1) firstIndex = i;
      lastIndex = i;
      crossings++;
    }
  }

  if (crossings > 1 && lastIndex > firstIndex) {
    const cycleCount = crossings - 1;
    const sampleDistance = lastIndex - firstIndex;
    const avgSamplesPerCycle = sampleDistance / cycleCount;
    return Math.round(sampleRate / avgSamplesPerCycle);
  }
  return null;
}

/**
 * 毎フレームの描画ループ (60fps)
 */
function animationLoop() {
  if (!isRunning) return;

  // 最新の音声解析データを取得
  lastAudioData = getAudioData();

  // 音量メーターの更新（0〜100%にクランプ）
  const volumePercent = Math.min(100, Math.round(lastAudioData.rms * 300));
  meterFill.style.width = `${volumePercent}%`;
  if (teacherMeterFill) {
    teacherMeterFill.style.width = `${volumePercent}%`;
  }

  // 周波数の推定とOSD更新（ノイズゲート超えかつ停止中でない場合）
  if (!isFrozen && lastAudioData.isAboveGate) {
    const freq = estimateFrequency(lastAudioData.rawData, lastAudioData.sampleRate);
    if (freq && freq >= 50 && freq <= 3000) {
      osdFreq.textContent = `推定: 約 ${freq} Hz`;
    } else {
      osdFreq.textContent = `推定: --- Hz`;
    }
  }

  // 【波形タブ】オシロスコープ画面の描画実行
  if (currentTab === "wave") {
    renderer.render(lastAudioData.rawData, lastAudioData.isAboveGate, lastAudioData.sampleRate);
  }

  // 【チューナータブ】音の高さしらべ画面の更新実行
  if (currentTab === "tuner") {
    updateTunerDisplay(lastAudioData.rawData, lastAudioData.sampleRate, lastAudioData.isAboveGate);
  }

  requestAnimationFrame(animationLoop);
}

// --- イベントリスナー設定 ---

// 1. 実験開始ボタン（マイクON）
btnStart.addEventListener("click", async () => {
  try {
    btnStart.textContent = "⌛ マイクを準備中...";
    await initAudio();
    isRunning = true;
    startOverlay.style.display = "none";
    requestAnimationFrame(animationLoop);
  } catch (error) {
    btnStart.textContent = "🎤 実験をはじめる（マイクをON）";
    // 単純なアラートではなく、Chromebook/iPad別の分かりやすいガイドを表示
    const micGuideModal = document.getElementById("micGuideModal");
    if (micGuideModal) {
      micGuideModal.classList.add("active");
    } else {
      alert("マイクの利用が許可されませんでした。ブラウザの鍵アイコンからマイクを許可して再読み込みしてください。");
    }
  }
});

// マイクガイドモーダルの操作
const btnCloseMicGuide = document.getElementById("btnCloseMicGuide");
const btnRetryMic = document.getElementById("btnRetryMic");
if (btnCloseMicGuide) {
  btnCloseMicGuide.addEventListener("click", () => {
    document.getElementById("micGuideModal").classList.remove("active");
  });
}
if (btnRetryMic) {
  btnRetryMic.addEventListener("click", () => {
    document.getElementById("micGuideModal").classList.remove("active");
    btnStart.click();
  });
}

// 2. ピタッと停止（一時停止 / ホールド）ボタン
btnFreeze.addEventListener("click", () => {
  isFrozen = !isFrozen;

  if (isFrozen) {
    // 停止時：現在のバッファを固定保持（画面上の邪魔な文字は出さず、ボタンをオレンジ色に点灯させて再開を促す）
    const currentBuffer = lastAudioData ? lastAudioData.rawData : null;
    renderer.setFrozen(true, currentBuffer);
    btnFreeze.classList.add("frozen");
    freezeIcon.textContent = "▶️";
    freezeText.textContent = "再開する";
    if (freezeIndicator) freezeIndicator.style.display = "none";
  } else {
    // 再開時
    renderer.setFrozen(false, null);
    btnFreeze.classList.remove("frozen");
    freezeIcon.textContent = "⏸️";
    freezeText.textContent = "ピタッと停止";
    if (freezeIndicator) freezeIndicator.style.display = "none";
  }
});

// --------------------------------------------------------------------------
// 先生用設定・コントロールパネル ＆ 生徒画面パラメータ同期処理
// --------------------------------------------------------------------------

// 【初期状態で先生モード解除（パスコード入力を不要にして快適化）】
// パネル内の「🔒 再施錠」を押すことで手動ロックも可能
let isTeacherModeUnlocked = true;
// 先生用パスコード（LocalStorageから読み込み、初期値0000）
let teacherPasscode = localStorage.getItem("school_oscilloscope_teacher_passcode") || "0000";

let toastTimeout = null;
/**
 * クリップボードコピー完了や設定適用を知らせるトースト通知を表示する関数
 * @param {string} message - 表示メッセージ（HTML可）
 */
function showToast(message) {
  if (!toastNotification) return;
  toastNotification.innerHTML = message;
  toastNotification.classList.add("show");
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toastNotification.classList.remove("show");
  }, 2800);
}

/**
 * 現在の設定（またはカスタム設定）から生徒配布用URLを生成する関数
 * 【なぜURLパラメータを使うのか】
 * Google Classroomやロイロノート等でURLを1回配るだけで、
 * 生徒全員がパスコード入力やQR読み取り不要で、先生の指定した設定で即座に実験を開始できるようにするため。
 * 
 * @param {Object} [customParams={}] - 個別上書き用パラメータ
 * @returns {string} 配布用完全URL
 */
function generateStudentUrl(customParams = {}) {
  const url = new URL(window.location.href.split("?")[0]);
  const curThemeId = document.documentElement.getAttribute("data-theme") || "classic";

  const config = {
    gain: customParams.gain !== undefined ? customParams.gain : getGain(),
    w: customParams.w !== undefined ? customParams.w : renderer.getHorizontalDivs(),
    t: customParams.t !== undefined ? customParams.t : renderer.timeDivMs,
    v: customParams.v !== undefined ? customParams.v : renderer.voltsDiv,
    gate: customParams.gate !== undefined ? customParams.gate : Math.round(getNoiseGateThreshold() * 100),
    th: customParams.th !== undefined ? customParams.th : curThemeId
  };

  // 各設定値をURLクエリパラメータにセット
  Object.entries(config).forEach(([key, val]) => {
    url.searchParams.set(key, val);
  });

  return url.toString();
}

/**
 * 先生パネル内のURLプレビュー入力欄を最新設定に更新する関数
 */
function updateShareUrlPreview() {
  if (shareUrlPreview) {
    shareUrlPreview.value = generateStudentUrl();
  }
}

/**
 * 指定されたURLをクリップボードにコピーし、トースト通知を表示する関数
 * @param {string} url - コピー対象URL
 * @param {string} successMsg - 成功時トーストメッセージ
 */
async function copyUrlToClipboard(url, successMsg = "📋 生徒用リンクをコピーしました！Classroom等で配布できます") {
  try {
    await navigator.clipboard.writeText(url);
    showToast(successMsg);
  } catch (err) {
    // クリップボードAPIが使えない環境（非HTTPS等）向けのフォールバック
    const tempInput = document.createElement("input");
    tempInput.value = url;
    document.body.appendChild(tempInput);
    tempInput.select();
    document.execCommand("copy");
    document.body.removeChild(tempInput);
    showToast(successMsg);
  }
}

/**
 * 先生が設定変更した際に、ルーム参加中の生徒へ設定を自動配信する関数
 */
function syncCurrentConfigToStudents() {
  if (isTeacherModeUnlocked) {
    const curThemeId = document.documentElement.getAttribute("data-theme") || "classic";
    broadcastConfig({
      theme: curThemeId,
      gain: getGain(),
      horizontalDivs: renderer.getHorizontalDivs(),
      timeDiv: renderer.timeDivMs,
      voltsDiv: renderer.voltsDiv,
      noiseGate: Math.round(getNoiseGateThreshold() * 100)
    });
  }
}

/**
 * マイク感度・波形ゲインをアプリ全体に適用する関数
 * @param {number} val - ゲイン倍率（0.5〜10.0）
 */
function applyGain(val, isSyncEvent = false) {
  const num = Math.max(0.1, Math.min(20, Number(val) || 1.0));
  setGain(num);

  // 画面OSD表示の更新
  if (osdGain) {
    osdGain.textContent = `GAIN: ${num.toFixed(1)}x`;
  }

  // 先生パネル内バッジとスライダーの同期
  if (teacherGainBadge) {
    teacherGainBadge.textContent = `×${num.toFixed(1)}${num === 1.0 ? "（標準）" : ""}`;
  }
  if (teacherGainSlider) {
    teacherGainSlider.value = num;
  }

  // クイック選択ボタンのactive同期
  btnGainQuicks.forEach(btn => {
    const btnVal = parseFloat(btn.dataset.gain);
    if (Math.abs(btnVal - num) < 0.05) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });

  if (!isSyncEvent) {
    syncCurrentConfigToStudents();
    updateShareUrlPreview();
  }
}

/**
 * 波の表示幅（横マス数）を適用・同期する関数
 * 【なぜ音Aと音Bの両方に作用させるのか】
 * 比較実験において、音Aと音Bが同じ横軸マス数スケールで描画されて初めて、
 * 「高い音は波の幅が狭い（波の数が多い）」という物理的関係を正しく視覚比較できるため。
 * 
 * @param {number} divs - 横の小マス数（10, 20, 30, 40, 50）
 */
function applyHorizontalDivs(divs, isSyncEvent = false) {
  const val = Math.max(10, Math.min(100, parseInt(divs, 10) || 50));
  renderer.setHorizontalDivs(val);

  // 画面OSD表示の更新
  if (osdWidth) {
    osdWidth.textContent = `WIDTH: ${val}マス`;
  }

  // 先生パネル内バッジの更新
  if (teacherWidthBadge) {
    teacherWidthBadge.textContent = `${val}マス${val === 50 ? "（標準）" : ""}`;
  }

  // クイックボタンのactive同期
  btnWidthQuicks.forEach(btn => {
    const btnVal = parseInt(btn.dataset.width, 10);
    if (btnVal === val) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });

  if (!isSyncEvent) {
    syncCurrentConfigToStudents();
    updateShareUrlPreview();
  }
}

/**
 * TIME/DIV（時間の目盛り）を適用・同期する関数
 * @param {number} val - ミリ秒/div
 */
function applyTimeDiv(val, isSyncEvent = false) {
  renderer.setTimeDiv(val);
  osdTimeDiv.textContent = `TIME: ${val.toFixed(1)} ms/div`;
  timeDivSelect.value = String(val);
  teacherTimeDivSelect.value = String(val);

  if (!isSyncEvent) {
    syncCurrentConfigToStudents();
    updateShareUrlPreview();
  }
}

/**
 * VOLTS/DIV（高さの目盛り）を適用・同期する関数
 * @param {number} val - 電圧/div
 */
function applyVoltsDiv(val, isSyncEvent = false) {
  renderer.setVoltsDiv(val);
  osdVoltsDiv.textContent = `VOLT: ${val.toFixed(1)} V/div`;
  voltsDivSelect.value = String(val);
  teacherVoltsDivSelect.value = String(val);

  if (!isSyncEvent) {
    syncCurrentConfigToStudents();
    updateShareUrlPreview();
  }
}

/**
 * ノイズゲート（混入防止しきい値）を適用・同期する関数
 * 【なぜ生徒画面と先生画面を連動させるのか】
 * 先生が指定した初期推奨値（URLパラメータ等）を生徒のスライダーへ初期反映しつつ、
 * 生徒自身も机の環境に合わせていつでも自由に微調整できるようにするため。
 * 
 * @param {number} val - 0〜50 (%)
 */
function applyNoiseGate(val, isSyncEvent = false) {
  const percent = Math.max(0, Math.min(50, parseInt(val, 10) || 0));
  setNoiseGateThreshold(percent / 100);

  // 生徒側UIの同期（初期値や先生の設定が確実に反映される）
  if (gateLine) gateLine.style.left = `${percent}%`;
  if (gateValText) gateValText.textContent = `${percent}%`;
  if (noiseGateSlider) {
    if (percent > parseInt(noiseGateSlider.max, 10)) {
      noiseGateSlider.max = percent;
    }
    noiseGateSlider.value = percent;
  }

  // 先生側UIの同期
  if (teacherGateLine) teacherGateLine.style.left = `${percent}%`;
  if (teacherGateValText) teacherGateValText.textContent = `${percent}%`;
  if (teacherGateSlider) teacherGateSlider.value = percent;

  if (!isSyncEvent) {
    syncCurrentConfigToStudents();
    updateShareUrlPreview();
  }
}

/**
 * 授業シーン別おすすめプリセットを一括適用する関数
 * 【なぜプリセットが必要なのか】
 * 理科の授業準備で先生が設定に迷う時間をゼロにし、
 * 「おんさ」「声」「弦」などの実験をボタン1つでベストな表示状態にするため。
 * 
 * @param {string} presetKey - "tuning-fork" | "voice" | "monochord" | "loud"
 */
function applyScenePreset(presetKey) {
  switch (presetKey) {
    case "tuning-fork": // おんさの実験: 減衰音を大きく捉える高感度設定 ＆ 2〜3周期に拡大
      applyGain(5.0);
      applyHorizontalDivs(20);
      applyTimeDiv(0.5);
      applyVoltsDiv(0.2);
      applyNoiseGate(2);
      break;
    case "voice": // 声・歌声の観察: 複雑な波形を広めに観察
      applyGain(1.0);
      applyHorizontalDivs(40);
      applyTimeDiv(2.0);
      applyVoltsDiv(0.5);
      applyNoiseGate(3);
      break;
    case "monochord": // 弦・モノコード: 基本波形と高調波を捉える
      applyGain(2.0);
      applyHorizontalDivs(20);
      applyTimeDiv(1.0);
      applyVoltsDiv(0.5);
      applyNoiseGate(2);
      break;
    case "loud": // 大音量・打楽器: 画面からはみ出さない低感度設定 ＆ 全体表示
      applyGain(0.5);
      applyHorizontalDivs(50);
      applyTimeDiv(5.0);
      applyVoltsDiv(1.0);
      applyNoiseGate(5);
      break;
  }
}

// --- 先生用認証モーダルの開閉イベント ---
btnOpenTeacherAuth.addEventListener("click", () => {
  if (isTeacherModeUnlocked) {
    // 既に解除済みの場合は直接先生用コントロールパネルを開き、最新URLプレビューを更新
    updateShareUrlPreview();
    teacherPanelModal.classList.add("active");
  } else {
    // 未解除の場合はパスコード認証モーダルを開く
    inputTeacherPasscode.value = "";
    alertTeacherAuth.classList.remove("visible");
    teacherAuthModal.classList.add("active");
    setTimeout(() => inputTeacherPasscode.focus(), 100);
  }
});

btnCancelTeacherAuth.addEventListener("click", () => {
  teacherAuthModal.classList.remove("active");
});

// パスコード認証処理
function verifyTeacherPasscode() {
  const entered = inputTeacherPasscode.value.trim();
  if (entered === teacherPasscode) {
    isTeacherModeUnlocked = true;
    teacherModeBadge.style.display = "inline-block";
    teacherAuthModal.classList.remove("active");
    updateShareUrlPreview();
    teacherPanelModal.classList.add("active");
  } else {
    alertTeacherAuth.classList.add("visible");
    inputTeacherPasscode.focus();
    inputTeacherPasscode.select();
  }
}

btnSubmitTeacherAuth.addEventListener("click", verifyTeacherPasscode);
inputTeacherPasscode.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    verifyTeacherPasscode();
  }
});

// --- 先生専用コントロールパネル内のイベント ---
btnCloseTeacherPanel.addEventListener("click", () => {
  teacherPanelModal.classList.remove("active");
});
btnApplyTeacherSettings.addEventListener("click", () => {
  teacherPanelModal.classList.remove("active");
});

// 先生モード終了（再施錠）
btnLockTeacherMode.addEventListener("click", () => {
  isTeacherModeUnlocked = false;
  teacherModeBadge.style.display = "none";
  teacherPanelModal.classList.remove("active");
  showToast("🔒 先生モードを終了しました（次回はパスコードが必要です）");
});

// 【生徒配布用 現在の設定リンクをコピー】
if (btnCopyCurrentConfigLink) {
  btnCopyCurrentConfigLink.addEventListener("click", () => {
    const url = generateStudentUrl();
    copyUrlToClipboard(url, "📋 現在の設定リンクをコピーしました！Classroom等で配布できます");
  });
}

// 【プリセットごとの生徒用リンクを直接コピー】
btnPresetLinkCopies.forEach(btn => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation(); // プリセット適用ボタンの発火と分離
    const presetKey = btn.dataset.preset;
    let params = {};
    let presetLabel = "";
    switch (presetKey) {
      case "tuning-fork":
        params = { gain: 5.0, w: 20, t: 0.5, v: 0.2, gate: 2 };
        presetLabel = "おんさ実験用";
        break;
      case "voice":
        params = { gain: 1.0, w: 40, t: 2.0, v: 0.5, gate: 3 };
        presetLabel = "声・歌声観察用";
        break;
      case "monochord":
        params = { gain: 2.0, w: 20, t: 1.0, v: 0.5, gate: 2 };
        presetLabel = "弦・モノコード用";
        break;
      case "loud":
        params = { gain: 0.5, w: 50, t: 5.0, v: 1.0, gate: 5 };
        presetLabel = "大音量・打楽器用";
        break;
    }
    const url = generateStudentUrl(params);
    copyUrlToClipboard(url, `📋 ${presetLabel}リンクをコピーしました！Classroom等で配布できます`);
  });
});

// 授業シーン別プリセットボタン
scenePresetButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    const preset = btn.dataset.preset;
    applyScenePreset(preset);
  });
});

// ゲインクイック選択ボタン
btnGainQuicks.forEach(btn => {
  btn.addEventListener("click", () => {
    const gain = parseFloat(btn.dataset.gain);
    applyGain(gain);
  });
});

// ゲインスライダー
teacherGainSlider.addEventListener("input", (e) => {
  const gain = parseFloat(e.target.value);
  applyGain(gain);
});

// 横マス数クイック選択ボタン
btnWidthQuicks.forEach(btn => {
  btn.addEventListener("click", () => {
    const divs = parseInt(btn.dataset.width, 10);
    applyHorizontalDivs(divs);
  });
});

// 先生側 TIME/DIV 変更
teacherTimeDivSelect.addEventListener("change", (e) => {
  applyTimeDiv(parseFloat(e.target.value));
});

// 先生側 VOLTS/DIV 変更
teacherVoltsDivSelect.addEventListener("change", (e) => {
  applyVoltsDiv(parseFloat(e.target.value));
});

// 先生側 ノイズゲート変更
teacherGateSlider.addEventListener("input", (e) => {
  applyNoiseGate(parseInt(e.target.value, 10));
});

// 先生側 カラーテーマ変更
teacherThemeSelect.addEventListener("change", (e) => {
  setTheme(e.target.value);
  syncCurrentConfigToStudents();
  updateShareUrlPreview();
});

// 生徒画面への詳細設定解放トグルスイッチ
chkUnlockStudentControls.addEventListener("change", (e) => {
  if (e.target.checked) {
    studentParamControls.style.display = "flex";
  } else {
    studentParamControls.style.display = "none";
  }
});

// 先生用パスコード変更ボタン
btnSaveNewPasscode.addEventListener("click", () => {
  const newPass = inputNewPasscode.value.trim();
  if (newPass.length === 4 && /^\d{4}$/.test(newPass)) {
    teacherPasscode = newPass;
    localStorage.setItem("school_oscilloscope_teacher_passcode", newPass);
    alert(`先生用パスコードを「${newPass}」に変更しました。`);
    inputNewPasscode.value = "";
  } else {
    alert("4桁の数字（例: 1234）を入力してください。");
  }
});

// --- リアルタイム授業ルーム管理（先生側） ---
btnStartRoom.addEventListener("click", () => {
  const code = startTeacherRoom();
  teacherRoomCodeDisplay.textContent = `#${code}`;
  roomInitialArea.style.display = "none";
  roomActiveArea.style.display = "block";

  // 開始直後の設定を一括配信
  syncCurrentConfigToStudents();

  // 自動的にプロジェクター用QRモーダルを表示
  showQRCodeModal(code);
});

btnShowQRModal.addEventListener("click", () => {
  const code = getCurrentRoomCode();
  if (code) {
    showQRCodeModal(code);
  }
});

btnCloseRoom.addEventListener("click", () => {
  leaveRoom();
  roomInitialArea.style.display = "block";
  roomActiveArea.style.display = "none";
  teacherRoomCodeDisplay.textContent = "#----";
});

/**
 * プロジェクター用大画面QRコードモーダルを表示する関数
 * @param {string} code - ルームコード
 */
function showQRCodeModal(code) {
  qrRoomCodeText.textContent = `#${code}`;
  // 参加用URLの生成（現在のURLに ?room=XXXX を付与）
  const joinUrl = new URL(window.location.href);
  joinUrl.searchParams.set("room", code);

  if (window.drawQRCodeToCanvas && qrCanvas) {
    try {
      window.drawQRCodeToCanvas(qrCanvas, joinUrl.toString(), 220);
    } catch (e) {
      console.warn("[QR] QRコード描画に失敗しました:", e);
    }
  }
  qrModal.classList.add("active");
}

btnCloseQRModal.addEventListener("click", () => {
  qrModal.classList.remove("active");
});

// --- 生徒側ルーム参加処理 ---
if (btnOpenJoinRoom) {
  btnOpenJoinRoom.addEventListener("click", () => {
    inputJoinRoomCode.value = "";
    alertJoinRoom.classList.remove("visible");
    joinRoomModal.classList.add("active");
    setTimeout(() => inputJoinRoomCode.focus(), 100);
  });
}

btnCancelJoinRoom.addEventListener("click", () => {
  joinRoomModal.classList.remove("active");
});

function submitJoinRoom() {
  const code = inputJoinRoomCode.value.trim().toUpperCase();
  if (code.length === 4) {
    joinRoom(code);
    joinRoomModal.classList.remove("active");
    updateRoomUI(code);
  } else {
    alertJoinRoom.classList.add("visible");
  }
}

btnSubmitJoinRoom.addEventListener("click", submitJoinRoom);
inputJoinRoomCode.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    submitJoinRoom();
  }
});

// 接続中バッジをクリックして退出
roomStatusBadge.addEventListener("click", () => {
  if (confirm("授業ルームから退出しますか？")) {
    leaveRoom();
    updateRoomUI(null);
  }
});

/**
 * ルーム接続状態UIの更新
 * @param {string|null} code 
 */
function updateRoomUI(code) {
  if (code) {
    currentRoomText.textContent = `#${code}`;
    roomStatusBadge.style.display = "inline-flex";
    if (btnOpenJoinRoom) btnOpenJoinRoom.style.display = "none";
  } else {
    roomStatusBadge.style.display = "none";
    if (btnOpenJoinRoom) btnOpenJoinRoom.style.display = "inline-flex";
  }
}

// 同期エンジンの初期化リスナー登録
initSyncEngine((config) => {
  console.log("[Sync] 先生からの設定を受信しました:", config);

  // 【生徒の一時停止保護ロジック】
  // 生徒がピタッと停止してノートに記録中の場合は、記録中の波形データ（frozenBuffer）を保護
  if (config.theme) setTheme(config.theme);
  if (config.gain !== undefined) applyGain(config.gain, true);
  if (config.horizontalDivs !== undefined) applyHorizontalDivs(config.horizontalDivs, true);
  if (config.timeDiv !== undefined) applyTimeDiv(config.timeDiv, true);
  if (config.voltsDiv !== undefined) applyVoltsDiv(config.voltsDiv, true);
  if (config.noiseGate !== undefined) applyNoiseGate(config.noiseGate, true);

  // 停止中の場合、背景の目盛りと波形を再描画（バッファは破棄しない）
  if (isFrozen && renderer.frozenBuffer) {
    renderer.render(renderer.frozenBuffer, true, 44100);
  }
});

// 起動時に既存ルーム参加があるか確認
const activeRoom = getCurrentRoomCode();
if (activeRoom) {
  updateRoomUI(activeRoom);
}

// ==========================================================================
// 起動時URLパラメータ自動解析・適用（設定埋め込みリンク共有）
// ==========================================================================

/**
 * ページ起動時にURLクエリパラメータ（?gain=...&w=...等）を解析し、
 * 先生が事前に指定した実験条件を自動でセットアップする関数
 * 【なぜこの機能が必要なのか】
 * 生徒がパスコードを入力したりQRコードを読み取る手間をゼロにし、
 * Classroomやロイロノートの配布リンクを開くだけで、先生の指定通りの波形スケールで
 * すぐに実験を開始できるようにするため。
 */
function applyUrlParams() {
  const params = new URLSearchParams(window.location.search);
  if (!params.toString()) return;

  const appliedItems = [];

  // 1. マイク感度・波形ゲイン (gain)
  if (params.has("gain")) {
    const g = parseFloat(params.get("gain"));
    if (!isNaN(g) && g >= 0.1 && g <= 20.0) {
      applyGain(g, true);
      appliedItems.push(`ゲイン ×${g}`);
    }
  }

  // 2. 波の表示幅・横マス数 (w)
  if (params.has("w")) {
    const w = parseInt(params.get("w"), 10);
    if (!isNaN(w) && w >= 10 && w <= 100) {
      applyHorizontalDivs(w, true);
      appliedItems.push(`横 ${w}マス`);
    }
  }

  // 3. 時間の目盛り (t: TIME/DIV)
  if (params.has("t")) {
    const t = parseFloat(params.get("t"));
    if (!isNaN(t)) {
      applyTimeDiv(t, true);
      appliedItems.push(`${t} ms/div`);
    }
  }

  // 4. 高さの目盛り (v: VOLTS/DIV)
  if (params.has("v")) {
    const v = parseFloat(params.get("v"));
    if (!isNaN(v)) {
      applyVoltsDiv(v, true);
      appliedItems.push(`${v} V/div`);
    }
  }

  // 5. ノイズ混入防止ゲート (gate)
  if (params.has("gate")) {
    const gate = parseInt(params.get("gate"), 10);
    if (!isNaN(gate)) {
      applyNoiseGate(gate, true);
    }
  }

  // 6. カラーテーマ (th)
  if (params.has("th")) {
    const th = params.get("th");
    if (th) {
      setTheme(th);
      if (teacherThemeSelect) teacherThemeSelect.value = th;
    }
  }

  // 生徒へのフィードバック（先生の指定設定で起動したことをわかりやすく通知）
  if (appliedItems.length > 0) {
    setTimeout(() => {
      showToast(`✨ 先生の設定（${appliedItems.join(" / ")}）を適用しました！マイクをONにして実験をはじめよう！`);
    }, 400);
  }
}

// 起動時のURLパラメータ適用とプレビューURL初期化
applyUrlParams();
updateShareUrlPreview();

// --- 生徒画面側（解放時）のイベントリスナー ---
timeDivSelect.addEventListener("change", (e) => {
  applyTimeDiv(parseFloat(e.target.value));
});

voltsDivSelect.addEventListener("change", (e) => {
  applyVoltsDiv(parseFloat(e.target.value));
});

noiseGateSlider.addEventListener("input", (e) => {
  applyNoiseGate(parseInt(e.target.value, 10));
});

// --- 7. 波形比較（音A・音Bスロット）イベント制御 ---

// 【音Aの保存（何度でも上書き可能）】
btnSaveSlotA.addEventListener("click", () => {
  // 一時停止中の場合は停止波形、動作中の場合は最新の音声バッファを取得
  const currentBuffer = isFrozen && renderer.frozenBuffer ? renderer.frozenBuffer : (lastAudioData ? lastAudioData.rawData : null);
  if (!currentBuffer) {
    alert("まずマイクをONにして音を出してください。");
    return;
  }
  renderer.setSlotA(currentBuffer);
  statusA.textContent = "保存済み";
  statusA.style.color = "#3b82f6";
  btnClearSlotA.style.display = "flex";
  btnSaveSlotA.textContent = "🔄 音Aを再保存";
  btnSaveSlotA.closest(".slot-card").classList.add("has-data");
});

// 音Aの消去
btnClearSlotA.addEventListener("click", () => {
  renderer.clearSlotA();
  statusA.textContent = "未保存";
  statusA.style.color = "var(--text-muted)";
  btnClearSlotA.style.display = "none";
  btnSaveSlotA.textContent = "📥 音Aを保存";
  btnSaveSlotA.closest(".slot-card").classList.remove("has-data");
});

// 【音Bの保存（何度でも上書き可能）】
btnSaveSlotB.addEventListener("click", () => {
  const currentBuffer = isFrozen && renderer.frozenBuffer ? renderer.frozenBuffer : (lastAudioData ? lastAudioData.rawData : null);
  if (!currentBuffer) {
    alert("まずマイクをONにして音を出してください。");
    return;
  }
  renderer.setSlotB(currentBuffer);
  statusB.textContent = "保存済み";
  statusB.style.color = "#ef4444";
  btnClearSlotB.style.display = "flex";
  btnSaveSlotB.textContent = "🔄 音Bを再保存";
  btnSaveSlotB.closest(".slot-card").classList.add("has-data");
});

// 音Bの消去
btnClearSlotB.addEventListener("click", () => {
  renderer.clearSlotB();
  statusB.textContent = "未保存";
  statusB.style.color = "var(--text-muted)";
  btnClearSlotB.style.display = "none";
  btnSaveSlotB.textContent = "📥 音Bを保存";
  btnSaveSlotB.closest(".slot-card").classList.remove("has-data");
  updatePhaseUI(0);
});

// 表示モード切り替え（重ね合わせ / 上下に並べる）
btnModeOverlay.addEventListener("click", () => {
  btnModeOverlay.classList.add("active");
  btnModeSplit.classList.remove("active");
  renderer.setDisplayMode("overlay");
});

btnModeSplit.addEventListener("click", () => {
  btnModeSplit.classList.add("active");
  btnModeOverlay.classList.remove("active");
  renderer.setDisplayMode("split");
});

// --- 8. 手動位相シフト（波の左右位置あわせ）制御 ---

/**
 * スライダー値（-100〜+100）から位相オフセットサンプル数を計算して適用する関数
 * 【なぜミリ秒換算するのか】
 * TIME/DIVのスケールに合わせて、画面の横幅に対して直感的に波が移動するようにするため。
 * 
 * @param {number} sliderValue - -100 〜 +100
 */
function updatePhaseUI(sliderValue) {
  const sampleRate = lastAudioData ? lastAudioData.sampleRate : 44100;
  // 最大で画面の半分（5マス分）相当の時間シフト
  const maxMs = renderer.timeDivMs * 5;
  const currentMs = (sliderValue / 100) * maxMs;
  const samples = Math.round((currentMs / 1000) * sampleRate);

  renderer.setPhaseShiftSamples(samples);
  const sign = currentMs > 0 ? "+" : "";
  phaseValText.textContent = `${sign}${currentMs.toFixed(2)} ms`;
  phaseSlider.value = sliderValue;
}

// スライダー操作
phaseSlider.addEventListener("input", (e) => {
  updatePhaseUI(parseFloat(e.target.value));
});

// ワンタップ微調整ボタン（◀ / ▶）
btnPhaseLeft.addEventListener("click", () => {
  const current = parseFloat(phaseSlider.value);
  updatePhaseUI(Math.max(-100, current - 4));
});

btnPhaseRight.addEventListener("click", () => {
  const current = parseFloat(phaseSlider.value);
  updatePhaseUI(Math.min(100, current + 4));
});

// リセットボタン
btnPhaseReset.addEventListener("click", () => {
  updatePhaseUI(0);
});

// 【Canvas画面上の直接ドラッグ（スワイプ）による位相調整】
// 生徒がタブレット等で波を直接指で掴んで左右に動かせるようにする
let isDragging = false;
let dragStartX = 0;
let dragStartPhase = 0;

function handleDragStart(clientX) {
  isDragging = true;
  dragStartX = clientX;
  dragStartPhase = parseFloat(phaseSlider.value);
}

function handleDragMove(clientX) {
  if (!isDragging) return;
  const deltaX = clientX - dragStartX;
  // 画面幅に応じたスライダー感度
  const deltaVal = (deltaX / canvas.clientWidth) * 150;
  const newVal = Math.max(-100, Math.min(100, dragStartPhase + deltaVal));
  updatePhaseUI(newVal);
}

function handleDragEnd() {
  isDragging = false;
}

canvas.addEventListener("mousedown", (e) => handleDragStart(e.clientX));
window.addEventListener("mousemove", (e) => handleDragMove(e.clientX));
window.addEventListener("mouseup", handleDragEnd);

canvas.addEventListener("touchstart", (e) => {
  if (e.touches.length > 0) handleDragStart(e.touches[0].clientX);
}, { passive: true });
window.addEventListener("touchmove", (e) => {
  if (e.touches.length > 0) handleDragMove(e.touches[0].clientX);
}, { passive: true });
window.addEventListener("touchend", handleDragEnd);

// --- 9. 画像保存モーダルおよび合成PNG出力処理 ---

// モーダルを開く
btnSaveImage.addEventListener("click", () => {
  // アラートと入力をリセット
  alertName.classList.remove("visible");
  alertCond.classList.remove("visible");
  inputStudentName.classList.remove("error");
  inputExperimentCond.classList.remove("error");

  saveModal.classList.add("active");
  inputStudentName.focus();
});

// モーダルを閉じる
btnCancelModal.addEventListener("click", () => {
  saveModal.classList.remove("active");
});

// 保存の確定と画像ダウンロード
btnConfirmSave.addEventListener("click", () => {
  const name = inputStudentName.value.trim();
  const cond = inputExperimentCond.value.trim();

  let hasError = false;

  // 【自由記述の入力バリデーション】
  if (!name) {
    alertName.classList.add("visible");
    inputStudentName.classList.add("error");
    hasError = true;
  } else {
    alertName.classList.remove("visible");
    inputStudentName.classList.remove("error");
  }

  if (!cond) {
    alertCond.classList.add("visible");
    inputExperimentCond.classList.add("error");
    hasError = true;
  } else {
    alertCond.classList.remove("visible");
    inputExperimentCond.classList.remove("error");
  }

  // どちらかが未入力の場合は保存を中止して生徒に入力を促す
  if (hasError) return;

  // 合成画像の生成とダウンロード
  exportImageWithMetadata(name, cond);

  // モーダルを閉じる
  saveModal.classList.remove("active");
});

/**
 * 名前・実験条件・日時・目盛り情報を合成したPNG画像を出力する関数
 * 【なぜ合成するのか】
 * 提出された画像単体で、誰がどのような実験を行い、どのような設定値だったかが
 * 先生や生徒自身に一目で伝わるポートフォリオにするため。
 * 
 * @param {string} studentName - 生徒の名前
 * @param {string} experimentCond - 実験の条件
 */
function exportImageWithMetadata(studentName, experimentCond) {
  // オフスクリーンCanvasの作成
  const exportCanvas = document.createElement("canvas");
  const exportCtx = exportCanvas.getContext("2d");

  const originalWidth = canvas.width;
  const originalHeight = canvas.height;

  // ヘッダー帯の高さを定義（70px相当）
  const headerHeight = Math.floor(originalHeight * 0.12);

  exportCanvas.width = originalWidth;
  exportCanvas.height = originalHeight + headerHeight;

  const currentTheme = getCurrentTheme();

  // 1. ヘッダー帯の背景を描画
  exportCtx.fillStyle = currentTheme.bg;
  exportCtx.fillRect(0, 0, exportCanvas.width, headerHeight);

  // 2. ヘッダー情報の文字を描画
  exportCtx.fillStyle = currentTheme.waveMain;
  const fontSize = Math.max(16, Math.floor(headerHeight * 0.28));
  exportCtx.font = `bold ${fontSize}px sans-serif`;

  const dateStr = new Date().toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });

  const timeDivText = timeDivSelect.options[timeDivSelect.selectedIndex].text;
  const voltsDivText = voltsDivSelect.options[voltsDivSelect.selectedIndex].text;

  // 1行目: なまえ & 日時
  const line1Y = Math.floor(headerHeight * 0.40);
  exportCtx.fillText(`👤 なまえ: ${studentName}`, 20, line1Y);
  const dateWidth = exportCtx.measureText(`📅 ${dateStr}`).width;
  exportCtx.fillText(`📅 ${dateStr}`, exportCanvas.width - dateWidth - 20, line1Y);

  // 2行目: 実験条件 & 比較状態・位相シフト
  const line2Y = Math.floor(headerHeight * 0.82);
  exportCtx.font = `${Math.floor(fontSize * 0.85)}px sans-serif`;
  exportCtx.fillStyle = currentTheme.osdColor;
  exportCtx.fillText(`🔬 実験条件: ${experimentCond}`, 20, line2Y);

  // 比較情報の組み立て
  const hasA = !!renderer.slotABuffer;
  const hasB = !!renderer.slotBBuffer;
  let compareInfo = "";
  if (hasA || hasB) {
    const modeName = renderer.displayMode === "split" ? "上下並列" : "重ね合わせ";
    const phaseText = hasB ? ` | 位相: ${phaseValText.textContent}` : "";
    compareInfo = `[比較: ${modeName}${phaseText}] `;
  }

  const gainVal = getGain();
  const gainText = `[ゲイン: ×${gainVal.toFixed(1)}] `;
  const widthVal = renderer.getHorizontalDivs();
  const widthText = `[横幅: ${widthVal}マス] `;
  const settingText = `${compareInfo}${gainText}${widthText}[${timeDivText}] [${voltsDivText}]`;
  const settingWidth = exportCtx.measureText(settingText).width;
  exportCtx.fillText(settingText, exportCanvas.width - settingWidth - 20, line2Y);

  // 3. 境界線の描画
  exportCtx.strokeStyle = currentTheme.grid;
  exportCtx.lineWidth = 2;
  exportCtx.beginPath();
  exportCtx.moveTo(0, headerHeight);
  exportCtx.lineTo(exportCanvas.width, headerHeight);
  exportCtx.stroke();

  // 4. オシロスコープ画面のコピー
  exportCtx.drawImage(canvas, 0, headerHeight);

  // 5. 安全なファイル名を生成してダウンロード
  // ファイル名禁止記号（\ / : * ? " < > |）を '_' に置換
  const safeName = studentName.replace(/[\\/:*?"<>| ]/g, "_");
  const safeCond = experimentCond.replace(/[\\/:*?"<>| ]/g, "_");
  const fileName = `${safeName}_${safeCond}.png`;

  const link = document.createElement("a");
  link.download = fileName;
  link.href = exportCanvas.toDataURL("image/png");
  link.click();
}

// ==========================================================================
// 10. 画面切り替えタブ制御
// ==========================================================================

/**
 * 画面タブを切り替える関数
 * 【なぜ状態を維持するのか】
 * タブを切り替えても、生徒が波形タブで一時停止（ホールド）した波形や、
 * 記録した音A・音Bのデータが消えないようにするため。
 * 
 * @param {string} targetTab - "wave" | "tuner" | "generator"
 */
function switchTab(targetTab) {
  currentTab = targetTab;

  // タブボタンのアクティブ状態を更新
  tabBtnWave.classList.toggle("active", targetTab === "wave");
  tabBtnTuner.classList.toggle("active", targetTab === "tuner");
  tabBtnGenerator.classList.toggle("active", targetTab === "generator");

  // セクションの表示・非表示を切り替え
  sectionWave.style.display = targetTab === "wave" ? "flex" : "none";
  sectionTuner.style.display = targetTab === "tuner" ? "flex" : "none";
  sectionGenerator.style.display = targetTab === "generator" ? "flex" : "none";

  // 波形タブに戻ったときはCanvasのサイズを再計算
  if (targetTab === "wave") {
    renderer.handleResize();
  }
}

tabBtnWave.addEventListener("click", () => switchTab("wave"));
tabBtnTuner.addEventListener("click", () => switchTab("tuner"));
tabBtnGenerator.addEventListener("click", () => switchTab("generator"));

// ==========================================================================
// 11. 【タブ2】音の高さしらべ（チューナー）表示更新
// ==========================================================================

/**
 * チューナー画面の音名・周波数・メーター針をリアルタイム更新する関数
 * @param {Float32Array} buffer - 音声バッファ
 * @param {number} sampleRate - サンプリングレート
 * @param {boolean} isAboveGate - 音量しきい値を超えているか
 */
function updateTunerDisplay(buffer, sampleRate, isAboveGate) {
  if (!isAboveGate || !buffer || buffer.length === 0) {
    tunerStatusMsg.textContent = "マイクに向かって声を出したり、モノコードを弾いてみよう！";
    tunerNeedle.style.left = "50%";
    tunerNeedle.classList.remove("in-tune");
    tunerNoteDisplay.classList.remove("in-tune");
    return;
  }

  // 自己相関法によるピッチ検出
  const pitch = detectPitch(buffer, sampleRate);

  if (pitch && pitch >= 60 && pitch <= 1500) {
    const details = getNoteDetails(pitch);
    if (details) {
      tunerSolfege.textContent = details.solfege;
      tunerNoteName.textContent = details.noteName;
      tunerFrequency.textContent = `${pitch.toFixed(1)} Hz`;
      tunerStandardFreq.textContent = `（基準: ${details.standardFreq.toFixed(1)} Hz）`;

      // セントずれ（-50 〜 +50）をゲージのパーセント（0%〜100%）にマッピング
      // 0セントが中央の 50%
      const clampedCents = Math.max(-50, Math.min(50, details.cents));
      const needlePos = 50 + clampedCents; // -50で0%、0で50%、+50で100%
      tunerNeedle.style.left = `${needlePos}%`;

      const sign = details.cents > 0 ? "+" : "";
      tunerCents.textContent = `${sign}${details.cents} セント`;

      // 判定メッセージとお褒めアニメーション
      if (Math.abs(details.cents) <= 5) {
        tunerStatusMsg.textContent = "✨ ピッタリ！完璧な音の高さです！";
        tunerNeedle.classList.add("in-tune");
        tunerNoteDisplay.classList.add("in-tune");
      } else if (details.cents > 5) {
        tunerStatusMsg.textContent = `少し高いよ（あと ${details.cents} セント下げてみよう）`;
        tunerNeedle.classList.remove("in-tune");
        tunerNoteDisplay.classList.remove("in-tune");
      } else {
        tunerStatusMsg.textContent = `少し低いよ（あと ${Math.abs(details.cents)} セント上げてみよう）`;
        tunerNeedle.classList.remove("in-tune");
        tunerNoteDisplay.classList.remove("in-tune");
      }
    }
  }
}

// ==========================================================================
// 12. 【タブ3】基準音ジェネレーター（トーンジェネレーター）イベント制御
// ==========================================================================

// ワンタップおんさプリセットボタン
presetButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    presetButtons.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");

    const freq = parseFloat(btn.dataset.freq);
    currentToneFreq = freq;
    genFreqSlider.value = freq;
    genFreqDisplay.textContent = `${freq.toFixed(1)} Hz`;
    genNoteDisplay.textContent = `(${btn.dataset.note})`;

    setToneFrequency(freq);
  });
});

// 周波数連続調整スライダー
genFreqSlider.addEventListener("input", (e) => {
  presetButtons.forEach(b => b.classList.remove("active"));
  const freq = parseFloat(e.target.value);
  currentToneFreq = freq;
  genFreqDisplay.textContent = `${freq.toFixed(1)} Hz`;

  const details = getNoteDetails(freq);
  if (details) {
    genNoteDisplay.textContent = `(${details.solfege} / ${details.noteName})`;
  }
  setToneFrequency(freq);
});

// 波形タイプ選択チップ（音色の違い）
waveChips.forEach(chip => {
  chip.addEventListener("click", () => {
    waveChips.forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    currentToneType = chip.dataset.type;
    setToneType(currentToneType);
  });
});

// 音を鳴らす/止めるボタン
btnToggleTone.addEventListener("click", () => {
  isTonePlaying = !isTonePlaying;

  if (isTonePlaying) {
    startTone(currentToneFreq, currentToneType, 0.25);
    btnToggleTone.classList.add("playing");
    tonePlayIcon.textContent = "⏹️";
    tonePlayText.textContent = "音を止める";
  } else {
    stopTone();
    btnToggleTone.classList.remove("playing");
    tonePlayIcon.textContent = "▶️";
    tonePlayText.textContent = "音を鳴らす";
  }
});

// 内部直結観察モード（ハウリングなしで波形タブで直接波を見る）
btnLoopback.addEventListener("click", () => {
  isLoopbackActive = !isLoopbackActive;
  btnLoopback.classList.toggle("active", isLoopbackActive);
  setLoopbackEnabled(isLoopbackActive);

  if (isLoopbackActive) {
    btnLoopback.textContent = "✅ 内部直結中（波形タブへ送信中）";
    // 自動で音を鳴らし、波形タブへスムーズに案内
    if (!isTonePlaying) {
      btnToggleTone.click();
    }
    switchTab("wave");
  } else {
    btnLoopback.textContent = "🔀 波形観察タブでこの音を見る";
  }
});
