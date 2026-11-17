/**
 * ==========================================================================
 * まるごと波形きろく（連続録音・比較描画）エンジン (recorder.js)
 * ==========================================================================
 * 【なぜこのモジュールが必要なのか】
 * - ボタンを押してから再度押すまでの間にマイクから入力された全音声データを記録し、
 *   時間経過（秒単位）に伴う音の減衰や変化を波形全体として可視化するため。
 * - リアルタイムオシロスコープ（数ミリ秒の瞬時波形）とは異なり、
 *   「音の余韻の長さ」「おんさを強く叩いた時と弱く叩いた時の音の消え方の違い」
 *   などを、音Aと音Bの2つのスロットで比較・画像保存できるようにする。
 * ==========================================================================
 */

import { getCurrentTheme } from "./themes.js";

export class WaveformRecorder {
  /**
   * @param {HTMLCanvasElement} canvas - 全体波形を描画するCanvas要素
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");

    // 録音データのスロット管理（音A・音B）
    // 【なぜFloat32Arrayの配列で保持するのか】
    // 録音中は可変長のチャンクを高速にpushし、録音停止時に1つの連続バッファに結合することで、
    // メモリ再確保によるプチノイズやフレーム落ちをゼロにするため。
    this.slotAData = null; // Float32Array
    this.slotBData = null; // Float32Array
    this.sampleRate = 44100;

    // 現在の録音状態 ('idle', 'waiting_a', 'waiting_b', 'recording_a', 'recording_b')
    this.recordingState = "idle";
    this.recordingChunks = [];
    this.recordingSamplesCount = 0;
    this.recordingStartTime = 0;
    // トリガー待機中に直近1チャンクだけ保持するプリロールバッファ
    // 【なぜプリロールバッファが必要なのか】
    // 音が出た瞬間にトリガーが反応しても、ScriptProcessorのブロック境界の都合で
    // 叩いた最初のアタック波形が欠けるのを防ぎ、立ち上がりから正確に記録するため。
    this.preRollChunk = null;

    // 最大録音時間（15秒：生徒端末のメモリ保護および十分な実験時間）
    this.maxRecordingDurationSec = 15;

    // 比較表示モード: "split"（上下に並べる） または "overlay"（重ね合わせ）
    this.displayMode = "split";

    // 音声再生管理（Web Audio API）
    this.currentPlayingSource = null;
    this.playbackSlot = null;
    this.playbackStartTime = 0;
    this.playbackDuration = 0;
    this.playbackProgressTimer = null;

    // 画面サイズ調整
    this.handleResize();
    window.addEventListener("resize", () => {
      this.handleResize();
      this.draw();
    });
  }

  /**
   * Canvasの解像度を端末のピクセル比率（devicePixelRatio）に合わせて最適化
   */
  handleResize() {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    this.width = rect.width;
    this.height = rect.height;

    this.canvas.width = Math.floor(rect.width * dpr);
    this.canvas.height = Math.floor(rect.height * dpr);

    this.ctx.resetTransform();
    this.ctx.scale(dpr, dpr);
  }

  /**
   * 録音（またはトリガー待機）を開始する
   * @param {'A'|'B'} slot - 記録対象のスロット ('A' または 'B')
   * @param {boolean} [waitForTrigger=false] - trueの場合、しきい値を超えるまで待機状態にする
   */
  startRecording(slot, waitForTrigger = false) {
    this.stopPlayback(); // 再生中なら停止
    if (waitForTrigger) {
      this.recordingState = slot === "A" ? "waiting_a" : "waiting_b";
    } else {
      this.recordingState = slot === "A" ? "recording_a" : "recording_b";
    }
    this.recordingChunks = [];
    this.recordingSamplesCount = 0;
    this.recordingStartTime = performance.now();
    this.preRollChunk = null;
    this.draw();
  }

