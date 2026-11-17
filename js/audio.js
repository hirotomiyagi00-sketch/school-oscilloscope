/**
 * ==========================================================================
 * 音声入力・解析モジュール (audio.js)
 * ==========================================================================
 * 【なぜこのモジュールが必要なのか】
 * - ブラウザの Web Audio API を用いてマイクからの音声ストリームを取得し、
 *   オシロスコープ描画に必要な時間領域データ（波形の生データ）と
 *   音量（RMS）をリアルタイムに抽出するため。
 * - 教室での騒音混入を防ぐ「ノイズゲート（しきい値判定）」を実装し、
 *   隣の班の音をカットして自分の班の実験音だけを取り込めるようにする。
 * ==========================================================================
 */

let audioContext = null;
let analyserNode = null;
let rawAnalyserNode = null;
let gainNode = null;
let microphoneStream = null;
let timeDomainBuffer = null;
let rawTimeDomainBuffer = null;

// マイク入力ゲイン（増幅倍率：初期値1.0倍）
// 【なぜ初期値を1.0倍にするのか】
// 通常はマイクの生信号のまま取り込み、先生が小さな音を大きく見せたい場合にのみ
// 2倍、5倍、10倍などに増幅できるようにするため。
let currentGain = 1.0;

// ノイズゲートのしきい値（UI・内部共通の最適化パーセント: 0 〜 100）
// 【なぜ生の数値と1:1にせずdB最適化パーセントで管理するのか】
// マイクの生入力（autoGainControl: false）は実用的な音量が 0.002〜0.3 付近に偏るため、
// 生の値と1:1にするとスライダー左端に調整域が密集し微調整が極めて難しくなる。
// 対数（dB）カーブで実用域を 0〜100% へ広げ、画面の緑バーと赤線の位置を一致させることで
// 「微調整のしやすさ」と「赤線を超えたら反応する直感性」を両立する。
let noiseGatePercent = 25;

// dBスケーリング範囲（静かな室内の約-54dB 〜 大音量の-6dBを 0%〜100% に割り当て）
const MIN_GATE_DB = -54;
const MAX_GATE_DB = -6;

// 一度しきい値を超えた後に音を拾い続けるラッチ時間（10秒 = 10000ms）
// 【なぜ10秒ラッチ方式にするのか】
// おんさや楽器の減衰音を観察する際、毎フレーム音量判定を行うと余韻が小さくなった瞬間に
// 波形が突然消えてしまう。瞬間的な大きい音で一度トリガーを引いた後は、
// 停止ボタンが押されるか10秒経過するまで減衰音を含めて途切れず観察できるようにするため。
const GATE_LATCH_DURATION_MS = 10000;
let gateActiveUntil = 0;

/**
 * 生入力の振幅レベル（0.0〜1.0）を操作しやすい音量メーター%（0〜100）へ変換する
 * 【なぜ対数（dB）マッピングを用いるのか】
 * 人間の聴覚は音圧に対して対数的に反応するため、dB基準でマッピングすることで
 * 雑音〜会話〜楽器の音までがメーター全体にバランスよく分布し、閾値調整がしやすくなる。
 *
 * @param {number} level - 生入力の代表振幅レベル
 * @returns {number} 0〜100 のメーター表示パーセント
 */
function levelToMeterPercent(level) {
  if (!level || level <= 0) return 0;
  const db = 20 * Math.log10(Math.max(level, 1e-5));
  const pct = ((db - MIN_GATE_DB) / (MAX_GATE_DB - MIN_GATE_DB)) * 100;
  return Math.max(0, Math.min(100, pct));
}

/**
 * 波形解析パイプライン（GainNode → AnalyserNode ＆ 生入力監視用 rawAnalyserNode）を初期化・確保する内部ヘルパー
 * 【なぜ2系統のアナライザーを用意するのか】
 * - 先生がゲインを ×5.0 や ×10.0 に上げても、ノイズゲート（トリガー）の判定は
 *   ゲイン増幅前の「マイク生の音」で行い、周囲の雑音増幅による誤作動を防ぐため。
 * - 描画用には GainNode 通過後の信号を使い、基準音ジェネレーターの内部直結観察時にも
 *   先生が設定したゲイン倍率（0.5x〜10x）が正確に波形振幅へ反映されるようにする。
 */
