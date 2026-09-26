// <zakadi-call> (spec/06-web-sdk.md 6.4 and 6.2.10, spec/05-sdk-contract.md 5.8 and
// 5.10): the default UI, drawn from the renderer bridge of @zakadi/web-core. The session
// binds the element (bindSession) and it renders the bridge's view, the server's `ui`
// states, `tile`, `say` captions and the listening ring, and forwards the user's taps.
// The class is made inside zakadiCall(), which defineZakadiCall() calls: Node has no
// HTMLElement (6.5).
import type {
  RendererBridge,
  RendererView,
  UiState,
  ZakadiRenderer,
} from "@zakadi/web-core";
import { character, rendererFor, type Character } from "./character";
import { contrast, grey, hsl, parseColor, type Rgba } from "./color";
import { el, show, svg, text } from "./dom";
import { governor } from "./governor";
import { ARROWS, DIM, H, OVAL, W } from "./guide";
import { adopt } from "./styles";

type Screen = RendererView["screen"];
type Terminal = Exclude<
  Screen,
  "idle" | "consent" | "permission" | "connecting" | "call"
>;
type Control = "repeat" | "more_time" | "cancel";
type Hsl = readonly [number, number, number];

const CONTROLS: Control[] = ["repeat", "more_time", "cancel"];
const LOCAL: readonly Screen[] = [
  "idle",
  "consent",
  "permission",
  "connecting",
  "call",
];
/** The tile before the first `tile`: a neutral grey, the session's own fallback. */
export const NEUTRAL: Hsl = [0, 0, 50];
/** `surround.brightness` before the first `ui` (G5). */
export const SURROUND = 0.9;
/** The caption pair a refused theme falls back to (6.2.10). */
export const CAPTION = { text: "#141414", bg: "#ffffff" };
const TOKENS = [
  ["colorPrimary", "--lv-color-primary"],
  ["colorOnPrimary", "--lv-color-on-primary"],
  ["colorText", "--lv-color-text"],
  ["captionBg", "--lv-caption-bg"],
  ["fontFamily", "--lv-font-family"],
  ["radius", "--lv-radius"],
] as const;

const isTerminal = (s: Screen): s is Terminal => !LOCAL.includes(s);

