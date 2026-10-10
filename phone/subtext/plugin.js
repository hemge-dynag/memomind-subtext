import { createGMPlugin, opusRecordingToOgg } from './vendor/gm-plugin-web-sdk.esm.js';
import {
  EVENT_CHANNEL,
  SETTINGS_CHANNEL,
  ALERT_SUBTEXT,
  ALERT_IMPORTANT,
  ALERT_KIND_COUNT,
  decodeEvent,
  encodeAlert,
  encodeClear,
  encodeStatus,
} from './protocol.js';
import { detectLocale, getStrings } from './translations.js';
import { createPipeline, defaultConfig } from './ai.js';

const S = getStrings(detectLocale());

const STORAGE_KEY = 'subtext';
// Each analysis window: how much audio (ms) we accumulate before running the
// STT + LLM pass. interactive profile emits 40 ms chunks.
const WINDOW_MS = 4000;

const gm = createGMPlugin();

const ui = {
  status: document.querySelector('#status'),
  listenButton: document.querySelector('#listen-button'),
  listeningBadge: document.querySelector('#listening-badge'),
  modeSimulated: document.querySelector('#mode-simulated'),
  modeLive: document.querySelector('#mode-live'),
  baseUrl: document.querySelector('#base-url'),
  apiKey: document.querySelector('#api-key'),
  sttModel: document.querySelector('#stt-model'),
  llmModel: document.querySelector('#llm-model'),
  language: document.querySelector('#language'),
  sensitivity: document.querySelector('#sensitivity'),
  sensitivityValue: document.querySelector('#sensitivity-value'),
  saveButton: document.querySelector('#save-button'),
  testButton: document.querySelector('#test-button'),
  transcript: document.querySelector('#transcript'),
  alertsList: document.querySelector('#alerts-list'),
  emptyAlerts: document.querySelector('#empty-alerts'),
  clearButton: document.querySelector('#clear-button'),
};

let config = defaultConfig();
let alerts = [];
let connected = false;
let listening = false;
let pipeline = null;
let capture = null;
let consumePromise = null;
let generation = 0;
let windowBytes = [];
let windowFrameLengths = [];
let windowStartMs = 0;

const KIND_CLASS = ['subtext', 'important', 'commitment', 'tone', 'question'];
const KIND_LABEL = [
  S.kindSubtext,
  S.kindImportant,
  S.kindCommitment,
  S.kindTone,
  S.kindQuestion,
];

function setStatus(text, state = '') {
  ui.status.textContent = text;
  ui.status.className = `status ${state}`.trim();
}

function applyStrings() {
  document.documentElement.lang = detectLocale();
  document.querySelector('#app-title').textContent = S.appTitle;
  document.querySelector('#subtitle').textContent = S.subtitle;
  document.querySelector('#consent-note').textContent = S.consentNote;
  document.querySelector('#mode-title').textContent = S.modeTitle;
  document.querySelector('#mode-simulated-label').textContent = S.modeSimulated;
  document.querySelector('#mode-live-label').textContent = S.modeLive;
  document.querySelector('#config-title').textContent = S.configTitle;
  document.querySelector('#base-url-label').textContent = S.baseUrl;
  document.querySelector('#api-key-label').textContent = S.apiKey;
  document.querySelector('#stt-model-label').textContent = S.sttModel;
  document.querySelector('#llm-model-label').textContent = S.llmModel;
  document.querySelector('#language-label').textContent = S.language;
  document.querySelector('#sensitivity-label').textContent = S.sensitivity;
  document.querySelector('#save-button').textContent = S.save;
  document.querySelector('#test-title').textContent = S.testTitle;
  document.querySelector('#test-button').textContent = S.testButton;
  document.querySelector('#transcript-title').textContent = S.transcriptTitle;
  document.querySelector('#alerts-title').textContent = S.alertsTitle;
  document.querySelector('#clear-button').textContent = S.clear;
  ui.emptyAlerts.textContent = S.noAlerts;
  ui.listenButton.textContent = listening ? S.listenStop : S.listenStart;
  ui.listeningBadge.textContent = listening ? S.listening : S.idle;
  setStatus(S.statusStarting);
}

