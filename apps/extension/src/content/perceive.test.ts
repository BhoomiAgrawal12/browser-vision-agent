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

  it("keeps offscreen fields and stable IDs when earlier content appears", () => {
    const { document } = dom;
    document.body.innerHTML = '<input aria-label="Name" required><input aria-label="City" aria-required="true">';
    const name = document.querySelector('input')!;
    const city = document.querySelectorAll('input')[1]!;
    setRect(city, { x: 10, y: 1800, width: 100, height: 30 });
    const before = perceive(document as unknown as Document);
    name.before(document.createElement('button'));
    const after = perceive(document as unknown as Document);
    expect(after.regions.find((r) => r.label === "City")).toMatchObject({ id: before.regions.find((r) => r.label === "City")!.id, state: { required: true, partially_visible: true } });
  });

  it("uses the real Microsoft question title and treats its calendar combo as text", () => {
    const { document } = dom;
    document.body.innerHTML = `<div data-automation-id="questionItem"><div id="q"><span data-automation-id="questionTitle"><span data-automation-id="questionOrdinal">1.</span><span class="text-format-content">Date</span><span data-automation-id="requiredStar"></span><span aria-hidden="true">Date.</span></span></div><div data-automation-id="dateContainer"><input role="combobox" aria-haspopup="dialog" aria-expanded="false" aria-labelledby="q" placeholder="Please input date (M/d/yyyy)"></div><div role="alert" style="display:none">Old error</div></div>`;
    const regions = perceive(document as unknown as Document).regions;
    const date = regions.find((r) => r.control)!;
    expect(date).toMatchObject({ role: "textbox", label: "Date", state: { required: true, invalid: false }, control: { kind: "text", help: "Please input date (M/d/yyyy)" } });
    expect(date.validationMessage).toBeUndefined();
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

  it("perceives Microsoft Forms question titles and ARIA text controls", () => {
    const { document } = dom;
    document.body.innerHTML = `
      <div data-automation-id="questionItem">
        <span data-automation-id="questionTitle">Work email</span>
        <div role="textbox" contenteditable="true" aria-required="true"></div>
      </div>
      <div data-automation-id="questionItem">
        <span data-automation-id="questionTitle">Preferred contact method</span>
        <div role="radio" aria-label="Email" aria-checked="true" aria-required="true"></div>
      </div>
    `;
    const textbox = document.querySelector('[role="textbox"]')!;
    const radio = document.querySelector('[role="radio"]')!;
    setRect(textbox);
    setRect(radio, { x: 0, y: 40, width: 20, height: 20 });

    const snapshot = perceive(document as unknown as Document);
    const email = snapshot.regions.find((region) => region.role === "textbox");
    const choice = snapshot.regions.find((region) => region.role === "radio");

    expect(email).toMatchObject({
      label: "Work email",
      structuralClass: "EMAIL",
      state: { required: true, filled: false },
    });
    expect(choice).toMatchObject({
      label: "Email",
      state: { required: true, checked: true },
    });
    expect(snapshot.meta.pageKind).toBe("form");
  });

  it("captures Google Forms linked validation advice", () => {
    const { document } = dom;
    document.body.innerHTML = `
      <div class="freebirdFormviewerComponentsQuestionBaseRoot" role="listitem">
        <label for="date-answer">Date of birth</label>
        <input id="date-answer" aria-invalid="true" aria-describedby="date-error" value="31/31/2025">
        <div id="date-error" role="alert">Enter a real date in MM/DD/YYYY format.</div>
      </div>
    `;
    const input = document.querySelector("#date-answer")!;
    setRect(input);

    const field = perceive(document as unknown as Document).regions.find((region) => region.label === "Date of birth");

    expect(field).toMatchObject({
      state: { invalid: true, filled: true },
      validationMessage: "Enter a real date in MM/DD/YYYY format.",
    });
  });

  it("captures Microsoft Forms inline ARIA validation advice", () => {
    const { document } = dom;
    document.body.innerHTML = `
      <div data-automation-id="questionItem">
        <span data-automation-id="questionTitle">Start date</span>
        <div role="textbox" contenteditable="true" aria-invalid="true">31/31/2025</div>
        <div role="alert">Enter the date using the format shown in the question.</div>
      </div>
    `;
    const textbox = document.querySelector('[role="textbox"]')!;
    setRect(textbox);

    const field = perceive(document as unknown as Document).regions.find((region) => region.label === "Start date");

    expect(field).toMatchObject({
      state: { invalid: true, filled: true },
      validationMessage: "Enter the date using the format shown in the question.",
    });
  });

  it("discovers a required Profile Photo upload button paired with a hidden native file input", () => {
    const { document } = dom;
    document.body.innerHTML = `
      <section role="listitem">
        <div role="heading">Profile Photo *</div>
        <p>Upload 1 supported file. Max 10 MB.</p>
        <button id="upload" type="button">Add file</button>
        <input id="photo" type="file" accept="image/png" required style="display:none">
      </section>
    `;
    const upload = document.querySelector("#upload")!;
    setRect(upload, { x: 12, y: 40, width: 104, height: 32 });

    const snapshot = perceive(document as unknown as Document);
    const field = snapshot.regions.find((region) => region.control?.inputType === "file");

    expect(field).toMatchObject({
      role: "button",
      label: "Profile Photo",
      state: { required: true, filled: false },
      control: { inputType: "file", fileInputAvailable: true, help: "Upload 1 supported file. Max 10 MB" },
      evidence: expect.arrayContaining(["structural:input_type=file"]),
    });
    expect(snapshot.elements.get(field!.id)).toBe(upload);
    expect(snapshot.regions.some((region) => region.id !== field!.id && region.label === "Profile Photo")).toBe(false);
  });

  it("keeps an uploaded-file question after the picker input and trigger disappear", () => {
    const { document } = dom;
    document.body.innerHTML = `<form><section role="listitem"><div role="heading">Profile Photo *</div><div role="listitem"><span data-file-name="sanitized-image.png">sanitized-image.png</span><button aria-label="Remove file">Remove</button></div></section></form>`;
    for (const element of document.querySelectorAll("section, span, button")) setRect(element);
    const snapshot = perceive(document as unknown as Document);
    const fields = snapshot.regions.filter((region) => region.control?.inputType === "file");
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ label: "Profile Photo", rawValue: "file selected", state: { filled: true, required: true }, control: { fileInputAvailable: false } });
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
