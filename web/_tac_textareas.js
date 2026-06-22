// Tag Autocomplete — Diffucore UI text area detection.
//
// Finds the prompt and negative-prompt textareas in the Diffucore UI and
// provides helpers to identify them (positive vs negative) and to sync
// textarea value changes back to Alpine's x-model binding.
//
// Adapted from the original _textAreas.js for the Diffucore UI extension
// platform (no Gradio).

// ── selectors ──────────────────────────────────────────────────────
// Diffucore uses Alpine.js x-model bindings. The main prompt textareas
// are in the Generate view; secondary ones are in the detailer / upscaler
// panels. We match by the x-model attribute value.
const TAC_CORE_SELECTORS = [
    'textarea[x-model="form.prompt"]',
    'textarea[x-model="form.neg"]',
];

// Secondary prompt textareas (detailer / upscaler) — always treated as
// positive prompts.
const TAC_EXTRA_SELECTORS = [
    'textarea[x-model="dm.prompt"]',
    'textarea[x-model="upscale.prompt"]',
    'textarea[x-model="upscaleForm.prompt"]',
];

function tacGetTextAreas() {
    let areas = [...document.querySelectorAll(TAC_CORE_SELECTORS.join(", "))];
    if (TAC_CFG && TAC_CFG.activeIn && TAC_CFG.activeIn.thirdParty !== false) {
        areas = areas.concat([...document.querySelectorAll(TAC_EXTRA_SELECTORS.join(", "))]);
    }
    return areas;
}

// ── identifier ─────────────────────────────────────────────────────
// Returns a CSS-safe string that uniquely identifies the textarea type
// (positive / negative / extra) so the results popup can be targeted.
const _tacAreaMap = new WeakMap();
let _tacAreaIndex = 0;

function getTextAreaIdentifier(textArea) {
    // Check x-model attribute to determine type
    const model = textArea.getAttribute("x-model") || "";
    if (model === "form.prompt") return ".prompt.p";
    if (model === "form.neg") return ".prompt.n";
    if (model === "dm.prompt") return ".detailer.p";
    if (model === "upscale.prompt") return ".upscale.p";
    if (model === "upscaleForm.prompt") return ".upscaleForm.p";
    // Fallback: assign a unique index
    if (!_tacAreaMap.has(textArea)) _tacAreaMap.set(textArea, _tacAreaIndex++);
    return `.extra.ta${_tacAreaMap.get(textArea)}`;
}

// ── Alpine sync ────────────────────────────────────────────────────
// After we modify a textarea's value programmatically, we must dispatch
// an `input` event so Alpine's x-model binding updates the underlying
// data property. Without this, the change would be lost on the next
// Alpine re-render.
function tacSyncTextarea(textArea) {
    textArea.dispatchEvent(new Event("input", { bubbles: true }));
}

// ── disable the built-in LoRA autocomplete ─────────────────────────
// When the extension is active and its LoRA parser is enabled, we
// monkey-patch the Alpine app's ``loraAutocomplete`` method so the
// built-in ``<lora:…>`` dropdown never opens — the extension's own
// LoRA parser handles ``<`` completion instead.  If the user later
// disables the extension's "Use LoRAs" setting, the original method is
// restored so the built-in works again.
var _tacOriginalLoraAutocomplete = null;
var _tacLoraPatched = false;

function tacPatchBuiltinLoraAC() {
    if (_tacLoraPatched) return;
    if (typeof Alpine === "undefined") return;
    try {
        const root = document.querySelector("[x-data]");
        if (!root) return;
        const data = Alpine.$data(root);
        if (!data || typeof data.loraAutocomplete !== "function") return;

        // Save the original so we can restore it if the user disables
        // the extension's LoRA completion.
        _tacOriginalLoraAutocomplete = data.loraAutocomplete.bind(data);

        // Replace with a guard: no-op when the extension handles LoRAs,
        // delegate to the original otherwise.
        data.loraAutocomplete = function (el, opts) {
            if (TAC_CFG && TAC_CFG.useLoras) {
                // Extension handles LoRA completion — keep the built-in
                // dropdown closed so the two never compete.
                this.loraAC.open = false;
                return;
            }
            return _tacOriginalLoraAutocomplete(el, opts);
        };

        _tacLoraPatched = true;
    } catch (e) { /* Alpine not ready yet — retry on next call */ }
}

// Force-close the built-in dropdown immediately (used while the patch
// is being installed or if the Alpine component isn't ready yet).
function tacSuppressBuiltinLoraAC() {
    if (typeof Alpine === "undefined") return;
    try {
        const root = document.querySelector("[x-data]");
        if (!root) return;
        const data = Alpine.$data(root);
        if (data && data.loraAC) data.loraAC.open = false;
    } catch (e) { /* Alpine not ready yet — fine */ }
}
