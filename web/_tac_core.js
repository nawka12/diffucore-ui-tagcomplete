// Tag Autocomplete — core globals, utilities, and data types.
//
// This file is loaded first (underscore prefix sorts before the rest) and
// sets up the shared globals, helper functions, result types, base parser
// class, and caret-position utility that the parser extensions and the main
// tagcomplete.js rely on.
//
// Adapted from the original a1111-sd-webui-tagcomplete __globals.js,
// _utils.js, _result.js, _baseParser.js, and _caretPosition.js for the
// Diffucore UI extension platform.

// ── core globals ───────────────────────────────────────────────────
var TAC_CFG = null;
var tagBasePath = "/ext-static/tagcomplete/tags";
var tacSelfTrigger = false;

// Tag completion data loaded from files
var allTags = [];
var translations = new Map();
var extras = [];
var wildcardFiles = [];
var yamlWildcards = {};
var loras = [];
var chants = [];

// Current results
var results = [];
var resultCount = 0;

// Relevant for parsing
var previousTags = [];
var tagword = "";
var originalTagword = "";
let hideBlocked = false;

// Tag selection for keyboard navigation
var selectedTag = null;
var oldSelectedTag = null;
var resultCountBeforeNormalTags = 0;

// LoRA keyword undo/redo history
var textBeforeKeywordInsertion = "";
var textAfterKeywordInsertion = "";
var lastEditWasKeywordInsertion = false;
var keywordInsertionUndone = false;

// ── extendability system ───────────────────────────────────────────
// Queues for other files to add functions called at certain points.
const QUEUE_AFTER_INSERT = [];
const QUEUE_AFTER_SETUP = [];
const QUEUE_FILE_LOAD = [];
const QUEUE_AFTER_CONFIG_CHANGE = [];
const QUEUE_SANITIZE = [];

// List of parsers to try
const PARSERS = [];

// ── result type ────────────────────────────────────────────────────
const ResultType = Object.freeze({
    "tag": 1,
    "extra": 2,
    "embedding": 3,
    "wildcardTag": 4,
    "wildcardFile": 5,
    "yamlWildcard": 6,
    "umiWildcard": 7,
    "hypernetwork": 8,
    "lora": 9,
    "lyco": 10,
    "chant": 11,
    "styleName": 12
});

class AutocompleteResult {
    text = "";
    type = ResultType.tag;
    category = null;
    count = Number.MAX_SAFE_INTEGER;
    usageBias = null;
    aliases = null;
    meta = null;
    hash = null;
    sortKey = null;

    constructor(text, type) {
        this.text = text;
        this.type = type;
    }
}

// ── base parser ────────────────────────────────────────────────────
class FunctionNotOverriddenError extends Error {
    constructor(message = "", ...args) {
        super(message, ...args);
        this.message = message + " is an abstract base function and must be overwritten.";
    }
}

class BaseTagParser {
    triggerCondition = null;

    constructor(triggerCondition) {
        if (new.target === BaseTagParser) {
            throw new TypeError("Cannot construct abstract BaseTagParser directly");
        }
        this.triggerCondition = triggerCondition;
    }

    parse() {
        throw new FunctionNotOverriddenError("parse()");
    }
}

// ── CSV parsing ────────────────────────────────────────────────────
// Lightweight CSV parser (no regex) — handles quoted fields with commas
// and doubled quotes inside quotes.
function parseCSV(str) {
    const arr = [];
    let quote = false;
    for (let row = 0, col = 0, c = 0; c < str.length; c++) {
        let cc = str[c], nc = str[c + 1];
        arr[row] = arr[row] || [];
        arr[row][col] = arr[row][col] || '';
        if (cc == '"' && quote && nc == '"') { arr[row][col] += cc; ++c; continue; }
        if (cc == '"') { quote = !quote; continue; }
        if (cc == ',' && !quote) { ++col; continue; }
        if (cc == '\r' && nc == '\n') { ++row; col = 0; ++c; quote = false; continue; }
        if (cc == '\n') { ++row; col = 0; quote = false; continue; }
        if (cc == '\r') { ++row; col = 0; quote = false; continue; }
        arr[row][col] += cc;
    }
    return arr;
}

// ── file loading ───────────────────────────────────────────────────
// In Diffucore, tag data files are served at /ext-static/tagcomplete/tags/
// via the extension's serve_static. API endpoints are at /api/ext/tagcomplete/.

async function readFile(filePath, json = false, cache = false) {
    if (!cache)
        filePath += `?${new Date().getTime()}`;

    let response = await fetch(filePath);
    if (response.status != 200) {
        console.error(`TAC: Error loading file "${filePath}": ` + response.status);
        return null;
    }
    if (json)
        return await response.json();
    else
        return await response.text();
}

async function loadCSV(path) {
    let text = await readFile(path);
    if (!text) return [];
    return parseCSV(text);
}

// ── API helpers ────────────────────────────────────────────────────
const TAC_API = "/api/ext/tagcomplete";

