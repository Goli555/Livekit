import express from "express";
import dotenv from "dotenv";
import { AccessToken } from "livekit-server-sdk";
import { randomUUID } from "node:crypto";
import http from "node:http";
import WebSocket, { RawData, WebSocketServer } from "ws";
import cors from "cors";

dotenv.config();

const corsOrigin = process.env.CORS_ORIGIN ?? "http://localhost:5173";

const app = express();
app.use(
  cors({
    origin: corsOrigin,
  }),
);
app.use(express.json());

const appPort = Number(process.env.APP_PORT ?? 3000);
const livekitUrl = process.env.LIVEKIT_URL ?? "ws://localhost:7880";
const livekitApiKey = process.env.LIVEKIT_API_KEY ?? "devkey";
const livekitApiSecret = process.env.LIVEKIT_API_SECRET ?? "devsecret";
const geminiModel =
  process.env.GEMINI_LIVE_MODEL ?? "gemini-2.5-flash-native-audio-preview-12-2025";
const enableGeminiBridge = process.env.ENABLE_GEMINI_BRIDGE === "1";
const enableDebugTranscript = process.env.ENABLE_DEBUG_TRANSCRIPT === "1";
const geminiApiKey = process.env.GEMINI_API_KEY ?? "";
const geminiWsEndpoint =
  process.env.GEMINI_LIVE_WS_ENDPOINT ??
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const vadStartSensitivity = process.env.GEMINI_VAD_START_SENSITIVITY ?? "START_SENSITIVITY_LOW";
const vadEndSensitivity = process.env.GEMINI_VAD_END_SENSITIVITY ?? "END_SENSITIVITY_LOW";
const vadPrefixPaddingMs = Number(process.env.GEMINI_VAD_PREFIX_PADDING_MS ?? 20);
const vadSilenceDurationMs = Number(process.env.GEMINI_VAD_SILENCE_DURATION_MS ?? 100);
const geminiAudioViaLivekit = process.env.GEMINI_AUDIO_VIA_LIVEKIT === "1";
const geminiLocalPlayback = process.env.GEMINI_LOCAL_PLAYBACK !== "0";

type TranscriptEvent = {
  id: string;
  role: "user" | "model" | "system";
  text: string;
  createdAt: string;
};

const transcriptClients = new Set<express.Response>();

