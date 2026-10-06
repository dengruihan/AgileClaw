import type {
  SpeechProviderPlugin,
  SpeechSynthesisRequest,
  SpeechSynthesisTarget,
} from "openclaw/plugin-sdk/speech";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  createXaiSpeechProviderMetadata,
  readXaiSpeechOverrides,
  readXaiSpeechProviderConfig,
  resolveDirectXaiAudioApiKey,
  resolveXaiSpeechResponseFormat,
  xaiSpeechResponseFormatToFileExtension,
  XAI_TTS_FALLBACK_VOICES,
  normalizeXaiTtsBaseUrl,
  type XaiSpeechResponseFormat,
} from "./speech-provider-metadata.js";
import { listXaiTtsVoices, xaiTTS, xaiTTSStream } from "./tts.js";

async function resolveXaiSpeechSynthesisRequest(
  req: Pick<
    SpeechSynthesisRequest,
    "cfg" | "providerConfig" | "providerOverrides" | "text" | "timeoutMs"
  > & { target?: SpeechSynthesisTarget },
  forcedResponseFormat?: XaiSpeechResponseFormat,
) {
  const config = readXaiSpeechProviderConfig(req.providerConfig);
  const overrides = readXaiSpeechOverrides(req.providerOverrides);
  const { resolveGeneratedMediaMaxBytes } =
    await import("openclaw/plugin-sdk/media-generation-runtime");
  return {
    text: req.text,
    apiKey: await resolveXaiAudioApiKey(config.apiKey),
    baseUrl: config.baseUrl,
    voiceId: overrides.voiceId ?? config.voiceId,
    language: overrides.language ?? config.language,
    speed: overrides.speed ?? config.speed,
    responseFormat:
      forcedResponseFormat ?? resolveXaiSpeechResponseFormat(req.target, config.responseFormat),
    timeoutMs: req.timeoutMs,
    maxBytes: resolveGeneratedMediaMaxBytes(req.cfg, "audio"),
  };
}

export function buildXaiSpeechProvider() {
  return {
    ...createXaiSpeechProviderMetadata(),
    listVoices: async (req) => {
      const config = readXaiSpeechProviderConfig(req.providerConfig ?? {});
      const directApiKey = normalizeOptionalString(req.apiKey) ?? config.apiKey;
      const apiKey = await resolveOptionalXaiAudioApiKey(directApiKey);
      if (!apiKey) {
        return XAI_TTS_FALLBACK_VOICES.map((voice) => ({ id: voice, name: voice }));
      }
      return await listXaiTtsVoices({
        apiKey,
        baseUrl: normalizeXaiTtsBaseUrl(normalizeOptionalString(req.baseUrl) ?? config.baseUrl),
      });
    },
    synthesize: async (req) => {
      const params = await resolveXaiSpeechSynthesisRequest(req);
      return {
        audioBuffer: await xaiTTS(params),
        outputFormat: params.responseFormat,
        fileExtension: xaiSpeechResponseFormatToFileExtension(params.responseFormat),
        voiceCompatible: false,
      };
    },
    streamSynthesize: async (req) => {
      const params = await resolveXaiSpeechSynthesisRequest(req);
      const stream = await xaiTTSStream(params);
      return {
        audioStream: stream.audioStream,
        outputFormat: params.responseFormat,
        fileExtension: xaiSpeechResponseFormatToFileExtension(params.responseFormat),
        voiceCompatible: false,
        release: stream.release,
      };
    },
    synthesizeTelephony: async (req) => {
      const params = await resolveXaiSpeechSynthesisRequest(req, "pcm");
      return { audioBuffer: await xaiTTS(params), outputFormat: "pcm", sampleRate: 24000 };
    },
  } satisfies SpeechProviderPlugin;
}

// Resolve an xAI bearer for `/v1/tts`:
// Resolve only capability config or the configured xAI API key.
async function resolveOptionalXaiAudioApiKey(
  configApiKey: string | undefined,
): Promise<string | undefined> {
  const direct = resolveDirectXaiAudioApiKey(configApiKey);
  if (direct) {
    return direct;
  }
  return normalizeOptionalString(process.env.XAI_API_KEY);
}

async function resolveXaiAudioApiKey(configApiKey: string | undefined): Promise<string> {
  const apiKey = await resolveOptionalXaiAudioApiKey(configApiKey);
  if (apiKey) {
    return apiKey;
  }
  throw new Error("xAI API key missing for TTS. Configure the xAI API key or set XAI_API_KEY.");
}
