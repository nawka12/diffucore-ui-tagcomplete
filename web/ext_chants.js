// Tag Autocomplete — Chant (preset) parser extension.
//
// Suggests longer prompt presets from a JSON chant file (e.g.
// demo-chants.json). Chants are triggered by typing `<c:` or `<chant:`.
//
// Adapted from the original ext_chants.js — loads from the tags directory
// served at /ext-static/tagcomplete/tags/ by the backend.

const CHANT_REGEX = /<(?!e:|h:|l:)[^,> ]*>?/g;
const CHANT_TRIGGER = () => TAC_CFG.chantFile && TAC_CFG.chantFile !== "None" && tagword.match(CHANT_REGEX);

class ChantParser extends BaseTagParser {
    parse() {
        let tempResults = [];
        if (tagword !== "<" && tagword !== "<c:") {
            let searchTerm = tagword.replace("<chant:", "").replace("<c:", "").replace("<", "");
            let filterCondition = x => {
                let regex = new RegExp(escapeRegExp(searchTerm, true), 'i');
                return regex.test(x.terms.toLowerCase()) || regex.test(x.name.toLowerCase());
            };
            tempResults = chants.filter(x => filterCondition(x));
        } else {
            tempResults = chants;
        }

        let finalResults = [];
        tempResults.forEach(t => {
            let result = new AutocompleteResult(t.content.trim(), ResultType.chant);
            result.meta = "Chant";
            result.aliases = t.name;
            result.category = t.color;
            finalResults.push(result);
        });
        return finalResults;
    }
}

async function tacLoadChants() {
    if (TAC_CFG.chantFile && TAC_CFG.chantFile !== "None") {
        try {
            chants = await readFile(`${tagBasePath}/${TAC_CFG.chantFile}`, true);
        } catch (e) {
            console.error("TAC: Error loading chants: " + e);
        }
    } else {
        chants = [];
    }
}

function tacSanitizeChant(tagType, text) {
    if (tagType === ResultType.chant) return text;
    return null;
}

PARSERS.push(new ChantParser(CHANT_TRIGGER));
QUEUE_FILE_LOAD.push(tacLoadChants);
QUEUE_SANITIZE.push(tacSanitizeChant);
QUEUE_AFTER_CONFIG_CHANGE.push(tacLoadChants);
