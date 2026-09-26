// The styles of <zakadi-call> (spec/06-web-sdk.md 6.4.1, 6.4.2, 6.2.10). The theme
// custom properties feed private ones: a page sets `--lv-*` on the element, `ui.theme`
// sets them on the call, and `--lv-color-primary` falls back to `sessionUi.brand.primary`
// (`--zk-brand`). Tile, surround and flood colours are never tokens: the element writes
// them through the CSSOM. The geometry is 5.8's, in % of the portrait frame: a self-view
// 75 % of the height and a host tile 22 % of the width by 26 % of the height, whose lower
// 14 % holds the character. The frame is at most 3:4, so a landscape area pillarboxes it
// and the self-view stays close to the 3:4 encoded frame.

export const CSS = `
:host{display:none}
:host([data-screen]){display:block;position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483000}
[hidden]{display:none!important}
.zk{--zk-primary:var(--lv-color-primary,var(--zk-brand,#0b57d0));--zk-on-primary:var(--lv-color-on-primary,#fff);--zk-text:var(--lv-color-text,#141414);--zk-caption-bg:var(--lv-caption-bg,#fff);--zk-radius:var(--lv-radius,12px);position:absolute;top:0;right:0;bottom:0;left:0;overflow:hidden;background-color:rgb(243,243,243);color:var(--zk-text);font-family:var(--lv-font-family,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif);font-size:16px;line-height:1.4;outline:none}
.zk *{box-sizing:border-box}
.frame{position:absolute;top:0;right:0;bottom:0;left:0;max-width:calc(100vh * 3 / 4);max-width:calc(100dvh * 3 / 4);margin:0 auto}
.badge{position:absolute;top:0;left:3%;right:3%;height:7%;min-height:28px;margin:0;display:flex;align-items:center;justify-content:center;text-align:center;font-size:14px;font-weight:600;line-height:1.2}
.page{position:absolute;top:7%;left:0;right:0;bottom:0;max-width:40em;margin:0 auto;padding:12px 6% 24px;overflow-y:auto}
h2{margin:8px 0 12px;font-size:22px;line-height:1.3;outline:none}
.page p{margin:8px 0}
.logo{display:block;max-width:50%;max-height:40px;margin-bottom:8px}
.notice,.lang{display:flex;flex-wrap:wrap;align-items:center}
.notice p{flex:1 1 12em;margin-right:12px}
.lang select{margin-left:12px}
details{margin:12px 0}
summary{padding:12px 0;cursor:pointer}
.check{display:flex;align-items:center;min-height:48px}
.check input{flex:none;width:24px;height:24px;margin:0 12px 0 0}
.actions{display:flex;flex-wrap:wrap;justify-content:flex-end;margin:16px -4px 0}
.actions button{margin:4px}
button,select,summary{min-width:48px;min-height:48px;border-radius:var(--zk-radius);color:inherit;font:inherit}
button,select{padding:8px 20px;border:2px solid var(--zk-primary);background-color:var(--zk-caption-bg);cursor:pointer}
button.primary{background-color:var(--zk-primary);color:var(--zk-on-primary)}
:focus-visible{outline:3px solid var(--zk-primary);outline-offset:2px}
.stage{position:absolute;top:0;right:0;bottom:0;left:0;outline:none}
.self{position:absolute;top:7%;left:3%;width:72%;height:75%;overflow:hidden;border-radius:var(--zk-radius);background-color:#000}
.self video,.self svg{position:absolute;top:0;left:0;width:100%;height:100%}
.self video{object-fit:cover;transform:scaleX(-1)}
.dim{fill:#000;opacity:0}
.oval{fill:none;stroke:#fff;stroke-width:4}
.oval.hl{stroke-width:9}
.shaft,.heads{fill:none;stroke:#fff;stroke-width:8;stroke-linecap:round;stroke-linejoin:round}
.shaft{transition:stroke-dashoffset .2s linear}
.ring{position:absolute;top:calc(7% - 6px);left:calc(3% - 6px);width:calc(72% + 12px);height:calc(75% + 12px);border:3px solid var(--zk-primary);border-radius:calc(var(--zk-radius) + 6px);pointer-events:none}
.stage[data-phase=listening] .ring{animation:zk-sweep 2.4s ease-in-out infinite}
@keyframes zk-sweep{50%{transform:scale(1.015);border-width:6px}}
.digits{position:absolute;top:62%;left:3%;width:72%;display:flex;flex-wrap:wrap;justify-content:center;pointer-events:none}
.digit{width:20.9%;margin:0 1% 4px;padding:4px 0;border-radius:8px;background-color:#141414;color:#fff;font-size:36px;font-weight:700;line-height:1.2;text-align:center;font-variant-numeric:tabular-nums}
.tile{position:absolute;top:7%;left:75%;width:22%;height:26%;overflow:hidden;border-radius:var(--zk-radius);transition:none}
.character{position:absolute;right:0;bottom:0;left:0;height:53.85%;overflow:hidden}
.lower{position:absolute;top:83%;right:3%;bottom:0;left:3%;display:flex;flex-direction:column;align-items:center}
.caption{max-width:100%;margin:0 0 4px;padding:6px 12px;border-radius:var(--zk-radius);background-color:var(--zk-cap-bg,var(--zk-caption-bg));color:var(--zk-cap-fg,var(--zk-text));text-align:center}
.controls{display:flex;flex-wrap:wrap;justify-content:center}
.controls button{margin:0 4px 4px}
.dots{display:flex}
.dot{width:8px;height:8px;margin:0 3px;border-radius:50%;background-color:#8a8a8a}
.dot.on{background-color:var(--zk-primary)}
.sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.zk[data-still] *{animation:none!important;transition:none!important}
`;

let sheet: CSSStyleSheet | undefined;

/**
 * Styles a shadow root with one constructable stylesheet shared by every element
 * (Chrome 73, Safari 16.4, Firefox 101), or a `<style>` element on older engines.
 */
export function adopt(root: ShadowRoot): void {
  if ("adoptedStyleSheets" in root && typeof CSSStyleSheet === "function")
    try {
      if (!sheet) {
        const s = new CSSStyleSheet();
        s.replaceSync(CSS);
        sheet = s;
      }
      root.adoptedStyleSheets = [sheet];
      return;
    } catch {
      // No constructor on this engine: the fallback below.
    }
  const style = document.createElement("style");
  style.textContent = CSS;
  root.prepend(style);
}
