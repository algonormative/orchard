import "./style.css";
import { buildIdentityText } from "./build-identity";

// The About window: the desktop shell opens this page from the embedded server. Links
// leave the window through the shell; this page needs no Tauri commands.
const version = document.querySelector<HTMLElement>("#about-version")!;
const buildText = document.querySelector<HTMLElement>("#about-build-text")!;
const copy = document.querySelector<HTMLButtonElement>("#about-copy")!;
const copyStatus = document.querySelector<HTMLElement>("#about-copy-status")!;

async function loadIdentity() {
  try {
    const response = await fetch("/api/build", { credentials: "same-origin", cache: "no-cache" });
    if (!response.ok) return;
    const identity = await response.json().catch(() => undefined);
    if (!identity || typeof identity !== "object") return;
    const appVersion = (identity as Record<string, unknown>).app_version;
    if (typeof appVersion === "string" && appVersion) version.textContent = `Version ${appVersion}`;
    buildText.textContent = buildIdentityText(identity as Record<string, unknown>);
  } catch {
    // The page keeps its "unavailable" text.
  }
}

copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(buildText.textContent || "");
    copyStatus.textContent = "Copied.";
  } catch {
    copyStatus.textContent = "Copying is unavailable here; select the text instead.";
  }
});

void loadIdentity();
