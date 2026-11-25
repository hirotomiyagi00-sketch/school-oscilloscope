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

    // 比較表示モード: デフォルトは1つの音（compareEnabled = false）
    this.compareEnabled = false;
    this.displayMode = "split";

    // --- 波形拡大ルーペ（2段表示）＆ 音B左右位置ずらし用パラメータ ---
    // 【なぜタブ1の縦軸・横軸設定をルーペへ同期させるのか】
    // 先生が「波形観察・比較（タブ1）」で調整した TIME/DIV・VOLTS/DIV・横マス数を
    // ルーペでも全く同じレンジで反映させることで、タブ間を行き来しても違和感なく
    // おんさや楽器の波形を同じ縮尺で観察・比較できるようにするため。
    this.inspectTimeSec = 0;      // ルーペで拡大表示する中心時刻（秒）
    this.timeDivMs = 1.0;         // タブ1連動: 1大マスあたりの時間（ms）
    this.voltsDiv = 0.5;          // タブ1連動: 1縦マスあたりの振幅（V）
    this.horizontalDivs = 50;     // タブ1連動: 横の小マス数（10〜50）
    this.loupeZoomMult = 1;       // ルーペの相対時間倍率（1 = タブ1と完全一致, 2, 5）
    this.slotBOffsetSec = 0;      // 音Bの横位置ずらし量（秒: 正で右へ、負で左へ移動）
    this.overviewRatio = 0.58;    // Canvas高さに対する上段（全体波形）の占有比率

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

    // 録音完了時、現在の検査時刻が未設定または録音範囲外なら最大音量ピーク付近へ自動移動
    // 【なぜピーク位置へ自動移動するのか】
    // 先頭0.00秒はプリロールの無音部分になりやすいため、録音直後から下段ルーペに
    // 最も見やすい波形が自動で表示されるようにするため。
    const newDuration = mergedBuffer.length / this.sampleRate;
    const otherHasData = slot === "A" ? !!this.slotBData : !!this.slotAData;
    if (!otherHasData || this.inspectTimeSec <= 0 || this.inspectTimeSec > newDuration) {
      this.inspectTimeSec = this.findPeakTime(mergedBuffer);
    }

    this.recordingChunks = [];
    this.draw();
    return slot;
  }

  /**
   * 波形データ内で最も振幅が大きい（見やすい）時刻（秒）を探す内部ヘルパー
   * @param {Float32Array} data - 音声データ
   * @returns {number} ピーク時刻（秒）
   */
  findPeakTime(data) {
    if (!data || data.length === 0) return 0;
    let maxAbs = -1;
    let maxIdx = 0;
    // 間引き走査（4サンプルごと）で高速にピーク位置を特定
    for (let i = 0; i < data.length; i += 4) {
      const absVal = Math.abs(data[i]);
      if (absVal > maxAbs) {
        maxAbs = absVal;
        maxIdx = i;
      }
    }
    const peakSec = maxIdx / this.sampleRate;
    const duration = data.length / this.sampleRate;
    // ルーペ窓の半分だけ端から離して中央に綺麗に収まるようにする
    const halfWinSec = (this.getLoupeWindowMs() / 1000) / 2;
    return Math.max(halfWinSec, Math.min(Math.max(0, duration - halfWinSec), peakSec));
  }

  /**
   * 現在の表示全体時間（秒）を取得する
   * @returns {number}
   */
  getMaxDuration() {
    const durationA = this.slotAData ? this.slotAData.length / this.sampleRate : 0;
    const durationB = (this.compareEnabled && this.slotBData) ? this.slotBData.length / this.sampleRate : 0;
    if (durationA === 0 && durationB === 0) return 0;
    return Math.max(2.0, Math.max(durationA, durationB));
  }

  /**
   * 実際にデータが存在する最長時間（秒）を取得する
   * @returns {number}
   */
  getMaxDataDuration() {
    const durationA = this.slotAData ? this.slotAData.length / this.sampleRate : 0;
    const durationB = (this.compareEnabled && this.slotBData) ? this.slotBData.length / this.sampleRate : 0;
    return Math.max(durationA, durationB);
  }

  /**
   * 「1つの音（false）」／「2つの音をくらべる（true）」モードを切り替えて再描画する
   * @param {boolean} enabled
   */
  setCompareEnabled(enabled) {
    this.compareEnabled = !!enabled;
    this.draw();
  }

  /**
   * 上段（全体波形エリア）の描画高さ（px）を取得する
   * @returns {number}
   */
  getOverviewHeight() {
    return Math.floor(this.height * this.overviewRatio);
  }

  /**
   * タブ1（波形観察・比較）の縦軸・横軸レンジ設定をルーペへ同期する
   * 【なぜタブ1と同じパラメータを受け取るのか】
   * タブ1とまるごと波形きろくのルーペで時間幅・振幅スケール・方眼マス数を完全統一し、
   * 先生が準備した実験設定のまま波の形を観察できるようにするため。
   *
   * @param {Object} scale
   * @param {number} [scale.timeDivMs] - TIME/DIV（ms）
   * @param {number} [scale.voltsDiv] - VOLTS/DIV（V）
   * @param {number} [scale.horizontalDivs] - 横の小マス数（10〜50）
   */
  setOscilloscopeScale({ timeDivMs, voltsDiv, horizontalDivs } = {}) {
    if (timeDivMs !== undefined && !isNaN(Number(timeDivMs))) {
      this.timeDivMs = Math.max(0.1, Number(timeDivMs));
    }
    if (voltsDiv !== undefined && !isNaN(Number(voltsDiv))) {
      this.voltsDiv = Math.max(0.05, Number(voltsDiv));
    }
    if (horizontalDivs !== undefined && !isNaN(Number(horizontalDivs))) {
      this.horizontalDivs = Math.max(10, Math.min(100, Number(horizontalDivs)));
    }
    this.draw();
  }

  /**
   * ルーペの相対時間倍率（×1=タブ1と同一 / ×2 / ×5）を設定して再描画する
   * @param {number} mult
   */
  setLoupeZoomMult(mult) {
    this.loupeZoomMult = Math.max(1, Math.min(20, Number(mult) || 1));
    this.draw();
  }

  /**
   * 現在のルーペ相対時間倍率を取得する
   * @returns {number}
   */
  getLoupeZoomMult() {
    return this.loupeZoomMult;
  }

  /**
   * 現在のルーペ表示時間幅（ミリ秒）をタブ1設定から算出して取得する
   * @returns {number}
   */
  getLoupeWindowMs() {
    const mainDivs = this.horizontalDivs / 5;
    return this.timeDivMs * mainDivs * this.loupeZoomMult;
  }

  /**
   * 音Bの横位置ずらし量（秒）を設定して再描画する
   * 【なぜ音Bのみをずらすのか】
   * 音Aを基準として固定し、音Bだけを左右にスライドして立ち上がり位置を揃えることで、
   * タブ1の位相シフトと同じ操作感にし、中学1年生が迷わないようにするため。
   *
   * @param {number} sec - ずらし量（秒、正で右へ、負で左へ）
   */
  setSlotBOffsetSec(sec) {
    const maxDur = Math.max(2.0, this.getMaxDuration());
    const limit = maxDur;
    this.slotBOffsetSec = Math.max(-limit, Math.min(limit, Number(sec) || 0));
    this.draw();
  }

  /**
   * 音Bの横位置を相対移動（微調整）する
   * @param {number} deltaSec - 移動量（秒）
   */
  nudgeSlotBOffsetSec(deltaSec) {
    this.setSlotBOffsetSec(this.slotBOffsetSec + deltaSec);
  }

  /**
   * 現在の音B横位置ずらし量（秒）を取得する
   * @returns {number}
   */
  getSlotBOffsetSec() {
    return this.slotBOffsetSec;
  }

  /**
   * ルーペの検査中心時刻（秒）を設定して再描画する
   * @param {number} sec - 秒
   */
  setInspectTime(sec) {
    const maxDur = this.getMaxDuration();
    if (maxDur <= 0) {
      this.inspectTimeSec = 0;
      return;
    }
    this.inspectTimeSec = Math.max(0, Math.min(maxDur, Number(sec) || 0));
    this.draw();
  }

  /**
   * ルーペの検査時刻を相対移動（微調整）する
   * @param {number} deltaSec - 移動量（秒、正負対応）
   */
  nudgeInspectTime(deltaSec) {
    this.setInspectTime(this.inspectTimeSec + deltaSec);
  }

  /**
   * 現在のルーペ検査時刻（秒）を取得する
   * @returns {number}
   */
  getInspectTime() {
    return this.inspectTimeSec;
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
      this.slotBOffsetSec = 0;
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
    const hasB = this.compareEnabled && !!this.slotBData;

    // データが何もない場合のガイド表示
    if (!hasA && !hasB) {
      this.drawEmptyGuide(w, h, theme);
    } else {
      // 基準となる表示時間（両方のスロットのうち長い方、または最低2秒）
      const durationA = hasA ? this.slotAData.length / this.sampleRate : 0;
      const durationB = hasB ? this.slotBData.length / this.sampleRate : 0;
      const maxDuration = Math.max(2.0, Math.max(durationA, durationB));

      // 検査時刻が現在のデータ最大長を超えていた場合は安全に丸める
      const maxDataDur = Math.max(durationA, durationB);
      if (this.inspectTimeSec > maxDataDur) {
        this.inspectTimeSec = this.findPeakTime(this.slotAData || (hasB ? this.slotBData : null));
      }

      // 2段構成のレイアウト計算: 上段＝全体波形（減衰確認）、下段＝波形拡大ルーペ（波の形確認）
      const overviewH = this.getOverviewHeight();
      const loupeY = overviewH;
      const loupeH = h - overviewH;

      // ------------------------------------------------------------------
      // 上段: 全体波形（減衰カーブ表示エリア）
      // ------------------------------------------------------------------
      if (!this.compareEnabled) {
        // --- 1つの音モード（シンプル単独表示） ---
        this.drawSingleSlotTrack({
          x: 0,
          y: 0,
          width: w,
          height: overviewH,
          data: this.slotAData,
          duration: durationA,
          maxDuration: maxDuration,
          title: "🎙️ きろく波形",
          color: theme.waveMain,
          theme: theme,
          showTimeline: true
        });
      } else if (this.displayMode === "split" && hasA && hasB) {
        // --- 上下に並べて比較モード ---
        const halfOverviewH = Math.floor(overviewH / 2);

        // 上段: 音A
        this.drawSingleSlotTrack({
          x: 0,
          y: 0,
          width: w,
          height: halfOverviewH,
          data: this.slotAData,
          duration: durationA,
          maxDuration: maxDuration,
          title: "🔵 音A（基準）",
          color: "#3b82f6",
          theme: theme,
          showTimeline: false
        });

        // 音A/音Bの境界区切り線
        this.ctx.strokeStyle = theme.subGrid;
        this.ctx.lineWidth = 1.5;
        this.ctx.beginPath();
        this.ctx.moveTo(0, halfOverviewH);
        this.ctx.lineTo(w, halfOverviewH);
        this.ctx.stroke();

        // 下段: 音B（横位置ずらし slotBOffsetSec を適用）
        const offsetSign = this.slotBOffsetSec > 0 ? "+" : "";
        const offsetLabel = Math.abs(this.slotBOffsetSec) >= 0.005
          ? ` / 位置: ${offsetSign}${this.slotBOffsetSec.toFixed(2)}s`
          : "";
        this.drawSingleSlotTrack({
          x: 0,
          y: halfOverviewH,
          width: w,
          height: overviewH - halfOverviewH,
          data: this.slotBData,
          duration: durationB,
          maxDuration: maxDuration,
          title: `🔴 音B（比較${offsetLabel}）`,
          color: "#ef4444",
          theme: theme,
          showTimeline: true,
          offsetSec: this.slotBOffsetSec
        });
      } else {
        // --- 重ね合わせモード または 単独スロット表示 ---
        this.drawOverlayTrack({
          x: 0,
          y: 0,
          width: w,
          height: overviewH,
          dataA: this.slotAData,
          dataB: hasB ? this.slotBData : null,
          durationA: durationA,
          durationB: durationB,
          maxDuration: maxDuration,
          theme: theme
        });
      }

      // 上段全体波形の上に「拡大位置カーソル（縦線＋時刻バッジ）」を描画
      this.drawCursorLine(w, overviewH, maxDuration);

      // ------------------------------------------------------------------
      // 上段・下段の境界セパレーター
      // ------------------------------------------------------------------
      this.ctx.strokeStyle = "#f59e0b";
      this.ctx.lineWidth = 2;
      this.ctx.beginPath();
      this.ctx.moveTo(0, loupeY);
      this.ctx.lineTo(w, loupeY);
      this.ctx.stroke();

      // ------------------------------------------------------------------
      // 下段: 波形拡大ルーペ（指定時刻の前後数ミリ秒をミクロ表示）
      // ------------------------------------------------------------------
      this.drawLoupeArea({
        x: 0,
        y: loupeY,
        width: w,
        height: loupeH,
        dataA: this.slotAData,
        dataB: hasB ? this.slotBData : null,
        theme: theme
      });
    }

    // 待機中・録音中のステータスバナー（Canvas下部に控えめに重ねて状態を明示）
    if (this.recordingState === "waiting_a" || this.recordingState === "waiting_b") {
      const targetName = !this.compareEnabled ? "音" : (this.recordingState === "waiting_a" ? "音A" : "音B");
      this.drawStatusOverlay(w, h, `⏳ ${targetName}の入力を待っています…（赤い線より大きい音を鳴らすと記録スタート）`, "#f59e0b");
    } else if (this.recordingState === "recording_a" || this.recordingState === "recording_b") {
      const targetName = !this.compareEnabled ? "音" : (this.recordingState === "recording_a" ? "音A" : "音B");
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
      const startLabel = this.compareEnabled
        ? "「🔴 音Aのきろく開始」ボタンを押して音を鳴らしてください"
        : "「🔴 きろく開始」ボタンを押して音を鳴らしてください";
      this.ctx.fillText(startLabel, w / 2, h / 2 - 12);
      this.ctx.font = "13px sans-serif";
      this.ctx.fillStyle = "rgba(100, 116, 139, 0.8)";
      this.ctx.fillText("しきい値以上の音を検知した瞬間から、全体の音の波形が記録されます", w / 2, h / 2 + 16);
    }
  }

  /**
   * 単一トラック（上下分割時の各領域）を描画
   */
  drawSingleSlotTrack({ x, y, width, height, data, duration, maxDuration, title, color, theme, showTimeline, offsetSec = 0 }) {
    // 背景グリッドと時間目盛りの描画
    this.drawTimeGrid(x, y, width, height, maxDuration, theme, showTimeline);

    // トラック見出し
    this.ctx.fillStyle = color;
    this.ctx.font = "bold 13px sans-serif";
    this.ctx.textAlign = "left";
    this.ctx.textBaseline = "top";
    this.ctx.fillText(`${title} (${duration.toFixed(2)} 秒)`, x + 12, y + 8);

    if (!data) return;

    // 波形のエンベロープ（包絡線）描画（横位置ずらし offsetSec を適用）
    this.drawEnvelope(x, y, width, height, data, maxDuration, color, offsetSec);
  }

  /**
   * 重ね合わせトラックを描画
   */
  drawOverlayTrack({ x, y, width, height, dataA, dataB, durationA, durationB, maxDuration, theme }) {
    // 背景グリッドと時間目盛り
    this.drawTimeGrid(x, y, width, height, maxDuration, theme, true);

    // 波形Aの描画（青色・基準位置固定）
    if (dataA) {
      this.drawEnvelope(x, y, width, height, dataA, maxDuration, "rgba(59, 130, 246, 0.75)", 0);
    }

    // 波形Bの描画（赤色・横位置ずらし slotBOffsetSec を適用）
    if (dataB) {
      this.drawEnvelope(x, y, width, height, dataB, maxDuration, "rgba(239, 68, 68, 0.75)", this.slotBOffsetSec);
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
      const offsetSign = this.slotBOffsetSec > 0 ? "+" : "";
      const offsetLabel = Math.abs(this.slotBOffsetSec) >= 0.005
        ? ` (位置:${offsetSign}${this.slotBOffsetSec.toFixed(2)}s)`
        : "";
      this.ctx.fillText(`🔴 音B: ${durationB.toFixed(2)}s${offsetLabel}`, labelX, y + 8);
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
   * 【なぜピクセル座標から時刻逆算してオフセット適用するのか】
   * 音Bを左右に任意秒数ずらした際も、描画領域からはみ出さずに
   * 音Aと同一時間軸スケール上で正確に比較できるようにするため。
   */
  drawEnvelope(x, y, width, height, data, maxDuration, color, offsetSec = 0) {
    const ctx = this.ctx;
    const centerY = y + height / 2;
    const amplitudeH = (height / 2) * 0.88; // 上下に少し余白を残す
    const totalSamples = data.length;
    if (totalSamples === 0 || maxDuration <= 0 || width <= 0) return;

    const secPerPixel = maxDuration / width;
    const pixels = Math.max(1, Math.floor(width));

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();

    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();

    for (let px = 0; px < pixels; px++) {
      // 画面上の現在ピクセル区間が、録音データ内のどのサンプル範囲に相当するかを計算
      const tStart = px * secPerPixel - offsetSec;
      const tEnd = (px + 1) * secPerPixel - offsetSec;

      const rawStartIdx = Math.floor(tStart * this.sampleRate);
      const rawEndIdx = Math.ceil(tEnd * this.sampleRate);

      // データ範囲外は描画しない
      if (rawEndIdx <= 0 || rawStartIdx >= totalSamples) continue;

      const startIdx = Math.max(0, rawStartIdx);
      const endIdx = Math.min(totalSamples, Math.max(startIdx + 1, rawEndIdx));

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
    ctx.restore();
  }

  /**
   * 上段（全体波形）の上に、拡大中の位置を示すカーソル縦線と時刻バッジを描画する関数
   * 【なぜカーソル帯＋時刻ピルを描くのか】
   * 「下段に拡大されている波が、全体波形のどの瞬間なのか」を視覚的に即座に結びつけ、
   * 生徒がタップやドラッグで直感的に位置を動かせるようにするため。
   */
  drawCursorLine(w, overviewH, maxDuration) {
    if (maxDuration <= 0) return;
    const ctx = this.ctx;
    const cursorX = Math.max(0, Math.min(w, (this.inspectTimeSec / maxDuration) * w));

    // ルーペがカバーする時間幅のハイライト帯（視認性のため最小6pxを確保）
    const loupeWinMs = this.getLoupeWindowMs();
    const windowWidthPx = Math.max(6, ((loupeWinMs / 1000) / maxDuration) * w);

    ctx.save();
    ctx.fillStyle = "rgba(245, 158, 11, 0.20)";
    ctx.fillRect(cursorX - windowWidthPx / 2, 0, windowWidthPx, overviewH);

    // 中心カーソル縦線（オレンジ）
    ctx.strokeStyle = "#f59e0b";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cursorX, 0);
    ctx.lineTo(cursorX, overviewH);
    ctx.stroke();

    // 上部の時刻ラベルピル（画面端にはみ出さないよう横位置をクランプ）
    const label = `▼ ${this.inspectTimeSec.toFixed(2)}s`;
    ctx.font = "bold 11px monospace";
    const textW = ctx.measureText(label).width;
    const pillW = textW + 12;
    const pillH = 20;
    const pillX = Math.max(4, Math.min(w - pillW - 4, cursorX - pillW / 2));
    const pillY = 4;

    ctx.fillStyle = "#f59e0b";
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(pillX, pillY, pillW, pillH, 6);
    } else {
      ctx.rect(pillX, pillY, pillW, pillH);
    }
    ctx.fill();

    ctx.fillStyle = "#0f172a";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, pillX + pillW / 2, pillY + pillH / 2 + 0.5);
    ctx.restore();
  }

  /**
   * 下段の「波形拡大ルーペ」エリア（タブ1連動の方眼グリッド＋ミクロ波形）を描画する関数
   * 【なぜタブ1（波形観察・比較）と全く同じマス目・レンジで描画するのか】
   * 先生が設定した TIME/DIV・VOLTS/DIV・横マス数 をルーペにもそのまま反映することで、
   * 縦横の縮尺の違和感をなくし、タブ1で見た波形と同じ感覚で減衰中の波を観察できるようにするため。
   */
  drawLoupeArea({ x, y, width, height, dataA, dataB, theme }) {
    const ctx = this.ctx;
    ctx.save();

    // クリッピング領域を設定し、大振幅波形が上段エリアへはみ出すのを防止
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();

    ctx.fillStyle = theme.bg;
    ctx.fillRect(x, y, width, height);

    const centerY = y + height / 2;
    const totalSubCols = this.horizontalDivs; // タブ1と同じ横小マス数 (10〜50)
    const subColW = width / totalSubCols;
    const rows = 8; // タブ1と同じ縦8マス構成（案A: 画面比率を完全一致）
    const rowH = height / rows;

    // --- 1. サブ目盛り線（5小マス以外の細かい縦線） ---
    ctx.strokeStyle = theme.subGrid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < totalSubCols; i++) {
      if (i % 5 !== 0) {
        const gx = x + i * subColW;
        ctx.moveTo(gx, y);
        ctx.lineTo(gx, y + height);
      }
    }
    ctx.stroke();

    // --- 2. 主グリッド線（横は5小マスごと、縦は8マス） ---
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    for (let i = 5; i < totalSubCols; i += 5) {
      const gx = x + i * subColW;
      ctx.moveTo(gx, y);
      ctx.lineTo(gx, y + height);
    }
    for (let r = 1; r < rows; r++) {
      const gy = y + r * rowH;
      ctx.moveTo(x, gy);
      ctx.lineTo(x + width, gy);
    }
    ctx.stroke();

    // --- 3. 中心線（0V水平線 ＆ 中央時刻の垂直線） ---
    ctx.strokeStyle = theme.centerLine;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, centerY);
    ctx.lineTo(x + width, centerY);
    ctx.stroke();

    // 中央の検査基準時刻ライン（オレンジ点線）
    ctx.save();
    ctx.strokeStyle = "rgba(245, 158, 11, 0.55)";
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x + width / 2, y);
    ctx.lineTo(x + width / 2, y + height);
    ctx.stroke();
    ctx.restore();

    // --- 4. 音A・音Bのミクロ波形描画（タブ1の VOLTS/DIV と横時間幅を完全適用） ---
    // 縦8マス換算で pixelsPerVolt を算出（タブ1と同じ画面比率で振幅を表示）
    const pixelsPerVolt = (height / rows) / this.voltsDiv;
    const waveAColor = this.compareEnabled ? "#3b82f6" : theme.waveMain;
    if (dataA) {
      this.drawLoupeWaveform(x, y, width, height, dataA, waveAColor, 2.2, pixelsPerVolt, 0);
    }
    if (dataB) {
      this.drawLoupeWaveform(x, y, width, height, dataB, "#ef4444", 2.2, pixelsPerVolt, this.slotBOffsetSec);
    }

    // --- 5. ルーペ見出し・目盛り情報ラベル ---
    const winMs = this.getLoupeWindowMs();
    const effTimeDivMs = this.timeDivMs * this.loupeZoomMult;
    const multTag = this.loupeZoomMult > 1 ? ` [×${this.loupeZoomMult}]` : "";
    const headerText = `🔍 拡大ルーペ: ${this.inspectTimeSec.toFixed(2)}s 付近（幅 ${winMs.toFixed(1)}ms / TIME ${effTimeDivMs.toFixed(1)}ms・VOLT ${this.voltsDiv.toFixed(1)}V・横${this.horizontalDivs}マス${multTag}）`;
    ctx.font = "bold 11.5px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = "#f59e0b";
    ctx.fillText(headerText, x + 12, y + 6);

    // 右下に操作ヒント（控えめ表示）
    ctx.font = "11px sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = theme.osdColor || "#64748b";
    ctx.globalAlpha = 0.75;
    ctx.fillText("上段タップで移動 / 下段ドラッグで微調整", x + width - 10, y + height - 5);

    ctx.restore();
  }

  /**
   * 指定時刻の前後（タブ1連動の時間幅）の生サンプルを滑らかな折れ線で描画する関数
   * 【なぜ offsetSec を考慮するのか】
   * 上段の全体波形で音Bを左右にずらした位置関係が、そのまま下段の拡大ルーペでも
   * 寸分違わず再現されるようにするため。
   */
  drawLoupeWaveform(x, y, width, height, data, color, lineWidth = 2.2, pixelsPerVolt = 100, offsetSec = 0) {
    const ctx = this.ctx;
    const centerY = y + height / 2;

    const loupeWinMs = this.getLoupeWindowMs();
    const halfWindowSamples = Math.max(1, Math.floor(((loupeWinMs / 1000) * this.sampleRate) / 2));
    const totalWindowSamples = Math.max(2, halfWindowSamples * 2);

    // 表示時刻 inspectTimeSec に対するデータ内の実参照時刻は (inspectTimeSec - offsetSec)
    const targetDataSec = this.inspectTimeSec - offsetSec;
    const centerSample = Math.round(targetDataSec * this.sampleRate);
    const startSample = centerSample - halfWindowSamples;
    const endSample = centerSample + halfWindowSamples;

    const clampedStart = Math.max(0, startSample);
    const clampedEnd = Math.min(data.length - 1, endSample);
    if (clampedStart >= clampedEnd) return;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();

    // サンプル数が非常に多い場合（例: 100ms超の広い設定時）でも描画負荷を抑える安全ステップ
    const span = clampedEnd - clampedStart;
    const step = span > 6000 ? Math.floor(span / 3000) : 1;

    let isFirst = true;
    for (let i = clampedStart; i <= clampedEnd; i += step) {
      const ratio = (i - startSample) / totalWindowSamples;
      const drawX = x + ratio * width;
      const drawY = centerY - data[i] * pixelsPerVolt;

      if (isFirst) {
        ctx.moveTo(drawX, drawY);
        isFirst = false;
      } else {
        ctx.lineTo(drawX, drawY);
      }
    }
    ctx.stroke();
    ctx.restore();
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
