// Tag Autocomplete — main autocomplete logic.
//
// This is the core of the extension: it loads tag data, manages the popup
// DOM, handles keyboard navigation, inserts selected tags, and hooks into
// the Diffucore UI's prompt textareas.
//
// Adapted from the original tagAutocomplete.js for the Diffucore UI
// extension platform. Key changes:
//   - Gradio's gradioApp() / onUiUpdate / updateInput are replaced with
//     plain DOM APIs and Alpine.js integration.
//   - Settings are fetched from the extension's config API endpoint
//     instead of A1111's opts object.
//   - Tag data files are loaded from /ext-static/tagcomplete/tags/.
//   - A settings panel and tag-usage tab are registered via the
//     window.DiffucoreExt bridge.

(function () {

// ── CSS ────────────────────────────────────────────────────────────
// Uses Diffucore UI's CSS variables (--surface-3, --line-hi, --accent,
// --txt, etc.) so the popup matches the app's darkroom theme. Mirrors
// the .lora-ac dropdown pattern from style.css.
const autocompleteCSS = `
    .tac-autocomplete-parent {
        display: flex;
        position: absolute;
        z-index: 10000;
        max-width: calc(100% - 1.5rem);
        flex-wrap: wrap;
        gap: 10px;
    }
    .tac-autocomplete-results {
        background: var(--surface-3) !important;
        border: 1px solid var(--line-hi) !important;
        color: var(--txt) !important;
        border-radius: var(--r) !important;
        height: fit-content;
        flex-basis: fit-content;
        flex-shrink: 0;
        overflow-y: auto;
        overflow-x: hidden;
        word-break: break-word;
        margin-top: 4px;
        padding: 4px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.4);
        scrollbar-color: var(--surface-3) var(--surface-2);
    }
    .tac-autocomplete-results .tac-side-info {
        display: none;
        position: relative;
        height: 18rem;
        max-width: 16rem;
    }
    .tac-autocomplete-results .tac-side-info > img {
        object-fit: cover;
        height: 100%;
        width: 100%;
        border-radius: var(--r);
    }
    .tac-autocomplete-list {
        list-style: none;
        margin: 0;
        padding: 0;
    }
    .tac-autocomplete-list > li {
        padding: 6px 10px;
        border-radius: 4px;
        cursor: pointer;
        transition: all 120ms ease;
    }
    .tac-autocomplete-list > li:hover {
        background: var(--surface-2);
    }
    .tac-autocomplete-list > li.selected {
        background: var(--surface-2);
        color: var(--txt);
        box-shadow: inset 2px 0 0 var(--accent);
    }
    .tac-flex-container {
        display: flex;
        align-items: center;
    }
    .tac-list-item {
        white-space: break-spaces;
        min-width: 100px;
        font-size: 13px;
        color: var(--txt-2);
    }
    .tac-list-item b {
        color: var(--txt);
        font-weight: 600;
    }
    .tac-meta-text {
        position: relative;
        flex-grow: 1;
        text-align: end;
        padding: 0 0 0 14px;
        white-space: nowrap;
        font-family: var(--mono);
        font-size: 11px;
        color: var(--txt-3);
    }
    .tac-meta-text.biased::before {
        content: "\\2728";
        margin-right: 3px;
        font-size: 10px;
    }
    .tac-meta-text span.used::after {
        content: "\\1F501";
        margin-right: 3px;
        font-size: 10px;
    }
    .tac-wiki-link {
        padding: 2px 6px;
        margin: 0 4px 0 -4px;
        font-size: 12px;
        color: var(--txt-3);
        text-decoration: none;
        border-radius: 3px;
        transition: all 120ms ease;
    }
    .tac-wiki-link:hover {
        color: var(--accent);
        background: rgba(232,160,101,0.08);
    }
    .tac-list-item .tac-path-part:nth-child(3n+1) {
        color: var(--accent);
    }
    .tac-list-item .tac-path-part:nth-child(3n+2) {
        color: var(--teal);
    }
    .tac-list-item .tac-path-part:nth-child(3n+3) {
        color: #c4a66d;
    }
`;

// ── tag loading ────────────────────────────────────────────────────

async function loadTags(c) {
    if (allTags.length === 0 && c.tagFile && c.tagFile !== "None") {
        try {
            allTags = await loadCSV(`${tagBasePath}/${c.tagFile}`);
        } catch (e) {
            console.error("TAC: Error loading tags file: " + e);
            return;
        }
    }
    await loadExtraTags(c);
}

async function loadExtraTags(c) {
    if (c.extra_extraFile && c.extra_extraFile !== "None") {
        try {
            extras = await loadCSV(`${tagBasePath}/${c.extra_extraFile}`);
            extras.forEach(e => {
                if (e[4]) translations.set(e[0], e[4]);
            });
        } catch (e) {
            console.error("TAC: Error loading extra file: " + e);
            return;
        }
    }
}

async function loadTranslations(c) {
    if (c.translation_translationFile && c.translation_translationFile !== "None") {
        try {
            let tArray = await loadCSV(`${tagBasePath}/${c.translation_translationFile}`);
            tArray.forEach(t => {
                if (c.translation_oldFormat && t[2])
                    translations.set(t[0], t[2]);
                else if (t[1])
                    translations.set(t[0], t[1]);
                else
                    translations.set(t[0], "Not found");
            });
        } catch (e) {
            console.error("TAC: Error loading translations file: " + e);
            return;
        }
    }
}

// ── config sync ────────────────────────────────────────────────────
// Fetch settings from the extension's config API and build the TAC_CFG
// object that the rest of the code reads.

async function syncOptions() {
    const data = await fetchTacAPI("", true, false);
    if (!data || !data.settings) return;

    const s = data.settings;
    let newCFG = {
        tagFile: s.tagFile,
        activeIn: {
            txt2img: s.activeIn_txt2img,
            img2img: s.activeIn_img2img,
            negativePrompts: s.activeIn_negativePrompts,
            thirdParty: true,
        },
        slidingPopup: true,
        maxResults: s.maxResults,
        showAllResults: s.showAllResults,
        resultStepLength: s.resultStepLength,
        delayTime: s.delayTime,
        useWildcards: s.useWildcards,
        sortWildcardResults: s.sortWildcardResults,
        useLoras: s.useLoras,
        showWikiLinks: s.showWikiLinks,
        modelSortOrder: s.modelSortOrder,
        frequencySort: s.frequencySort,
        frequencyFunction: s.frequencyFunction,
        frequencyMinCount: s.frequencyMinCount,
        frequencyMaxAge: s.frequencyMaxAge,
        frequencyRecommendCap: s.frequencyRecommendCap,
        frequencyIncludeAlias: s.frequencyIncludeAlias,
        replaceUnderscores: s.replaceUnderscores,
        replaceUnderscoresExclusionList: s.replaceUnderscoresExclusionList,
        escapeParentheses: s.escapeParentheses,
        appendComma: s.appendComma,
        appendSpace: s.appendSpace,
        alwaysSpaceAtEnd: s.alwaysSpaceAtEnd,
        wildcardCompletionMode: s.wildcardCompletionMode,
        extraNetworksDefaultMultiplier: s.extraNetworksDefaultMultiplier,
        wcWrap: "__",
        alias: {
            searchByAlias: s.alias_searchByAlias,
            onlyShowAlias: s.alias_onlyShowAlias,
        },
        translation: {
            translationFile: s.translation_translationFile,
            oldFormat: s.translation_oldFormat,
            searchByTranslation: s.translation_searchByTranslation,
            liveTranslation: s.translation_liveTranslation,
        },
        extra: {
            extraFile: s.extra_extraFile,
            addMode: s.extra_addMode,
        },
        chantFile: s.chantFile,
        keymap: JSON.parse(s.keymap),
        colorMap: JSON.parse(s.colormap),
        // Store available files for the settings panel
        _csvFiles: data.csvFiles || [],
        _jsonFiles: data.jsonFiles || [],
        _dbOk: data.dbOk,
    };

    if (newCFG.alias.onlyShowAlias) {
        newCFG.alias.searchByAlias = true;
    }

    // Reload translations if the file changed
    if (!TAC_CFG || newCFG.translation.translationFile !== TAC_CFG.translation.translationFile) {
        translations.clear();
        await loadTranslations(newCFG);
        await loadExtraTags(newCFG);
    }
    // Reload tags if the tag file changed
    if (!TAC_CFG || newCFG.tagFile !== TAC_CFG.tagFile || newCFG.extra.extraFile !== TAC_CFG.extra.extraFile) {
        allTags = [];
        await loadTags(newCFG);
    }
    // Update popup max height if maxResults changed
    if (TAC_CFG && newCFG.maxResults !== TAC_CFG.maxResults) {
        document.querySelectorAll(".tac-autocomplete-results").forEach(r => {
            r.style.maxHeight = `${newCFG.maxResults * 50}px`;
        });
    }

    TAC_CFG = newCFG;
    await processQueue(QUEUE_AFTER_CONFIG_CHANGE, null);
}

// ── popup DOM ──────────────────────────────────────────────────────

function createResultsDiv(textArea) {
    let parentDiv = document.createElement("div");
    let resultsDiv = document.createElement("div");
    let resultsList = document.createElement("ul");
    let sideDiv = document.createElement("div");
    let sideDivImg = document.createElement("img");

    let textAreaId = getTextAreaIdentifier(textArea);
    let typeClass = textAreaId.replaceAll(".", " ");

    parentDiv.setAttribute("class", `tac-autocomplete-parent${typeClass}`);
    parentDiv.style.display = "none";

    resultsDiv.style.maxHeight = `${TAC_CFG.maxResults * 50}px`;
    resultsDiv.setAttribute("class", `tac-autocomplete-results${typeClass} notranslate`);
    resultsDiv.setAttribute("translate", "no");
    resultsList.setAttribute("class", "tac-autocomplete-list");
    resultsDiv.appendChild(resultsList);

    sideDiv.setAttribute("class", `tac-autocomplete-results${typeClass} tac-side-info`);
    sideDiv.appendChild(sideDivImg);

    parentDiv.appendChild(resultsDiv);
    parentDiv.appendChild(sideDiv);

    return parentDiv;
}

function isVisible(textArea) {
    let textAreaId = getTextAreaIdentifier(textArea);
    let parentDiv = document.querySelector('.tac-autocomplete-parent' + textAreaId);
    return parentDiv && parentDiv.style.display === "flex";
}

function showResults(textArea) {
    let textAreaId = getTextAreaIdentifier(textArea);
    let parentDiv = document.querySelector('.tac-autocomplete-parent' + textAreaId);
    if (!parentDiv) return;
    parentDiv.style.display = "flex";

    if (TAC_CFG.slidingPopup) {
        let caretPosition = getCaretCoordinates(textArea, textArea.selectionEnd);
        let offsetTop = textArea.offsetTop + caretPosition.top - textArea.scrollTop + 10;
        let offsetLeft = Math.min(
            textArea.offsetLeft - textArea.scrollLeft + caretPosition.left,
            textArea.offsetWidth - parentDiv.offsetWidth
        );
        parentDiv.style.top = `${offsetTop}px`;
        parentDiv.style.left = `${offsetLeft}px`;
    } else {
        if (parentDiv.style.left) parentDiv.style.removeProperty("left");
    }
    parentDiv.scrollTop = 0;

    let previewDiv = parentDiv.querySelector(`.tac-side-info`);
    if (previewDiv) previewDiv.style.display = "none";

    // Suppress the built-in LoRA autocomplete so two popups don't show at once
    tacSuppressBuiltinLoraAC();
}

function hideResults(textArea) {
    let textAreaId = getTextAreaIdentifier(textArea);
    let parentDiv = document.querySelector('.tac-autocomplete-parent' + textAreaId);
    if (!parentDiv) return;
    parentDiv.style.display = "none";
    selectedTag = null;
}

// ── enable check ───────────────────────────────────────────────────

function isEnabled() {
    return TAC_CFG.activeIn.global !== false;
}

// ── regexes ────────────────────────────────────────────────────────
const WEIGHT_REGEX = /[([]([^()[\]:|]+)(?::(?:\d+(?:\.\d+)?|\.\d+))?[)\]]/g;
const POINTY_REGEX = /<[^\s,<](?:[^\t\n\r,<>]*>|[^\t\n\r,> ]*)/g;
const COMPLETED_WILDCARD_REGEX = /__[^\s,_][^\t\n\r,_]*[^\s,_]__[^\s,_]*/g;
const NORMAL_TAG_REGEX = /[^\s,|<>\[\]:]+_\([^\s,|<>\[\]:]*\)?|[^\s,|<>():\[\]]+|</g;
const TAG_REGEX = () => new RegExp(
    `${POINTY_REGEX.source}|${COMPLETED_WILDCARD_REGEX.source.replaceAll("__", escapeRegExp(TAC_CFG.wcWrap))}|${NORMAL_TAG_REGEX.source}`, "g"
);

// ── tag insertion ──────────────────────────────────────────────────

async function insertTextAtCursor(textArea, result, tagword, tabCompletedWithoutChoice = false) {
    let text = result.text;
    let tagType = result.type;
    let cursorPos = textArea.selectionStart;
    var sanitizedText = text;

    // Run sanitize queue
    let sanitizeResults = await processQueueReturn(QUEUE_SANITIZE, null, tagType, text);
    if (sanitizeResults && sanitizeResults.length > 0) {
        sanitizedText = sanitizeResults[0];
    } else {
        const excluded = TAC_CFG.replaceUnderscoresExclusionList?.split(',').map(s => s.trim()) || [];
        if (TAC_CFG.replaceUnderscores && !excluded.includes(sanitizedText)) {
            sanitizedText = text.replaceAll("_", " ");
        }
        if (TAC_CFG.escapeParentheses && tagType === ResultType.tag) {
            sanitizedText = sanitizedText
                .replaceAll("(", "\\(").replaceAll(")", "\\)")
                .replaceAll("[", "\\[").replaceAll("]", "\\]");
        }
    }

    // Wildcard path completion modes
    if ((tagType === ResultType.wildcardFile || tagType === ResultType.yamlWildcard)
        && tabCompletedWithoutChoice
        && TAC_CFG.wildcardCompletionMode !== "Always fully"
        && sanitizedText.includes("/")) {
        if (TAC_CFG.wildcardCompletionMode === "To next folder level") {
            let regexMatch = sanitizedText.match(new RegExp(`${escapeRegExp(tagword)}([^/]*\\/?)`, "i"));
            if (regexMatch) {
                let pathPart = regexMatch[0];
                if (pathPart === `${tagword}/`) {
                    pathPart = sanitizedText.match(new RegExp(`${escapeRegExp(tagword)}\\/([^/]*\\/?)`, "i"))[0];
                }
                sanitizedText = pathPart;
            }
        } else if (TAC_CFG.wildcardCompletionMode === "To first difference") {
            let firstDifference = 0;
            let longestResult = results.map(x => x.text.length).reduce((a, b) => Math.max(a, b));
            for (let i = 0; i < longestResult; i++) {
                let char = results[0].text[i];
                if (results.every(x => x.text[i] === char)) firstDifference++;
                else break;
            }
            if (firstDifference > 0 && firstDifference < longestResult) {
                sanitizedText = sanitizedText.substring(0, firstDifference + TAC_CFG.wcWrap.length);
            } else if (firstDifference === 0) {
                sanitizedText = tagword;
            }
        }
    }

    // Frequency db update
    if (TAC_CFG.frequencySort) {
        let name = null;
        switch (tagType) {
            case ResultType.wildcardFile:
            case ResultType.yamlWildcard:
                if (sanitizedText.endsWith(TAC_CFG.wcWrap)) name = text;
                break;
            case ResultType.chant:
                name = result.aliases;
                break;
            default:
                name = text;
                break;
        }
        if (name && name.length > 0) {
            let textAreaId = getTextAreaIdentifier(textArea);
            let isNegative = textAreaId.includes("n");
            increaseUseCount(encodeURIComponent(name), tagType, isNegative);
        }
    }

    var prompt = textArea.value;
    let editStart = Math.max(cursorPos - tagword.length, 0);
    let editEnd = Math.min(cursorPos + tagword.length, prompt.length);
    let surrounding = prompt.substring(editStart, editEnd);
    let match = surrounding.match(new RegExp(escapeRegExp(`${tagword}`), "i"));
    if (!match) return;
    let afterInsertCursorPos = editStart + match.index + sanitizedText.length;

    var optionalSeparator = "";
    let noCommaTypes = [ResultType.wildcardFile, ResultType.yamlWildcard, ResultType.umiWildcard, ResultType.lora];
    if (!noCommaTypes.includes(tagType)) {
        let beforeComma = surrounding.match(new RegExp(`${escapeRegExp(tagword)}[,:]`, "i")) !== null;
        if (TAC_CFG.appendComma) optionalSeparator = beforeComma ? "" : ",";
        if (TAC_CFG.appendSpace && !beforeComma) optionalSeparator += " ";
        if (!TAC_CFG.appendSpace && TAC_CFG.alwaysSpaceAtEnd)
            optionalSeparator += surrounding.match(new RegExp(`${escapeRegExp(tagword)}$`, "im")) !== null ? " " : "";
    } else if (tagType === ResultType.lora) {
        optionalSeparator = TAC_CFG.extraNetworksSeparator || " ";
    }

    sanitizedText = sanitizedText.replaceAll("$", "$$$$");
    let insert = surrounding.replace(match, sanitizedText + optionalSeparator);
    var newPrompt = prompt.substring(0, editStart) + insert + prompt.substring(editEnd);

    // Insert into textarea and sync with Alpine
    textArea.value = newPrompt;
    textArea.selectionStart = afterInsertCursorPos + optionalSeparator.length;
    textArea.selectionEnd = textArea.selectionStart;
    tacSyncTextarea(textArea);
    tacSuppressBuiltinLoraAC();

    if ([ResultType.wildcardFile, ResultType.yamlWildcard, ResultType.wildcardTag].includes(result.type))
        tacSelfTrigger = true;

    // Update previous tags
    let weightedTags = [...prompt.matchAll(WEIGHT_REGEX)].map(m => m[1]).sort((a, b) => a.length - b.length);
    let tags = [...prompt.match(TAG_REGEX())].sort((a, b) => a.length - b.length);
    if (weightedTags && tags) {
        let workingTags = [...tags];
        for (const wt of weightedTags) {
            const idx = workingTags.findIndex(t => t === wt && !t.startsWith("<[") && !t.startsWith("$("));
            if (idx !== -1) workingTags.splice(idx, 1);
        }
        tags = workingTags.concat(weightedTags);
    }
    previousTags = tags;

    let returns = await processQueueReturn(QUEUE_AFTER_INSERT, null, tagType, sanitizedText, newPrompt, textArea);
    if (returns.some(x => x === true)) return;

    if (!hideBlocked && isVisible(textArea)) hideResults(textArea);
}

// ── results rendering ──────────────────────────────────────────────

function addResultsToList(textArea, results, tagword, resetList) {
    let textAreaId = getTextAreaIdentifier(textArea);
    let resultDiv = document.querySelector('.tac-autocomplete-results' + textAreaId);
    if (!resultDiv) return;
    let resultsList = resultDiv.querySelector('ul');

    if (resetList) {
        resultsList.innerHTML = "";
        selectedTag = null;
        oldSelectedTag = null;
        resultDiv.scrollTop = 0;
        resultCount = 0;
    }

    let tagFileName = TAC_CFG.tagFile.split(".")[0];
    let tagColors = TAC_CFG.colorMap;
    let nextLength = Math.min(results.length, resultCount + TAC_CFG.resultStepLength);
    const IS_DAN_OR_E621 = tagFileName.toLowerCase().startsWith("danbooru") || tagFileName.toLowerCase().startsWith("e621");

    const tagCount = {};
    if (IS_DAN_OR_E621) {
        const prompt = textArea.value.trim();
        const tagsInPrompt = prompt.replaceAll('\n', ',').split(',').map(t => t.trim()).filter(t => t);
        const unsanitized = tagsInPrompt.map(tag => {
            const wt = [...tag.matchAll(WEIGHT_REGEX)].flat();
            return wt.length === 2 ? wt[1] : tag;
        }).map(tag => tag.replaceAll(" ", "_").replaceAll("\\(", "(").replaceAll("\\)", ")"));
        for (const tag of unsanitized) tagCount[tag] = (tagCount[tag] || 0) + 1;
    }

    for (let i = resultCount; i < nextLength; i++) {
        let result = results[i];
        if (!result) continue;

        let li = document.createElement("li");
        let flexDiv = document.createElement("div");
        flexDiv.classList.add("tac-flex-container");
        li.appendChild(flexDiv);

        let itemText = document.createElement("div");
        itemText.classList.add("tac-list-item");

        let displayText = "";
        if (result.type === ResultType.chant) {
            displayText = escapeHTML(result.aliases);
        } else if (result.aliases && !result.text.includes(tagword)) {
            let splitAliases = result.aliases.split(",");
            let bestAlias = splitAliases.find(a => a.toLowerCase().includes(tagword));
            if (!bestAlias) {
                let tagOrAlias = pair => pair[0] === result.text || splitAliases.includes(pair[0]);
                let translationKey = [...translations].find(pair => tagOrAlias(pair) && pair[1].includes(tagword));
                if (translationKey) bestAlias = translationKey[0];
            }
            displayText = escapeHTML(bestAlias);
            if (translations.has(bestAlias) && translations.get(bestAlias) !== bestAlias && bestAlias !== result.text)
                displayText += `[${translations.get(bestAlias)}]`;
            if (!TAC_CFG.alias.onlyShowAlias && result.text !== bestAlias)
                displayText += " \u21A2 " + result.text;
        } else {
            displayText = escapeHTML(result.text);
        }
        if (translations.has(result.text))
            displayText += `[${translations.get(result.text)}]`;

        itemText.innerHTML = displayText.replace(tagword, `<b>${tagword}</b>`);

        // Wildcard path coloring
        if ([ResultType.wildcardFile, ResultType.yamlWildcard].includes(result.type) && itemText.innerHTML.includes("/")) {
            let parts = itemText.innerHTML.split("/");
            let lastPart = parts[parts.length - 1];
            parts = parts.slice(0, parts.length - 1);
            itemText.innerHTML = "<span class='tac-path-part'>" + parts.join("</span><span class='tac-path-part'>/") +
                "</span>/" + lastPart;
        }

        // Wiki link
        if (TAC_CFG.showWikiLinks && result.type === ResultType.tag && IS_DAN_OR_E621) {
            let wikiLink = document.createElement("a");
            wikiLink.classList.add("tac-wiki-link");
            wikiLink.innerText = "?";
            wikiLink.title = "Open external wiki page for this tag";
            let linkPart = displayText;
            if (displayText.includes("\u21A2")) linkPart = displayText.split(" \u21A2 ")[1];
            if (linkPart.includes("[")) linkPart = linkPart.split("[")[0];
            linkPart = encodeURIComponent(linkPart);
            let lower = tagFileName.toLowerCase();
            if (lower.startsWith("danbooru_e621_merged")) {
                wikiLink.href = result.category && result.category >= 6
                    ? `https://e621.net/wiki_pages/${linkPart}`
                    : `https://danbooru.donmai.us/wiki_pages/${linkPart}`;
            } else if (lower.startsWith("danbooru")) {
                wikiLink.href = `https://danbooru.donmai.us/wiki_pages/${linkPart}`;
            } else if (lower.startsWith("e621")) {
                wikiLink.href = `https://e621.net/wiki_pages/${linkPart}`;
            }
            wikiLink.target = "_blank";
            flexDiv.appendChild(wikiLink);
        }

        flexDiv.appendChild(itemText);

        // Tag color
        if (result.category) {
            let cat = result.category;
            let colorGroup = tagColors[tagFileName] || tagColors["danbooru"];
            if (!colorGroup[cat]) cat = "-1";
            flexDiv.style.color = colorGroup[cat][0];
        }

        // Post count
        if (result.count && !isNaN(result.count) && result.count !== Number.MAX_SAFE_INTEGER) {
            let formatter;
            if (result.count >= 1000000 || (result.count >= 1000 && result.count < 10000))
                formatter = Intl.NumberFormat("en", { notation: "compact", minimumFractionDigits: 1, maximumFractionDigits: 1 });
            else
                formatter = Intl.NumberFormat("en", { notation: "compact" });
            let countDiv = document.createElement("div");
            countDiv.textContent = formatter.format(result.count);
            countDiv.classList.add("tac-meta-text");
            flexDiv.appendChild(countDiv);
        } else if (result.meta) {
            let metaDiv = document.createElement("div");
            metaDiv.textContent = result.meta;
            metaDiv.classList.add("tac-meta-text");
            flexDiv.appendChild(metaDiv);
        }

        // Usage bias marker
        if (result.usageBias) {
            let metaNode = flexDiv.querySelector(".tac-meta-text");
            if (metaNode) {
                metaNode.classList.add("biased");
                flexDiv.title = "\u2728 Frequent tag. Ctrl/Cmd + click to reset usage count.";
            }
        }

        // Already-used marker
        if (IS_DAN_OR_E621 && tagCount[result.text]) {
            if (!(result.text === tagword && tagCount[result.text] === 1)) {
                const textNode = flexDiv.querySelector(".tac-meta-text");
                if (textNode) {
                    const span = document.createElement("span");
                    textNode.insertBefore(span, textNode.firstChild);
                    span.classList.add("used");
                    span.title = "\uD83D\uDD01 The prompt already contains this tag";
                }
            }
        }

        let isNegative = textAreaId.includes("n");
        li.addEventListener("click", (e) => {
            if (e.ctrlKey || e.metaKey) {
                resetUseCount(result.text, result.type, !isNegative, isNegative);
                let metaNode = flexDiv.querySelector(".tac-meta-text");
                if (metaNode) metaNode.classList.remove("biased");
            } else {
                insertTextAtCursor(textArea, result, tagword);
            }
        });

        resultsList.appendChild(li);
    }
    resultCount = nextLength;

    if (resetList) {
        selectedTag = null;
        oldSelectedTag = null;
        resultDiv.scrollTop = 0;
    }
}

async function updateSelectionStyle(textArea, newIndex, oldIndex, scroll = true) {
    let textAreaId = getTextAreaIdentifier(textArea);
    let resultDiv = document.querySelector('.tac-autocomplete-results' + textAreaId);
    if (!resultDiv) return;
    let resultsList = resultDiv.querySelector('ul');
    let items = resultsList.getElementsByTagName('li');

    if (oldIndex != null && items[oldIndex]) items[oldIndex].classList.remove('selected');
    if (newIndex !== null && items[newIndex]) {
        items[newIndex].classList.add('selected');
        if (scroll) resultDiv.scrollTop = items[newIndex].offsetTop - resultDiv.offsetTop;
    }
}

// ── autocomplete ───────────────────────────────────────────────────

async function autocomplete(textArea, prompt, fixedTag = null) {
    if (!isEnabled()) return;

    if (prompt.length === 0) {
        hideResults(textArea);
        previousTags = [];
        tagword = "";
        return;
    }

    if (fixedTag === null) {
        let weightedTags = [...prompt.matchAll(WEIGHT_REGEX)].map(m => m[1]).sort((a, b) => a.length - b.length);
        let tags = [...prompt.match(TAG_REGEX())].sort((a, b) => a.length - b.length);
        if (weightedTags && tags) {
            let workingTags = [...tags];
            for (const wt of weightedTags) {
                const idx = workingTags.findIndex(t => t === wt && !t.startsWith("<[") && !t.startsWith("$("));
                if (idx !== -1) workingTags.splice(idx, 1);
            }
            tags = workingTags.concat(weightedTags);
        }

        if (!tags || tags.length === 0) {
            previousTags = [];
            tagword = "";
            hideResults(textArea);
            return;
        }

        let tagCountChange = tags.length - previousTags.length;
        let diff = difference(tags, previousTags);
        previousTags = tags;

        if (diff === null || diff.length === 0 || (diff.length === 1 && tagCountChange < 0)) {
            if (!hideBlocked) hideResults(textArea);
            return;
        }

        tagword = diff[0];
        if (tagword === null || tagword.length === 0) {
            hideResults(textArea);
            return;
        }
    } else {
        tagword = fixedTag;
    }

    results = [];
    resultCountBeforeNormalTags = 0;
    tagword = tagword.toLowerCase().replace(/[\n\r]/g, "");
    let normalTags = false;

    let resultCandidates = (await processParsers(textArea, prompt))?.filter(x => x.length > 0);
    if (resultCandidates && resultCandidates.length > 0) {
        results = resultCandidates.flat();
        if (!(resultCandidates.length === 1 && results[0]?.type === ResultType.umiWildcard))
            results = results.sort(getSortFunction());
    }

    if (!resultCandidates || resultCandidates.length === 0) {
        normalTags = true;
        resultCountBeforeNormalTags = results.length;

        let searchRegex;
        if (tagword.startsWith("*")) {
            tagword = tagword.slice(1);
            searchRegex = new RegExp(`${escapeRegExp(tagword)}`, 'i');
        } else {
            searchRegex = new RegExp(`(^|[^a-zA-Z])${escapeRegExp(tagword)}`, 'i');
        }

        let baseFilter = (x) => x[0].toLowerCase().search(searchRegex) > -1;
        let aliasFilter = (x) => x[3] && x[3].toLowerCase().search(searchRegex) > -1;
        let translationFilter = (x) =>
            (translations.has(x[0]) && translations.get(x[0]).toLowerCase().search(searchRegex) > -1) ||
            (x[3] && x[3].split(",").some(y => translations.has(y) && translations.get(y).toLowerCase().search(searchRegex) > -1));

        let fil;
        if (TAC_CFG.alias.searchByAlias && TAC_CFG.translation.searchByTranslation)
            fil = (x) => baseFilter(x) || aliasFilter(x) || translationFilter(x);
        else if (TAC_CFG.alias.searchByAlias && !TAC_CFG.translation.searchByTranslation)
            fil = (x) => baseFilter(x) || aliasFilter(x);
        else if (TAC_CFG.translation.searchByTranslation && !TAC_CFG.alias.searchByAlias)
            fil = (x) => baseFilter(x) || translationFilter(x);
        else
            fil = (x) => baseFilter(x);

        allTags.filter(fil).forEach(t => {
            let result = new AutocompleteResult(t[0].trim(), ResultType.tag);
            result.category = t[1];
            result.count = t[2];
            result.aliases = t[3];
            results.push(result);
        });

        if (TAC_CFG.extra.extraFile && TAC_CFG.extra.extraFile !== "None") {
            let extraResults = [];
            extras.filter(fil).forEach(e => {
                let result = new AutocompleteResult(e[0].trim(), ResultType.extra);
                result.category = e[1] || 0;
                result.meta = e[2] || "Custom tag";
                result.aliases = e[3] || "";
                extraResults.push(result);
            });
            if (TAC_CFG.extra.addMode === "Insert before") results = extraResults.concat(results);
            else results = results.concat(extraResults);
        }
    }

    if (!results || results.length === 0) {
        hideResults(textArea);
        return;
    }

    // Frequency sorting
    if (TAC_CFG.frequencySort) {
        let tagNames = [];
        let aliasNames = [];
        let types = [];
        const aliasTypes = [ResultType.tag, ResultType.extra];
        results.slice(0, 2000).forEach(r => {
            const name = r.type === ResultType.chant ? r.aliases : r.text;
            if (aliasTypes.includes(r.type) && !name.includes(tagword)) aliasNames.push(name);
            else tagNames.push(name);
            types.push(r.type);
        });

        let textAreaId = getTextAreaIdentifier(textArea);
        let isNegative = textAreaId.includes("n");
        const names = TAC_CFG.frequencyIncludeAlias ? tagNames.concat(aliasNames) : tagNames;
        const counts = await getUseCounts(names, types, isNegative) || [];

        const biasMap = new Map();
        results.forEach(result => {
            const name = result.type === ResultType.chant ? result.aliases : result.text;
            const useStats = counts.find(c => c.name === name && c.type === result.type);
            const uses = useStats?.count || 0;
            biasMap.set(result, calculateUsageBias(result, result.count, uses));
        });
        results = results.sort((a, b) => biasMap.get(b) - biasMap.get(a));
    }

    if (!TAC_CFG.showAllResults && normalTags) {
        results = results.slice(0, TAC_CFG.maxResults + resultCountBeforeNormalTags);
    }

    addResultsToList(textArea, results, tagword, true);
    showResults(textArea);
}

// ── keyboard navigation ────────────────────────────────────────────

function navigateInList(textArea, event) {
    if (!isEnabled()) return;

    let keys = TAC_CFG.keymap;
    if ((event.key === "Home" || event.key === "End") && !Object.values(keys).includes(event.key)) {
        hideResults(textArea);
        return;
    }

    let validKeys = Object.values(keys).filter(x => x !== "None" && x !== "");
    if (!validKeys.includes(event.key)) return;
    if (!isVisible(textArea)) return;

    let modKey = "";
    if (event.ctrlKey) modKey += "Ctrl+";
    if (event.altKey) modKey += "Alt+";
    if (event.shiftKey) modKey += "Shift+";
    if (event.metaKey) modKey += "Meta+";
    modKey += event.key;

    oldSelectedTag = selectedTag;

    switch (modKey) {
        case keys["MoveUp"]:
            selectedTag = selectedTag === null ? resultCount - 1 : (selectedTag - 1 + resultCount) % resultCount;
            break;
        case keys["MoveDown"]:
            selectedTag = selectedTag === null ? 0 : (selectedTag + 1) % resultCount;
            break;
        case keys["JumpUp"]:
            if (selectedTag === null || selectedTag === 0) selectedTag = resultCount - 1;
            else selectedTag = (Math.max(selectedTag - 5, 0) + resultCount) % resultCount;
            break;
        case keys["JumpDown"]:
            if (selectedTag === null || selectedTag === resultCount - 1) selectedTag = 0;
            else selectedTag = Math.min(selectedTag + 5, resultCount - 1) % resultCount;
            break;
        case keys["JumpToStart"]:
            selectedTag = 0;
            break;
        case keys["JumpToEnd"]:
            selectedTag = resultCount - 1;
            break;
        case keys["ChooseSelected"]:
            if (selectedTag !== null) insertTextAtCursor(textArea, results[selectedTag], tagword);
            else { hideResults(textArea); return; }
            break;
        case keys["ChooseFirstOrSelected"]:
            let withoutChoice = false;
            if (selectedTag === null) { selectedTag = 0; withoutChoice = true; }
            else if (TAC_CFG.wildcardCompletionMode === "To next folder level") withoutChoice = true;
            insertTextAtCursor(textArea, results[selectedTag], tagword, withoutChoice);
            break;
        case keys["Close"]:
            hideResults(textArea);
            break;
        default:
            if (event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return;
    }

    let moveKeys = [keys["MoveUp"], keys["MoveDown"], keys["JumpUp"], keys["JumpDown"], keys["JumpToStart"], keys["JumpToEnd"]];
    if (selectedTag === resultCount - 1 && moveKeys.includes(event.key)) {
        addResultsToList(textArea, results, tagword, false);
    }
    if (selectedTag !== null) updateSelectionStyle(textArea, selectedTag, oldSelectedTag);

    event.preventDefault();
    event.stopPropagation();
}

// ── textarea setup ─────────────────────────────────────────────────

function addAutocompleteToArea(area) {
    if (area.classList.contains('tac-autocomplete')) return;

    // Check if autocomplete is disabled for this textarea type
    let textAreaId = getTextAreaIdentifier(area);
    if (textAreaId.includes("n") && TAC_CFG.activeIn && !TAC_CFG.activeIn.negativePrompts) return;

    let resultsDiv = createResultsDiv(area);
    // Insert the popup inside the textarea's parent label (positioned context)
    let container = area.closest('label') || area.parentNode;
    container.style.position = container.style.position || 'relative';
    container.appendChild(resultsDiv);
    hideResults(area);

    area.addEventListener('input', (e) => {
        // Skip programmatic events (from tacSyncTextarea) unless self-triggered
        if (!e.inputType && !tacSelfTrigger) return;
        tacSelfTrigger = false;

        if (e.isComposing) {
            hideBlocked = true;
            setTimeout(() => { hideBlocked = false; }, 100);
        }

        debounce(() => autocomplete(area, area.value), TAC_CFG.delayTime)();
    });

    area.addEventListener('focusout', debounce(() => {
        if (!hideBlocked) hideResults(area);
    }, 400));

    area.addEventListener('keydown', (e) => navigateInList(area, e));

    area.addEventListener('compositionend', () => {
        hideBlocked = true;
        setTimeout(() => { hideBlocked = false; }, 100);
    });

    area.classList.add('tac-autocomplete');
}

// ── one-time setup ─────────────────────────────────────────────────

async function tacSetup() {
    // Load external files (LoRAs, wildcards, chants)
    await processQueue(QUEUE_FILE_LOAD, null);

    // Find textareas and add autocomplete
    let textAreas = tacGetTextAreas();
    textAreas.forEach(area => addAutocompleteToArea(area));

    // Inject CSS
    if (!document.getElementById('tac-style')) {
        let acStyle = document.createElement('style');
        acStyle.id = 'tac-style';
        acStyle.textContent = autocompleteCSS;
        document.head.appendChild(acStyle);
    }

    await processQueue(QUEUE_AFTER_SETUP, null);
}

// ── initialization ─────────────────────────────────────────────────
// In A1111, the extension used onUiUpdate (a Gradio callback) to detect
// when the UI was ready. Diffucore uses Alpine.js, so we poll for the
// textareas to appear and then set up. A MutationObserver catches
// textareas that appear later (e.g. when switching to the generate tab
// or expanding the detailer/upscaler panels).

var tacInitialized = false;
var tacInitAttempts = 0;

async function tacInit() {
    if (tacInitialized) return;
    if (tacInitAttempts++ > 100) return; // give up after ~50 seconds
    if (typeof Alpine === "undefined") { setTimeout(tacInit, 500); return; }

    // Fetch config from the backend
    await syncOptions();
    if (!TAC_CFG) { setTimeout(tacInit, 500); return; }

    // Disable the built-in <lora:> autocomplete so the extension's own
    // LoRA parser handles it instead. Done before tacSetup so the patch
    // is in place by the time the user can type. Retry in case the
    // Alpine component isn't fully initialized yet.
    tacPatchBuiltinLoraAC();
    if (!_tacLoraPatched) {
        let patchTries = 0;
        const patchInterval = setInterval(() => {
            tacPatchBuiltinLoraAC();
            if (_tacLoraPatched || ++patchTries > 20) clearInterval(patchInterval);
        }, 250);
    }

    await tacSetup();
    tacInitialized = true;
    console.log("TAC: Tag Autocomplete initialized");

    // Watch for new textareas (detailer/upscaler panels opening, etc.)
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== 1) continue;
                // Check if the added node is or contains a prompt textarea
                const areas = node.matches?.('textarea[x-model]')
                    ? [node]
                    : [...(node.querySelectorAll?.('textarea[x-model]') || [])];
                areas.forEach(area => {
                    if (!area.classList.contains('tac-autocomplete')) {
                        addAutocompleteToArea(area);
                    }
                });
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

// Start initialization when the DOM is ready
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(tacInit, 500));
} else {
    setTimeout(tacInit, 500);
}

// Listen for SSE refresh events from the backend (post_load hook)
if (typeof EventSource !== "undefined") {
    // The main app already has an EventSource on /api/events; we add our
    // own listener on a fresh connection to catch ext:tagcomplete:refresh.
    // Actually, the main app's EventSource broadcasts to all listeners, but
    // we can't easily hook into it. Instead, we poll for LoRA updates when
    // a model load status changes. For simplicity, we just re-fetch LoRAs
    // periodically when the popup is next shown.
}

// ── settings panel ─────────────────────────────────────────────────
// Registered via the DiffucoreExt bridge so it appears under
// Settings → Extensions.

if (typeof window !== "undefined" && window.DiffucoreExt) {
    window.DiffucoreExt.registerSettingsPanel({
        id: "tagcomplete",
        title: "Tag Autocomplete",
        mount(el) {
            el.innerHTML = `
                <h3 style="margin:0 0 6px;font-size:14px;color:var(--txt)">Tag Autocomplete</h3>
                <p class="sub" style="margin:0 0 14px;color:var(--txt-3);font-size:12px">
                  Configure tag completion sources, behavior, and key bindings.
                </p>
                <div id="tac-settings" style="display:flex;flex-direction:column;gap:10px;font-size:13px;max-width:560px">
                  <label style="display:flex;justify-content:space-between;align-items:center;gap:12px">
                    <span style="font-size:12px;color:var(--txt-2)">Tag file</span>
                    <select id="tac-tagfile" style="min-width:220px"></select>
                  </label>
                  <label style="display:flex;justify-content:space-between;align-items:center;gap:12px">
                    <span style="font-size:12px;color:var(--txt-2)">Extra tags file</span>
                    <select id="tac-extrafile" style="min-width:220px"></select>
                  </label>
                  <label style="display:flex;justify-content:space-between;align-items:center;gap:12px">
                    <span style="font-size:12px;color:var(--txt-2)">Chant file</span>
                    <select id="tac-chantfile" style="min-width:220px"></select>
                  </label>
                  <label style="display:flex;justify-content:space-between;align-items:center;gap:12px">
                    <span style="font-size:12px;color:var(--txt-2)">Max results</span>
                    <input type="number" id="tac-maxresults" min="1" max="100"
                      style="width:80px;font-family:var(--mono);color:var(--accent);text-align:right">
                  </label>
                  <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:4px">
                    <label class="chip"><input type="checkbox" id="tac-alias"> Search by alias</label>
                    <label class="chip"><input type="checkbox" id="tac-underscores"> Replace underscores</label>
                    <label class="chip"><input type="checkbox" id="tac-escape"> Escape parentheses</label>
                    <label class="chip"><input type="checkbox" id="tac-comma"> Append comma</label>
                    <label class="chip"><input type="checkbox" id="tac-space"> Append space</label>
                  </div>
                  <div style="display:flex;flex-wrap:wrap;gap:8px">
                    <label class="chip"><input type="checkbox" id="tac-loras"> Use LoRAs</label>
                    <label class="chip"><input type="checkbox" id="tac-wildcards"> Use wildcards</label>
                    <label class="chip"><input type="checkbox" id="tac-freq"> Frequency sort</label>
                    <label class="chip"><input type="checkbox" id="tac-wiki"> Show wiki links</label>
                  </div>
                  <div style="display:flex;gap:12px;align-items:center;margin-top:6px">
                    <button class="btn small primary" id="tac-save">Save</button>
                    <span id="tac-msg" style="font-size:11px;color:var(--teal);font-family:var(--mono)"></span>
                  </div>
                </div>`;

            // Populate dropdowns and seed from backend
            const tagSel = el.querySelector("#tac-tagfile");
            const extraSel = el.querySelector("#tac-extrafile");
            const chantSel = el.querySelector("#tac-chantfile");

            fetchTacAPI("", true, false).then(data => {
                if (!data) return;
                const s = data.settings;
                const fillSelect = (sel, files, current, includeNone = true) => {
                    sel.innerHTML = "";
                    if (includeNone) {
                        let opt = document.createElement("option");
                        opt.value = "None"; opt.textContent = "None";
                        sel.appendChild(opt);
                    }
                    files.forEach(f => {
                        let opt = document.createElement("option");
                        opt.value = f; opt.textContent = f;
                        sel.appendChild(opt);
                    });
                    sel.value = current || "None";
                };
                fillSelect(tagSel, data.csvFiles || [], s.tagFile, true);
                fillSelect(extraSel, data.csvFiles || [], s.extra_extraFile, true);
                fillSelect(chantSel, data.jsonFiles || [], s.chantFile, true);
                el.querySelector("#tac-maxresults").value = s.maxResults;
                const checkboxes = {
                    "tac-alias": s.alias_searchByAlias,
                    "tac-underscores": s.replaceUnderscores,
                    "tac-escape": s.escapeParentheses,
                    "tac-comma": s.appendComma,
                    "tac-space": s.appendSpace,
                    "tac-loras": s.useLoras,
                    "tac-wildcards": s.useWildcards,
                    "tac-freq": s.frequencySort,
                    "tac-wiki": s.showWikiLinks,
                };
                Object.entries(checkboxes).forEach(([id, checked]) => {
                    const cb = el.querySelector("#" + id);
                    cb.checked = checked;
                    cb.closest(".chip").classList.toggle("on", checked);
                    cb.addEventListener("change", () => {
                        cb.closest(".chip").classList.toggle("on", cb.checked);
                    });
                });
            });

            el.querySelector("#tac-save").addEventListener("click", async () => {
                const msg = el.querySelector("#tac-msg");
                msg.textContent = "saving\u2026";
                const body = {
                    tagFile: tagSel.value,
                    extra_extraFile: extraSel.value,
                    chantFile: chantSel.value,
                    maxResults: parseInt(el.querySelector("#tac-maxresults").value) || 5,
                    alias_searchByAlias: el.querySelector("#tac-alias").checked,
                    replaceUnderscores: el.querySelector("#tac-underscores").checked,
                    escapeParentheses: el.querySelector("#tac-escape").checked,
                    appendComma: el.querySelector("#tac-comma").checked,
                    appendSpace: el.querySelector("#tac-space").checked,
                    useLoras: el.querySelector("#tac-loras").checked,
                    useWildcards: el.querySelector("#tac-wildcards").checked,
                    frequencySort: el.querySelector("#tac-freq").checked,
                    showWikiLinks: el.querySelector("#tac-wiki").checked,
                };
                const r = await fetch(`${TAC_API}/config`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                });
                if (r.ok) {
                    msg.textContent = "saved";
                    await syncOptions();
                } else {
                    msg.textContent = "failed";
                }
                setTimeout(() => (msg.textContent = ""), 2000);
            });
        },
    });
}

})();
