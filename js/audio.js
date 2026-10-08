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
let gainNode = null;
let microphoneStream = null;
let timeDomainBuffer = null;

// マイク入力ゲイン（増幅倍率：初期値1.0倍）
// 【なぜ初期値を1.0倍にするのか】
// 通常はマイクの生信号のまま取り込み、先生が小さな音を大きく見せたい場合にのみ
// 2倍、5倍、10倍などに増幅できるようにするため。
let currentGain = 1.0;

// ノイズゲートのしきい値（0.0 〜 1.0）
// 【なぜ初期値を0.02にするのか】
// 0.05だと通常の声の立ち上がりがカットされて遅延を感じるため、
// 敏感に反応しつつ無音時の暗騒音をカットできる0.02（2%）を初期値とする。
let noiseGateThreshold = 0.02;

// ゲートが開いた後のリリース保持フレーム数（約10フレーム＝約160ms）
// 【なぜリリース保持が必要なのか】
// 音の立ち上がりで瞬時にゲートを開いた後、母音の切れ目などで波形が瞬時に消えて
// パラパラと点滅するのを防ぎ、自然で滑らかな観察を可能にするため。
let gateHoldCounter = 0;
const GATE_HOLD_FRAMES = 10;

/**
 * 波形解析パイプライン（GainNode → AnalyserNode）を初期化・確保する内部ヘルパー
 * 【なぜこの共通化が必要なのか】
 * マイク入力だけでなく、アプリ内部で生成した基準音（トーンジェネレーター）の直結観察時にも
 * まったく同じゲイン増幅器（GainNode）と解析器（AnalyserNode）を通すことで、
 * どちらの入力ソースでも先生が設定したゲイン倍率（0.5x〜10x）が正確に波形振幅に反映されるようにするため。
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

    // ゲインノード → アナライザー に接続（スピーカーには出力しないためハウリングしない）
    gainNode.connect(analyserNode);
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

    // 【なぜGainNode（増幅器）を挟むのか】
    // 先生が設定したゲイン倍率（0.5x〜10x）で信号を増幅し、
    // 小さな音やおんさの減衰音でも波形が大きく綺麗に映るようにするため。
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
 * ノイズゲートのしきい値を設定する関数
 * @param {number} threshold - 0.0 〜 1.0 の範囲のしきい値
 */
export function setNoiseGateThreshold(threshold) {
  noiseGateThreshold = Math.max(0, Math.min(1, threshold));
}

/**
 * 現在のノイズゲートしきい値を取得する関数
 * @returns {number} しきい値
 */
export function getNoiseGateThreshold() {
  return noiseGateThreshold;
}

/**
 * 音声のリアルタイム解析データを取得する関数
 * 【なぜピーク検出とホールドを組み合わせるのか】
 * - 45ミリ秒全体のRMS平均だけだと、音が鳴り始めた瞬間（最初のアタック）の
 *   値が小さくなり、ゲートが開くまでにタイムラグ（遅延）が発生するため。
 * - ピーク振幅（最大値）を併用することで、音が出た最初の0.001秒で瞬時にゲートを開放する。
 * 
 * @returns {Object} { rawData: Float32Array, rms: number, isAboveGate: boolean, sampleRate: number }
 */
export function getAudioData() {
  if (!analyserNode || !timeDomainBuffer) {
    return {
      rawData: new Float32Array(0),
      rms: 0,
      isAboveGate: false,
      sampleRate: 44100
    };
  }

  // 最新の時間領域波形データを取得 (-1.0 〜 +1.0)
  analyserNode.getFloatTimeDomainData(timeDomainBuffer);

  // 音の強さ（RMS）と瞬間ピーク振幅を同時に計算
  let sumSquares = 0;
  let peak = 0;
  const len = timeDomainBuffer.length;

  for (let i = 0; i < len; i++) {
    const val = timeDomainBuffer[i];
    const absVal = Math.abs(val);
    if (absVal > peak) peak = absVal;
    sumSquares += val * val;
  }

  const rms = Math.sqrt(sumSquares / len);

  // 【即時アタック検出】
  // RMSがしきい値を超えているか、またはピーク振幅がしきい値×1.5を超えた瞬間に即座に検知
  const isTriggered = (rms >= noiseGateThreshold) || (peak >= noiseGateThreshold * 1.5);

  if (isTriggered) {
    // 音を検出したらホールドタイマーを満杯にリセット
    gateHoldCounter = GATE_HOLD_FRAMES;
  } else if (gateHoldCounter > 0) {
    // 音が止まった直後も指定フレーム数はゲートを開いたまま維持（滑らかな余韻）
    gateHoldCounter--;
  }

  const isAboveGate = (gateHoldCounter > 0) || (noiseGateThreshold <= 0.005);

  return {
    rawData: timeDomainBuffer,
    rms: rms,
    isAboveGate: isAboveGate,
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
  audioContext = null;
  analyserNode = null;
  gainNode = null;
}