function ensureAnalysisPipeline() {
  if (!audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextClass({
      latencyHint: "interactive"
    });
  }
  if (!gainNode) {
    gainNode = audioContext.createGain();
    gainNode.gain.setValueAtTime(currentGain, audioContext.currentTime);
    gainNode.gain.value = currentGain;
  }
  if (!analyserNode) {
    analyserNode = audioContext.createAnalyser();
    // 【なぜ fftSize を 2048 に設定するのか】
    // 時間領域のサンプリング解像度を十分に高く確保し、
    // 高い音（細かな波）でも滑らかに描画できるようにするため。
    analyserNode.fftSize = 2048;
    timeDomainBuffer = new Float32Array(analyserNode.fftSize);

    // ゲインノード → 表示用アナライザー に接続（スピーカーには出力しないためハウリングしない）
    gainNode.connect(analyserNode);
  }
  if (!rawAnalyserNode) {
    rawAnalyserNode = audioContext.createAnalyser();
    rawAnalyserNode.fftSize = 2048;
    rawTimeDomainBuffer = new Float32Array(rawAnalyserNode.fftSize);
  }
}

/**
 * マイクを初期化し、音声解析を開始する関数
 * 【なぜユーザー操作（クリック）が必要なのか】
 * ブラウザのセキュリティ仕様（Autoplay Policy）により、ユーザーのクリック等の
 * 明示的な操作なしに AudioContext を開始することが禁止されているため。
 * 
 * @returns {Promise<boolean>} 初期化が成功したかどうか
 */
export async function initAudio() {
  try {
    // 共通解析パイプライン（GainNode -> AnalyserNode）を確保
    ensureAnalysisPipeline();

    // マイクのアクセス許可をリクエスト
    // 【なぜ echoCancellation 等を無効化するのか】
    // 通話用の自動ゲインコントロール(AGC)やノイズキャンセラが働くと、
    // おんさの純音や楽器の微細な波形がブラウザによって消去されてしまうため、
    // 実験用オシロスコープでは極力「生の音（Raw Audio）」を取得する。
    microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,  // エコーキャンセラOFF
        noiseSuppression: false,  // ブラウザ自動ノイズ低減OFF
        autoGainControl: false    // 自動ゲイン調整OFF（振幅が狂うのを防ぐ）
      },
      video: false
    });

    // マイクストリームを Web Audio のソースノードに接続
    const sourceNode = audioContext.createMediaStreamSource(microphoneStream);

    // 【なぜGainNodeの前段と後段の2系統に接続するのか】
    // 1. rawAnalyserNode（ゲイン前）: 生の音量をそのまま監視し、ゲイン変更の影響を受けないノイズゲート判定を行うため。
    // 2. gainNode（増幅器）: 先生が設定したゲイン倍率（0.5x〜10x）で信号を増幅し、小さな音でも画面上に大きく描くため。
    sourceNode.connect(rawAnalyserNode);
    sourceNode.connect(gainNode);

    // コンテキストがサスペンド状態の場合は再開
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    return true;
  } catch (error) {
    console.error("[Audio] マイクの初期化に失敗しました:", error);
    throw error;
  }
}

/**
 * マイク感度・波形ゲイン（増幅倍率）を設定する関数
 * 【なぜ setValueAtTime でアンカーした後に linearRamp を用いるのか】
 * - ゲインを瞬時に切り替えると「プチッ」という破裂音（クリックノイズ）が生じ、
 *   波形が乱れたりノイズゲートが誤判定するのを防ぐため、0.04秒かけて滑らかに音量を変更する。
 * - cancelScheduledValues 直後に現在値を明示的に setValueAtTime しないと、
 *   Web Audio API 仕様によりランプの始点が未定義となってゲイン変更が無視されるのを防ぐ。
 * 
 * @param {number} multiplier - 増幅倍率（0.5〜10.0など）
 */
