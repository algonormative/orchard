/** The only renderer for copyable block code.  Keep its source as text, never HTML. */
export type CopyReport = (message: string, tone: "error" | "info") => void;

export function copyTextButton(source: () => string, report: CopyReport, label = "Copy") {
  const node = document.createElement("button");
  node.type = "button"; node.className = "copy-button subtle"; node.textContent = label;
  node.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(source()); report("Copied.", "info"); }
    catch { report("Copying is unavailable in this window.", "error"); }
  });
  return node;
}

export function codeBlock(content: string, report: CopyReport, label = "Copy") {
  const block = document.createElement("section"); block.className = "code-block";
  const pre = document.createElement("pre"); pre.className = "connection-value";
  const code = document.createElement("code");
  code.textContent = content;
  pre.append(code);
  block.append(pre, copyTextButton(() => code.textContent || "", report, label));
  return block;
}