  /**
   * トリガー待機状態から実際の記録（録音）状態へ移行する
   * @returns {boolean} 待機状態から録音へ移行した場合 true
   */
  triggerRecording() {
    if (this.recordingState === "waiting_a") {
      this.recordingState = "recording_a";
    } else if (this.recordingState === "waiting_b") {
      this.recordingState = "recording_b";
    } else {
      return false;
    }

    this.recordingStartTime = performance.now();
    // 直前のプリロールチャンクがあれば先頭に含めて立ち上がりを欠損させない
    if (this.preRollChunk) {
      this.recordingChunks.push(this.preRollChunk);
      this.recordingSamplesCount += this.preRollChunk.length;
      this.preRollChunk = null;
    }
    this.draw();
    return true;
  }

  /**
   * 待機状態・録音状態を保存せずにキャンセルしてアイドルに戻す
   */
  cancelRecording() {
    this.recordingState = "idle";
    this.recordingChunks = [];
    this.recordingSamplesCount = 0;
    this.preRollChunk = null;
    this.draw();
  }

  /**
   * 音声入力ストリームからデータチャンクを受信して蓄積する
   * @param {Float32Array} chunk - 取得したPCMサンプルデータ
   * @param {number} sampleRate - サンプリング周波数（例: 44100）
   * @returns {boolean} 最大記録時間に達して自動停止すべきか
   */
  addAudioChunk(chunk, sampleRate) {
    if (this.recordingState === "idle") return false;

    this.sampleRate = sampleRate || 44100;

    // 待機中は最新1チャンクのみプリロールとして保持し、録音時間には積算しない
    if (this.recordingState === "waiting_a" || this.recordingState === "waiting_b") {
      this.preRollChunk = new Float32Array(chunk);
      return false;
    }

    // データを安全に複製して保存
    this.recordingChunks.push(new Float32Array(chunk));
    this.recordingSamplesCount += chunk.length;

    // 最大記録時間を超えたか判定
    const currentDuration = this.recordingSamplesCount / this.sampleRate;
    if (currentDuration >= this.maxRecordingDurationSec) {
      return true; // 上限到達通知
    }
    return false;
  }

  /**
   * 現在の録音経過秒数を取得する
   * @returns {number} 経過秒数
   */
  getRecordingDurationSec() {
    if (this.recordingState !== "recording_a" && this.recordingState !== "recording_b") return 0;
    return this.recordingSamplesCount / (this.sampleRate || 44100);
  }

  /**
   * 録音を停止し、蓄積データをスロットに確定する
   * @returns {'A'|'B'} 記録が確定したスロット
   */
  stopRecording() {
    const slot = (this.recordingState === "recording_a" || this.recordingState === "waiting_a") ? "A" : "B";
    this.recordingState = "idle";
    this.preRollChunk = null;

    if (this.recordingSamplesCount === 0) {
      this.recordingChunks = [];
      this.draw();
      return slot;
    }

    // すべてのチャンクを1つの連続したFloat32Arrayに統合
    const mergedBuffer = new Float32Array(this.recordingSamplesCount);
    let offset = 0;
    for (const chunk of this.recordingChunks) {
      mergedBuffer.set(chunk, offset);
      offset += chunk.length;
    }

    if (slot === "A") {
      this.slotAData = mergedBuffer;
    } else {
      this.slotBData = mergedBuffer;
    }

    this.recordingChunks = [];
    this.draw();
    return slot;
  }

  /**
   * 指定したスロットの録音データを消去する
   * @param {'A'|'B'} slot
   */
  clearSlot(slot) {
    this.stopPlayback();
    if (slot === "A") {
      this.slotAData = null;
    } else {
      this.slotBData = null;
    }
    this.draw();
  }

  /**
   * スロットにデータが存在するか判定
   * @param {'A'|'B'} slot
   * @returns {boolean}
   */
  hasData(slot) {
    return slot === "A" ? !!this.slotAData : !!this.slotBData;
  }

  /**
   * スロットの録音時間（秒）を取得
   * @param {'A'|'B'} slot
   * @returns {number}
   */
  getDuration(slot) {
    const data = slot === "A" ? this.slotAData : this.slotBData;
    if (!data) return 0;
    return data.length / this.sampleRate;
  }

  /**
   * 表示モードを設定（"split" または "overlay"）
   * @param {'split'|'overlay'} mode
   */
  setDisplayMode(mode) {
    this.displayMode = mode;
    this.draw();
  }