export function setGain(multiplier) {
  const val = Math.max(0.1, Math.min(20, Number(multiplier) || 1.0));
  currentGain = val;
  if (gainNode && audioContext) {
    try {
      gainNode.gain.cancelScheduledValues(audioContext.currentTime);
      gainNode.gain.setValueAtTime(gainNode.gain.value, audioContext.currentTime);
      gainNode.gain.linearRampToValueAtTime(val, audioContext.currentTime + 0.04);
    } catch (e) {
      gainNode.gain.setValueAtTime(val, audioContext.currentTime);
    }
    // プロパティ直接代入も併用し、確実に即時反映させる
    gainNode.gain.value = val;
  }
}

/**
 * 現在設定されているゲイン倍率を取得する関数
 * @returns {number} ゲイン倍率
 */
export function getGain() {
  return currentGain;
}

/**
 * ノイズゲート（トリガー）のしきい値パーセントを設定する関数
 * 【なぜ変更時にラッチ状態をリセットするのか】
 * ユーザーがスライダーを動かして閾値を上げた際、前のラッチ（10秒保持）が残ったままだと
 * 新しい閾値が即座に効いている手応えが感じられないため、変更時点で一度待機判定をやり直す。
 *
 * @param {number} percent - 0 〜 100 のしきい値（0は待機なし・常時入力）
 */
export function setNoiseGateThreshold(percent) {
  noiseGatePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  gateActiveUntil = 0;
}

/**
 * 現在のノイズゲートしきい値（0〜100%）を取得する関数
 * @returns {number} しきい値（0〜100）
 */
export function getNoiseGateThreshold() {
  return noiseGatePercent;
}

/**
 * ノイズゲートの10秒保持（ラッチ）を強制リセットして「待機状態」に戻す関数
 * 【なぜこの関数が必要なのか】
 * 一時停止（ピタッと停止）から再開した直後や、実験をやり直したいときに
 * 前の計測の残り時間を引き継がず、次の音が鳴るまでクリーンに待機するため。
 */
export function resetNoiseGateLatch() {
  gateActiveUntil = 0;
}

/**
 * ゲイン適用前の「生の音」の音量レベルとメーター%を取得する関数
 * 【なぜ生音（プリゲイン）で測定するのか】
 * 先生が波形を見やすくするためにゲイン倍率を上げても、周囲の暗騒音まで
 * しきい値を突破してゲートが開いてしまうのを防ぐため。
 *
 * @returns {{ rawRms: number, rawPeak: number, rawLevel: number, meterPercent: number }}
 */
export function getRawAudioLevel() {
  if (!rawAnalyserNode || !rawTimeDomainBuffer) {
    return { rawRms: 0, rawPeak: 0, rawLevel: 0, meterPercent: 0 };
  }

  rawAnalyserNode.getFloatTimeDomainData(rawTimeDomainBuffer);

  let sumSquares = 0;
  let peak = 0;
  const len = rawTimeDomainBuffer.length;

  for (let i = 0; i < len; i++) {
    const val = rawTimeDomainBuffer[i];
    const absVal = Math.abs(val);
    if (absVal > peak) peak = absVal;
    sumSquares += val * val;
  }

  const rms = Math.sqrt(sumSquares / len);
  // 持続音（サイン波等）ではRMSを、叩いた瞬間のアタックはピークの45%を併用して取りこぼしを防ぐ
  const rawLevel = Math.max(rms, peak * 0.45);
  const meterPercent = levelToMeterPercent(rawLevel);

  return {
    rawRms: rms,
    rawPeak: peak,
    rawLevel: rawLevel,
    meterPercent: meterPercent
  };
}

/**
 * 生入力の音が現在設定されているノイズゲートしきい値を超えているか判定する関数
 * （「まるごと波形きろく」タブの自動録音スタート判定でも共通利用）
 *
 * @returns {boolean} しきい値超過中（またはしきい値0%・内部直結中）なら true
 */
export function isRawAudioAboveThreshold() {
  if (noiseGatePercent <= 0) return true;
  if (isLoopbackEnabled && !!toneOscillator) return true;
  const { meterPercent } = getRawAudioLevel();
  return meterPercent >= noiseGatePercent;
}

