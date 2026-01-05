# LiveKit + Gemini Live (テスト用最小構成)

このリポジトリは、LiveKit + Gemini Live 音声チャットSPAの最小動作確認を目的とした構成です。  
現時点では **LiveKit接続 + マイク送受信** に加えて、**Gemini Live WebSocket接続 / 音声再生 / 入出力文字起こし / VAD対応** まで実装しています。

## 前提
- Docker / Docker Compose
- Gemini API Key（Gemini Live利用時）

## 使い方（最小テスト）
1. `.env.example` を `.env` にコピーして値を調整
2. `livekit.yaml` の `keys` を `.env` と一致させる
3. 起動
   ```bash
   docker compose up --build
   ```
4. `http://localhost:5173` を開く
5. 同じ部屋名で2タブ開き、互いにマイク音声が届くことを確認

## Transcriptテスト（ダミー送信）
Gemini Liveに接続せずUI表示を確認したい場合はデバッグ用エンドポイントを使います。
1. `.env` に `ENABLE_DEBUG_TRANSCRIPT=1` を追加
2. 起動後に以下を実行:
   ```bash
   curl -X POST http://localhost:3300/debug/transcript \
     -H "Content-Type: application/json" \
     -d '{"role":"system","text":"hello transcript"}'
   ```

## 構成
- `livekit`: SFU
- `app`: トークン発行 + Geminiブリッジ（スケルトン）
- `spa`: LiveKitクライアントUI

## Gemini Live ブリッジについて
`ENABLE_GEMINI_BRIDGE=1` で有効化されます。  
SPAはアプリサーバーの `/gemini` WebSocket に接続し、サーバー側がGemini Liveと接続します。

### 使い方（Gemini）
1. `.env` に `GEMINI_API_KEY` を設定
2. `ENABLE_GEMINI_BRIDGE=1`
3. `http://localhost:5173` を開く
4. 「Gemini Connect」→「Gemini Mic On」

### 仕様メモ
- 入力音声は 16-bit PCM / 16kHz / mono で送信
- 出力音声は 24kHz PCM
- 入出力の文字起こしは `inputAudioTranscription` / `outputAudioTranscription` を有効化
- VADは自動検出を使用（`GEMINI_VAD_*` で調整可能）
- Gemini音声は `GEMINI_AUDIO_VIA_LIVEKIT=1` でLiveKitにpublish（ローカル再生は無効）

## ファイル一覧
- `docker-compose.yml`
- `livekit.yaml`
- `app/` (Node/TypeScript)
- `spa/` (Vite + LiveKit client)
