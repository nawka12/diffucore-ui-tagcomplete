// Tag Autocomplete — Wildcard parser extension.
//
// Suggests wildcard files and their contents when the user types `__`.
// Wildcard files are .txt files in the optional wildcards/ directory
// (scanned by the backend). YAML wildcard collections are also supported
// if the files contain key/value lists.
//
// Adapted from the original ext_wildcards.js for the Diffucore UI platform.

const WC_WRAP = "__";
const WC_REGEX = new RegExp(/__([^,]+)__([^, ]*)/g);

const WC_TRIGGER = () => TAC_CFG.useWildcards &&
    [...tagword.matchAll(new RegExp(WC_REGEX.source.replaceAll("__", escapeRegExp(WC_WRAP)), "g"))].length > 0;
const WC_FILE_TRIGGER = () => TAC_CFG.useWildcards &&
    (tagword.startsWith(WC_WRAP) && !tagword.endsWith(WC_WRAP) || tagword === WC_WRAP);

class WildcardParser extends BaseTagParser {
    async parse() {
        let wcMatch = [...tagword.matchAll(new RegExp(WC_REGEX.source.replaceAll("__", escapeRegExp(WC_WRAP)), "g"))];
        let wcFile = wcMatch[0][1];
        let wcWord = wcMatch[0][2];

        let wcPairs = wildcardFiles.filter(x => x[1].toLowerCase() === wcFile);
        if (!wcPairs.length) return [];

        let wildcards = [];
        for (let i = 0; i < wcPairs.length; i++) {
            const basePath = wcPairs[i][0];
            const fileName = wcPairs[i][1];
            if (!basePath || !fileName) continue;

            if (basePath.endsWith(".yaml") || basePath.endsWith(".yml")) {
                const getDescendantProp = (obj, desc) => {
                    const arr = desc.split("/");
                    while (arr.length) obj = obj[arr.shift()];
                    return obj;
                };
                let vals = getDescendantProp(yamlWildcards, fileName);
                if (Array.isArray(vals)) wildcards = wildcards.concat(vals);
            } else {
                const fileContent = await fetchTacAPI(
                    `wildcard-contents?basepath=${encodeURIComponent(basePath)}&filename=${encodeURIComponent(fileName)}`,
                    false
                );
                if (fileContent) {
                    wildcards = wildcards.concat(
                        fileContent.split("\n").filter(x => x.trim().length > 0 && !x.startsWith('#'))
                    );
                }
            }
        }

        if (TAC_CFG.sortWildcardResults)
            wildcards.sort((a, b) => a.localeCompare(b));

        let finalResults = [];
        let tempResults = wildcards.filter(x =>
            (wcWord !== null && wcWord.length > 0) ? x.toLowerCase().includes(wcWord) : x
        );
        tempResults.forEach(t => {
            let result = new AutocompleteResult(t.trim(), ResultType.wildcardTag);
            result.meta = wcFile;
            finalResults.push(result);
        });
        return finalResults;
    }
}

class WildcardFileParser extends BaseTagParser {
    parse() {
        let tempResults = [];
        if (tagword !== WC_WRAP) {
            let lmb = (x) => x[1].toLowerCase().includes(tagword.replace(WC_WRAP, ""));
            tempResults = wildcardFiles.filter(lmb);
        } else {
            tempResults = wildcardFiles;
        }

        let finalResults = [];
        const alreadyAdded = new Map();
        tempResults.forEach(wcFile => {
            if (alreadyAdded.has(wcFile[1])) return;
            let result = new AutocompleteResult(wcFile[1].trim(), ResultType.wildcardFile);
            result.meta = "Wildcard file";
            result.sortKey = wcFile[2] || wcFile[1];
            finalResults.push(result);
            alreadyAdded.set(wcFile[1], true);
        });

        finalResults.sort(getSortFunction());
        return finalResults;
    }
}

async function tacLoadWildcards() {
    if (wildcardFiles.length === 0) {
        try {
            const data = await fetchTacAPI("wildcards", true, true);
            if (data && data.wildcards) {
                wildcardFiles = data.wildcards.map(w => [w.base, w.name, w.name]);
            }
        } catch (e) {
            console.error("TAC: Error loading wildcards: " + e);
        }
    }
}

function tacSanitizeWildcard(tagType, text) {
    if (tagType === ResultType.wildcardFile || tagType === ResultType.yamlWildcard) {
        return `${WC_WRAP}${text}${WC_WRAP}`;
    } else if (tagType === ResultType.wildcardTag) {
        return text;
    }
    return null;
}

function tacKeepOpenIfWildcard(tagType, sanitizedText, newPrompt, textArea) {
    if (tagType === ResultType.wildcardFile || tagType === ResultType.yamlWildcard) {
        hideBlocked = true;
        setTimeout(() => { hideBlocked = false; }, 450);
        return true;
    }
    return false;
}

PARSERS.push(new WildcardParser(WC_TRIGGER));
PARSERS.push(new WildcardFileParser(WC_FILE_TRIGGER));
QUEUE_FILE_LOAD.push(tacLoadWildcards);
QUEUE_SANITIZE.push(tacSanitizeWildcard);
QUEUE_AFTER_INSERT.push(tacKeepOpenIfWildcard);