  /**
   * 全体波形を描画する（メイン描画ループ）
   */
  draw() {
    if (!this.canvas || !this.ctx) return;

    const theme = getCurrentTheme();
    const w = this.width;
    const h = this.height;

    // 1. 背景の塗りつぶし
    this.ctx.fillStyle = theme.bg;
    this.ctx.fillRect(0, 0, w, h);

    const hasA = !!this.slotAData;
    const hasB = !!this.slotBData;

    // データが何もない場合のガイド表示
    if (!hasA && !hasB) {
      this.drawEmptyGuide(w, h, theme);
    } else {
      // 基準となる表示時間（両方のスロットのうち長い方、または最低2秒）
      const durationA = hasA ? this.slotAData.length / this.sampleRate : 0;
      const durationB = hasB ? this.slotBData.length / this.sampleRate : 0;
      const maxDuration = Math.max(2.0, Math.max(durationA, durationB));

      if (this.displayMode === "split" && hasA && hasB) {
        // --- 上下に並べて比較モード ---
        const halfH = Math.floor(h / 2);

        // 上段: 音A
        this.drawSingleSlotTrack({
          x: 0,
          y: 0,
          width: w,
          height: halfH,
          data: this.slotAData,
          duration: durationA,
          maxDuration: maxDuration,
          title: "🔵 音A（基準）",
          color: "#3b82f6",
          theme: theme,
          showTimeline: false
        });

        // 境界区切り線
        this.ctx.strokeStyle = theme.subGrid;
        this.ctx.lineWidth = 2;
        this.ctx.beginPath();
        this.ctx.moveTo(0, halfH);
        this.ctx.lineTo(w, halfH);
        this.ctx.stroke();

        // 下段: 音B
        this.drawSingleSlotTrack({
          x: 0,
          y: halfH,
          width: w,
          height: halfH,
          data: this.slotBData,
          duration: durationB,
          maxDuration: maxDuration,
          title: "🔴 音B（比較）",
          color: "#ef4444",
          theme: theme,
          showTimeline: true
        });
      } else {
        // --- 重ね合わせモード または 単独スロット表示 ---
        this.drawOverlayTrack({
          x: 0,
          y: 0,
          width: w,
          height: h,
          dataA: this.slotAData,
          dataB: this.slotBData,
          durationA: durationA,
          durationB: durationB,
          maxDuration: maxDuration,
          theme: theme
        });
      }
    }

    // 待機中・録音中のステータスバナー（Canvas下部に控えめに重ねて状態を明示）
    if (this.recordingState === "waiting_a" || this.recordingState === "waiting_b") {
      const targetName = this.recordingState === "waiting_a" ? "音A" : "音B";
      this.drawStatusOverlay(w, h, `⏳ ${targetName}の入力を待っています…（赤い線より大きい音を鳴らすと記録スタート）`, "#f59e0b");
    } else if (this.recordingState === "recording_a" || this.recordingState === "recording_b") {
      const targetName = this.recordingState === "recording_a" ? "音A" : "音B";
      this.drawStatusOverlay(w, h, `🔴 ${targetName}を記録中…（もう一度ボタンを押すと完了します）`, "#ef4444");
    }
  }