/** The language's own name for the consent screen's switcher. */
function languageName(tag: string): string {
  try {
    return new Intl.DisplayNames([tag], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/** The element class; defineZakadiCall() registers it as `zakadi-call`. */
export function zakadiCall(): CustomElementConstructor {
  return class ZakadiCall extends HTMLElement implements ZakadiRenderer {
    private readonly call = createCall(this);
    connectedCallback(): void {
      this.call.connected(true);
    }
    disconnectedCallback(): void {
      this.call.connected(false);
    }
    bindSession(bridge: RendererBridge): void {
      this.call.bind(bridge);
    }
    unbindSession(bridge: RendererBridge): void {
      this.call.unbind(bridge);
    }
  };
}

function createCall(host: HTMLElement) {
  const root = host.attachShadow({ mode: "open" });
  adopt(root);
  const button = (cls = "") => el("button", cls, { type: "button" });

  // The badge (5.8): on every screen, never hidden.
  const badge = el("p", "badge", { id: "zk-badge" });

  // Consent (6.4.6).
  const logo = el("img", "logo", { alt: "" });
  const title = el("h2", "", { tabindex: "-1" });
  const body = el("p");
  const notice = el("p");
  const listen = button();
  const noticeRow = el("div", "notice", {}, notice, listen);
  const langName = el("span");
  const select = el("select");
  const langRow = el("label", "lang", {}, langName, select);
  const brightness = el("p");
  const a11yName = el("summary");
  const srBox = el("input", "", { type: "checkbox" });
  const srName = el("span");
  const etBox = el("input", "", { type: "checkbox" });
  const etName = el("span");
  const decline = button();
  const start = button("primary");
  const consent = el(
    "section",
    "page",
    {},
    logo,
    title,
    body,
    noticeRow,
    langRow,
    brightness,
    el(
      "details",
      "",
      {},
      a11yName,
      el("label", "check", {}, srBox, srName),
      el("label", "check", {}, etBox, etName),
    ),
    el("div", "actions", {}, decline, start),
  );

  // The permission explainer (6.4.6).
  const permTitle = el("h2", "", { tabindex: "-1" });
  const permBody = el("p");
  const permission = el("section", "page", {}, permTitle, permBody);

  // The call (5.8, 6.4.2), also the connecting screen: the self-view with the oval and
  // the arc over it in encoded-frame coordinates, the host tile, digits, captions and
  // controls.
  const video = el("video", "", {
    autoplay: "",
    muted: "",
    playsinline: "",
    "aria-hidden": "true",
  });
  video.muted = true;
  const dim = svg("path", { class: "dim", d: DIM, "fill-rule": "evenodd" });
  const oval = svg("ellipse", {
    class: "oval",
    cx: String(OVAL.cx),
    cy: String(OVAL.cy),
    rx: String(OVAL.rx),
    ry: String(OVAL.ry),
  });
  const shafts = [0, 1, 2, 3].map(() => svg("path", { class: "shaft" }));
  const heads = svg("path", { class: "heads" });
  const guide = svg(
    "svg",
    {
      viewBox: `0 0 ${W} ${H}`,
      preserveAspectRatio: "xMidYMid slice",
      "aria-hidden": "true",
    },
    dim,
    oval,
    ...shafts,
    heads,
  );
  const ring = el("div", "ring");
  const digits = el("div", "digits");
  const figure = el("div", "character");
  const tile = el("div", "tile", { "aria-hidden": "true" }, figure);
  const caption = el("p", "caption");
  const live = el("div", "sr", { "aria-live": "polite" });
  const buttons = {
    repeat: button(),
    more_time: button(),
    cancel: button(),
  };
  const dots = el("div", "dots", { role: "progressbar", "aria-valuemin": "0" });
  const stage = el(
    "section",
    "stage",
    { tabindex: "-1" },
    el("div", "self", {}, video, guide),
    ring,
    digits,
    tile,
    el(
      "div",
      "lower",
      {},
      caption,
      el("div", "controls", {}, ...CONTROLS.map((c) => buttons[c])),
      dots,
    ),
    live,
  );

  // The terminal states (5.8, 6.4.6): a caption, close, and redial where 5.8 offers it.
  const endTitle = el("h2", "", { tabindex: "-1" });
  const endText = el("p");
  const redial = button();
  const close = button("primary");
  const end = el(
    "section",
    "page",
    {},
    endTitle,
    endText,
    el("div", "actions", {}, redial, close),
  );

  // The call is a modal dialog, labelled by the badge (6.2.10). Its background is the
  // surround; the portrait layout inside is fitted into a landscape area, as where the
  // orientation cannot be locked (6.4.2, 6.8).
  const probe = el("span", "sr");
  const zk = el(
    "div",
    "zk",
    { role: "dialog", "aria-modal": "true", "aria-labelledby": "zk-badge" },
    el("div", "frame", {}, badge, consent, permission, stage, end),
    probe,
  );
  for (const s of [consent, permission, stage, end]) show(s, false);
  root.append(zk);

  let bridge: RendererBridge | null = null;
  let offs: (() => void)[] = [];
  let view: RendererView | null = null;
  let state: UiState | null = null;
  let screen: Screen | null = null;
  let said = "";
  let stream: MediaStream | null = null;
  let figureData: unknown = null;
  let lottie: Character | undefined;
  let connected = false;
  let painted = false;
  let raf = 0;
  let last = 0;
  let envelope = 0;
  const samples = new Uint8Array(256);

  // Luminance-changing updates, three a second at most per element (6.4.3).
  const surround = governor<[number, boolean]>(
    ([y, flood]) => {
      // Surround changes take 300 ms; flood is one 600 ms ramp to white (6.4.2).
      zk.style.transition = painted
        ? `background-color ${flood ? 600 : 300}ms linear`
        : "none";
      zk.style.backgroundColor = flood ? "rgb(255, 255, 255)" : grey(y);
      painted = true;
    },
    ([y, flood]) => (flood ? "flood" : String(y)),
  );
  const dimming = governor<boolean>((on) => {
    dim.style.opacity = on ? "0.4" : "0";
  }, String);
  const numbers = governor<number[] | null>(
    (values) => {
      digits.textContent = "";
      for (const n of values ?? [])
        digits.append(el("span", "digit", {}, document.createTextNode(`${n}`)));
      show(digits, !!values);
    },
    (values) => JSON.stringify(values),
  );

  // The nonce band: the palette colour, set in the handler with no transition, so that
  // it lands in the next frame; never governed (6.4.3).
  const paintTile = (c: Hsl) => {
    tile.style.backgroundColor = hsl(c);
  };

  const still = () => !!view?.a11y.reduced_motion;

  const drawArc = (s: UiState | null) => {
    const a = s?.arc;
    const arrows = a?.visible && a.direction ? ARROWS[a.direction] : [];
    const progress = Math.min(1, Math.max(0, a?.progress ?? 0));
    shafts.forEach((p, i) => {
      const arrow = arrows[i];
      show(p, !!arrow);
      if (!arrow) {
        p.removeAttribute("d");
        p.style.removeProperty("stroke-dasharray");
        p.style.removeProperty("stroke-dashoffset");
        return;
      }
      p.setAttribute("d", arrow.d);
      p.style.strokeDasharray = `${arrow.length}`;
      // Reduced motion draws the arc complete (6.4.4).
      p.style.strokeDashoffset = `${still() ? 0 : arrow.length * (1 - progress)}`;
    });
    if (arrows.length)
      heads.setAttribute("d", arrows.map((x) => x.head).join(""));
    else heads.removeAttribute("d");
    show(heads, arrows.length > 0);
  };

  const renderCaption = () => {
    const v = view;
    const own = state?.caption?.text ?? "";
    // `ui.caption` in the bar; `say.caption` only when it is empty (G6).
    const t =
      screen === "connecting" ? (v?.strings.connecting ?? "") : own || said;
    text(caption, t);
    const pictogram = screen === "call" ? state?.caption?.pictogram : undefined;
    // No pictogram asset exists yet (D96): the bar names it and draws none.
    if (pictogram) caption.setAttribute("data-pictogram", pictogram);
    else caption.removeAttribute("data-pictogram");
    show(caption, !!t && v?.a11y.captions !== false);
  };

  /** The server's `ui` state, rendered whole: an absent field is its default (1.5). */
  const renderUi = () => {
    const s = state;
    const call = screen === "call";
    stage.setAttribute("data-phase", s?.phase ?? "");
    const sv = s?.self_view;
    show(oval, sv?.oval !== false);
    oval.classList.toggle("hl", sv?.oval_emphasis === "highlight");
    dimming.set(sv?.fill === "dim");
    drawArc(call ? s : null);
    lottie?.play(s?.character?.anim ?? "idle", still());
    renderCaption();
    const d = s?.digits;
    numbers.set(call && d?.visible ? (d.values ?? []) : null);
    const su = s?.surround;
    surround.set([su?.brightness ?? SURROUND, !!su?.flood]);
    // Controls per `ui.controls`; more time is always there with extended time (5.10);
    // while connecting, cancel alone.
    const c = s?.controls;
    for (const k of CONTROLS)
      show(
        buttons[k],
        screen === "connecting"
          ? k === "cancel"
          : call &&
              (!!c?.[k] || (k === "more_time" && !!view?.a11y.extended_time)),
      );
    const p = s?.progress;
    const of = call ? Math.min(p?.of ?? 0, 20) : 0;
    if (dots.childElementCount !== of) {
      dots.textContent = "";
      for (let i = 0; i < of; i++) dots.append(el("span", "dot"));
    }
    [...dots.children].forEach((d, i) =>
      d.classList.toggle("on", i < (p?.step ?? 0)),
    );
    dots.setAttribute("aria-valuemax", `${of}`);
    dots.setAttribute("aria-valuenow", `${Math.min(p?.step ?? 0, of)}`);
    show(dots, of > 0);
  };

  // A colour a token holds, parsed here or resolved by the browser.
  const rgba = (value: string): Rgba | null => {
    const parsed = parseColor(value);
    if (parsed) return parsed;
    probe.style.color = "";
    probe.style.color = value;
    return probe.style.color ? parseColor(getComputedStyle(probe).color) : null;
  };
  const token = (
    v: RendererView,
    key: "colorText" | "captionBg",
    prop: string,
    fallback: string,
  ) =>
    v.theme[key] ||
    (connected ? getComputedStyle(host).getPropertyValue(prop).trim() : "") ||
    fallback;

  // Theme tokens from `ui.theme`, the brand's primary colour beneath the page's; caption
  // colours under 4.5:1 are refused for the built-in pair (6.2.10, 5.10).
  const theme = (v: RendererView) => {
    for (const [key, prop] of TOKENS) {
      const value = v.theme[key];
      if (value) zk.style.setProperty(prop, value);
      else zk.style.removeProperty(prop);
    }
    if (v.brand.primary) zk.style.setProperty("--zk-brand", v.brand.primary);
    else zk.style.removeProperty("--zk-brand");
    const fg = rgba(token(v, "colorText", "--lv-color-text", CAPTION.text));
    const bg = rgba(token(v, "captionBg", "--lv-caption-bg", CAPTION.bg));
    const refused = !fg || !bg || contrast(fg, bg) < 4.5;
    caption.toggleAttribute("data-refused", refused);
    if (refused) {
      caption.style.setProperty("--zk-cap-fg", CAPTION.text);
      caption.style.setProperty("--zk-cap-bg", CAPTION.bg);
    } else {
      caption.style.removeProperty("--zk-cap-fg");
      caption.style.removeProperty("--zk-cap-bg");
    }
  };

  const renderConsent = (v: RendererView) => {
    const s = v.strings.consent;
    const copy = v.consentCopy;
    if (v.brand.logo_url) logo.src = v.brand.logo_url;
    show(logo, !!v.brand.logo_url);
    text(title, copy?.title ?? "");
    text(body, copy?.body ?? "");
    // "Listen" plays `consent.recording_notice`.
    text(notice, copy?.recording_notice ?? "");
    text(listen, s.listen);
    show(noticeRow, !!copy?.recording_notice);
    // The switcher, when the session offers several languages.
    text(langName, s.language);
    if ([...select.options].map((o) => o.value).join() !== v.languages.join()) {
      select.textContent = "";
      for (const l of v.languages)
        select.append(
          el(
            "option",
            "",
            { value: l },
            document.createTextNode(languageName(l)),
          ),
        );
    }
    select.value = v.lang;
    show(langRow, v.languages.length > 1);
    text(brightness, s.brightness);
    text(a11yName, s.accessibility);
    text(srName, s.screenReader);
    text(etName, s.extendedTime);
    srBox.checked = v.a11y.screen_reader;
    text(decline, s.decline);
    text(start, s.start);
  };

  const renderEnd = (v: RendererView, s: Terminal) => {
    text(endTitle, v.strings.end[s]);
    // The server's message for sdk_disabled; the guidance for an unsupported browser.
    const more =
      s === "sdk_disabled"
        ? (v.message ?? "")
        : s === "unsupported_device"
          ? v.strings.unsupported.body
          : "";
    text(endText, more);
    show(endText, !!more);
    text(close, v.strings.actions.close);
    text(redial, v.strings.actions.redial);
    // Redial only where 5.8 offers it: incomplete, disconnected, network_floor, error
    // and interrupted.
    show(redial, v.redial);
  };

  const attach = (s: MediaStream | null) => {
    if (s === stream) return;
    stream = s;
    try {
      video.srcObject = s;
      if (s) void video.play()?.catch(() => undefined);
    } catch {
      // A page without media elements.
    }
  };

  // The listening ring (6.4.2): a slow sweep in `listening`, the playback envelope
  // low-passed below 3 Hz during cues; width and scale only, never luminance.
  const tick = (t: number) => {
    raf = 0;
    const analyser = bridge?.analyser();
    if (analyser) {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const b of samples) sum += ((b - 128) / 128) ** 2;
      const rms = Math.sqrt(sum / samples.length);
      const dt = last ? Math.min(0.25, (t - last) / 1000) : 1 / 60;
      envelope += (rms - envelope) * (1 - Math.exp(-2 * Math.PI * 2.5 * dt));
      const k = Math.min(1, envelope * 4);
      const scale = `scale(${(1 + 0.03 * k).toFixed(3)})`;
      const width = `${(3 + 5 * k).toFixed(1)}px`;
      // Written only when they change: a quiet bus costs no style work.
      if (ring.style.transform !== scale) ring.style.transform = scale;
      if (ring.style.borderWidth !== width) ring.style.borderWidth = width;
    }
    last = t;
    loop();
  };
  const loop = () => {
    const run = connected && !!bridge && screen === "call" && !still();
    if (run && !raf) raf = requestAnimationFrame(tick);
    if (!run && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    if (!run) {
      last = 0;
      envelope = 0;
      ring.style.removeProperty("transform");
      ring.style.removeProperty("border-width");
    }
  };

  // Focus stays inside the dialog (6.2.10).
  const focusables = () =>
    [
      ...zk.querySelectorAll<HTMLElement>("button, select, input, summary"),
    ].filter(
      (e) =>
        !e.closest("[hidden]") &&
        !(e as HTMLButtonElement).disabled &&
        // A closed disclosure hides all but its summary.
        (e.localName === "summary" || !e.closest("details:not([open])")),
    );
  const focusScreen = () => {
    if (!connected || !screen || screen === "idle") return;
    const target =
      screen === "consent"
        ? title
        : screen === "permission"
          ? permTitle
          : isTerminal(screen)
            ? endTitle
            : stage;
    target.focus({ preventScroll: true });
  };
  zk.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const items = focusables();
    const first = items[0];
    const last = items[items.length - 1];
    const active = root.activeElement as HTMLElement | null;
    const inside = !!active && items.includes(active);
    if (!first || !last) return e.preventDefault();
    if (e.shiftKey ? active === first || !inside : active === last || !inside) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  });
  let refocusing = false;
  const onFocusIn = (e: Event) => {
    // Focus inside this call stays where it is, and so does focus in another open one.
    const inCall = e
      .composedPath()
      .some((n) => (n as Element).localName === "zakadi-call");
    if (refocusing || inCall) return;
    refocusing = true;
    focusScreen();
    refocusing = false;
  };
  const guard = () => {
    const doc = host.ownerDocument;
    doc.removeEventListener("focusin", onFocusIn, true);
    if (connected && screen && screen !== "idle")
      doc.addEventListener("focusin", onFocusIn, true);
  };

  const emit = (type: string, detail: object = {}) =>
    host.dispatchEvent(
      new CustomEvent(type, { bubbles: true, composed: true, detail }),
    );

  // Taps. Start calls submitConsent synchronously: the tap is the gesture that unlocks
  // audio and asks for fullscreen (6.2.9, 6.8).
  start.addEventListener("click", () =>
    bridge?.submitConsent(true, view?.lang ?? "", etBox.checked),
  );
  decline.addEventListener("click", () =>
    bridge?.submitConsent(false, view?.lang ?? "", false),
  );
  listen.addEventListener("click", () => bridge?.listen());
  select.addEventListener("change", () => bridge?.selectLanguage(select.value));
  srBox.addEventListener("change", () =>
    bridge?.setScreenReader(srBox.checked),
  );
  for (const c of CONTROLS)
    buttons[c].addEventListener("click", () => bridge?.press(c));
  redial.addEventListener("click", () => {
    const b = bridge;
    if (!b) return;
    emit("zakadi-redial");
    b.redial();
  });
  close.addEventListener("click", () => {
    const b = bridge;
    if (!b) return;
    emit("zakadi-close");
    b.close();
  });

  const render = (v: RendererView) => {
    view = v;
    const s = v.screen;
    zk.lang = v.lang;
    zk.toggleAttribute("data-still", v.a11y.reduced_motion);
    theme(v);
    text(badge, v.strings.badge);
    show(consent, s === "consent");
    show(permission, s === "permission");
    show(stage, s === "connecting" || s === "call");
    show(end, isTerminal(s));
    if (s === "consent") renderConsent(v);
    if (s === "permission") {
      text(permTitle, v.strings.permission.title);
      text(permBody, v.strings.permission.body);
    }
    if (isTerminal(s)) renderEnd(v, s);
    for (const c of CONTROLS) text(buttons[c], v.strings.controls[c]);
    // The preview, hidden while the camera probe runs (6.4.6).
    attach(
      s === "connecting" || s === "call"
        ? (bridge?.previewStream() ?? null)
        : null,
    );
    video.style.visibility = v.previewHidden ? "hidden" : "visible";
    // The character once the session has checked it; colour alone without one (D73).
    if (v.character !== figureData) {
      lottie?.destroy();
      lottie = undefined;
      figureData = v.character;
      if (figureData)
        lottie = character(figure, figureData, rendererFor(v.lottieRenderer));
    }
    const changed = s !== screen;
    screen = s;
    renderUi();
    if (changed) {
      if (s === "idle") host.removeAttribute("data-screen");
      else host.setAttribute("data-screen", s);
      guard();
      focusScreen();
      emit("zakadi-state", { screen: s, state: bridge?.session.state });
    }
    loop();
  };

  const reset = () => {
    state = null;
    said = "";
    screen = null;
    painted = false;
    surround.reset();
    dimming.reset();
    numbers.reset();
    live.textContent = "";
    etBox.checked = !!bridge?.view().a11y.extended_time;
    paintTile(NEUTRAL);
  };

  const unbind = (b: RendererBridge) => {
    if (b !== bridge) return;
    offs.splice(0).forEach((off) => off());
    bridge = null;
    view = null;
    lottie?.destroy();
    lottie = undefined;
    figureData = null;
    attach(null);
    screen = null;
    host.removeAttribute("data-screen");
    guard();
    loop();
  };

  return {
    bind(b: RendererBridge) {
      if (b === bridge) return;
      if (bridge) unbind(bridge);
      bridge = b;
      reset();
      offs = [
        b.onView(render),
        b.onUi((s) => {
          state = s;
          renderUi();
        }),
        b.onTile((_m, c) => paintTile(c)),
        b.onSay((m) => {
          if (!m.caption) return;
          said = m.caption;
          // Announced whether or not the bar shows it (G6).
          live.textContent = "";
          live.append(el("p", "", {}, document.createTextNode(m.caption)));
          renderCaption();
        }),
      ];
      render(b.view());
    },
    unbind,
    connected(on: boolean) {
      connected = on;
      guard();
      if (on && view) theme(view);
      if (on) focusScreen();
      loop();
    },
  };
}