function broadcastTranscript(event: TranscriptEvent) {
  const payload = `event: transcript\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of transcriptClients) {
    client.write(payload);
  }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/config", (_req, res) => {
  res.json({
    livekitUrl,
    geminiModel,
    enableGeminiBridge,
    geminiInputSampleRate: 16000,
    geminiOutputSampleRate: 24000,
    geminiAudioViaLivekit,
    geminiLocalPlayback,
  });
});

app.get("/token", async (req, res) => {
  const room = String(req.query.room ?? "demo");
  const identity = String(req.query.identity ?? `user-${Date.now()}`);
  const token = new AccessToken(livekitApiKey, livekitApiSecret, {
    identity,
    ttl: "15m",
  });
  token.addGrant({
    room,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
  });

  res.json({
    token: await token.toJwt(),
    room,
    identity,
  });
});

app.get("/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("\n");
  transcriptClients.add(res);

  req.on("close", () => {
    transcriptClients.delete(res);
  });
});

if (enableDebugTranscript) {
  app.post("/debug/transcript", (req, res) => {
    const text = String(req.body?.text ?? "").trim();
    const role = (req.body?.role as TranscriptEvent["role"]) ?? "system";
    if (!text) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    broadcastTranscript({
      id: randomUUID(),
      role,
      text,
      createdAt: new Date().toISOString(),
    });
    res.json({ ok: true });
  });
}

function normalizeModelName(model: string) {
  return model.startsWith("models/") ? model : `models/${model}`;
}

function buildGeminiSetup() {
  return {
    setup: {
      model: normalizeModelName(geminiModel),
      generationConfig: {
        responseModalities: ["AUDIO"],
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity: vadStartSensitivity,
          endOfSpeechSensitivity: vadEndSensitivity,
          prefixPaddingMs: vadPrefixPaddingMs,
          silenceDurationMs: vadSilenceDurationMs,
        },
      },
    },
  };
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/gemini" });

function sendJson(ws: WebSocket, payload: unknown) {
  ws.send(JSON.stringify(payload));
}

function parseJson<T>(data: RawData): T | null {
  try {
    const raw = typeof data === "string" ? data : data.toString();
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

wss.on("connection", (client) => {
  const sessionId = randomUUID();
  console.log(`[gemini][${sessionId}] client connected`);

  if (!enableGeminiBridge) {
    sendJson(client, { type: "error", message: "Gemini bridge is disabled." });
    client.close(1013, "Gemini bridge disabled");
    return;
  }
  if (!geminiApiKey) {
    sendJson(client, { type: "error", message: "GEMINI_API_KEY is not configured." });
    client.close(1013, "Missing API key");
    return;
  }

  const geminiWs = new WebSocket(`${geminiWsEndpoint}?key=${geminiApiKey}`);

  geminiWs.on("open", () => {
    console.log(`[gemini][${sessionId}] upstream connected`);
    sendJson(geminiWs, buildGeminiSetup());
    sendJson(client, { type: "status", status: "gemini_connected" });
  });

  geminiWs.on("message", (data) => {
    const message = parseJson<Record<string, unknown>>(data);
    if (!message) {
      console.warn(`[gemini][${sessionId}] failed to parse upstream message`);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(message, "setupComplete")) {
      sendJson(client, { type: "ready" });
    }
    sendJson(client, { type: "gemini", message });
  });

  geminiWs.on("close", (code, reason) => {
    const detail = reason.toString();
    console.log(`[gemini][${sessionId}] upstream closed ${code} ${detail}`);
    sendJson(client, { type: "status", status: "gemini_closed", code, reason: detail });
    client.close(1011, "Gemini upstream closed");
  });

  geminiWs.on("error", (err) => {
    console.error(`[gemini][${sessionId}] upstream error`, err);
    sendJson(client, { type: "error", message: "Gemini upstream error." });
  });

  client.on("message", (data) => {
    const message = parseJson<{ type: string; data?: string; mimeType?: string }>(data);
    if (!message || !message.type) {
      sendJson(client, { type: "error", message: "Invalid client message." });
      return;
    }

    if (message.type === "ping") {
      sendJson(client, { type: "pong" });
      return;
    }

    if (geminiWs.readyState !== WebSocket.OPEN) {
      sendJson(client, { type: "error", message: "Gemini upstream not ready." });
      return;
    }

    if (message.type === "audio") {
      if (!message.data) {
        sendJson(client, { type: "error", message: "audio data missing." });
        return;
      }
      sendJson(geminiWs, {
        realtimeInput: {
          audio: {
            data: message.data,
            mimeType: message.mimeType ?? "audio/pcm;rate=16000",
          },
        },
      });
      return;
    }

    if (message.type === "audioStreamEnd") {
      sendJson(geminiWs, { realtimeInput: { audioStreamEnd: true } });
      return;
    }

    if (message.type === "text") {
      sendJson(geminiWs, {
        clientContent: {
          turns: message.data ?? "",
          turnComplete: true,
        },
      });
      return;
    }

    sendJson(client, { type: "error", message: `Unknown message type: ${message.type}` });
  });

  client.on("close", () => {
    console.log(`[gemini][${sessionId}] client disconnected`);
    if (geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.close(1000, "Client disconnected");
    } else {
      geminiWs.terminate();
    }
  });

  client.on("error", (err) => {
    console.error(`[gemini][${sessionId}] client error`, err);
  });
});

server.listen(appPort, () => {
  console.log(`app server listening on ${appPort}`);
  if (enableGeminiBridge) {
    console.log("Gemini bridge is enabled.");
  }
});
