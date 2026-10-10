// Binary wire protocol shared with GlassSDK/examples/subtext/subtext.c.
// Keep both sides in sync if you change any layout or constant here.

export const SETTINGS_CHANNEL = 0x5355; // 'SU', phone -> glasses
export const EVENT_CHANNEL = 0x5356; // 'SV', glasses -> phone
export const PROTOCOL_VERSION = 1;

export const COMMAND_ALERT = 1;
export const COMMAND_CLEAR = 2;
export const COMMAND_STATUS = 3;

export const EVENT_DISMISS = 1;

// Alert kinds. Must match the ALERT_* constants on the glass side.
export const ALERT_SUBTEXT = 0;
export const ALERT_IMPORTANT = 1;
export const ALERT_COMMITMENT = 2;
export const ALERT_TONE = 3;
export const ALERT_QUESTION = 4;
export const ALERT_KIND_COUNT = 5;

export const ALERT_NOTE_MAX = 64;

// [version, cmd, kind, confidence(0-100), note_len, ...note utf8]
export function encodeAlert({ kind, confidence, note }) {
  if (kind < 0 || kind >= ALERT_KIND_COUNT) throw new Error('bad kind');
  const encoder = new TextEncoder();
  let noteBytes = encoder.encode(note || '');
  if (noteBytes.length > ALERT_NOTE_MAX) noteBytes = noteBytes.slice(0, ALERT_NOTE_MAX);
  const buffer = new Uint8Array(5 + noteBytes.length);
  buffer[0] = PROTOCOL_VERSION;
  buffer[1] = COMMAND_ALERT;
  buffer[2] = kind;
  buffer[3] = Math.max(0, Math.min(100, Math.round(confidence)));
  buffer[4] = noteBytes.length;
  buffer.set(noteBytes, 5);
  return buffer;
}

// [version, cmd, 0, 0]
export function encodeClear() {
  return new Uint8Array([PROTOCOL_VERSION, COMMAND_CLEAR, 0, 0]);
}

// [version, cmd, listening?1:0]
export function encodeStatus(listening) {
  return new Uint8Array([PROTOCOL_VERSION, COMMAND_STATUS, listening ? 1 : 0]);
}

// [version, event, 0]
export function decodeEvent(data) {
  if (!data || data.length < 3 || data[0] !== PROTOCOL_VERSION) return null;
  if (data[1] !== EVENT_DISMISS) return null;
  return { type: 'dismiss' };
}
