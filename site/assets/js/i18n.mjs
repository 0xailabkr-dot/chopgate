import { lang, setLang } from "./store.mjs";

let strings = {};
let current = "en";

export async function loadI18n() {
  current = lang();
  const url = new URL(`../i18n/${current}.json`, import.meta.url);
  const response = await fetch(url);
  strings = await response.json();
  document.documentElement.lang = current === "ko" ? "ko" : "en";
  return current;
}

export function t(key, vars) {
  let text = Object.prototype.hasOwnProperty.call(strings, key) ? strings[key] : key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

export function currentLang() { return current; }

export async function toggleLang() {
  setLang(current === "ko" ? "en" : "ko");
  await loadI18n();
}
