import "./style.css";
import {
  createLocalAudioTrack,
  LocalAudioTrack,
  Room,
  RoomEvent,
  Track,
} from "livekit-client";

const appBaseUrl = (import.meta.env.VITE_APP_BASE_URL as string) ??
  "http://localhost:3000";

const roomInput = document.querySelector<HTMLInputElement>("#roomInput")!;
const identityInput = document.querySelector<HTMLInputElement>("#identityInput")!;
const connectBtn = document.querySelector<HTMLButtonElement>("#connectBtn")!;
const disconnectBtn = document.querySelector<HTMLButtonElement>("#disconnectBtn")!;
const micBtn = document.querySelector<HTMLButtonElement>("#micBtn")!;
const statusEl = document.querySelector<HTMLDivElement>("#status")!;
const remoteAudio = document.querySelector<HTMLAudioElement>("#remoteAudio")!;
const geminiConnectBtn = document.querySelector<HTMLButtonElement>("#geminiConnectBtn")!;
const geminiDisconnectBtn = document.querySelector<HTMLButtonElement>("#geminiDisconnectBtn")!;
const geminiMicBtn = document.querySelector<HTMLButtonElement>("#geminiMicBtn")!;
const geminiStatusEl = document.querySelector<HTMLDivElement>("#geminiStatus")!;
const geminiSessionEl = document.querySelector<HTMLDivElement>("#geminiSession")!;
const geminiTranscript = document.querySelector<HTMLPreElement>("#geminiTranscript")!;
const geminiLogs = document.querySelector<HTMLPreElement>("#geminiLogs")!;

let room: Room | null = null;
let localTrack: Track | null = null;
let geminiWs: WebSocket | null = null;
let geminiReady = false;
let geminiAudioContext: AudioContext | null = null;
let geminiMicStream: MediaStream | null = null;
let geminiSource: MediaStreamAudioSourceNode | null = null;
let geminiWorklet: AudioWorkletNode | null = null;
let geminiSilentGain: GainNode | null = null;
let geminiOutputTime = 0;
const geminiPlaying = new Set<AudioBufferSourceNode>();
let geminiInputSampleRate = 16000;
let geminiOutputSampleRate = 24000;
let geminiAudioViaLivekit = false;
let geminiLocalPlayback = true;
let geminiLivekitDestination: MediaStreamAudioDestinationNode | null = null;
let geminiLivekitTrack: LocalAudioTrack | null = null;
let geminiPlaybackPrimed = false;

function setStatus(text: string) {
  statusEl.textContent = `Status: ${text}`;
}

function setGeminiStatus(text: string) {
  geminiStatusEl.textContent = `Gemini: ${text}`;
}

function logGemini(message: string) {
  const time = new Date().toLocaleTimeString();
  const next = `[${time}] ${message}`;
  const current = geminiLogs.textContent ?? "";
  if (!current || current.includes("(no logs yet)")) {
    geminiLogs.textContent = next;
  } else {
    geminiLogs.textContent += `\n${next}`;
  }
}

function appendGeminiTranscript(role: string, text: string) {
  const time = new Date().toLocaleTimeString();
  const current = geminiTranscript.textContent ?? "";
  if (current.includes("disabled")) {
    geminiTranscript.textContent = "";
  }
  geminiTranscript.textContent += `\n[${time}] ${role}: ${text}`;
}

async function fetchConfig() {
  const res = await fetch(`${appBaseUrl}/config`);
  if (!res.ok) {
    throw new Error("failed to fetch config");
  }
  return res.json() as Promise<{
    livekitUrl: string;
    enableGeminiBridge: boolean;
    geminiInputSampleRate: number;
    geminiOutputSampleRate: number;
    geminiAudioViaLivekit: boolean;
    geminiLocalPlayback: boolean;
  }>;
}

async function fetchToken(roomName: string, identity?: string) {
  const url = new URL(`${appBaseUrl}/token`);
  url.searchParams.set("room", roomName);
  if (identity) {
    url.searchParams.set("identity", identity);
  }
  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error("failed to fetch token");
  }
  return res.json() as Promise<{ token: string; identity: string }>;
}

function toWsUrl(httpUrl: string) {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/gemini";
  url.search = "";
  return url.toString();
}

