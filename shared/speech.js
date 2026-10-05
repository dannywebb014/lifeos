// ─── Speaking tasks ──────────────────────────────────────────────────
//
// The browser's own speech recognition, for calendar. and tasks., so there is a
// button to press instead of reaching for the keyboard's microphone. It
// never punctuates, so each finished phrase becomes its own line, which the
// task parser treats as one task. iOS ends a session after a pause, so it is
// restarted until stop() is called.

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
export const supported = Boolean(SpeechRec);

// Whether phrase a already holds phrase b: the same words, or b's words
// followed by more. Case and punctuation don't count.
const words = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const covers = (a, b) => words(a) === words(b) || words(a).startsWith(words(b) + " ");

// Writes what is said into `box`. onChange runs when its text changes,
// onInterim with the phrase still being heard, onState when listening starts
// or stops, onError with a message to show.
export function listener(box, { onChange, onInterim, onState, onError }) {
  let recogniser = null;
  let listening = false;

  function stop() {
    listening = false;
    try { recogniser?.stop(); } catch { /* already stopped */ }
    onInterim("");
    onState(false);
  }

  function start() {
    if (!SpeechRec || listening) return;
    recogniser = new SpeechRec();
    recogniser.lang = "en-GB";
    recogniser.continuous = true;
    recogniser.interimResults = true;
    // Chrome on Android re-sends earlier phrases as new final results, either
    // repeated word for word or growing ("joint", "joint get", "joint get hand
    // soap"). So the session's text is rebuilt from all its results each
    // time, with a phrase that repeats or extends the one before replacing it.
    let before = "";
    recogniser.onstart = () => { before = box.value.trimEnd(); };
    recogniser.onresult = (event) => {
      const lines = [];
      let interim = "";
      for (const result of event.results) {
        const said = result[0].transcript.trim();
        if (!said) continue;
        if (!result.isFinal) { interim = said; continue; }
        const last = lines.at(-1) ?? before.split("\n").at(-1).trim();
        if (last && covers(last, said)) continue;
        if (lines.length && covers(said, last)) lines[lines.length - 1] = said;
        else lines.push(said);
      }
      const text = [before, ...lines].filter(Boolean).join("\n");
      if (text !== box.value.trimEnd()) {
        box.value = text;
        onChange();
      }
      onInterim(interim);
    };
    recogniser.onerror = (event) => {
      if (event.error === "aborted" || event.error === "no-speech") return;
      stop();
      onError(event.error === "not-allowed"
        ? "Microphone access is off. Turn it on for this site in Safari’s settings."
        : `Speech didn’t work (${event.error}). Use the keyboard microphone instead.`);
    };
    // A pause ends the session on iOS, so pick it straight back up.
    recogniser.onend = () => { if (listening) { try { recogniser.start(); } catch { /* already going */ } } };
    try {
      recogniser.start();
      listening = true;
      onState(true);
    } catch {
      onError("Couldn’t start the microphone");
    }
  }

  return { start, stop, get listening() { return listening; } };
}
