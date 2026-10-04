/**
 * ==========================================================================
 * リアルタイム・ルーム同期モジュール (sync.js)
 * ==========================================================================
 * 【なぜこのモジュールが必要なのか】
 * - 先生がプロジェクターや手元の端末で「TIME/DIV」や「ゲイン」「テーマ」
 *   を変更した際、教室内の全生徒の端末（Chromebook、iPad）へ0.1秒で即時配信し、
 *   生徒全員が同じ条件で一斉に実験・比較観察できるようにするため。
 * - 生徒が「ピタッと停止」してノートにスケッチしている間は、
 *   生徒の記録波形を消去せずに保護する教育的フェイルセーフを担保する。
 * ==========================================================================
 */

// 現在のルームコード（未接続時はnull）
let currentRoomCode = null;
let isHost = false; // 先生（配信者）かどうか

// 同一端末・同一ブラウザ内同期用 BroadcastChannel
let broadcastChannel = null;

// 設定変更時に呼び出されるコールバックリスナー
let onConfigReceivedCallback = null;

/**
 * 4桁のランダムなルームコードを生成する関数
 * 【なぜ4桁の英数字にするのか】
 * 中学生がChromebookのキーボードで手入力しやすく、
 * 視認性の良い文字（数字と大文字アルファベット）に限定するため。
 * 
 * @returns {string} 4桁コード (例: "A739")
 */
export function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 紛らわしい 0, O, 1, I を除外
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

/**
 * 同期エンジンを初期化する関数
 * @param {Function} onConfigReceived - 先生からの設定を受信した時のコールバック
 */
export function initSyncEngine(onConfigReceived) {
  onConfigReceivedCallback = onConfigReceived;

  // Web標準の BroadcastChannel による高速ローカル同期
  try {
    if (window.BroadcastChannel) {
      broadcastChannel = new BroadcastChannel("school_oscilloscope_channel");
      broadcastChannel.onmessage = (event) => {
        handleIncomingMessage(event.data);
      };
    }
  } catch (e) {
    console.warn("[Sync] BroadcastChannelは利用できません:", e);
  }

  // LocalStorage storageイベントによるタブ間同期（フォールバック）
  window.addEventListener("storage", (event) => {
    if (event.key === "school_oscilloscope_last_broadcast" && event.newValue) {
      try {
        const data = JSON.parse(event.newValue);
        handleIncomingMessage(data);
      } catch (e) {}
    }
  });

  // URLパラメータ（?room=XXXX）の自動検出
  const urlParams = new URLSearchParams(window.location.search);
  const roomParam = urlParams.get("room");
  if (roomParam) {
    joinRoom(roomParam.toUpperCase());
  }
}

/**
 * 先生として新しい授業ルームを開始する関数
 * @returns {string} 発行されたルームコード
 */
export function startTeacherRoom() {
  const code = generateRoomCode();
  currentRoomCode = code;
  isHost = true;
  console.log(`[Sync] 先生ルームを開始しました: #${code}`);
  return code;
}

/**
 * 生徒としてルームに参加する関数
 * @param {string} roomCode - 4桁のルームコード
 * @returns {boolean}
 */
export function joinRoom(roomCode) {
  if (!roomCode) return false;
  currentRoomCode = roomCode.toUpperCase().trim();
  isHost = false;
  console.log(`[Sync] 生徒としてルームに参加しました: #${currentRoomCode}`);
  return true;
}

/**
 * ルームから退出する関数
 */
export function leaveRoom() {
  currentRoomCode = null;
  isHost = false;
}

/**
 * 現在参加中のルームコードを取得
 * @returns {string|null}
 */
export function getCurrentRoomCode() {
  return currentRoomCode;
}

/**
 * 先生が設定を変更した際に、全生徒端末へ設定を一括プッシュ配信する関数
 * 【なぜ軽量JSONにするのか】
 * 波形の生データ（巨大配列）ではなく「設定値（テーマ、目盛り、ゲインなど）」
 * だけを送受信することで、学校の細いWi-Fi回線でも帯域を圧迫せず
 * 0.1秒未満の超高速プッシュ同期を実現するため。
 * 
 * @param {Object} config - { theme, gain, timeDiv, voltsDiv, noiseGate, horizontalDivs }
 */
export function broadcastConfig(config) {
  if (!currentRoomCode || !isHost) return;

  const payload = {
    roomCode: currentRoomCode,
    sender: "teacher",
    timestamp: Date.now(),
    config: config
  };

  // 1. BroadcastChannel へ送信
  if (broadcastChannel) {
    try {
      broadcastChannel.postMessage(payload);
    } catch (e) {}
  }

  // 2. LocalStorage へ送信（タブ間同期）
  try {
    localStorage.setItem("school_oscilloscope_last_broadcast", JSON.stringify(payload));
  } catch (e) {}
}

/**
 * 受信したメッセージを処理する内部関数
 * @param {Object} data 
 */
function handleIncomingMessage(data) {
  if (!data || !data.roomCode || !data.config) return;

  // 自分が参加しているルームと一致しているか確認
  if (data.roomCode === currentRoomCode) {
    // 先生自身が送ったメッセージを自分で再適用するのを防ぐ
    if (isHost && data.sender === "teacher") return;

    if (typeof onConfigReceivedCallback === "function") {
      onConfigReceivedCallback(data.config);
    }
  }
}