function ensureAudioContext() {
  if (!geminiAudioContext) {
    geminiAudioContext = new AudioContext();
  }
  if (geminiAudioContext.state === "suspended") {
    void geminiAudioContext.resume();
  }
  return geminiAudioContext;
}

function stopGeminiPlayback() {
  for (const source of geminiPlaying) {
    source.stop();
  }
  geminiPlaying.clear();
  geminiPlaybackPrimed = false;
  if (geminiAudioContext) {
    geminiOutputTime = geminiAudioContext.currentTime;
  } else {
    geminiOutputTime = 0;
  }
}

function decodeBase64ToInt16(base64: string) {
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const view = new DataView(buffer);
  const result = new Int16Array(binary.length / 2);
  for (let i = 0; i < result.length; i += 1) {
    result[i] = view.getInt16(i * 2, true);
  }
  return result;
}

async function ensureGeminiLivekitTrack() {
  if (!room) {
    logGemini("LiveKit未接続のためGemini音声をpublishできません");
    return false;
  }
  const ctx = ensureAudioContext();
  if (!geminiLivekitDestination) {
    geminiLivekitDestination = ctx.createMediaStreamDestination();
  }
  if (!geminiLivekitTrack) {
    const track = geminiLivekitDestination.stream.getAudioTracks()[0];
    geminiLivekitTrack = new LocalAudioTrack(track, undefined, true, ctx);
    await room.localParticipant.publishTrack(geminiLivekitTrack);
    logGemini("Gemini音声をLiveKitにpublishしました");
  }
  return true;
}

async function stopGeminiLivekitTrack() {
  if (room && geminiLivekitTrack) {
    await room.localParticipant.unpublishTrack(geminiLivekitTrack);
  }
  if (geminiLivekitTrack) {
    geminiLivekitTrack.stop();
    geminiLivekitTrack = null;
  }
  geminiLivekitDestination = null;
}

async function playGeminiAudio(base64: string) {
  const ctx = ensureAudioContext();
  const pcm16 = decodeBase64ToInt16(base64);
  const float32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i += 1) {
    float32[i] = pcm16[i] / 0x8000;
  }
  const buffer = ctx.createBuffer(1, float32.length, geminiOutputSampleRate);
  buffer.copyToChannel(float32, 0);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  let routeToLocal = geminiLocalPlayback;
  let routeToLivekit = geminiAudioViaLivekit;
  if (routeToLivekit) {
    const published = await ensureGeminiLivekitTrack();
    if (published && geminiLivekitDestination) {
      source.connect(geminiLivekitDestination);
    } else {
      routeToLivekit = false;
      routeToLocal = true;
    }
  }
  if (routeToLocal) {
    source.connect(ctx.destination);
  }
  const leadIn = geminiPlaybackPrimed ? 0.02 : 0.2;
  const startAt = Math.max(ctx.currentTime + leadIn, geminiOutputTime);
  geminiPlaybackPrimed = true;
  source.start(startAt);
  geminiOutputTime = startAt + buffer.duration;
  geminiPlaying.add(source);
  source.addEventListener("ended", () => {
    geminiPlaying.delete(source);
  });
}

