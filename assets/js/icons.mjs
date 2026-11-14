const PATHS = {
  check: "M5 12.5l4.2 4.2L19 7.5",
  clock: "M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  ban: "M6 6l12 12M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  lock: "M8 11V8a4 4 0 0 1 8 0v3M7 11h10v8H7z",
  play: "M9 7l8 5-8 5z",
  pause: "M8 7h3v10H8zM13 7h3v10h-3z",
  menu: "M5 7h14M5 12h14M5 17h14",
  close: "M7 7l10 10M17 7L7 17",
  copy: "M9 9h9v11H9zM6 15V5h9",
  out: "M14 6h4v4M18 6l-7 7M10 6H7v12h12v-3",
  wallet: "M4 8h16v10H4zM4 8l2-3h12l2 3M16 13h2",
  key: "M8 14a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm4-4h8M18 10v3",
  gate: "M6 20V6h8a4 4 0 0 1 0 8H6",
  refresh: "M20 12a8 8 0 1 1-2.3-5.7M20 5v5h-5",
  agent: "M12 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 19c1.2-2.2 3.2-3.2 6-3.2S16.8 16.8 18 19",
  vault: "M5 5h14v14H5zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  stamp: "M8 14l-2 5h12l-2-5M8 14V8a4 4 0 0 1 8 0v6",
  dot: "M12 12.5a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4z",
};

export function sprite() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "sprite");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("aria-hidden", "true");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  for (const [name, d] of Object.entries(PATHS)) {
    const symbol = document.createElementNS("http://www.w3.org/2000/svg", "symbol");
    symbol.setAttribute("id", `i-${name}`);
    symbol.setAttribute("viewBox", "0 0 24 24");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    symbol.append(path);
    defs.append(symbol);
  }
  svg.append(defs);
  return svg;
}
