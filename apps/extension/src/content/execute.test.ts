import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeStep, reground } from "./execute.js";
import { perceive } from "./perceive.js";
import { installDom, setRect } from "./test-dom.js";
import type { Grounding } from "../shared/messages.js";
import type { Window } from "happy-dom";

describe("browser execution boundaries", () => {
  let dom: Window;

  beforeEach(() => {
    dom = installDom();
  });

  afterEach(() => {
    dom.close();
  });

  it("rejects role, label, geometry, and disabled-state changes", () => {
    const button = dom.document.createElement("button");
    button.textContent = "Submit application";
    dom.document.body.append(button);
    setRect(button, { x: 10, y: 20, width: 180, height: 30 });
    const grounding: Grounding = {
      id: "e1",
      role: "button",
      label: "Submit application",
      box: [10, 20, 180, 30],
      disabled: false,
    };

    const browserButton = button as unknown as Element;
    expect(reground(browserButton, grounding)).toBeNull();
    button.disabled = true;
    expect(reground(browserButton, grounding)).toContain("disabled state");
    button.disabled = false;
    button.textContent = "Delete application";
    expect(reground(browserButton, grounding)).toContain("label changed");
    button.textContent = "Submit application";
    setRect(button, { x: 100, y: 20, width: 180, height: 30 });
    expect(reground(browserButton, grounding)).toContain("moved");
  });

  it("re-grounds a label-for input with the same accessible label used at capture", () => {
    const { document } = dom;
    document.body.innerHTML = `
      <label for="pincode">PIN Code *</label>
      <input id="pincode" required>
    `;
    const input = document.querySelector("#pincode")!;
    setRect(input);

    const snapshot = perceive(document as unknown as Document);
    const region = snapshot.regions.find((candidate) => candidate.label === "PIN Code *");
    expect(region).toBeDefined();
    const grounding: Grounding = {
      id: region!.id,
      role: region!.role,
      label: region!.label,
      box: region!.box,
      ...(region!.state?.disabled !== undefined ? { disabled: region!.state.disabled } : {}),
      ...(region!.state?.readonly !== undefined ? { readonly: region!.state.readonly } : {}),
    };

    expect(reground(snapshot.elements.get(region!.id), grounding)).toBeNull();
  });

  it("does not type into disabled or readonly controls and dispatches normal input events", async () => {
    const input = dom.document.createElement("input");
    dom.document.body.append(input);
    setRect(input);
    let inputs = 0;
    input.addEventListener("input", () => {
      inputs += 1;
    });

    const browserInput = input as unknown as Element;
    expect(await executeStep(browserInput, { action: "type", text: "safe value" })).toMatchObject({ ok: true });
    expect(input.value).toBe("safe value");
    expect(inputs).toBe(1);

    input.readOnly = true;
    expect(await executeStep(browserInput, { action: "type", text: "blocked" })).toMatchObject({
      ok: false,
      error: "failed",
    });
    input.readOnly = false;
    input.disabled = true;
    expect(await executeStep(browserInput, { action: "clear" })).toMatchObject({ ok: false, error: "failed" });
  });

  it("types into Microsoft Forms contenteditable textboxes", async () => {
    const textbox = dom.document.createElement("div");
    textbox.setAttribute("role", "textbox");
    textbox.setAttribute("contenteditable", "true");
    dom.document.body.append(textbox);
    setRect(textbox);
    let inputEvents = 0;
    textbox.addEventListener("input", () => {
      inputEvents += 1;
    });

    const result = await executeStep(textbox as unknown as Element, {
      action: "type",
      text: "example response",
    });

    expect(result).toMatchObject({ ok: true });
    expect(textbox.textContent).toBe("example response");
    expect(inputEvents).toBe(1);
  });

  it("selects a visible ARIA combobox option by its accessible label", async () => {
    const combobox = dom.document.createElement("div");
    combobox.setAttribute("role", "combobox");
    combobox.setAttribute("aria-expanded", "true");
    combobox.setAttribute("aria-controls", "contact-options");
    const list = dom.document.createElement("div");
    list.id = "contact-options";
    const option = dom.document.createElement("div");
    option.setAttribute("role", "option");
    option.textContent = "Email";
    list.append(option);
    dom.document.body.append(combobox, list);
    setRect(combobox);
    setRect(option, { x: 0, y: 40, width: 80, height: 24 });
    let selected = false;
    option.addEventListener("click", () => {
      selected = true;
      option.setAttribute("aria-selected", "true");
    });

    const result = await executeStep(combobox as unknown as Element, {
      action: "select",
      optionLabel: "Email",
    });

    expect(result).toMatchObject({ ok: true });
    expect(selected).toBe(true);
  });
});
