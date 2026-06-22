// Tag Autocomplete — LoRA parser extension.
//
// Suggests LoRAs from models/loras/ when the user types `<` or `<lora:`.
// The LoRA list is fetched from the extension's /loras API endpoint
// (backed by a directory scan of models/loras/).
//
// Adapted from the original ext_loras.js — no hash-based keyword lookup
// (that depended on the A1111 model-keyword extension).

const LORA_REGEX = /<(?!e:|h:|c:)[^,> ]*>?/g;
const LORA_TRIGGER = () => TAC_CFG.useLoras && tagword.match(LORA_REGEX);

class LoraParser extends BaseTagParser {
    parse() {
        let tempResults = [];
        if (tagword !== "<" && tagword !== "<l:" && tagword !== "<lora:") {
            let searchTerm = tagword.replace("<lora:", "").replace("<l:", "").replace("<", "");
            let filterCondition = x => {
                let regex = new RegExp(escapeRegExp(searchTerm, true), 'i');
                return regex.test(x.toLowerCase()) || regex.test(x.toLowerCase().replaceAll(" ", "_"));
            };
            tempResults = loras.filter(x => filterCondition(x[0]));
        } else {
            tempResults = loras;
        }

        let finalResults = [];
        tempResults.forEach(t => {
            const text = t[0].trim();
            let lastDot = text.lastIndexOf(".") > -1 ? text.lastIndexOf(".") : text.length;
            let name = text.substring(0, lastDot);

            let result = new AutocompleteResult(name, ResultType.lora);
            result.meta = "LoRA";
            result.sortKey = t[1] || name;
            finalResults.push(result);
        });
        return finalResults;
    }
}

async function tacLoadLoras() {
    if (loras.length === 0) {
        try {
            const data = await fetchTacAPI("loras", true, true);
            if (data && data.loras) {
                loras = data.loras.map(name => [name, name]);
            }
        } catch (e) {
            console.error("TAC: Error loading LoRAs: " + e);
        }
    }
}

function tacSanitizeLora(tagType, text) {
    if (tagType === ResultType.lora) {
        let multiplier = TAC_CFG.extraNetworksDefaultMultiplier;
        return `<lora:${text}:${multiplier}>`;
    }
    return null;
}

PARSERS.push(new LoraParser(LORA_TRIGGER));
QUEUE_FILE_LOAD.push(tacLoadLoras);
QUEUE_SANITIZE.push(tacSanitizeLora);
