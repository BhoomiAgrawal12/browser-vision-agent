import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { perceive, type Snapshot } from "./perceive.js";
import { installDom, setRect } from "./test-dom.js";
import type { Window } from "happy-dom";

describe("Tier 0 DOM perception", () => {
  let dom: Window;

  beforeEach(() => {
    dom = installDom();
  });

  afterEach(() => {
    dom.close();
  });

  it("walks labelled controls and open shadow roots without hiding local raw values", () => {
    const { document } = dom;
    document.body.innerHTML = `
      <form>
        <label for="email">Email address</label>
        <input id="email" autocomplete="email" value="ramesh@example.test">
        <button id="submit" type="submit">Submit application</button>
      </form>
    `;
    const email = document.querySelector("#email")!;
    const submit = document.querySelector("#submit")!;
    setRect(email);
    setRect(submit, { x: 0, y: 40, width: 180, height: 30 });

    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<input aria-label="One-time code" autocomplete="one-time-code">`;
    setRect(shadow.querySelector("input")!);
    document.body.append(host);

    const snapshot = perceive(document as unknown as Document);
    const emailRegion = snapshot.regions.find((region) => region.label === "Email address");
    const otpRegion = snapshot.regions.find((region) => region.label === "One-time code");
    const submitRegion = snapshot.regions.find((region) => region.label === "Submit application");

    expect(emailRegion).toMatchObject({ structuralClass: "EMAIL", rawValue: "ramesh@example.test" });
    expect(otpRegion).toMatchObject({ structuralClass: "OTP" });
    expect(submitRegion).toMatchObject({ role: "button", risk: "state_changing" });
    expect(snapshot.elements.size).toBe(snapshot.regions.length);
  });

  it("omits hidden content and masks every media box until vision explains it", () => {
    const { document } = dom;
    document.body.innerHTML = `
      <div aria-hidden="true"><button>Hidden action</button></div>
      <button id="disabled" disabled>Disabled action</button>
      <img id="photo" alt="Profile photo" src="https://cdn.example.test/photo.png">
      <iframe id="frame" title="Embedded content"></iframe>
      <canvas id="canvas"></canvas>
    `;
    for (const element of document.querySelectorAll("button, img, iframe, canvas")) setRect(element);

    const snapshot: Snapshot = perceive(document as unknown as Document);
    expect(snapshot.regions.some((region) => region.label === "Hidden action")).toBe(false);

    const hiddenHost = document.createElement("div");
    hiddenHost.setAttribute("aria-hidden", "true");
    const hiddenShadow = hiddenHost.attachShadow({ mode: "open" });
    hiddenShadow.innerHTML = `<button>Hidden shadow action</button>`;
    setRect(hiddenShadow.querySelector("button")!);
    document.body.append(hiddenHost);
    const withHiddenShadow: Snapshot = perceive(document as unknown as Document);
    expect(withHiddenShadow.regions.some((region) => region.label === "Hidden shadow action")).toBe(false);

    expect(snapshot.regions.find((region) => region.label === "Disabled action"))?.toMatchObject({
      state: { disabled: true },
    });

    const media = snapshot.regions.filter((region) => ["image", "iframe", "canvas"].includes(region.role));
    expect(media).toHaveLength(3);
    expect(media.every((region) => region.explained === false)).toBe(true);
  });
});