async function fetchTacAPI(path, json = true, cache = false) {
    let url = path.startsWith("http") ? path : (path ? `${TAC_API}/${path}` : TAC_API);
    if (!cache) {
        const appendChar = url.includes("?") ? "&" : "?";
        url += `${appendChar}${new Date().getTime()}`;
    }
    let response = await fetch(url);
    if (response.status != 200) {
        console.error(`TAC: API error "${url}": ` + response.status);
        return null;
    }
    if (json)
        return await response.json();
    else
        return await response.text();
}

async function postTacAPI(path, body = null) {
    let url = path.startsWith("http") ? path : (path ? `${TAC_API}/${path}` : TAC_API);
    let response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body
    });
    if (response.status != 200) {
        console.error(`TAC: API POST error "${url}": ` + response.status);
        return null;
    }
    return await response.json();
}

async function putTacAPI(path, body = null) {
    let url = path.startsWith("http") ? path : (path ? `${TAC_API}/${path}` : TAC_API);
    let response = await fetch(url, { method: "PUT", body: body });
    if (response.status != 200) {
        console.error(`TAC: API PUT error "${url}": ` + response.status);
        return null;
    }
    return await response.json();
}

// ── tag frequency API ──────────────────────────────────────────────
function increaseUseCount(tagName, type, negative = false) {
    const url = `${TAC_API}/increase-use-count?tagname=${encodeURIComponent(tagName)}&ttype=${type}&neg=${negative}`;
    fetch(url, { method: "POST" }).catch(() => {});
}

function mapUseCountArray(useCounts, posAndNeg = false) {
    return useCounts.map(uc => {
        if (posAndNeg) {
            return { name: uc[0], type: uc[1], count: uc[2], negCount: uc[3], lastUseDate: uc[4] };
        }
        return { name: uc[0], type: uc[1], count: uc[2], lastUseDate: uc[3] };
    });
}

async function getUseCounts(tagNames, types, negative = false) {
    const body = JSON.stringify({ tagNames, tagTypes: types, neg: negative });
    const response = await postTacAPI("get-use-count-list", body);
    if (response == null) return null;
    return mapUseCountArray(response["result"]);
}

async function getAllUseCounts() {
    const response = await fetchTacAPI("all-use-counts");
    if (response == null) return null;
    return mapUseCountArray(response["result"], true);
}

async function resetUseCount(tagName, type, resetPosCount, resetNegCount) {
    const url = `${TAC_API}/reset-use-count?tagname=${encodeURIComponent(tagName)}&ttype=${type}&pos=${resetPosCount}&neg=${resetNegCount}`;
    await putTacAPI(url);
}

// ── usage bias calculation ─────────────────────────────────────────
function calculateUsageBias(result, count, uses) {
    if (uses < TAC_CFG.frequencyMinCount) {
        uses = 0;
    } else if (uses != 0) {
        result.usageBias = true;
    }
    switch (TAC_CFG.frequencyFunction) {
        case "Logarithmic (weak)":
            return Math.log(1 + count) + Math.log(1 + uses);
        case "Logarithmic (strong)":
            return Math.log(1 + count) + 2 * Math.log(1 + uses);
        case "Usage first":
            return uses;
        default:
            return count;
    }
}

// ── debounce ───────────────────────────────────────────────────────
var dbTimeOut;
const debounce = (func, wait = 300) => {
    return function (...args) {
        if (dbTimeOut) clearTimeout(dbTimeOut);
        dbTimeOut = setTimeout(() => func.apply(this, args), wait);
    }
}

// ── difference ─────────────────────────────────────────────────────
function difference(a, b) {
    if (a.length == 0) return b;
    if (b.length == 0) return a;
    return [...b.reduce((acc, v) => acc.set(v, (acc.get(v) || 0) - 1),
        a.reduce((acc, v) => acc.set(v, (acc.get(v) || 0) + 1), new Map())
    )].reduce((acc, [v, count]) => acc.concat(Array(Math.abs(count)).fill(v)), []);
}

// ── flatten (for YAML wildcards) ───────────────────────────────────
function flatten(obj, roots = [], sep = ".") {
    return Object.keys(obj).reduce(
        (memo, prop) =>
            Object.assign({}, memo,
                Object.prototype.toString.call(obj[prop]) === "[object Object]"
                    ? flatten(obj[prop], roots.concat([prop]), sep)
                    : { [roots.concat([prop]).join(sep)]: obj[prop] }
            ),
        {}
    );
}

