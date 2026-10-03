import "./style.css";
import { buildIdentityText } from "./build-identity";
import { codeBlock } from "./code-block";

// The About window: the desktop shell opens this page from the embedded server and gives
// it no Tauri commands. Links leave the window through the shell's navigation filter, and
// so does Escape, by navigating to the shell's close address.
const version = document.querySelector<HTMLElement>("#about-version")!;
const buildBlock = document.querySelector<HTMLElement>("#about-build-block")!;
const copyStatus = document.querySelector<HTMLElement>("#about-copy-status")!;

function showIdentity(identity: Record<string, unknown>) {
  buildBlock.replaceChildren(codeBlock(buildIdentityText(identity), (message) => { copyStatus.textContent = message; }));
}

async function loadIdentity() {
  try {
    const response = await fetch("/api/build", { credentials: "same-origin", cache: "no-cache" });
    const identity = response.ok ? await response.json().catch(() => undefined) : undefined;
    if (!identity || typeof identity !== "object") return showIdentity({});
    const appVersion = (identity as Record<string, unknown>).app_version;
    if (typeof appVersion === "string" && appVersion) version.textContent = `Version ${appVersion}`;
    showIdentity(identity as Record<string, unknown>);
  } catch {
    showIdentity({});
  }
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") location.assign("/about/close");
});

void loadIdentity();
