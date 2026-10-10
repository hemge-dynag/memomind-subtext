#include "gm_plugin_lvgl_api.h"
#include "gm_plugin_libc.h"

/* Paired with PhoneSDK/examples/subtext.
 *
 * The phone owns the glasses microphone (audio.capture), streams the audio to
 * an STT + LLM pipeline, and — when it detects a hidden meaning, an important
 * detail, or a commitment in the conversation under way — pushes an alert over
 * this plugin's settings channel.
 *
 * This plugin only renders the alert: a short colored banner with the alert
 * kind, a confidence bar, and a one-line note. The wearer can acknowledge it
 * with a head movement or the primary button, which lets the phone clear it.
 *
 * The recording indicator / consent light is handled natively by the Host
 * while any plugin holds the audio channel; this plugin does not (and cannot)
 * draw or suppress it. */

#define SETTINGS_CHANNEL UINT16_C(0x5355) /* 'SU': phone -> glasses */
#define EVENT_CHANNEL UINT16_C(0x5356)    /* 'SV': glasses -> phone */
#define PROTOCOL_VERSION 1U

#define COMMAND_ALERT 1U
#define COMMAND_CLEAR 2U
#define COMMAND_STATUS 3U

#define EVENT_DISMISS UINT8_C(1)

#define ALERT_NOTE_MAX 64U

/* Alert kinds. Must match ALERT_KINDS in the phone protocol.js. */
#define ALERT_SUBTEXT 0U
#define ALERT_IMPORTANT 1U
#define ALERT_COMMITMENT 2U
#define ALERT_TONE 3U
#define ALERT_QUESTION 4U
#define ALERT_KIND_COUNT 5U

#define SCREEN_MARGIN 20
#define BANNER_HEIGHT 96
#define TITLE_HEIGHT 40
#define HINT_HEIGHT 40

typedef struct {
    const gm_plugin_host_api_t *host;
    const gm_plugin_lvgl_api_t *ui;
    const gm_plugin_libc_extension_api_t *libc;
    gm_plugin_lvgl_obj_t *screen;
    gm_plugin_lvgl_obj_t *banner;
    gm_plugin_lvgl_obj_t *kind_label;
    gm_plugin_lvgl_obj_t *note_label;
    gm_plugin_lvgl_obj_t *title_label;
    gm_plugin_lvgl_obj_t *hint_label;
    gm_plugin_lvgl_obj_t *confidence_track;
    gm_plugin_lvgl_obj_t *confidence_fill;
    int32_t track_width;
    bool has_alert;
    bool listening;
    uint8_t alert_kind;
    uint8_t confidence;   /* 0-100 */
    char note[ALERT_NOTE_MAX + 1];
    uint8_t language;     /* 0=fr 1=en 2=es 3=it 4=de 5=zh-CN */
} subtext_t;

#define L(fr_str, en_str, es_str, it_str, de_str, zh_str) \
    (subtext.language == 1U ? (en_str) : subtext.language == 2U ? (es_str) : \
     subtext.language == 3U ? (it_str) : subtext.language == 4U ? (de_str) : \
     subtext.language == 5U ? (zh_str) : (fr_str))

static subtext_t subtext;

static uint8_t subtext_detect_language(const char *locale)
{
    if (locale[0] == 'e' && locale[1] == 'n') return 1U;
    if (locale[0] == 'e' && locale[1] == 's') return 2U;
    if (locale[0] == 'i' && locale[1] == 't') return 3U;
    if (locale[0] == 'd' && locale[1] == 'e') return 4U;
    if (locale[0] == 'z' && locale[1] == 'h') return 5U;
    return 0U;
}

static const char *alert_kind_label(uint8_t kind)
{
    switch (kind) {
    case ALERT_SUBTEXT:
        return L("SOUS-ENTENDU", "SUBTEXT", "SUBTEXTO", "SOTTINTESO", "UNTERTON", "暗示");
    case ALERT_IMPORTANT:
        return L("IMPORTANT", "IMPORTANT", "IMPORTANTE", "IMPORTANTE", "WICHTIG", "重点");
    case ALERT_COMMITMENT:
        return L("ENGAGEMENT", "COMMITMENT", "COMPROMISO", "IMPEGNO", "ZUSAGE", "承诺");
    case ALERT_TONE:
        return L("TON", "TONE", "TONO", "TONO", "TON", "语气");
    default:
        return L("QUESTION", "QUESTION", "PREGUNTA", "DOMANDA", "FRAGE", "提问");
    }
}

