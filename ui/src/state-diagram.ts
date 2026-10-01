type Json = Record<string, unknown>;

const svgNs = "http://www.w3.org/2000/svg";
const string = (value: unknown) => typeof value === "string" ? value : "";
const record = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const list = (value: unknown) => Array.isArray(value) ? value : [];
let diagramSequence = 0;

type Edge = { from: string; to: string; label: string; index: number };
type Node = { name: string; index: number; layer: number; row: number; x: number; y: number };
const svg = <K extends keyof SVGElementTagNameMap>(tag: K) => document.createElementNS(svgNs, tag);
function svgText(parent: SVGElement, x: number, y: number, value: string, className = "") {
  const node = svg("text"); node.setAttribute("x", String(x)); node.setAttribute("y", String(y));
  if (className) node.setAttribute("class", className); node.textContent = value; parent.append(node); return node;
}

/** A bounded, read-only view of a definition. It does not attach click handlers or advance state. */
export function stateDiagram(definitionValue: unknown, currentState: string): HTMLElement | undefined {
  const diagramId = ++diagramSequence;
  const definition = record(definitionValue);
  const names = list(definition.states).map(string).filter(Boolean).slice(0, 64);
  if (!names.length) return undefined;
  const known = new Set(names);
  const edges = list(definition.transitions).map(record).map((transition, index) => ({
    from: string(transition.from), to: string(transition.to), label: string(transition.label) || "transition", index,
  })).filter((edge) => known.has(edge.from) && known.has(edge.to)).slice(0, 256);
  const initial = string(definition.initial);
  const outgoing = new Map(names.map((name) => [name, [] as Edge[]]));
  for (const edge of edges) outgoing.get(edge.from)?.push(edge);

  // BFS establishes forward columns while definition order makes ties reproducible.
  const layer = new Map<string, number>();
  for (const root of [...(initial && known.has(initial) ? [initial] : []), ...names]) {
    if (layer.has(root)) continue;
    layer.set(root, 0); const pending = [root];
    for (let cursor = 0; cursor < pending.length; cursor += 1) {
      const name = pending[cursor]; const rank = layer.get(name)!;
      for (const edge of outgoing.get(name) || []) if (!layer.has(edge.to)) { layer.set(edge.to, rank + 1); pending.push(edge.to); }
    }
  }
  const grouped = new Map<number, Node[]>();
  const nodes = names.map((name, index) => ({ name, index, layer: layer.get(name) || 0, row: 0, x: 0, y: 0 }));
  for (const node of nodes) { const group = grouped.get(node.layer) || []; group.push(node); grouped.set(node.layer, group); }
  const nodeWidth = 170; const nodeHeight = 58; const xGap = 116; const yGap = 34; const margin = 72;
  for (const group of grouped.values()) group.forEach((node, row) => { node.row = row; node.x = margin + node.layer * (nodeWidth + xGap); node.y = margin + row * (nodeHeight + yGap); });
  const byName = new Map(nodes.map((node) => [node.name, node]));
  const width = Math.max(430, margin + 112 + (Math.max(...nodes.map((node) => node.layer)) + 1) * nodeWidth + Math.max(...nodes.map((node) => node.layer)) * xGap);
  const height = Math.max(180, margin * 2 + Math.max(...nodes.map((node) => node.row)) * (nodeHeight + yGap) + nodeHeight + 54);
  const section = document.createElement("section"); section.className = "state-diagram";
  const heading = document.createElement("h3"); heading.textContent = "State map"; section.append(heading);
  const note = document.createElement("p"); note.className = "muted state-diagram-note"; note.textContent = "Read-only definition overview. Current state is highlighted."; section.append(note);
  const scroller = document.createElement("div"); scroller.className = "state-diagram-scroll"; scroller.tabIndex = 0; scroller.setAttribute("role", "region"); scroller.setAttribute("aria-label", "State map. Use arrow keys or trackpad to scroll the diagram."); scroller.dataset.stateDiagram = "true";
  const titleId = `state-map-title-${diagramId}`; const descriptionId = `state-map-description-${diagramId}`; const arrowId = `state-map-arrow-${diagramId}`;
  const graph = svg("svg"); graph.setAttribute("class", "state-diagram-graph"); graph.setAttribute("viewBox", `0 0 ${width} ${height}`); graph.setAttribute("width", String(width)); graph.setAttribute("height", String(height)); graph.setAttribute("role", "img"); graph.setAttribute("aria-labelledby", `${titleId} ${descriptionId}`);
  const title = svg("title"); title.id = titleId; title.textContent = "State definition map"; graph.append(title);
  const desc = svg("desc"); desc.id = descriptionId; desc.textContent = `States: ${names.join(", ")}. Transitions: ${edges.map((edge) => `${edge.from} to ${edge.to}, ${edge.label}`).join("; ") || "none"}.`; graph.append(desc);
  const defs = svg("defs"); const marker = svg("marker"); marker.id = arrowId; marker.setAttribute("viewBox", "0 0 8 8"); marker.setAttribute("refX", "7"); marker.setAttribute("refY", "4"); marker.setAttribute("markerWidth", "7"); marker.setAttribute("markerHeight", "7"); marker.setAttribute("orient", "auto-start-reverse"); const arrow = svg("path"); arrow.setAttribute("d", "M 0 0 L 8 4 L 0 8 z"); arrow.setAttribute("class", "state-diagram-arrow"); marker.append(arrow); defs.append(marker); graph.append(defs);
  const edgeLayer = svg("g"); edgeLayer.setAttribute("class", "state-diagram-edges"); graph.append(edgeLayer);
  for (const edge of edges) {
    const from = byName.get(edge.from)!; const to = byName.get(edge.to)!; const path = svg("path"); path.setAttribute("class", "state-diagram-edge"); path.setAttribute("marker-end", `url(#${arrowId})`);
    let labelX: number; let labelY: number;
    if (from === to) { const right = from.x + nodeWidth; path.setAttribute("d", `M ${right} ${from.y + 12} C ${right + 54} ${from.y - 38}, ${right + 54} ${from.y + nodeHeight + 38}, ${right} ${from.y + nodeHeight - 12}`); labelX = right + 24; labelY = from.y - 9; }
    else if (to.layer <= from.layer) { const lane = 20 + (edge.index % 4) * 13; const startX = from.x + nodeWidth / 2; const endX = to.x + nodeWidth / 2; path.setAttribute("d", `M ${startX} ${from.y} C ${startX} ${lane}, ${endX} ${lane}, ${endX} ${to.y}`); labelX = (startX + endX) / 2; labelY = lane - 4; }
    else { const startX = from.x + nodeWidth; const startY = from.y + nodeHeight / 2; const endX = to.x; const endY = to.y + nodeHeight / 2; const bend = Math.max(46, Math.abs(endX - startX) / 2); const offset = ((edge.index % 3) - 1) * 12; path.setAttribute("d", `M ${startX} ${startY} C ${startX + bend} ${startY + offset}, ${endX - bend} ${endY + offset}, ${endX} ${endY}`); labelX = (startX + endX) / 2; labelY = (startY + endY) / 2 - 8 + offset; }
    edgeLayer.append(path); const labelBox = svg("svg"); labelBox.setAttribute("x", String(labelX - 55)); labelBox.setAttribute("y", String(labelY - 13)); labelBox.setAttribute("width", "110"); labelBox.setAttribute("height", "17"); labelBox.setAttribute("overflow", "hidden"); const visibleLabel = edge.label.length > 18 ? `${edge.label.slice(0, 17)}…` : edge.label; const label = svgText(labelBox, 55, 13, visibleLabel, "state-diagram-edge-label"); label.setAttribute("text-anchor", "middle"); const labelTitle = svg("title"); labelTitle.textContent = `${edge.from} → ${edge.to}: ${edge.label}`; label.append(labelTitle); edgeLayer.append(labelBox);
  }
  const nodeLayer = svg("g"); nodeLayer.setAttribute("class", "state-diagram-nodes"); graph.append(nodeLayer);
  for (const node of nodes) {
    const group = svg("g"); group.setAttribute("class", `state-diagram-node${node.name === currentState ? " is-current" : ""}`); group.setAttribute("transform", `translate(${node.x} ${node.y})`); const nodeTitle = svg("title"); nodeTitle.textContent = `${node.name}${node.name === currentState ? " (current)" : ""}${node.name === initial ? " (initial)" : ""}${(outgoing.get(node.name)?.length || 0) === 0 ? " (terminal)" : ""}`; group.append(nodeTitle);
    const box = svg("rect"); box.setAttribute("width", String(nodeWidth)); box.setAttribute("height", String(nodeHeight)); box.setAttribute("rx", "8"); group.append(box);
    const labelBox = svg("svg"); labelBox.setAttribute("x", "12"); labelBox.setAttribute("y", "13"); labelBox.setAttribute("width", "144"); labelBox.setAttribute("height", "19"); labelBox.setAttribute("overflow", "hidden"); labelBox.setAttribute("aria-hidden", "true"); const visible = node.name.length > 18 ? `${node.name.slice(0, 17)}…` : node.name; const text = svgText(labelBox, 0, 14, visible, "state-diagram-node-label"); const full = svg("title"); full.textContent = node.name; text.append(full); group.append(labelBox);
    const badges = [node.name === initial ? "initial" : "", (outgoing.get(node.name)?.length || 0) === 0 ? "terminal" : "", node.name === currentState ? "current" : ""].filter(Boolean); if (badges.length) svgText(group, 12, 46, badges.join(" · "), "state-diagram-node-badge"); nodeLayer.append(group);
  }
  scroller.append(graph); section.append(scroller); return section;
}
