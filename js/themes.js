/**
 * ==========================================================================
 * カラーテーマ管理モジュール (themes.js)
 * ==========================================================================
 * 【なぜこのモジュールが必要なのか】
 * - HTMLのCSS変数とCanvas 2Dコンテキストは自動で同期しないため、
 *   JavaScript側でもCanvas描画用のカラーパレットを管理し、
 *   テーマ切り替え時に即座にCanvasの色を反映させる必要があるため。
 * - 理科室の明るさや、プロジェクター投影、生徒の色覚多様性（UD）に合わせた
 *   全10種類のテーマを集中管理する。
 * ==========================================================================
 */

export const THEMES = {
  // ① オシロスコープ・クラシック（初期値）: 伝統的な漆黒×蛍光グリーン
  classic: {
    id: "classic",
    name: "クラシック（黒×緑）",
    bg: "#060a12",
    grid: "rgba(34, 197, 94, 0.15)",
    subGrid: "rgba(34, 197, 94, 0.06)",
    centerLine: "rgba(34, 197, 94, 0.45)",
    waveMain: "#22c55e",
    waveCompare: "#f97316",
    osdColor: "#22c55e"
  },
  // ② サイバー・シアン: 最も視認性が高く、先進的でクリアなネオンブルー
  cyan: {
    id: "cyan",
    name: "サイバー・シアン",
    bg: "#040711",
    grid: "rgba(0, 240, 255, 0.15)",
    subGrid: "rgba(0, 240, 255, 0.05)",
    centerLine: "rgba(0, 240, 255, 0.4)",
    waveMain: "#00f0ff",
    waveCompare: "#f43f5e",
    osdColor: "#00f0ff"
  },
  // ③ メディカル・グリーン（心電図）: 薄い緑背景に濃いエメラルド波形。明るい教室に最適
  medical: {
    id: "medical",
    name: "心電図（メディカル）",
    bg: "#e8f5e9",
    grid: "rgba(46, 125, 50, 0.25)",
    subGrid: "rgba(46, 125, 50, 0.1)",
    centerLine: "rgba(46, 125, 50, 0.5)",
    waveMain: "#1b5e20",
    waveCompare: "#b71c1c",
    osdColor: "#1b5e20"
  },
  // ④ ノート・方眼紙（ライト）: 理科ノート・ワークシートと同一の見た目
  paper: {
    id: "paper",
    name: "ノート方眼紙（白×青）",
    bg: "#ffffff",
    grid: "rgba(59, 130, 246, 0.22)",
    subGrid: "rgba(59, 130, 246, 0.08)",
    centerLine: "rgba(59, 130, 246, 0.45)",
    waveMain: "#1d4ed8",
    waveCompare: "#dc2626",
    osdColor: "#1d4ed8"
  },
  // ⑤ レトロ・アンバー: 真空管オシロスコープ風の温かみのある琥珀色
  amber: {
    id: "amber",
    name: "レトロ・アンバー",
    bg: "#0d0804",
    grid: "rgba(249, 115, 22, 0.16)",
    subGrid: "rgba(249, 115, 22, 0.06)",
    centerLine: "rgba(249, 115, 22, 0.4)",
    waveMain: "#f97316",
    waveCompare: "#38bdf8",
    osdColor: "#f97316"
  },
  // ⑥ 黒板・チョーク（学校風）: 教室の黒板になじむスクールグリーン
  chalkboard: {
    id: "chalkboard",
    name: "黒板・チョーク（学校風）",
    bg: "#1b3323",
    grid: "rgba(255, 255, 255, 0.18)",
    subGrid: "rgba(255, 255, 255, 0.06)",
    centerLine: "rgba(255, 255, 255, 0.4)",
    waveMain: "#fde047",
    waveCompare: "#ffffff",
    osdColor: "#fde047"
  },
  // ⑦ ハイコントラスト・CUD: 色覚多様性（色弱の生徒）に配慮したUD高コントラスト
  highcontrast: {
    id: "highcontrast",
    name: "高コントラスト（UD）",
    bg: "#000000",
    grid: "rgba(255, 255, 255, 0.25)",
    subGrid: "rgba(255, 255, 255, 0.1)",
    centerLine: "rgba(255, 255, 255, 0.55)",
    waveMain: "#ffff00",
    waveCompare: "#00e5ff",
    osdColor: "#ffff00"
  },
  // ⑧ ペーパー・モノクロ: 白黒プリント印刷や提出物キャプチャ用
  monochrome: {
    id: "monochrome",
    name: "白黒モノクロ（印刷用）",
    bg: "#ffffff",
    grid: "rgba(0, 0, 0, 0.2)",
    subGrid: "rgba(0, 0, 0, 0.06)",
    centerLine: "rgba(0, 0, 0, 0.45)",
    waveMain: "#000000",
    waveCompare: "#64748b",
    osdColor: "#111827"
  },
  // ⑨ サンセット・ウォーム: ブルーライトを抑えた目に優しいアイボリー×テラコッタ
  sunset: {
    id: "sunset",
    name: "サンセット・ウォーム",
    bg: "#faf6eb",
    grid: "rgba(120, 53, 15, 0.2)",
    subGrid: "rgba(120, 53, 15, 0.07)",
    centerLine: "rgba(120, 53, 15, 0.45)",
    waveMain: "#c2410c",
    waveCompare: "#1e40af",
    osdColor: "#c2410c"
  },
  // ⑩ フューチャー・バイオレット: 暗紫色×ネオンピンクのモダンで洗練されたスタイル
  violet: {
    id: "violet",
    name: "フューチャー・バイオレット",
    bg: "#0a0414",
    grid: "rgba(216, 180, 254, 0.15)",
    subGrid: "rgba(216, 180, 254, 0.05)",
    centerLine: "rgba(216, 180, 254, 0.4)",
    waveMain: "#f43f5e",
    waveCompare: "#06b6d4",
    osdColor: "#f43f5e"
  }
};

/**
 * 現在選択されているテーマのオブジェクトを保持
 */
let currentTheme = THEMES.classic;

/**
 * テーマを切り替える関数
 * @param {string} themeId - 切り替えるテーマのID（例: 'medical'）
 * @returns {Object} 適用されたテーマ設定オブジェクト
 */
export function setTheme(themeId) {
  if (!THEMES[themeId]) {
    console.warn(`[Theme] 指定されたテーマ '${themeId}' が存在しないためクラシックを適用します。`);
    themeId = "classic";
  }

  currentTheme = THEMES[themeId];

  // 【なぜHTMLの属性を更新するのか】
  // CSS側の `[data-theme="..."]` セレクタを発火させ、
  // 操作パネルやボタン、背景色を一括で切り替えるため。
  document.documentElement.setAttribute("data-theme", themeId);

  return currentTheme;
}

/**
 * 現在のテーマ設定を取得する関数
 * @returns {Object} 現在のテーマ設定
 */
export function getCurrentTheme() {
  return currentTheme;
}