/* Banner tint per kind (16-gray nibble accents on a dark background). */
static uint8_t alert_kind_shade(uint8_t kind)
{
    switch (kind) {
    case ALERT_SUBTEXT: return 0xB0;
    case ALERT_IMPORTANT: return 0xE0;
    case ALERT_COMMITMENT: return 0xC8;
    case ALERT_TONE: return 0xA0;
    default: return 0xD0;
    }
}

#define number gm_plugin_lvgl_style_number
#define color gm_plugin_lvgl_style_color

static void set_style(gm_plugin_lvgl_obj_t *object,
                       gm_plugin_lvgl_style_prop_t property,
                       gm_plugin_lvgl_style_value_t value)
{
    subtext.ui->style_set(object, property, value, GM_PLUGIN_LVGL_SELECTOR_MAIN);
}

static void style_panel(gm_plugin_lvgl_obj_t *object, uint8_t fill,
                         uint8_t border, uint8_t radius)
{
    set_style(object, GM_PLUGIN_LVGL_STYLE_BG_COLOR, color(fill));
    set_style(object, GM_PLUGIN_LVGL_STYLE_BG_OPA, number(255));
    set_style(object, GM_PLUGIN_LVGL_STYLE_BORDER_COLOR, color(0xA0));
    set_style(object, GM_PLUGIN_LVGL_STYLE_BORDER_OPA, number(255));
    set_style(object, GM_PLUGIN_LVGL_STYLE_BORDER_WIDTH, number(border));
    set_style(object, GM_PLUGIN_LVGL_STYLE_RADIUS, number(radius));
    subtext.ui->obj_clear_flag(object, GM_PLUGIN_LVGL_FLAG_SCROLLABLE);
}

static gm_plugin_lvgl_obj_t *make_label(gm_plugin_lvgl_obj_t *parent,
                                         const char *text, uint8_t shade)
{
    gm_plugin_lvgl_obj_t *label = subtext.ui->label_create(parent);
    if (label == 0) return 0;
    subtext.ui->label_set_text(label, text);
    subtext.ui->label_set_long_mode(label, GM_PLUGIN_LVGL_LABEL_WRAP);
    set_style(label, GM_PLUGIN_LVGL_STYLE_TEXT_COLOR, color(shade));
    set_style(label, GM_PLUGIN_LVGL_STYLE_TEXT_ALIGN,
              number(GM_PLUGIN_LVGL_TEXT_ALIGN_CENTER));
    return label;
}

static void refresh_confidence(void)
{
    int32_t width = (int32_t)subtext.confidence * subtext.track_width / 100;
    if (width < 0) width = 0;
    subtext.ui->obj_set_size(subtext.confidence_fill, width, 6);
    subtext.ui->obj_align(subtext.confidence_fill, GM_PLUGIN_LVGL_ALIGN_LEFT_MID, 0, 0);
}