function downsampleTo16k(buffer: Float32Array, sampleRate: number) {
  if (sampleRate === geminiInputSampleRate) {
    const result = new Int16Array(buffer.length);
    for (let i = 0; i < buffer.length; i += 1) {
      const s = Math.max(-1, Math.min(1, buffer[i]));
      result[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return result;
  }

  const ratio = sampleRate / geminiInputSampleRate;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Int16Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i += 1) {
      accum += buffer[i];
      count += 1;
    }
    const avg = accum / Math.max(1, count);
    const s = Math.max(-1, Math.min(1, avg));
    result[offsetResult] = s < 0 ? s * 0x8000 : s * 0x7fff;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

function int16ToBase64(data: Int16Array) {
  const buffer = new ArrayBuffer(data.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < data.length; i += 1) {
    view.setInt16(i * 2, data[i], true);
  }
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function startGeminiMic() {
  if (!geminiWs || geminiWs.readyState !== WebSocket.OPEN) {
    logGemini("Gemini WebSocketが開いていません");
    return;
  }
  const ctx = ensureAudioContext();
  if (!geminiMicStream) {
    geminiMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }
  await ctx.audioWorklet.addModule(
    new URL("./worklets/gemini-mic-processor.ts", import.meta.url),
  );
  geminiSource = ctx.createMediaStreamSource(geminiMicStream);
  geminiWorklet = new AudioWorkletNode(ctx, "gemini-mic-processor");
  geminiSilentGain = ctx.createGain();
  geminiSilentGain.gain.value = 0;
  geminiWorklet.port.onmessage = (event) => {
    if (!geminiWs || geminiWs.readyState !== WebSocket.OPEN || !geminiReady) {
      return;
    }
    const { buffer, sampleRate } = event.data ?? {};
    if (!buffer || typeof sampleRate !== "number") return;
    const input = new Float32Array(buffer as ArrayBuffer);
    const pcm16 = downsampleTo16k(input, sampleRate);
    const base64 = int16ToBase64(pcm16);
    geminiWs.send(
      JSON.stringify({
        type: "audio",
        data: base64,
        mimeType: `audio/pcm;rate=${geminiInputSampleRate}`,
      }),
    );
  };
  geminiSource.connect(geminiWorklet);
  geminiWorklet.connect(geminiSilentGain);
  geminiSilentGain.connect(ctx.destination);
  geminiMicBtn.textContent = "Gemini Mic Off";
  logGemini("マイク送信を開始しました");
}

function stopGeminiMic() {
  if (geminiWorklet) {
    geminiWorklet.port.onmessage = null;
    geminiWorklet.disconnect();
    geminiWorklet = null;
  }
  if (geminiSilentGain) {
    geminiSilentGain.disconnect();
    geminiSilentGain = null;
  }
  if (geminiSource) {
    geminiSource.disconnect();
    geminiSource = null;
  }
  if (geminiMicStream) {
    for (const track of geminiMicStream.getTracks()) {
      track.stop();
    }
    geminiMicStream = null;
  }
  if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
    geminiWs.send(JSON.stringify({ type: "audioStreamEnd" }));
  }
  geminiMicBtn.textContent = "Gemini Mic On";
  logGemini("マイク送信を停止しました");
}

connectBtn.addEventListener("click", async () => {
  try {
    setStatus("connecting...");
    const roomName = roomInput.value.trim() || "demo";
    const identity = identityInput.value.trim();
    const config = await fetchConfig();
    const { livekitUrl, enableGeminiBridge } = config;
    const tokenData = await fetchToken(roomName, identity || undefined);

    const rtcConfig = {
      iceServers: [
        { urls: ["stun:stun.l.google.com:19302"] },
        {
          urls: ["turn:192.168.50.3:3478?transport=udp"],
          username: "demo",
          credential: "demo",
        },
      ],
      // Force TURN relay for Docker Desktop networking.
      iceTransportPolicy: "relay",
    };
    const nextRoom = new Room();
    nextRoom
      .on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) {
          track.attach(remoteAudio);
        }
      })
      .on(RoomEvent.Disconnected, () => {
        setStatus("disconnected");
        connectBtn.disabled = false;
        disconnectBtn.disabled = true;
        micBtn.disabled = true;
        micBtn.textContent = "Mic On";
        localTrack = null;
      });

    await nextRoom.connect(livekitUrl, tokenData.token, { rtcConfig });
    room = nextRoom;

    connectBtn.disabled = true;
    disconnectBtn.disabled = false;
    micBtn.disabled = false;
    setStatus(`connected as ${tokenData.identity}`);

    if (enableGeminiBridge) {
      geminiTranscript.textContent = "(Gemini bridge enabled - transcript will appear here)";
    } else {
      geminiTranscript.textContent = "(Gemini bridge disabled)";
    }

    geminiAudioViaLivekit = true;
    geminiLocalPlayback = true;
  } catch (err) {
    console.error(err);
    setStatus("error");
  }
});

disconnectBtn.addEventListener("click", async () => {
  if (!room) return;
  await room.disconnect();
  room = null;
  await stopGeminiLivekitTrack();
});

micBtn.addEventListener("click", async () => {
  if (!room) return;
  if (!localTrack) {
    const track = await createLocalAudioTrack();
    await room.localParticipant.publishTrack(track);
    localTrack = track;
    micBtn.textContent = "Mic Off";
  } else {
    await room.localParticipant.unpublishTrack(localTrack);
    localTrack.stop();
    localTrack = null;
    micBtn.textContent = "Mic On";
  }
});

