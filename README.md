# Tag Autocomplete for Diffucore UI

Booru-style tag autocompletion for [Diffucore UI](https://github.com/nawka12/diffucore-ui),
ported from [DominikDoom's a1111-sd-webui-tagcomplete](https://github.com/DominikDoom/a1111-sd-webui-tagcomplete).

Suggests tags from Danbooru, e621, Derpibooru, and other CSV tag files as you
type in the prompt or negative-prompt box. Supports LoRA completion, wildcard
files, chant presets, alias/translation search, keyboard navigation, wiki
links, and a local tag-frequency database that sorts often-used tags higher.

## Features

- **Tag completion** — Danbooru, e621, Derpibooru, e621 SFW, and an English
  dictionary ship in `tags/`. Pick which file to use in Settings.
- **LoRA completion** — typing `<` or `<lora:` suggests LoRAs from
  `models/loras/`. Selecting one inserts `<lora:name:1.0>`.
- **Wildcard completion** — typing `__` suggests wildcard files from an
  optional `wildcards/` directory at the project root. Selecting a file
  shows its contents for a second level of completion.
- **Chant presets** — longer prompt presets from JSON chant files
  (`demo-chants.json` and `noob_characters-chants.json` ship by default).
  Trigger with `<c:` or `<chant:`.
- **Alias & translation search** — find tags by their aliases or translations
  even if the primary name doesn't match what you typed.
- **Tag frequency tracking** — a SQLite database records which tags you
  select and how often, then sorts frequently-used tags higher in the
  results. View and reset counts in the **Tag Usage** tab.
- **Keyboard navigation** — Arrow keys to move, Enter to select, Tab to
  insert the first result, Escape to close. All key bindings are
  configurable.
- **Wiki links** — optional `?` links next to tags that open the relevant
  Danbooru or e621 wiki page.
- **Diffucore UI integration** — the popup uses the app's CSS variables and
  darkroom theme, coexists with the built-in `<lora:>` autocomplete, and
  syncs textarea changes back to Alpine.js bindings.

## Installation

### From the UI

1. Open **Settings → Extensions** in Diffucore UI.
2. Click **Install** and paste this repo's git URL:
   ```
   https://github.com/nawka12/diffucore-ui-tagcomplete.git
   ```
3. The extension loads immediately and the tag popup appears the next time
   you type in a prompt box.

### Manual

Clone or copy this folder into `extensions/` under your Diffucore UI
directory and restart the server:

```bash
cd diffucore-ui/extensions
git clone https://github.com/nawka12/diffucore-ui-tagcomplete.git tagcomplete
```

The extension is enabled by default. Disable it in **Settings → Extensions**
if you want to turn it off.

## Configuration

Open **Settings → Extensions → Tag Autocomplete** to configure:

| Setting | Description |
|---|---|
| **Tag file** | Which CSV file to use for tag suggestions (Danbooru, e621, etc.) |
| **Extra tags file** | A secondary CSV merged into the results (defaults to `extra-quality-tags.csv`) |
| **Chant file** | JSON preset file for chant completion |
| **Max results** | How many suggestions to show before scrolling |
| **Search by alias** | Match tag aliases, not just primary names |
| **Replace underscores** | Convert `long_hair` to `long hair` on insertion |
| **Escape parentheses** | Escape `(`, `)`, `[`, `]` on insertion so they aren't parsed as weighting |
| **Append comma** | Add a `,` after each inserted tag |
| **Append space** | Add a space after the comma |
| **Use LoRAs** | Enable `<lora:…>` completion |
| **Use wildcards** | Enable `__wildcard__` completion |
| **Frequency sort** | Track tag usage and sort frequent tags higher |
| **Show wiki links** | Show `?` links to Danbooru/e621 wiki pages |

## Tag Usage tab

The **Tag Usage** tab (added to the main nav) shows every tag you've
selected from the popup, ranked by how often you've used it. Click
**Reset** on any row to clear that tag's count.

## Wildcards

Create a `wildcards/` directory at the Diffucore UI project root and drop
`.txt` files into it (nested folders work). Each line in a wildcard file is
one option. Typing `__` in the prompt will list the files; selecting one
shows its contents for a second round of completion.

```
diffucore-ui/
└── wildcards/
    ├── hair_colors.txt      # one color per line
    └── poses/
        └── standing.txt     # nested folders supported
```

## Tag files

The following CSV files ship with the extension in `tags/`:

| File | Source | Description |
|---|---|---|
| `danbooru.csv` | Danbooru | General-purpose anime tag set |
| `danbooru_e621_merged.csv` | Danbooru + e621 | Merged furry + anime tags |
| `e621.csv` | e621 | Furry tag set |
| `e621_sfw.csv` | e621 | SFW-only furry tags |
| `derpibooru.csv` | Derpibooru | My Little Pony tags |
| `EnglishDictionary.csv` | English words | Generic English word completion |
| `extra-quality-tags.csv` | Custom | Quality modifier tags (masterpiece, etc.) |

You can add your own CSV files to `tags/` — they'll appear in the Tag file
dropdown after a page refresh.

CSV format (columns): `name, category, count, aliases, translation`

## Attribution

This extension is a port of **DominikDoom's**
[a1111-sd-webui-tagcomplete](https://github.com/DominikDoom/a1111-sd-webui-tagcomplete),
originally written for the AUTOMATIC1111 Stable Diffusion WebUI.

- **Original author**: Dominik Reh ([DominikDoom](https://github.com/DominikDoom))
- **Original project**: https://github.com/DominikDoom/a1111-sd-webui-tagcomplete
- **License**: MIT (see [LICENSE](LICENSE))

The tag data files in `tags/` (Danbooru, e621, Derpibooru CSVs and the chant
JSON files) are from the original project. The JavaScript autocomplete logic,
parser architecture, result rendering, keyboard navigation, and tag frequency
database are adapted from the original codebase.

### Changes from the original

This port adapts the extension to Diffucore UI's extension platform:

- Gradio's `gradioApp()` / `onUiUpdate` / `updateInput` are replaced with
  plain DOM APIs and Alpine.js integration.
- Settings are stored via Diffucore's `ExtensionAPI.get_setting` /
  `set_setting` instead of A1111's `shared.opts`.
- Tag data files are served through the extension's `serve_static` mount.
- The popup CSS uses Diffucore's CSS variables (`--surface-3`, `--accent`,
  `--line-hi`, etc.) to match the darkroom theme.
- LoRA scanning uses Diffucore's `models/loras/` directory.
- Wildcard scanning targets an optional `wildcards/` directory at the
  project root.
- The settings panel is registered through `window.DiffucoreExt` and a
  **Tag Usage** tab is added to the main nav.
- A1111-specific features that have no Diffucore equivalent were dropped:
  hypernetworks, textual inversion embeddings, webui style variables, UMI
  YAML wildcards, and the model-keyword hash-based trigger-word lookup.

## License

MIT — see [LICENSE](LICENSE). The original copyright notice is preserved as
required by the MIT license.