  /**
   * 待機中・録音中の状態バナーをCanvas下部に描画するヘルパー
   */
  drawStatusOverlay(w, h, text, accentColor) {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = "bold 13px sans-serif";
    const textWidth = ctx.measureText(text).width;
    const boxW = Math.min(w - 24, textWidth + 28);
    const boxH = 30;
    const boxX = (w - boxW) / 2;
    const boxY = h - boxH - 14;

    ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(boxX, boxY, boxW, boxH, 15);
    } else {
      ctx.rect(boxX, boxY, boxW, boxH);
    }
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, w / 2, boxY + boxH / 2);
    ctx.restore();
  }

  /**
   * データ未記録時のガイダンス表示
   */
  drawEmptyGuide(w, h, theme) {
    // グリッド線のみうっすら描画
    this.drawTimeGrid(0, 0, w, h, 5.0, theme, true);

    this.ctx.fillStyle = theme.osdColor || "#64748b";
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";
    this.ctx.font = "bold 16px sans-serif";
    if (this.recordingState === "waiting_a" || this.recordingState === "waiting_b") {
      this.ctx.fillText("大きい音を鳴らすと、その瞬間から記録が始まります！", w / 2, h / 2 - 12);
      this.ctx.font = "13px sans-serif";
      this.ctx.fillStyle = "rgba(100, 116, 139, 0.85)";
      this.ctx.fillText("下のスライダーで反応する音の大きさ（赤い線）を調整できます", w / 2, h / 2 + 16);
    } else {
      this.ctx.fillText("「🔴 音Aのきろく開始」ボタンを押して音を鳴らしてください", w / 2, h / 2 - 12);
      this.ctx.font = "13px sans-serif";
      this.ctx.fillStyle = "rgba(100, 116, 139, 0.8)";
      this.ctx.fillText("しきい値以上の音を検知した瞬間から、全体の音の波形が記録されます", w / 2, h / 2 + 16);
    }
  }

  /**
   * 単一トラック（上下分割時の各領域）を描画
   */
  drawSingleSlotTrack({ x, y, width, height, data, duration, maxDuration, title, color, theme, showTimeline }) {
    // 背景グリッドと時間目盛りの描画
    this.drawTimeGrid(x, y, width, height, maxDuration, theme, showTimeline);

    // トラック見出し
    this.ctx.fillStyle = color;
    this.ctx.font = "bold 13px sans-serif";
    this.ctx.textAlign = "left";
    this.ctx.textBaseline = "top";
    this.ctx.fillText(`${title} (${duration.toFixed(2)} 秒)`, x + 12, y + 8);

    if (!data) return;

    // 波形のエンベロープ（包絡線）描画
    // 【なぜエンベロープ方式を採用するのか】
    // 何十万ものサンプルをそのまま描画すると線が潰れて塗りつぶされるため、
    // 各ピクセルごとの最大値と最小値を抽出し、音の輪郭をクリアに可視化する。
    this.drawEnvelope(x, y, width, height, data, maxDuration, color);
  }

  /**
   * 重ね合わせトラックを描画
   */
  drawOverlayTrack({ x, y, width, height, dataA, dataB, durationA, durationB, maxDuration, theme }) {
    // 背景グリッドと時間目盛り
    this.drawTimeGrid(x, y, width, height, maxDuration, theme, true);

    // 波形Aの描画（青色・やや半透明）
    if (dataA) {
      this.drawEnvelope(x, y, width, height, dataA, maxDuration, "rgba(59, 130, 246, 0.75)");
    }

    // 波形Bの描画（赤色・やや半透明）
    if (dataB) {
      this.drawEnvelope(x, y, width, height, dataB, maxDuration, "rgba(239, 68, 68, 0.75)");
    }

    // 凡例表示（左上）
    this.ctx.textAlign = "left";
    this.ctx.textBaseline = "top";
    this.ctx.font = "bold 13px sans-serif";

    let labelX = x + 12;
    if (dataA) {
      this.ctx.fillStyle = "#3b82f6";
      this.ctx.fillText(`🔵 音A: ${durationA.toFixed(2)}s`, labelX, y + 8);
      labelX += 130;
    }
    if (dataB) {
      this.ctx.fillStyle = "#ef4444";
      this.ctx.fillText(`🔴 音B: ${durationB.toFixed(2)}s`, labelX, y + 8);
    }
  }

  /**
   * 時間軸グリッド線と秒数ラベルの描画
   */
  drawTimeGrid(x, y, width, height, maxDuration, theme, showLabels) {
    const ctx = this.ctx;
    const centerY = y + height / 2;

    // ゼロレベル中心線
    ctx.strokeStyle = theme.centerLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, centerY);
    ctx.lineTo(x + width, centerY);
    ctx.stroke();

    // 時間目盛り（0.5秒または1秒刻みでグリッド線を引く）
    const stepSec = maxDuration <= 4 ? 0.5 : 1.0;
    const totalSteps = Math.ceil(maxDuration / stepSec);

    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = theme.osdColor || "#64748b";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";

    for (let i = 0; i <= totalSteps; i++) {
      const timeVal = i * stepSec;
      if (timeVal > maxDuration) break;

      const lineX = x + (timeVal / maxDuration) * width;

      // 縦のグリッド線
      ctx.beginPath();
      ctx.moveTo(lineX, y);
      ctx.lineTo(lineX, y + height);
      ctx.stroke();

      // 秒数ラベル
      if (showLabels && lineX <= x + width - 15) {
        ctx.fillText(`${timeVal.toFixed(1)}s`, lineX, y + height - 4);
      }
    }
  }

  /**
   * 音声データのエンベロープ（最大値・最小値）を美しく描画する内部関数
   */
  drawEnvelope(x, y, width, height, data, maxDuration, color) {
    const ctx = this.ctx;
    const centerY = y + height / 2;
    const amplitudeH = (height / 2) * 0.88; // 上下に少し余白を残す

    const totalSamples = data.length;
    const duration = totalSamples / this.sampleRate;
    // 描画される実際の横幅
    const plotWidth = Math.min(width, (duration / maxDuration) * width);

    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;

    // 1ピクセル幅ごとに最大値・最小値を集計して縦線を描く
    const pixels = Math.max(1, Math.floor(plotWidth));
    const samplesPerPixel = totalSamples / pixels;

    ctx.beginPath();
    for (let px = 0; px < pixels; px++) {
      const startIdx = Math.floor(px * samplesPerPixel);
      const endIdx = Math.min(totalSamples, Math.floor((px + 1) * samplesPerPixel));

      let min = 1.0;
      let max = -1.0;

      for (let i = startIdx; i < endIdx; i++) {
        const val = data[i];
        if (val < min) min = val;
        if (val > max) max = val;
      }

      if (min > max) {
        min = 0;
        max = 0;
      }

      const drawX = x + px;
      const topY = centerY - max * amplitudeH;
      const bottomY = centerY - min * amplitudeH;

      ctx.moveTo(drawX, topY);
      ctx.lineTo(drawX, bottomY);
    }
    ctx.stroke();
  }

  /**
   * 記録した音声をスピーカーから再生する
   * @param {'A'|'B'} slot
   * @param {AudioContext} audioContext
   * @param {Function} onProgress - (progress: number) => void
   * @param {Function} onEnded - () => void
   */
  play(slot, audioContext, onProgress, onEnded) {
    this.stopPlayback();

    const data = slot === "A" ? this.slotAData : this.slotBData;
    if (!data || !audioContext) return;

    try {
      const audioBuffer = audioContext.createBuffer(1, data.length, this.sampleRate);
      audioBuffer.getChannelData(0).set(data);

      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioContext.destination);

      this.currentPlayingSource = source;
      this.playbackSlot = slot;
      this.playbackStartTime = audioContext.currentTime;
      this.playbackDuration = audioBuffer.duration;

      source.onended = () => {
        this.stopPlayback();
        if (onEnded) onEnded();
      };

      source.start();

      // 再生位置の定期通知
      if (onProgress) {
        this.playbackProgressTimer = setInterval(() => {
          if (!this.currentPlayingSource) return;
          const elapsed = audioContext.currentTime - this.playbackStartTime;
          const progress = Math.min(1.0, elapsed / this.playbackDuration);
          onProgress(progress);
        }, 30);
      }
    } catch (err) {
      console.error("[Recorder] 再生エラー:", err);
      this.stopPlayback();
      if (onEnded) onEnded();
    }
  }

  /**
   * 音声の再生を停止する
   */
  stopPlayback() {
    if (this.playbackProgressTimer) {
      clearInterval(this.playbackProgressTimer);
      this.playbackProgressTimer = null;
    }
    if (this.currentPlayingSource) {
      try {
        this.currentPlayingSource.stop();
        this.currentPlayingSource.disconnect();
      } catch (e) {
        // すでに停止している場合は無視
      }
      this.currentPlayingSource = null;
    }
    this.playbackSlot = null;
  }
}
