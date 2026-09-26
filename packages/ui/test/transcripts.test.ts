import { loadVectors } from "@zakadi/protocol/vectors";
import type { UiState } from "@zakadi/web-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { grey } from "../src/color";
import { ARROWS } from "../src/guide";
import { bound, viewOf, visible } from "./fakes";

// spec/01-protocol.md 1.5: the client MUST render any `ui` state from scratch, the
// message being idempotent, not a delta; spec/05-sdk-contract.md 5.16 asks for every
// `ui` state of the transcript set. Each distinct state of the `sessions/*.jsonl` of
// @zakadi/protocol@0.1.0 renders in a fresh element exactly as it does after all the
// others, and shows what it says.
afterEach(() => {
  vi.useRealTimers();
  document.body.textContent = "";
});

const states: UiState[] = [];
const seen = new Set<string>();
for (const tr of loadVectors().sessions)
  for (const l of tr.lines)
    if ("msg" in l && l.msg.t === "ui") {
      const key = JSON.stringify(l.msg.state);
      if (!seen.has(key)) states.push(l.msg.state);
      seen.add(key);
    }

/**
 * What the call shows: each element's attributes, own text and inline style, in tree
 * order. Transitions are left out: they are how a change is made, not what is shown.
 */
function snapshot(host: HTMLElement): string[] {
  const out: string[] = [];
  const walk = (n: Element, depth: number) => {
    const style = (n as HTMLElement).style;
    const props = [...Array(style?.length ?? 0).keys()]
      .map((i) => style.item(i))
      .filter((p) => p !== "transition")
      .map((p) => `${p}:${style.getPropertyValue(p)}`)
      .sort();
    const attrs = [...n.attributes]
      .filter((a) => a.name !== "style")
      .map((a) => `${a.name}=${a.value}`)
      .sort();
    const own = [...n.childNodes]
      .filter((c) => c.nodeType === 3)
      .map((c) => c.textContent)
      .join("");
    out.push(`${depth} ${n.localName} [${attrs}] {${props}} ${own}`);
    for (const c of n.children) walk(c, depth + 1);
  };
  walk(host.shadowRoot!.querySelector(".zk")!, 0);
  return out;
}

/** An element that has shown only `s`, once any governed change has landed. */
function fresh(s: UiState) {
  const call = bound(viewOf("call"));
  call.fake.ui(s);
  vi.advanceTimersByTime(1000);
  return call;
}

describe("the ui states of the transcripts (1.5, 5.16)", () => {
  it("are the twelve distinct states of the seven transcripts", () => {
    expect(loadVectors().sessions).toHaveLength(7);
    expect(states).toHaveLength(12);
  });

  it.each(states.map((s, i) => [i, s.phase, s] as const))(
    "state %i (%s) renders from scratch as it does after every other",
    (_i, _phase, s) => {
      vi.useFakeTimers();
      const { el } = fresh(s);
      const walked = bound(viewOf("call"));
      for (const other of states) {
        walked.fake.ui(other);
        vi.advanceTimersByTime(400);
      }
      walked.fake.ui(s);
      vi.advanceTimersByTime(1000);
      expect(snapshot(walked.el)).toEqual(snapshot(el));
    },
  );

  it.each(states.map((s, i) => [i, s.phase, s] as const))(
    "state %i (%s) shows what it says",
    (_i, _phase, s) => {
      vi.useFakeTimers();
      const { $, $$ } = fresh(s);
      expect($(".stage").getAttribute("data-phase")).toBe(s.phase);
      expect(visible($(".oval"))).toBe(s.self_view?.oval !== false);
      expect($(".oval").classList.contains("hl")).toBe(
        s.self_view?.oval_emphasis === "highlight",
      );
      expect($(".dim").style.opacity).toBe(
        s.self_view?.fill === "dim" ? "0.4" : "0",
      );
      const arrows = s.arc?.visible ? ARROWS[s.arc.direction!] : [];
      expect($$(".shaft").filter(visible)).toHaveLength(arrows.length);
      expect($(".caption").textContent).toBe(s.caption?.text ?? "");
      expect($(".caption").getAttribute("data-pictogram")).toBe(
        s.caption?.pictogram ?? null,
      );
      expect(visible($(".digits"))).toBe(!!s.digits?.visible);
      if (s.digits?.visible)
        expect($$(".digit").map((d) => Number(d.textContent))).toEqual(
          s.digits.values,
        );
      expect($(".zk").style.backgroundColor).toBe(
        s.surround?.flood
          ? "rgb(255, 255, 255)"
          : grey(s.surround!.brightness!),
      );
      expect(
        $$(".controls button")
          .filter(visible)
          .map((b) => b.textContent),
      ).toEqual(
        (
          [
            ["repeat", "Repeat"],
            ["more_time", "More time"],
            ["cancel", "Cancel"],
          ] as const
        )
          .filter(([k]) => s.controls?.[k])
          .map(([, label]) => label),
      );
      expect($$(".dot")).toHaveLength(s.progress?.of ?? 0);
      expect($$(".dot.on")).toHaveLength(s.progress?.step ?? 0);
      expect(visible($(".badge"))).toBe(true);
    },
  );
});