geminiConnectBtn.addEventListener("click", async () => {
  if (geminiWs) return;
  try {
    setGeminiStatus("connecting...");
    const config = await fetchConfig();
    geminiInputSampleRate = config.geminiInputSampleRate;
    geminiOutputSampleRate = config.geminiOutputSampleRate;
    geminiAudioViaLivekit = true;
    geminiLocalPlayback = true;
    if (!config.enableGeminiBridge) {
      setGeminiStatus("disabled");
      logGemini("Gemini bridgeが無効です");
      return;
    }
    const wsUrl = toWsUrl(appBaseUrl);
    geminiWs = new WebSocket(wsUrl);
    geminiReady = false;
    geminiSessionEl.textContent = `Session: ${wsUrl}`;
    geminiWs.addEventListener("open", () => {
      setGeminiStatus("connected");
      logGemini("Gemini WebSocketに接続しました");
      geminiConnectBtn.disabled = true;
      geminiDisconnectBtn.disabled = false;
    });
    geminiWs.addEventListener("message", (event) => {
      let payload: {
        type: string;
        message?: any;
        status?: string;
        code?: number;
        reason?: string;
        [key: string]: any;
      };
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        logGemini("受信メッセージのJSON解析に失敗しました");
        return;
      }
      if (payload.type === "ready") {
        geminiReady = true;
        geminiMicBtn.disabled = false;
        setGeminiStatus("ready");
        logGemini("Geminiセットアップ完了");
        return;
      }
      if (payload.type === "status") {
        logGemini(`status: ${payload.status ?? ""} ${payload.code ?? ""} ${payload.reason ?? ""}`);
        if (payload.status === "gemini_closed") {
          setGeminiStatus("closed");
        }
        return;
      }
      if (payload.type === "error") {
        logGemini(`error: ${payload.message ?? "unknown"}`);
        setGeminiStatus("error");
        return;
      }
      if (payload.type === "gemini") {
        const message = payload.message ?? {};
        const serverContent = message.serverContent ?? {};
        if (serverContent.interrupted) {
          logGemini("VAD割り込み: 再生を停止しました");
          stopGeminiPlayback();
        }
        if (serverContent.inputTranscription?.text) {
          appendGeminiTranscript("user", serverContent.inputTranscription.text);
        }
        if (serverContent.outputTranscription?.text) {
          appendGeminiTranscript("model", serverContent.outputTranscription.text);
        }
        const modelTurn = serverContent.modelTurn;
        if (modelTurn?.parts && Array.isArray(modelTurn.parts)) {
          for (const part of modelTurn.parts) {
            if (part.inlineData?.data) {
              void playGeminiAudio(part.inlineData.data);
            }
            if (part.text) {
              appendGeminiTranscript("model", part.text);
            }
          }
        }
        if (message.goAway) {
          logGemini("GoAwayを受信しました。再接続を検討してください。");
        }
        if (message.usageMetadata) {
          logGemini(`tokens: ${message.usageMetadata.totalTokenCount ?? "-"}`);
        }
      }
    });
    geminiWs.addEventListener("close", (event) => {
      setGeminiStatus("disconnected");
      logGemini(`WebSocket close: ${event.code} ${event.reason}`);
      geminiConnectBtn.disabled = false;
      geminiDisconnectBtn.disabled = true;
      geminiMicBtn.disabled = true;
      geminiReady = false;
      geminiWs = null;
      stopGeminiMic();
      stopGeminiPlayback();
    });
    geminiWs.addEventListener("error", () => {
      setGeminiStatus("error");
      logGemini("WebSocketエラー");
    });
  } catch (err) {
    console.error(err);
    setGeminiStatus("error");
    logGemini("接続に失敗しました");
  }
});

geminiDisconnectBtn.addEventListener("click", () => {
  if (!geminiWs) return;
  stopGeminiMic();
  stopGeminiPlayback();
  geminiWs.close(1000, "User disconnected");
  geminiWs = null;
});

geminiMicBtn.addEventListener("click", async () => {
  if (!geminiWs || geminiWs.readyState !== WebSocket.OPEN) return;
  if (geminiWorklet) {
    stopGeminiMic();
  } else {
    await startGeminiMic();
  }
});

geminiAudioViaLivekit = true;
geminiLocalPlayback = true;

setStatus("idle");
setGeminiStatus("idle");