static void refresh_display(void)
{
    if (!subtext.has_alert) {
        subtext.ui->obj_add_flag(subtext.banner, GM_PLUGIN_LVGL_FLAG_HIDDEN);
        subtext.ui->label_set_text(subtext.kind_label, "");
        subtext.ui->obj_add_flag(subtext.confidence_track, GM_PLUGIN_LVGL_FLAG_HIDDEN);
        subtext.ui->label_set_text(subtext.note_label,
            subtext.listening
                ? L("Ecoute active...", "Listening...", "Escuchando...", "In ascolto...", "Hört zu...", "正在聆听...")
                : L("En veille", "Idle", "En espera", "In attesa", "Bereit", "待机"));
        subtext.ui->label_set_text(subtext.title_label,
            L("Sous-entendus", "Subtext", "Subtexto", "Sottintesi", "Untertöne", "弦外之音"));
        subtext.ui->label_set_text(subtext.hint_label,
            subtext.listening
                ? L("Micro actif - voyant allume", "Mic active - indicator on",
                    "Micro activo - indicador encendido", "Microfono attivo - spia accesa",
                    "Mikro aktiv - Anzeige leuchtet", "麦克风开启 - 指示灯亮")
                : "");
        return;
    }

    subtext.ui->obj_clear_flag(subtext.banner, GM_PLUGIN_LVGL_FLAG_HIDDEN);
    subtext.ui->obj_clear_flag(subtext.confidence_track, GM_PLUGIN_LVGL_FLAG_HIDDEN);
    set_style(subtext.banner, GM_PLUGIN_LVGL_STYLE_BG_COLOR,
              color(0x18));
    set_style(subtext.banner, GM_PLUGIN_LVGL_STYLE_BORDER_COLOR,
              color(alert_kind_shade(subtext.alert_kind)));
    subtext.ui->label_set_text(subtext.kind_label, alert_kind_label(subtext.alert_kind));
    set_style(subtext.kind_label, GM_PLUGIN_LVGL_STYLE_TEXT_COLOR,
              color(alert_kind_shade(subtext.alert_kind)));
    subtext.ui->label_set_text(subtext.note_label, subtext.note);
    subtext.ui->label_set_text(subtext.title_label,
        L("Alerte", "Alert", "Alerta", "Avviso", "Hinweis", "提示"));
    subtext.ui->label_set_text(subtext.hint_label,
        L("Bouton / tete: fermer", "Button / head: dismiss",
          "Botón / cabeza: cerrar", "Pulsante / testa: chiudi",
          "Taste / Kopf: schließen", "按钮/抬头：关闭"));
    refresh_confidence();
}

static void apply_alert(const uint8_t *data, uint32_t length)
{
    uint32_t i;
    uint32_t note_len;

    /* layout: [version, cmd, kind, confidence, note_len, note...] */
    if (length < 5U) return;
    if (data[2] >= ALERT_KIND_COUNT) return;

    note_len = data[4];
    if (note_len > ALERT_NOTE_MAX) note_len = ALERT_NOTE_MAX;
    if (5U + note_len > length) note_len = length - 5U;

    subtext.alert_kind = data[2];
    subtext.confidence = data[3] > 100U ? 100U : data[3];
    for (i = 0U; i < note_len; i++)
        subtext.note[i] = (char)data[5U + i];
    subtext.note[note_len] = '\0';

    subtext.has_alert = true;
    refresh_display();
}

static void handle_settings_message(const uint8_t *data, uint32_t length)
{
    if (length < 2U || data[0] != PROTOCOL_VERSION) return;

    switch (data[1]) {
    case COMMAND_ALERT:
        apply_alert(data, length);
        break;
    case COMMAND_CLEAR:
        subtext.has_alert = false;
        refresh_display();
        break;
    case COMMAND_STATUS:
        if (length >= 3U) {
            subtext.listening = data[2] != 0U;
            if (!subtext.has_alert) refresh_display();
        }
        break;
    default:
        break;
    }
}

static void dismiss_alert(void)
{
    uint8_t payload[3];
    if (!subtext.has_alert) return;
    subtext.has_alert = false;
    refresh_display();
    payload[0] = PROTOCOL_VERSION;
    payload[1] = EVENT_DISMISS;
    payload[2] = 0U;
    (void)subtext.host->bt_send(EVENT_CHANNEL, payload, sizeof(payload));
}