// ── escape helpers ─────────────────────────────────────────────────
function escapeRegExp(string, wildcardMatching = false) {
    if (wildcardMatching) {
        return string.replace(/[-[\]{}()+.,\\^$|#\s]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    }
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHTML(unsafeText) {
    let div = document.createElement('div');
    div.textContent = unsafeText;
    return div.innerHTML;
}

// ── n-grams ────────────────────────────────────────────────────────
function toNgrams(inputArray, size) {
    return Array.from(
        { length: inputArray.length - (size - 1) },
        (_, index) => inputArray.slice(index, index + size)
    );
}

// ── sort function ──────────────────────────────────────────────────
function getSortFunction() {
    let criterion = TAC_CFG.modelSortOrder || "Name";
    const textSort = (a, b, reverse = false) => {
        if (!a.sortKey) a.sortKey = a.type === ResultType.chant ? a.aliases : a.text;
        if (!b.sortKey) b.sortKey = b.type === ResultType.chant ? b.aliases : b.text;
        return reverse ? b.sortKey.localeCompare(a.sortKey) : a.sortKey.localeCompare(b.sortKey);
    }
    const numericSort = (a, b, reverse = false) => {
        const noKey = reverse ? "-1" : Number.MAX_SAFE_INTEGER;
        let aParsed = parseFloat(a.sortKey || noKey);
        let bParsed = parseFloat(b.sortKey || noKey);
        if (aParsed === bParsed) return textSort(a, b, false);
        return reverse ? bParsed - aParsed : aParsed - bParsed;
    }
    return (a, b) => {
        switch (criterion) {
            case "Date Modified (newest first)": return numericSort(a, b, true);
            case "Date Modified (oldest first)": return numericSort(a, b, false);
            default: return textSort(a, b);
        }
    }
}

// ── queue processing ───────────────────────────────────────────────
async function processQueue(queue, context, ...args) {
    for (let i = 0; i < queue.length; i++) {
        await queue[i].call(context, ...args);
    }
}

async function processQueueReturn(queue, context, ...args) {
    let returns = [];
    for (let i = 0; i < queue.length; i++) {
        let returnValue = await queue[i].call(context, ...args);
        if (returnValue) returns.push(returnValue);
    }
    return returns;
}

async function processParsers(textArea, prompt) {
    let matchingParsers = PARSERS.filter(parser => parser.triggerCondition());
    if (matchingParsers.length === 0) return null;
    let parseFunctions = matchingParsers.map(parser => parser.parse);
    return await processQueueReturn(parseFunctions, null, textArea, prompt);
}

// ── caret position ─────────────────────────────────────────────────
// From https://github.com/component/textarea-caret-position
// Creates a mirror div to measure the caret's pixel coordinates.
var _tacCaretProps = [
    'direction', 'boxSizing', 'width', 'height', 'overflowX', 'overflowY',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'borderStyle', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize',
    'fontSizeAdjust', 'lineHeight', 'fontFamily', 'textAlign', 'textTransform',
    'textIndent', 'textDecoration', 'letterSpacing', 'wordSpacing', 'tabSize', 'MozTabSize'
];

function getCaretCoordinates(element, position, options) {
    var isFirefox = (window.mozInnerScreenX != null);
    var debug = options && options.debug || false;
    if (debug) {
        var el = document.querySelector('#input-textarea-caret-position-mirror-div');
        if (el) el.parentNode.removeChild(el);
    }
    var div = document.createElement('div');
    div.id = 'input-textarea-caret-position-mirror-div';
    document.body.appendChild(div);
    var style = div.style;
    var computed = window.getComputedStyle ? window.getComputedStyle(element) : element.currentStyle;
    var isInput = element.nodeName === 'INPUT';
    style.whiteSpace = 'pre-wrap';
    if (!isInput) style.wordWrap = 'break-word';
    style.position = 'absolute';
    if (!debug) style.visibility = 'hidden';
    _tacCaretProps.forEach(function (prop) {
        if (isInput && prop === 'lineHeight') {
            if (computed.boxSizing === "border-box") {
                var height = parseInt(computed.height);
                var outerHeight = parseInt(computed.paddingTop) + parseInt(computed.paddingBottom) +
                    parseInt(computed.borderTopWidth) + parseInt(computed.borderBottomWidth);
                var targetHeight = outerHeight + parseInt(computed.lineHeight);
                if (height > targetHeight) style.lineHeight = height - outerHeight + "px";
                else if (height === targetHeight) style.lineHeight = computed.lineHeight;
                else style.lineHeight = 0;
            } else {
                style.lineHeight = computed.height;
            }
        } else {
            style[prop] = computed[prop];
        }
    });
    if (isFirefox) {
        if (element.scrollHeight > parseInt(computed.height)) style.overflowY = 'scroll';
    } else {
        style.overflow = 'hidden';
    }
    div.textContent = element.value.substring(0, position);
    if (isInput) div.textContent = div.textContent.replace(/\s/g, '\u00a0');
    var span = document.createElement('span');
    span.textContent = element.value.substring(position) || '.';
    div.appendChild(span);
    var coordinates = {
        top: span.offsetTop + parseInt(computed['borderTopWidth']),
        left: span.offsetLeft + parseInt(computed['borderLeftWidth']),
        height: parseInt(computed['lineHeight'])
    };
    if (debug) span.style.backgroundColor = '#aaa';
    else document.body.removeChild(div);
    return coordinates;
}