/**
 * 音声のリアルタイム解析データを取得する関数
 * 【なぜ「10秒ラッチ型」のトリガー判定にするのか】
 * 瞬間的に大きい音を出してしきい値を超えた後、おんさの減衰音などが小さくなっても
 * 10秒経過するかユーザーが停止ボタンを押すまで途切れず波形を観察し続けられるようにするため。
 *
 * @param {Object} [options]
 * @param {boolean} [options.freezeLatch=false] - 一時停止中は新規ラッチ発火を抑止する
 * @returns {Object} { rawData: Float32Array, rms: number, meterPercent: number, isAboveGate: boolean, isLatched: boolean, gateRemainingMs: number, isBypassed: boolean, sampleRate: number }
 */
export function getAudioData(options = {}) {
  const freezeLatch = !!options.freezeLatch;

  if (!analyserNode || !timeDomainBuffer) {
    return {
      rawData: new Float32Array(0),
      rms: 0,
      meterPercent: 0,
      isAboveGate: false,
      isLatched: false,
      gateRemainingMs: 0,
      isBypassed: noiseGatePercent <= 0,
      sampleRate: 44100
    };
  }

  // 表示用の時間領域波形データ（GainNode通過後）を取得 (-1.0 〜 +1.0)
  analyserNode.getFloatTimeDomainData(timeDomainBuffer);

  let sumSquares = 0;
  const len = timeDomainBuffer.length;
  for (let i = 0; i < len; i++) {
    const val = timeDomainBuffer[i];
    sumSquares += val * val;
  }
  const rms = Math.sqrt(sumSquares / len);

  // ゲート判定＆メーター表示には「ゲイン適用前の生の音」を使用
  const rawStats = getRawAudioLevel();
  const isLoopbackActive = isLoopbackEnabled && !!toneOscillator;
  const isBypassed = (noiseGatePercent <= 0) || isLoopbackActive;

  // 内部直結モード時はループバック信号のRMSからメーター表示を補完して視認性を保つ
  const displayMeterPercent = isLoopbackActive
    ? Math.max(rawStats.meterPercent, levelToMeterPercent(rms))
    : rawStats.meterPercent;

  const now = performance.now();
  let isAboveGate = false;
  let isLatched = false;
  let gateRemainingMs = 0;

  if (isBypassed) {
    // 閾値0%または基準音ジェネレーター内部直結時は待機せず常に通す
    isAboveGate = true;
    gateActiveUntil = 0;
  } else {
    // 一時停止中でなく、かつ現在待機中のときに生の音が閾値を超えたら10秒間ラッチ開放
    if (!freezeLatch && gateActiveUntil <= now && rawStats.meterPercent >= noiseGatePercent) {
      gateActiveUntil = now + GATE_LATCH_DURATION_MS;
    }

    if (gateActiveUntil > now) {
      isAboveGate = true;
      isLatched = true;
      gateRemainingMs = gateActiveUntil - now;
    } else {
      // 10秒経過後は自動で待機状態へ戻す
      gateActiveUntil = 0;
      isAboveGate = false;
    }
  }

  return {
    rawData: timeDomainBuffer,
    rms: rms,
    meterPercent: Math.round(displayMeterPercent),
    isAboveGate: isAboveGate,
    isLatched: isLatched,
    gateRemainingMs: gateRemainingMs,
    isBypassed: isBypassed,
    sampleRate: audioContext.sampleRate
  };
}

/**
 * 自己相関法（Autocorrelation）による高精度ピッチ（基本周波数）検出関数
 * 【なぜ自己相関法を用いるのか】
 * FFT（周波数解析）のピーク検出では倍音成分に引っ張られてオクターブ誤認が
 * 起こりやすいため、時間領域での波の周期性を直接測る自己相関法を採用し、
 * 中学生の声やモノコードの音でも正確に音の高さを特定できるようにする。
 * 
 * @param {Float32Array} buffer - 音声バッファ
 * @param {number} sampleRate - サンプリングレート
 * @returns {number|null} 検出された基本周波数（Hz）
 */
