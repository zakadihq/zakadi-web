// The strings of the SDK's own chrome in en and fr (spec/06-web-sdk.md 6.2.10,
// 6.4.6). Consent copy comes from sessionUi and captions from the server; the
// terminal-state captions are the lines the local cues speak in the zakadi-content
// recording scripts. Non-ASCII characters are written as \u escapes.
import type { TerminalState } from "@zakadi/protocol";

export interface SdkStrings {
  /** The persistent badge of 5.8, replaced by `sessionUi.badge_text`. */
  badge: string;
  /** The consent screen's own controls; its title and body come from sessionUi. */
  consent: {
    start: string;
    decline: string;
    /** Plays `consent.recording_notice`. */
    listen: string;
    language: string;
    brightness: string;
    accessibility: string;
    screenReader: string;
    extendedTime: string;
  };
  permission: { title: string; body: string };
  /** The ringing state while the call connects. */
  connecting: string;
  unsupported: { title: string; body: string };
  /** The call controls, keyed as `ui.controls`. */
  controls: { repeat: string; more_time: string; cancel: string };
  /** The actions of the terminal states. */
  actions: { redial: string; close: string };
  /** The caption of each terminal state (5.8). */
  end: Record<TerminalState, string>;
}

export const en: SdkStrings = {
  badge: "Automated check, no one is watching live",
  consent: {
    start: "Start",
    decline: "No thanks",
    listen: "Listen",
    language: "Language",
    brightness: "Turn your screen brightness up.",
    accessibility: "Accessibility options",
    screenReader: "Guide me by voice",
    extendedTime: "Give me more time",
  },
  permission: {
    title: "Allow your camera and microphone",
    body: "The check uses your camera and microphone for about twenty seconds. When your browser asks, choose Allow.",
  },
  connecting: "Calling...",
  unsupported: {
    title: "This browser can't run the check",
    body: "Open this page in an up-to-date version of Chrome, Firefox or Safari.",
  },
  controls: { repeat: "Repeat", more_time: "More time", cancel: "Cancel" },
  actions: { redial: "Call again", close: "Close" },
  end: {
    completed: "All done. Thank you.",
    incomplete: "We need one more step. Please try again.",
    disconnected: "The call dropped.",
    network_floor: "Your network is too slow right now.",
    cancelled: "The check was cancelled.",
    error: "Something went wrong. Please try again.",
    unsupported_device: "Sorry, this device can't run the check.",
    permission_denied: "This check needs your camera and microphone.",
    interrupted: "The call was interrupted.",
    sdk_disabled: "This check is not available right now.",
  },
};

export const fr: SdkStrings = {
  badge: "V\u00e9rification automatique, personne ne regarde en direct",
  consent: {
    start: "Commencer",
    decline: "Non merci",
    listen: "\u00c9couter",
    language: "Langue",
    brightness: "Augmentez la luminosit\u00e9 de votre \u00e9cran.",
    accessibility: "Options d'accessibilit\u00e9",
    screenReader: "Me guider \u00e0 la voix",
    extendedTime: "Me laisser plus de temps",
  },
  permission: {
    title: "Autorisez la cam\u00e9ra et le micro",
    body: "La v\u00e9rification utilise votre cam\u00e9ra et votre micro pendant une vingtaine de secondes. Quand votre navigateur le demande, choisissez Autoriser.",
  },
  connecting: "Appel en cours...",
  unsupported: {
    title: "Ce navigateur ne permet pas la v\u00e9rification",
    body: "Ouvrez cette page dans une version r\u00e9cente de Chrome, Firefox ou Safari.",
  },
  controls: {
    repeat: "R\u00e9p\u00e9ter",
    more_time: "Plus de temps",
    cancel: "Annuler",
  },
  actions: { redial: "Rappeler", close: "Fermer" },
  end: {
    completed: "C'est termin\u00e9. Merci.",
    incomplete: "Il reste une \u00e9tape. Veuillez r\u00e9essayer.",
    disconnected: "L'appel a \u00e9t\u00e9 coup\u00e9.",
    network_floor: "Votre r\u00e9seau est trop lent pour le moment.",
    cancelled: "La v\u00e9rification a \u00e9t\u00e9 annul\u00e9e.",
    error: "Un probl\u00e8me est survenu. Veuillez r\u00e9essayer.",
    unsupported_device: "Cet appareil ne permet pas la v\u00e9rification.",
    permission_denied:
      "Cette v\u00e9rification demande la cam\u00e9ra et le micro.",
    interrupted: "L'appel a \u00e9t\u00e9 interrompu.",
    sdk_disabled:
      "Cette v\u00e9rification n'est pas disponible pour le moment.",
  },
};
