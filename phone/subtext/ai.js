// AI pipeline: speech-to-text + subtext analysis.
//
// Two modes:
//   - "simulated": no network, no key. Produces plausible transcripts and
//     alerts from a small script so the whole pipeline (audio -> alert ->
//     glasses) can be demoed and tested offline.
//   - "live": calls an OpenAI-compatible HTTP API using the `network`
//     permission. Both STT (audio transcription) and the chat completion run
//     against the configured base URL + key + models.
//
// Config shape (persisted by plugin.js):
//   { mode, baseUrl, apiKey, sttModel, llmModel, language, sensitivity }

import {
  ALERT_SUBTEXT,
  ALERT_IMPORTANT,
  ALERT_COMMITMENT,
  ALERT_TONE,
  ALERT_QUESTION,
} from './protocol.js';

const SIMULATED_TURNS = [
  { text: "Bon, si tu veux, on peut en reparler la semaine prochaine.", kind: ALERT_SUBTEXT, confidence: 74,
    note: "Report = desinteret possible" },
  { text: "N'oublie pas de m'envoyer le devis avant vendredi.", kind: ALERT_COMMITMENT, confidence: 88,
    note: "Engagement: devis avant vendredi" },
  { text: "C'est vraiment une super idee, bravo.", kind: ALERT_TONE, confidence: 61,
    note: "Ton enthousiaste, sincere" },
  { text: "On verra bien ce que ca donne.", kind: ALERT_SUBTEXT, confidence: 67,
    note: "Doute implicite" },
  { text: "Tu penses qu'on aura le budget cette annee ?", kind: ALERT_QUESTION, confidence: 72,
    note: "Question sous-jacente budget" },
  { text: "Le client a dit que le delai etait trop court.", kind: ALERT_IMPORTANT, confidence: 81,
    note: "Contrainte delai signalee" },
];

// The analysis JSON contract, unchanged between simulated and live modes.
export const ALERT_JSON_SCHEMA = {
  has_alert: 'boolean',
  kind: 'subtext | important | commitment | tone | question | none',
  confidence: 'number 0-100',
  note: 'short string (<= 64 chars, in the conversation language)',
};

const KIND_NAME_TO_CODE = {
  subtext: ALERT_SUBTEXT,
  important: ALERT_IMPORTANT,
  commitment: ALERT_COMMITMENT,
  tone: ALERT_TONE,
  question: ALERT_QUESTION,
};

export function kindCodeFromName(name) {
  return KIND_NAME_TO_CODE[name] ?? null;
}

export function defaultConfig() {
  return {
    mode: 'simulated',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    sttModel: 'whisper-1',
    llmModel: 'gpt-4o-mini',
    language: 'fr',
    sensitivity: 60, // min confidence (0-100) before an alert is pushed
  };
}

// ---- Simulated pipeline ----------------------------------------------------

export class SimulatedPipeline {
  constructor() {
    this.turn = 0;
  }

  // audioBytes ignored; emits the next scripted transcript turn.
  async transcribe() {
    const entry = SIMULATED_TURNS[this.turn % SIMULATED_TURNS.length];
    this.turn += 1;
    // small jitter so demos don't look perfectly regular
    const jitter = Math.round((Math.random() - 0.5) * 10);
    return {
      text: entry.text,
      kind: entry.kind,
      confidence: Math.max(0, Math.min(100, entry.confidence + jitter)),
      note: entry.note,
    };
  }

  async analyze(transcript, prior) {
    // The simulated transcript already carries its own label.
    return {
      has_alert: prior.confidence >= 0,
      kind: prior.kind,
      confidence: prior.confidence,
      note: prior.note,
      transcript: transcript.text,
    };
  }
}

// ---- Live pipeline (OpenAI-compatible) -------------------------------------

export class LivePipeline {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  async transcribe(blob, { filename = 'audio.ogg' } = {}) {
    const { baseUrl, apiKey, sttModel, language } = this.config;
    const form = new FormData();
    form.append('file', blob, filename);
    form.append('model', sttModel);
    if (language) form.append('language', language);
    const response = await this.fetch(`${this.trimSlash(baseUrl)}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!response.ok) throw new Error(`STT ${response.status}: ${await this.safeText(response)}`);
    const data = await response.json();
    return { text: (data.text || '').trim() };
  }

  async analyze(transcript, { sensitivity }) {
    const { baseUrl, apiKey, llmModel } = this.config;
    const body = {
      model: llmModel,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You are a real-time conversation copilot. Given a short snippet of a ' +
            'live conversation, decide if there is a hidden meaning, an important ' +
            'detail, an implicit commitment, a noteworthy tone, or an unspoken ' +
            'question that the wearer of smart glasses should be alerted to. ' +
            'Respond ONLY with JSON: ' +
            '{"has_alert": bool, "kind": "subtext|important|commitment|tone|question|none", ' +
            '"confidence": 0-100, "note": "short note"} . ' +
            'The note must be in the same language as the conversation, at most 64 characters. ' +
            'Prefer false negatives: only alert on something genuinely useful.',
        },
        { role: 'user', content: transcript.text },
      ],
    };
    const response = await this.fetch(`${this.trimSlash(baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`LLM ${response.status}: ${await this.safeText(response)}`);
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { has_alert: false };
    }
    const kind = kindCodeFromName(parsed.kind);
    const confidence = Number(parsed.confidence) || 0;
    if (!parsed.has_alert || kind === null || confidence < sensitivity) {
      return { has_alert: false, transcript: transcript.text };
    }
    return {
      has_alert: true,
      kind,
      confidence,
      note: String(parsed.note || '').slice(0, 64),
      transcript: transcript.text,
    };
  }

  trimSlash(url) {
    return url.replace(/\/+$/, '');
  }

  async safeText(response) {
    try {
      return await response.text();
    } catch {
      return '';
    }
  }
}

export function createPipeline(config, fetchImpl) {
  if (config.mode === 'live' && config.apiKey && config.baseUrl) {
    return new LivePipeline(config, fetchImpl);
  }
  return new SimulatedPipeline();
}