export function detectPitch(buffer, sampleRate) {
  if (!buffer || buffer.length === 0) return null;

  const SIZE = buffer.length;
  // 検出する周波数範囲（約60Hz 〜 1200Hz）に対応するラグの範囲
  const minLag = Math.floor(sampleRate / 1200); // 高音限界（約1200Hz）
  const maxLag = Math.floor(sampleRate / 60);   // 低音限界（約60Hz）

  // 二乗和平均（RMS）が小さすぎる（無音）場合は検出しない
  let sumSquares = 0;
  for (let i = 0; i < SIZE; i++) {
    sumSquares += buffer[i] * buffer[i];
  }
  const rms = Math.sqrt(sumSquares / SIZE);
  if (rms < 0.015) return null;

  let bestLag = -1;
  let bestCorrelation = 0;

  // ラグを変化させて自己相関を計算
  for (let lag = minLag; lag <= maxLag; lag++) {
    let correlation = 0;
    for (let i = 0; i < SIZE - lag; i++) {
      correlation += buffer[i] * buffer[i + lag];
    }

    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestLag = lag;
    }
  }

  // 十分な相関強度が得られた場合のみ周波数を算出
  if (bestCorrelation > sumSquares * 0.4 && bestLag > 0) {
    return sampleRate / bestLag;
  }

  return null;
}

/**
 * 周波数（Hz）から音名・オクターブ・セントずれを算出する関数
 * @param {number} freq - 周波数（Hz）
 * @returns {Object} { noteName: string, solfege: string, octave: number, cents: number, standardFreq: number }
 */
export function getNoteDetails(freq) {
  if (!freq || freq <= 0) return null;

  // A4 = 440Hz を基準としたMIDIノート番号の計算
  const noteNum = 12 * (Math.log(freq / 440) / Math.log(2)) + 69;
  const roundedNote = Math.round(noteNum);
  const cents = Math.round((noteNum - roundedNote) * 100);

  // 12音階名（英語表記および日本の中学生に馴染みのあるドレミ表記）
  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const SOLFEGE_NAMES = ["ド", "ド#", "レ", "レ#", "ミ", "ファ", "ファ#", "ソ", "ソ#", "ラ", "ラ#", "シ"];

  const noteIndex = roundedNote % 12;
  const octave = Math.floor(roundedNote / 12) - 1;
  const standardFreq = 440 * Math.pow(2, (roundedNote - 69) / 12);

  return {
    noteName: `${NOTE_NAMES[noteIndex]}${octave}`,
    solfege: `${SOLFEGE_NAMES[noteIndex]}`,
    octave: octave,
    cents: cents, // -50 〜 +50（0が完全一致）
    standardFreq: Math.round(standardFreq * 10) / 10
  };
}

// ==========================================================================
// 基準音ジェネレーター（トーンジェネレーター）機能
// ==========================================================================

let toneOscillator = null;
let toneGainNode = null;
let isLoopbackEnabled = false;

/**
 * 基準音の再生を開始する関数
 * @param {number} freq - 再生する周波数（Hz）
 * @param {string} type - 波形タイプ ("sine" | "square" | "sawtooth" | "triangle")
 * @param {number} volume - 音量（0.0 〜 1.0）
 */
export function startTone(freq = 440, type = "sine", volume = 0.3) {
  if (!audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextClass({ latencyHint: "interactive" });
  }

  // 既に再生中の場合は停止
  stopTone();

  toneOscillator = audioContext.createOscillator();
  toneGainNode = audioContext.createGain();

  toneOscillator.type = type;
  toneOscillator.frequency.setValueAtTime(freq, audioContext.currentTime);

  toneGainNode.gain.setValueAtTime(volume, audioContext.currentTime);

  // スピーカーへの出力接続
  toneOscillator.connect(toneGainNode);
  toneGainNode.connect(audioContext.destination);

  // 【内部直結モード】
  // マイクを通さずに直接オシロスコープのGainNode（ゲイン増幅器）に送ることで、
  // ハウリングなしに綺麗なサイン波を観察でき、かつゲイン変更も正確に反映されるようにする。
  if (isLoopbackEnabled) {
    ensureAnalysisPipeline();
    toneGainNode.connect(gainNode);
  }

  toneOscillator.start();
}

/**
 * 基準音の周波数を変更する
 * @param {number} freq - 周波数（Hz）
 */
export function setToneFrequency(freq) {
  if (toneOscillator && audioContext) {
    toneOscillator.frequency.setTargetAtTime(freq, audioContext.currentTime, 0.05);
  }
}

/**
 * 基準音の波形タイプを変更する
 * @param {string} type - "sine" | "square" | "sawtooth" | "triangle"
 */
