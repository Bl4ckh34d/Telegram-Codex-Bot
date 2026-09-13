"use strict";

// Small offline detector for the languages supported by the installed voices.
// Ambiguous fragments keep the configured default; names/code are not evidence.
const DE = new Set("der die das den dem des ein eine einer einen einem eines und ist sind war wir ich du er sie es ihr nicht mit für auf zu zum zur von auch aber oder bitte danke hallo guten morgen heute jetzt wird werden wurde haben habe hast hat kann kannst können möchte möchtest soll sollen schon noch nach bei aus über diese dieser dieses deutschen deutsch stimme sprache spreche sprechen antwort nachricht funktioniert gespeichert fertig ja nein genau laden lädt läuft modell laptop bot ausgabe klingt schön grüße straße prüfen nächste nächste datei".split(" "));
const EN = new Set("the a an and is are was were we i you he she it they not with for on to from also but or please thanks hello good morning today now will have has can could would should already still after this that these those english voice language speak response message works saved done yes no exactly loading running model output sounds next file".split(" "));

function detectTtsLanguage(text, fallback = "en") {
  const clean = String(text || "").replace(/```[\s\S]*?```|https?:\/\/\S+/g, " ");
  const words = clean.toLowerCase().match(/\p{L}+/gu) || [];
  let de = 0, en = 0;
  for (const word of words) {
    if (DE.has(word)) de++;
    if (EN.has(word)) en++;
    if (/[äöüß]/u.test(word)) de += 2;
  }
  const han = (clean.match(/\p{Script=Han}/gu) || []).length;
  if (han >= 2 && han > de + en) return "zh";
  if (de > en && de > 0) return "de";
  if (en > de && en > 0) return "en";
  return fallback;
}

function resolveTtsModel(text, { baseModel, germanModel = "", defaultLanguage = "en" }) {
  return detectTtsLanguage(text, defaultLanguage) === "de" && germanModel ? germanModel : baseModel;
}

function createSerialTtsRequests() {
  let tail = Promise.resolve();
  return (work) => {
    const result = tail.then(work);
    tail = result.catch(() => {});
    return result;
  };
}

module.exports = { detectTtsLanguage, resolveTtsModel, createSerialTtsRequests };
