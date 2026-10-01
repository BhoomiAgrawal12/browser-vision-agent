const MAX_FILE_BYTES = 20 * 1024 * 1024;

export function fileFieldLimit(help?: string): number {
  const match = help?.match(/\bmax(?:imum)?(?:\s+file\s+size)?\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*(bytes?|kb|mb|gb|kib|mib|gib)\b/i);
  if (!match) return MAX_FILE_BYTES;
  const unit = match[2]!.toLowerCase();
  const base = unit.includes("i") ? 1024 : 1000;
  const exponent = unit.startsWith("g") ? 3 : unit.startsWith("m") ? 2 : unit.startsWith("k") ? 1 : 0;
  return Math.min(MAX_FILE_BYTES, Math.floor(Number(match[1]) * base ** exponent));
}

export function fileChoiceError(file: Pick<File, "name" | "type" | "size">, accept: string, maxBytes: number): string | null {
  if (file.size > maxBytes) return "The selected file exceeds this field's size limit. Choose a smaller file.";
  const types = accept.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  const name = file.name.toLowerCase();
  const mime = file.type.toLowerCase();
  if (types.length && !types.some((type) => type.startsWith(".") ? name.endsWith(type)
    : type.endsWith("/*") ? mime.startsWith(type.slice(0, -1)) : mime === type)) {
    return "The selected file type is not accepted by this field. Choose a supported file.";
  }
  return null;
}

/** One popup per upload question; invalid choices stay in that same popup. */
export interface FileChoice {
  file: File;
  pageNumber: number;
}

export function requestPageFile(options: {
  label: string;
  accept?: string | undefined;
  help?: string | undefined;
}): Promise<FileChoice | null> {
  const dialog = document.getElementById("file-upload") as HTMLDialogElement;
  const form = dialog.querySelector("form")!;
  const input = document.getElementById("file-upload-input") as HTMLInputElement;
  const page = document.getElementById("file-upload-page") as HTMLInputElement;
  const pageRow = document.getElementById("file-upload-page-row")!;
  const error = document.getElementById("file-upload-error")!;
  const maxBytes = fileFieldLimit(options.help);
  document.getElementById("file-upload-text")!.textContent = `Choose a file for ${options.label}.`;
  document.getElementById("file-upload-help")!.textContent = [options.help, options.accept ? `Accepted types: ${options.accept}` : "", `Panel limit: ${Math.round(maxBytes / 1_000_000)} MB.`].filter(Boolean).join(" ");
  input.value = "";
  input.accept = options.accept ?? "";
  page.value = "1";
  pageRow.hidden = true;
  const onChange = (): void => {
    const file = input.files?.[0];
    pageRow.hidden = !file || !(file.type === "application/pdf" || /\.pdf$/i.test(file.name));
    page.value = "1";
    error.textContent = "";
    error.hidden = true;
  };
  input.addEventListener("change", onChange);
  error.textContent = "";
  error.hidden = true;
  let choice: FileChoice | null = null;
  const onSubmit = (event: SubmitEvent): void => {
    const value = (event.submitter as HTMLButtonElement | null)?.value;
    if (value === "cancel") return;
    const file = input.files?.[0];
    const pageNumber = pageRow.hidden ? 1 : Number(page.value);
    const problem = file ? fileChoiceError(file, input.accept, maxBytes) : "Choose a file before continuing.";
    if (problem) {
      event.preventDefault();
      error.textContent = problem;
      error.hidden = false;
    } else if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 50) {
      event.preventDefault();
      error.textContent = "Choose a PDF page from 1 to 50.";
      error.hidden = false;
    } else choice = { file: file!, pageNumber };
  };
  form.addEventListener("submit", onSubmit);
  dialog.returnValue = "cancel";
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      form.removeEventListener("submit", onSubmit);
      input.removeEventListener("change", onChange);
      input.value = "";
      resolve(dialog.returnValue === "cancel" ? null : choice);
    }, { once: true });
  });
}

export async function filePayload(file: File, maxBytes: number): Promise<{ name: string; mimeType: string; data_b64: string; maxBytes: number }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32_768) binary += String.fromCharCode(...bytes.subarray(i, i + 32_768));
  return { name: file.name, mimeType: file.type, data_b64: btoa(binary), maxBytes };
}