export function setToneType(type) {
  if (toneOscillator) {
    toneOscillator.type = type;
  }
}

/**
 * 基準音の音量を変更する
 * @param {number} volume - 音量（0.0 〜 1.0）
 */
export function setToneVolume(volume) {
  if (toneGainNode && audioContext) {
    toneGainNode.gain.setTargetAtTime(volume, audioContext.currentTime, 0.05);
  }
}

/**
 * 基準音の再生を停止する関数
 */
export function stopTone() {
  if (toneOscillator) {
    try {
      toneOscillator.stop();
      toneOscillator.disconnect();
    } catch (e) {}
    toneOscillator = null;
  }
  if (toneGainNode) {
    toneGainNode.disconnect();
    toneGainNode = null;
  }
}

/**
 * 内部直結モードの有効/無効を切り替える
 * @param {boolean} enabled - 有効にするか
 */
export function setLoopbackEnabled(enabled) {
  isLoopbackEnabled = !!enabled;
  if (toneGainNode) {
    if (isLoopbackEnabled) {
      ensureAnalysisPipeline();
      try {
        toneGainNode.connect(gainNode);
      } catch (e) {}
    } else if (gainNode) {
      try {
        toneGainNode.disconnect(gainNode);
      } catch (e) {}
    }
  }
}

/**
 * AudioContextを停止・解放する関数
 */
export function stopAudio() {
  stopTone();
  if (microphoneStream) {
    microphoneStream.getTracks().forEach(track => track.stop());
  }
  if (audioContext) {
    audioContext.close();
  }
}

// --- 連続波形レコーダー連携用フック ---
let recordDataCallback = null;
let recordingProcessorNode = null;
let recordingSilentGain = null;

/**
 * 連続波形記録用の音声データストリーム供給を開始する関数
 * 【なぜScriptProcessorNodeを採用するのか】
 * - Safari/iPadOS、Chromebook、Windowsなどあらゆる教育端末において、
 *   外部Workletスクリプト読み込みに伴うセキュリティ制約（file://やCORS制限）を回避し、
 *   100%確実に高精度なPCMサンプルを連続取得できるようにするため。
 * 
 * @param {Function} onData - (channelData: Float32Array, sampleRate: number) => void
 */
export function startRecordingStream(onData) {
  ensureAnalysisPipeline();
  recordDataCallback = onData;

  if (!recordingProcessorNode && audioContext && gainNode) {
    try {
      // 4096サンプルのバッファ（約90ms間隔で安定コールバック）
      recordingProcessorNode = audioContext.createScriptProcessor(4096, 1, 1);
      
      recordingProcessorNode.onaudioprocess = (e) => {
        if (recordDataCallback) {
          const input = e.inputBuffer.getChannelData(0);
          recordDataCallback(input, audioContext.sampleRate);
        }
      };

      // ゲイン調整後の信号を取り込む
      gainNode.connect(recordingProcessorNode);

      // 【ブラウザGC対策】
      // Web Audio APIの仕様上、ProcessorNodeがdestination（出力）の系統に
      // 接続されていないとブラウザによって自動破棄されるため、
      // ゲイン0（完全無音）のノードを経由して安全にdestinationに接続する。
      recordingSilentGain = audioContext.createGain();
      recordingSilentGain.gain.value = 0;
      recordingProcessorNode.connect(recordingSilentGain);
      recordingSilentGain.connect(audioContext.destination);
    } catch (err) {
      console.error("[Audio] 録音プロセッサの初期化に失敗:", err);
    }
  }
}

/**
 * 連続波形記録用の音声データストリーム供給を停止する関数
 */
export function stopRecordingStream() {
  recordDataCallback = null;
  if (recordingProcessorNode) {
    try {
      if (gainNode) gainNode.disconnect(recordingProcessorNode);
      recordingProcessorNode.disconnect();
    } catch (e) {}
    recordingProcessorNode = null;
  }
  if (recordingSilentGain) {
    try {
      recordingSilentGain.disconnect();
    } catch (e) {}
    recordingSilentGain = null;
  }
}

/**
 * 現在のAudioContextインスタンスを取得する関数（再生用）
 * @returns {AudioContext|null}
 */
export function getAudioContextInstance() {
  return audioContext;
}