static gm_plugin_result_t subtext_start(void *context)
{
    gm_plugin_display_info_t display;
    gm_plugin_lvgl_obj_t *root;
    char locale[GM_PLUGIN_LOCALE_TAG_MAX];
    int32_t screen_w;
    (void)context;

    subtext.has_alert = false;
    subtext.listening = false;
    subtext.alert_kind = ALERT_SUBTEXT;
    subtext.confidence = 0U;
    subtext.note[0] = '\0';
    subtext.language = 0U;

    if (subtext.host->locale_get != 0 &&
        subtext.host->locale_get(locale) == GM_PLUGIN_OK)
        subtext.language = subtext_detect_language(locale);

    if (subtext.host->display_get_info(&display) != GM_PLUGIN_OK ||
        display.width <= SCREEN_MARGIN * 2U)
        return GM_PLUGIN_ESTATE;

    screen_w = (int32_t)display.width;

    root = subtext.ui->root_get();
    if (root == 0) return GM_PLUGIN_ESTATE;
    subtext.ui->obj_clean(root);

    subtext.screen = subtext.ui->obj_create(root);
    if (subtext.screen == 0) return GM_PLUGIN_ENOMEM;
    subtext.ui->obj_set_size(subtext.screen, display.width, display.height);
    subtext.ui->obj_align(subtext.screen, GM_PLUGIN_LVGL_ALIGN_CENTER, 0, 0);
    style_panel(subtext.screen, 0x00, 0, 0);

    subtext.title_label = make_label(subtext.screen, "", 0xD0);
    if (subtext.title_label == 0) goto no_memory;
    subtext.ui->obj_set_size(subtext.title_label, screen_w - SCREEN_MARGIN * 2, TITLE_HEIGHT);
    subtext.ui->obj_align(subtext.title_label, GM_PLUGIN_LVGL_ALIGN_TOP_MID, 0, 6);

    subtext.banner = subtext.ui->obj_create(subtext.screen);
    if (subtext.banner == 0) goto no_memory;
    subtext.ui->obj_set_size(subtext.banner, screen_w - SCREEN_MARGIN,
                             BANNER_HEIGHT);
    subtext.ui->obj_align(subtext.banner, GM_PLUGIN_LVGL_ALIGN_CENTER, 0, -12);
    style_panel(subtext.banner, 0x18, 3, 12);

    subtext.kind_label = make_label(subtext.banner, "", 0xE0);
    if (subtext.kind_label == 0) goto no_memory;
    set_style(subtext.kind_label, GM_PLUGIN_LVGL_STYLE_TEXT_FONT,
              (gm_plugin_lvgl_style_value_t){.ptr = subtext.ui->font_large});
    subtext.ui->obj_set_size(subtext.kind_label, screen_w - SCREEN_MARGIN * 2, 40);
    subtext.ui->obj_align(subtext.kind_label, GM_PLUGIN_LVGL_ALIGN_TOP_MID, 0, 8);

    subtext.note_label = make_label(subtext.banner, "", 0xC0);
    if (subtext.note_label == 0) goto no_memory;
    subtext.ui->label_set_long_mode(subtext.note_label, GM_PLUGIN_LVGL_LABEL_DOT);
    subtext.ui->obj_set_size(subtext.note_label, screen_w - SCREEN_MARGIN * 2, 28);
    subtext.ui->obj_align(subtext.note_label, GM_PLUGIN_LVGL_ALIGN_TOP_MID, 0, 48);

    subtext.confidence_track = subtext.ui->obj_create(subtext.banner);
    if (subtext.confidence_track == 0) goto no_memory;
    subtext.track_width = screen_w - SCREEN_MARGIN * 2 - 40;
    subtext.ui->obj_set_size(subtext.confidence_track, subtext.track_width, 6);
    subtext.ui->obj_align(subtext.confidence_track, GM_PLUGIN_LVGL_ALIGN_BOTTOM_MID, 0, -8);
    style_panel(subtext.confidence_track, 0x30, 0, 3);

    subtext.confidence_fill = subtext.ui->obj_create(subtext.confidence_track);
    if (subtext.confidence_fill == 0) goto no_memory;
    subtext.ui->obj_set_size(subtext.confidence_fill, 0, 6);
    style_panel(subtext.confidence_fill, 0xE0, 0, 3);

    subtext.hint_label = make_label(subtext.screen, "", 0x70);
    if (subtext.hint_label == 0) goto no_memory;
    subtext.ui->obj_set_size(subtext.hint_label, screen_w - SCREEN_MARGIN * 2, HINT_HEIGHT);
    subtext.ui->obj_align(subtext.hint_label, GM_PLUGIN_LVGL_ALIGN_BOTTOM_MID, 0, -8);

    refresh_display();

    if (subtext.host->imu_enable(GM_PLUGIN_IMU_ENABLE_GESTURES) != GM_PLUGIN_OK)
        goto no_memory;
    return GM_PLUGIN_OK;

no_memory:
    subtext.ui->obj_clean(root);
    subtext.screen = 0;
    subtext.title_label = 0;
    subtext.banner = 0;
    subtext.kind_label = 0;
    subtext.note_label = 0;
    subtext.confidence_track = 0;
    subtext.confidence_fill = 0;
    subtext.hint_label = 0;
    return GM_PLUGIN_ENOMEM;
}