function setListeningUi() {
  ui.listeningBadge.textContent = listening ? S.listening : S.idle;
  ui.listeningBadge.className = `badge ${listening ? 'listening' : 'idle'}`;
  ui.listenButton.textContent = listening ? S.listenStop : S.listenStart;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ---- Persistence -----------------------------------------------------------

async function loadConfig() {
  const result = await gm.storage.get(STORAGE_KEY);
  if (result && result.value && typeof result.value === 'object') {
    config = { ...defaultConfig(), ...result.value.config };
    alerts = Array.isArray(result.value.alerts) ? result.value.alerts : [];
  }
  applyConfigToUi();
}

async function persist() {
  await gm.storage.set(STORAGE_KEY, { config, alerts: alerts.slice(0, 100) });
}

function applyConfigToUi() {
  ui.modeSimulated.checked = config.mode !== 'live';
  ui.modeLive.checked = config.mode === 'live';
  ui.baseUrl.value = config.baseUrl || '';
  ui.apiKey.value = config.apiKey || '';
  ui.sttModel.value = config.sttModel || '';
  ui.llmModel.value = config.llmModel || '';
  ui.language.value = config.language || 'fr';
  ui.sensitivity.value = String(config.sensitivity);
  ui.sensitivityValue.textContent = String(config.sensitivity);
}

function readConfigFromUi() {
  config = {
    ...config,
    mode: ui.modeLive.checked ? 'live' : 'simulated',
    baseUrl: ui.baseUrl.value.trim(),
    apiKey: ui.apiKey.value.trim(),
    sttModel: ui.sttModel.value.trim(),
    llmModel: ui.llmModel.value.trim(),
    language: ui.language.value,
    sensitivity: Number(ui.sensitivity.value),
  };
}

// ---- Alerts ----------------------------------------------------------------

function kindLabel(kind) {
  return KIND_LABEL[kind] || KIND_LABEL[0];
}

async function pushAlert({ kind, confidence, note, transcript }) {
  if (kind < 0 || kind >= ALERT_KIND_COUNT) return;
  const entry = {
    ts: Date.now(),
    kind,
    confidence: Math.round(confidence),
    note,
    transcript: transcript || '',
  };
  alerts.unshift(entry);
  renderAlerts();
  await persist();

  try {
    await gm.plugin.sendMessage(SETTINGS_CHANNEL, encodeAlert(entry));
  } catch (error) {
    setStatus(error.message || String(error), 'error');
  }
}

function renderAlerts() {
  ui.alertsList.innerHTML = '';
  for (const entry of alerts) {
    const row = document.createElement('li');
    row.className = `alert-row kind-${KIND_CLASS[entry.kind] || 'subtext'}`;
    const date = new Date(entry.ts).toLocaleTimeString();
    row.innerHTML = `
      <div class="alert-main">
        <div class="alert-kind">${escapeHtml(kindLabel(entry.kind))} · ${entry.confidence}%</div>
        <div class="alert-note">${escapeHtml(entry.note || '')}</div>
        <div class="alert-meta">${escapeHtml(date)}</div>
      </div>
    `;
    ui.alertsList.appendChild(row);
  }
  ui.emptyAlerts.hidden = alerts.length > 0;
}

// ---- Pipeline --------------------------------------------------------------

async function analyzeWindow() {
  if (!pipeline || windowBytes.length === 0) return;
  const audio = concatBytes(windowBytes);
  const frameLengths = windowFrameLengths.slice();
  windowBytes = [];
  windowFrameLengths = [];

  let payload;
  if (pipeline.live) {
    // Live STT needs an Ogg/Opus container, not raw frames.
    try {
      payload = opusRecordingToOgg({ data: audio, frameLengths });
    } catch (error) {
      setStatus(`${S.error}: ${error.message || error}`, 'error');
      return;
    }
  } else {
    payload = audio;
  }

  let transcript;
  try {
    transcript = await pipeline.transcribe(payload);
  } catch (error) {
    setStatus(`${S.error}: ${error.message || error}`, 'error');
    return;
  }
  if (!transcript || !transcript.text) return;
  ui.transcript.textContent = transcript.text;

  let result;
  try {
    result = await pipeline.analyze(transcript, { sensitivity: config.sensitivity });
  } catch (error) {
    setStatus(`${S.error}: ${error.message || error}`, 'error');
    return;
  }
  if (result && result.has_alert) {
    await pushAlert({
      kind: result.kind,
      confidence: result.confidence,
      note: result.note,
      transcript: result.transcript || transcript.text,
    });
    setStatus(S.sent, 'ready');
  }
}

function concatBytes(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

// ---- Capture ---------------------------------------------------------------

function handleChunk(chunk) {
  if (!chunk || !chunk.data) return;
  windowBytes.push(chunk.data);
  if (Array.isArray(chunk.frameLengths)) windowFrameLengths.push(...chunk.frameLengths);
  const now = chunk.timestampUs ? chunk.timestampUs / 1000 : performance.now();
  if (now - windowStartMs >= WINDOW_MS) {
    windowStartMs = now;
    void analyzeWindow();
  }
}

async function consumeStream(session, gen) {
  const reader = session.stream.getReader();
  try {
    while (gen === generation) {
      const { value, done } = await reader.read();
      if (done) break;
      if (gen !== generation) break;
      handleChunk(value);
    }
  } catch (error) {
    if (gen === generation) setStatus(error.message || String(error), 'error');
  } finally {
    reader.releaseLock?.();
  }
}

async function startListening() {
  if (listening) return;
  if (config.mode === 'live' && (!config.apiKey || !config.baseUrl)) {
    setStatus(S.needLive, 'error');
    return;
  }
  pipeline = createPipeline(config, typeof fetch === 'function' ? fetch.bind(globalThis) : undefined);
  generation += 1;
  windowBytes = [];
  windowFrameLengths = [];
  windowStartMs = performance.now();
  try {
    capture = await gm.audio.openCapture({
      profile: 'interactive',
      pickupMode: 'frontBalanced',
      noiseReduction: true,
    });
  } catch (error) {
    capture = null;
    setStatus(error.message || String(error), 'error');
    return;
  }
  listening = true;
  setListeningUi();
  setStatus(S.listening, 'ready');
  await gm.plugin.sendMessage(SETTINGS_CHANNEL, encodeStatus(true)).catch(() => {});
  consumePromise = consumeStream(capture, generation);
}

async function stopListening() {
  if (!listening) return;
  listening = false;
  generation += 1;
  setListeningUi();
  setStatus(S.idle);
  const session = capture;
  capture = null;
  if (session) await session.stop().catch(() => {});
  await consumePromise?.catch(() => {});
  consumePromise = null;
  await gm.plugin.sendMessage(SETTINGS_CHANNEL, encodeStatus(false)).catch(() => {});
}

// ---- Events ----------------------------------------------------------------

ui.listenButton.addEventListener('click', () => {
  if (listening) void stopListening();
  else void startListening();
});

ui.saveButton.addEventListener('click', async () => {
  readConfigFromUi();
  await persist();
  setStatus(S.saved, 'ready');
});

ui.sensitivity.addEventListener('input', () => {
  ui.sensitivityValue.textContent = ui.sensitivity.value;
});

ui.testButton.addEventListener('click', async () => {
  const demos = [
    { kind: ALERT_SUBTEXT, confidence: 78, note: 'Sous-entendu de demonstration' },
    { kind: ALERT_IMPORTANT, confidence: 85, note: 'Point important de demonstration' },
  ];
  const picked = demos[Math.floor(Math.random() * demos.length)];
  await pushAlert({ ...picked, transcript: '' });
});

ui.clearButton.addEventListener('click', async () => {
  alerts = [];
  renderAlerts();
  await persist();
  await gm.plugin.sendMessage(SETTINGS_CHANNEL, encodeClear()).catch(() => {});
});

const offMessages = gm.plugin.onMessage((message) => {
  if (message.channel !== EVENT_CHANNEL) return;
  const decoded = decodeEvent(message.data);
  if (!decoded) return;
  if (decoded.type === 'dismiss') {
    setStatus(S.dismissed, 'ready');
  }
});

async function start() {
  try {
    await gm.ready();
    await loadConfig();
    applyStrings();
    renderAlerts();
    const info = await gm.device.getInfo();
    connected = Boolean(info.connected);
    setStatus(connected ? S.statusConnected : S.statusDisconnected, connected ? 'ready' : 'error');
    ui.listenButton.disabled = !connected;
    await gm.device.subscribeEvents(['connection']);
    gm.device.onConnection((event) => {
      connected = Boolean(event.connected);
      setStatus(connected ? S.statusConnected : S.statusDisconnected, connected ? 'ready' : 'error');
      ui.listenButton.disabled = !connected;
      if (!connected && listening) void stopListening();
    });
  } catch (error) {
    setStatus(error.message || String(error), 'error');
  }
}

window.addEventListener('pagehide', () => {
  offMessages();
  void stopListening();
  gm.close();
});

void start();
