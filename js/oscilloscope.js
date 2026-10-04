/**
 * ==========================================================================
 * オシロスコープ描画エンジン (oscilloscope.js)
 * ==========================================================================
 * 【なぜこのモジュールが必要なのか】
 * - HTML5 Canvas を使用して、マイクからの時間領域データを本格的なオシロスコープ
 *   として毎秒60フレームで高速かつ滑らかに描画するため。
 * - 波が画面上を流れてしまう現象を防ぐ「ゼロクロス同期（立ち上がりトリガー）」
 *   や、理科実験で不可欠な「TIME/DIV（時間軸）」「VOLTS/DIV（電圧/振幅）」の
 *   目盛り計算を行う。
 * ==========================================================================
 */

import { getCurrentTheme } from "./themes.js";

export class OscilloscopeRenderer {
  /**
   * @param {HTMLCanvasElement} canvas - 描画対象のCanvas要素
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");

    // オシロスコープの標準グリッド分割数（横マス数：初期値50マス、縦8マス）
    // 【なぜ小マス換算で管理するのか】
    // 画面に見えているマス目を10マス、20マス、30マス、40マス、50マスと
    // 直感的に10マス単位で切り替え、波の表示幅を拡大・縮小できるようにするため。
    this.horizontalDivs = 50; // 小マス数 (10, 20, 30, 40, 50)
    this.gridCols = 10;       // 主マス数 (5小マスで1主マス)
    this.gridRows = 8;

    // パラメータ設定値（初期値）
    this.timeDivMs = 1.0; // 1目盛りあたり 1.0ms
    this.voltsDiv = 0.5;  // 1目盛りあたり 0.5V (正規化振幅)

    // 一時停止（ホールド）状態の管理
    this.isFrozen = false;
    this.frozenBuffer = null;

    // --- 波形比較（音A・音Bスロット）の管理 ---
    // 【なぜ個別バッファとして保持するのか】
    // 生徒が音Aと音Bをそれぞれ独立して何度でも録り直せるようにするため。
    this.slotABuffer = null;
    this.slotBBuffer = null;
    this.displayMode = "overlay"; // "overlay"（重ね合わせ） または "split"（上下並列）
    this.phaseShiftSamples = 0;   // 音Bの手動位相シフト量（サンプル数）

    // 画面サイズ調整
    this.handleResize();
    window.addEventListener("resize", () => this.handleResize());
  }

  /**
   * Canvasの内部解像度を調整する関数
   * 【なぜdevicePixelRatioを考慮するのか】
   * iPadやChromebookの高精細（Retina）ディスプレイにおいて、
   * CSSサイズと内部Canvasサイズが1:1だと線がぼやけてしまうため、
   * 端末のピクセル比率に合わせて内部解像度を倍加させる。
   */
  handleResize() {
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
   * TIME/DIV（1目盛りあたりの時間：ミリ秒）を設定
   * @param {number} ms - ミリ秒（例: 0.5, 1.0, 2.0）
   */
  setTimeDiv(ms) {
    this.timeDivMs = ms;
  }

  /**
   * VOLTS/DIV（1目盛りあたりの振幅：電圧）を設定
   * @param {number} volts - 電圧（例: 0.2, 0.5, 1.0）
   */
  setVoltsDiv(volts) {
    this.voltsDiv = volts;
  }

  /**
   * 波の表示幅（横の小マス数：10〜50マス、10マス単位）を設定
   * 【なぜ横マス数を変更できるようにするのか】
   * 波が横にぎっしり詰まりすぎている時、マス数を10マスや20マスに絞ることで、
   * 画面全体に波の1〜2周期だけを大きくドーンと拡大表示させ、
   * 音A・音Bの山や谷の形・幅を中学生が簡単にノートへスケッチできるようにするため。
   * 
   * @param {number} divs - 横の小マス数（10, 20, 30, 40, 50）
   */
  setHorizontalDivs(divs) {
    this.horizontalDivs = Math.max(10, Math.min(100, Number(divs) || 50));
    // 主グリッド数（大マス数＝5小マスで1大マス）
    this.gridCols = Math.max(2, Math.round(this.horizontalDivs / 5));
  }

  /**
   * 現在の横マス数を取得する
   * @returns {number} 横の小マス数 (10〜50)
   */
  getHorizontalDivs() {
    return this.horizontalDivs;
  }

  /**
   * 一時停止（フリーズ）の切り替え
   * @param {boolean} freeze - 停止するかどうか
   * @param {Float32Array} currentBuffer - 停止時点の波形データ
   */
  setFrozen(freeze, currentBuffer) {
    this.isFrozen = freeze;
    if (freeze && currentBuffer) {
      // 停止した瞬間の波形データをクローンして保持
      this.frozenBuffer = new Float32Array(currentBuffer);
    }
  }

  /**
   * 音Aを保存（クローン）する
   * @param {Float32Array} buffer - 音声バッファ
   */
  setSlotA(buffer) {
    if (buffer) {
      this.slotABuffer = new Float32Array(buffer);
    }
  }

  /**
   * 音Aをクリアする
   */
  clearSlotA() {
    this.slotABuffer = null;
  }

  /**
   * 音Bを保存（クローン）する
   * @param {Float32Array} buffer - 音声バッファ
   */
  setSlotB(buffer) {
    if (buffer) {
      this.slotBBuffer = new Float32Array(buffer);
    }
  }

  /**
   * 音Bをクリアする
   */
  clearSlotB() {
    this.slotBBuffer = null;
    this.phaseShiftSamples = 0;
  }

  /**
   * 表示モードを設定（"overlay" または "split"）
   * @param {string} mode - "overlay" | "split"
   */
  setDisplayMode(mode) {
    this.displayMode = mode;
  }

  /**
   * 手動位相シフト（サンプル数）を設定する
   * @param {number} samples - シフトするサンプル数（正負対応）
   */
  setPhaseShiftSamples(samples) {
    this.phaseShiftSamples = Math.round(samples);
  }

  /**
   * 現在の位相シフトサンプル数を取得
   */
  getPhaseShiftSamples() {
    return this.phaseShiftSamples;
  }

  /**
   * 方眼目盛り（グリッド線・中心線・サブ目盛り）を描画する関数
   * 【なぜ可変マス目に対応するのか】
   * 先生が設定した横マス数（10〜50マス）に合わせて正確にマス目を割り振り、
   * どのマス数設定でも目盛りの間隔と波の周期が完全に一致するように描く。
   * 
   * @param {Object} theme - 現在のテーマ設定
   * @param {number} startY - 描画開始Y座標
   * @param {number} drawHeight - 描画エリアの高さ
   * @param {number} rows - グリッド行数
   */
  drawGridArea(theme, startY = 0, drawHeight = this.height, rows = this.gridRows) {
    const ctx = this.ctx;
    const w = this.width;
    const h = drawHeight;

    const totalSubCols = this.horizontalDivs;
    const subColWidth = w / totalSubCols;
    const rowHeight = h / rows;

    // --- 1. サブ目盛り（薄いグリッド線） ---
    ctx.strokeStyle = theme.subGrid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    
    // 横方向の小目盛り線（5の倍数以外の細かい線）
    for (let i = 1; i < totalSubCols; i++) {
      if (i % 5 !== 0) {
        const x = i * subColWidth;
        ctx.moveTo(x, startY);
        ctx.lineTo(x, startY + h);
      }
    }

    // 縦方向の小目盛り線（各行を5等分）
    for (let r = 0; r < rows; r++) {
      for (let s = 1; s < 5; s++) {
        const y = startY + r * rowHeight + (s * rowHeight) / 5;
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
    }
    ctx.stroke();

    // --- 2. 主グリッド線（しっかりした目盛り線） ---
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    
    // 横方向の主グリッド線（5小マスごと）
    for (let i = 5; i < totalSubCols; i += 5) {
      const x = i * subColWidth;
      ctx.moveTo(x, startY);
      ctx.lineTo(x, startY + h);
    }

    // 縦方向の主グリッド線
    for (let r = 1; r < rows; r++) {
      const y = startY + r * rowHeight;
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();

    // --- 3. 中心線（ゼロレベル・X軸・Y軸） ---
    ctx.strokeStyle = theme.centerLine;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    const centerY = startY + h / 2;
    ctx.moveTo(0, centerY);
    ctx.lineTo(w, centerY);
    const centerX = w / 2;
    ctx.moveTo(centerX, startY);
    ctx.lineTo(centerX, startY + h);
    ctx.stroke();
  }

  /**
   * ゼロクロス点（立ち上がりトリガー）を検出する関数
   * @param {Float32Array} buffer - 音声バッファ
   * @returns {number} 描画開始インデックス
   */
  findZeroCrossing(buffer) {
    if (!buffer) return 0;
    const limit = Math.min(buffer.length - 512, 1024);
    for (let i = 0; i < limit; i++) {
      if (buffer[i] <= 0 && buffer[i + 1] > 0) {
        return i;
      }
    }
    return 0;
  }

  /**
   * 単一の波形を描画するヘルパー関数
   * 【なぜ循環モジュロを適用するのか】
   * 手動で位相を左右にどれだけ大きくスライドしても、
   * バッファが途切れることなく波がスムーズにループして描画されるようにするため。
   */
  drawWaveform(buffer, centerY, pixelsPerVolt, samplesToDraw, phaseOffset, strokeColor, glowColor, lineWidth = 2.5) {
    const ctx = this.ctx;
    const w = this.width;
    const len = buffer.length;

    // ゼロクロス位置（基準点）
    const startIndex = this.findZeroCrossing(buffer);

    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (glowColor) {
      ctx.shadowColor = glowColor;
      ctx.shadowBlur = 6;
    } else {
      ctx.shadowBlur = 0;
    }

    ctx.beginPath();

    for (let x = 0; x < w; x++) {
      const bufferOffset = Math.floor((x / w) * samplesToDraw);
      // 【循環ループ計算】負のオフセットにも安全に対応する二重モジュロ
      const rawIdx = startIndex + bufferOffset + phaseOffset;
      const sampleIndex = ((rawIdx % len) + len) % len;

      const sampleValue = buffer[sampleIndex];
      const y = centerY - (sampleValue * pixelsPerVolt);

      if (x === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }

    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  /**
   * 1フレームの描画メインループ
   */
  render(currentBuffer, isAboveGate, sampleRate = 44100) {
    const theme = getCurrentTheme();
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;

    // 背景の塗りつぶし
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, w, h);

    // 画面全体の表示サンプル数（1主マス = 5小マス = timeDivMs [ms]）
    // 【なぜhorizontalDivsで計算するのか】
    // 先生が横マス数を10マスや20マスに設定した際、画面全体の表示時間を短縮し、
    // 波を横方向に大きく拡大（ズーム）して1〜2周期をクッキリ描画するため。
    const totalTimeSec = (this.timeDivMs * (this.horizontalDivs / 5)) / 1000;
    const samplesToDraw = Math.floor(totalTimeSec * sampleRate);

    // 現在の有効なリアルタイム/一時停止バッファ
    const liveBuffer = this.isFrozen ? this.frozenBuffer : currentBuffer;
    const hasLiveSound = liveBuffer && (this.isFrozen || isAboveGate);

    // ----------------------------------------------------------------------
    // 描画モード A: 【上下に並べる（Split Mode）】
    // ----------------------------------------------------------------------
    if (this.displayMode === "split") {
      const halfH = h / 2;
      const splitRows = 4; // 上段4マス、下段4マス
      const pixelsPerVolt = (halfH / splitRows) / this.voltsDiv;

      // --- 上段: 音A（青系） ---
      this.drawGridArea(theme, 0, halfH, splitRows);
      const topCenterY = halfH / 2;

      const topBuf = this.slotABuffer || (hasLiveSound ? liveBuffer : null);
      if (topBuf) {
        const stroke = this.slotABuffer ? "#3b82f6" : theme.waveMain;
        this.drawWaveform(topBuf, topCenterY, pixelsPerVolt, samplesToDraw, 0, stroke, stroke, 2.5);
      } else {
        // 無音中心線
        ctx.strokeStyle = theme.waveMain;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, topCenterY);
        ctx.lineTo(w, topCenterY);
        ctx.stroke();
      }

      // 上段ラベル
      ctx.fillStyle = "#3b82f6";
      ctx.font = "bold 13px sans-serif";
      ctx.fillText(this.slotABuffer ? "🔵 音A（保存済み）" : "🔵 音A（入力中）", 16, 22);

      // --- 中心の境界線 ---
      ctx.strokeStyle = theme.centerLine;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, halfH);
      ctx.lineTo(w, halfH);
      ctx.stroke();

      // --- 下段: 音B（赤系・手動位相シフト適用） ---
      this.drawGridArea(theme, halfH, halfH, splitRows);
      const bottomCenterY = halfH + halfH / 2;

      const bottomBuf = this.slotBBuffer || (hasLiveSound && !this.slotABuffer ? null : (hasLiveSound ? liveBuffer : null));
      if (bottomBuf) {
        const stroke = this.slotBBuffer ? "#ef4444" : theme.waveMain;
        this.drawWaveform(bottomBuf, bottomCenterY, pixelsPerVolt, samplesToDraw, this.phaseShiftSamples, stroke, stroke, 2.5);
      } else {
        // 無音中心線
        ctx.strokeStyle = theme.waveMain;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, bottomCenterY);
        ctx.lineTo(w, bottomCenterY);
        ctx.stroke();
      }

      // 下段ラベル
      ctx.fillStyle = "#ef4444";
      ctx.font = "bold 13px sans-serif";
      const shiftMs = ((this.phaseShiftSamples / sampleRate) * 1000).toFixed(1);
      ctx.fillText(this.slotBBuffer ? `🔴 音B（保存済み / 位相: ${shiftMs}ms）` : "🔴 音B（入力中）", 16, halfH + 22);

      return;
    }

    // ----------------------------------------------------------------------
    // 描画モード B: 【重ね合わせ（Overlay Mode - デフォルト）】
    // ----------------------------------------------------------------------
    this.drawGridArea(theme, 0, h, this.gridRows);
    const pixelsPerVolt = (h / this.gridRows) / this.voltsDiv;
    const centerY = h / 2;

    const hasSlotA = !!this.slotABuffer;
    const hasSlotB = !!this.slotBBuffer;

    // 1. 音A（保存データ）の描画（青色系）
    if (hasSlotA) {
      this.drawWaveform(this.slotABuffer, centerY, pixelsPerVolt, samplesToDraw, 0, "#3b82f6", "#3b82f6", 2.6);
    }

    // 2. 音B（保存データ）の描画（赤色系・手動位相シフト適用）
    if (hasSlotB) {
      this.drawWaveform(this.slotBBuffer, centerY, pixelsPerVolt, samplesToDraw, this.phaseShiftSamples, "#ef4444", "#ef4444", 2.6);
    }

    // 3. 現在の音（リアルタイム入力）の描画
    // 音Aと音Bの両方が埋まっていない場合は、入力中の音をテーマ色で重ねて表示
    if (!hasSlotA || !hasSlotB) {
      if (hasLiveSound) {
        this.drawWaveform(liveBuffer, centerY, pixelsPerVolt, samplesToDraw, 0, theme.waveMain, theme.waveMain, 2.5);
      } else if (!hasSlotA && !hasSlotB) {
        // どちらも未保存で無音の場合は中心線を描画
        ctx.strokeStyle = theme.waveMain;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(0, centerY);
        ctx.lineTo(w, centerY);
        ctx.stroke();
      }
    }

    // 4. 重ね合わせ時の凡例（レジェンド）表示
    let legendX = 14;
    ctx.font = "bold 12px sans-serif";

    if (hasSlotA) {
      ctx.fillStyle = "#3b82f6";
      ctx.fillText("🔵 音A", legendX, h - 14);
      legendX += 55;
    }
    if (hasSlotB) {
      ctx.fillStyle = "#ef4444";
      const shiftMs = ((this.phaseShiftSamples / sampleRate) * 1000).toFixed(1);
      ctx.fillText(`🔴 音B (位相: ${shiftMs}ms)`, legendX, h - 14);
      legendX += 130;
    }
    if (!hasSlotA || !hasSlotB) {
      ctx.fillStyle = theme.waveMain;
      ctx.fillText("🟢 リアルタイム入力", legendX, h - 14);
    }
  }
}