static bool subtext_event(void *context, const gm_plugin_event_t *event)
{
    (void)context;
    if (event == 0) return false;

    if (event->type == GM_PLUGIN_EVENT_CONNECTION) {
        subtext.host->log("subtext: phone connected=%u",
                          (unsigned int)event->data.connection.connected);
        return true;
    }

    if (event->type == GM_PLUGIN_EVENT_BT_MESSAGE) {
        if (event->data.bt.channel != SETTINGS_CHANNEL || event->data.bt.data == 0)
            return false;
        handle_settings_message(event->data.bt.data, event->data.bt.length);
        return true;
    }

    if (!subtext.has_alert) return false;

    if (event->type == GM_PLUGIN_EVENT_BUTTON &&
        event->data.button.button == GM_PLUGIN_BUTTON_PRIMARY &&
        event->data.button.action == GM_PLUGIN_BUTTON_ACTION_SINGLE) {
        dismiss_alert();
        return true;
    }

    if (event->type == GM_PLUGIN_EVENT_IMU_GESTURE &&
        event->data.imu_gesture.active &&
        event->data.imu_gesture.gesture == GM_PLUGIN_IMU_GESTURE_HEAD_RAISE) {
        dismiss_alert();
        return true;
    }
    return false;
}

static void subtext_stop(void *context)
{
    gm_plugin_lvgl_obj_t *root;
    (void)context;
    root = subtext.ui->root_get();
    (void)subtext.host->imu_enable(GM_PLUGIN_IMU_ENABLE_NONE);
    if (root != 0) subtext.ui->obj_clean(root);
    subtext.screen = 0;
    subtext.title_label = 0;
    subtext.banner = 0;
    subtext.kind_label = 0;
    subtext.note_label = 0;
    subtext.confidence_track = 0;
    subtext.confidence_fill = 0;
    subtext.hint_label = 0;
    subtext.has_alert = false;
}

gm_plugin_result_t gm_plugin_entry(const gm_plugin_host_api_t *host,
                                    gm_plugin_descriptor_t *plugin)
{
    const gm_plugin_capabilities_t required =
        GM_PLUGIN_CAP_BLUETOOTH | GM_PLUGIN_CAP_BUTTON | GM_PLUGIN_CAP_IMU_EVENTS;

    if (host == 0 || plugin == 0 || host->log == 0 || host->bt_send == 0 ||
        host->display_get_info == 0 || host->graphics.lvgl == 0 ||
        host->imu_enable == 0 ||
        !GM_PLUGIN_VERSION_COMPATIBLE(host->abi_version,
                                      GM_PLUGIN_ABI_MIN_VERSION) ||
        host->struct_size < GM_PLUGIN_HOST_API_MIN_SIZE ||
        plugin->struct_size < GM_PLUGIN_DESCRIPTOR_MIN_SIZE ||
        (host->capabilities & required) != required)
        return GM_PLUGIN_ENOTSUP;

    subtext.host = host;
    subtext.ui = host->graphics.lvgl;
    if (gm_plugin_libc_get(host, &subtext.libc) != GM_PLUGIN_OK)
        return GM_PLUGIN_ENOTSUP;
    if (subtext.ui->struct_size < GM_PLUGIN_LVGL_API_MIN_SIZE ||
        !GM_PLUGIN_VERSION_COMPATIBLE(subtext.ui->api_version,
                                      GM_PLUGIN_LVGL_API_MIN_VERSION))
        return GM_PLUGIN_EVERSION;

    plugin->abi_version = GM_PLUGIN_ABI_MIN_VERSION;
    plugin->context = &subtext;
    plugin->on_start = subtext_start;
    plugin->on_event = subtext_event;
    plugin->on_stop = subtext_stop;
    return GM_PLUGIN_OK;
}
