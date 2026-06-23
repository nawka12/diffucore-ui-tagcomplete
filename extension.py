"""Tag Autocomplete extension for Diffucore UI.

Ported from DominikDoom's a1111-sd-webui-tagcomplete. Provides tag completion
for the prompt and negative-prompt textareas, suggesting tags from Danbooru /
e621 / derpibooru CSV files, LoRAs from ``models/loras/``, wildcard files, and
chant presets. Includes a SQLite tag-frequency database so often-used tags sort
higher.

The backend here handles:
  * serving the ``tags/`` directory (CSV + JSON data files) as static assets,
  * scanning ``models/loras/`` for LoRA filenames,
  * scanning an optional ``wildcards/`` directory for wildcard files,
  * the tag-frequency SQLite database (increase / get / reset counts),
  * a config endpoint that returns current settings + available file lists,
  * a ``post_load`` hook that refreshes the LoRA list when a model is loaded.

Read alongside ``docs/EXTENSIONS.md`` and the ``web/`` JS files.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel

router = APIRouter()

# ── paths ───────────────────────────────────────────────────────────
EXT_DIR = Path(__file__).resolve().parent
TAGS_PATH = EXT_DIR / "tags"
DB_FILE = TAGS_PATH / "tag_frequency.db"

# These are resolved from api.root_dir in setup().
_LORAS_DIR: Optional[Path] = None
_WILDCARDS_DIR: Optional[Path] = None


# ── tag-frequency database ──────────────────────────────────────────
# Adapted from the original tag_frequency_db.py. SQLite, one row per
# (name, type) pair, with separate positive / negative counters and a
# last-used timestamp. The JS side queries this to sort frequent tags higher.

_DB_VER = 1
_DB_TIMEOUT = 30


@contextmanager
def _transaction(db: Path = DB_FILE):
    conn = sqlite3.connect(str(db), timeout=_DB_TIMEOUT)
    try:
        conn.isolation_level = None
        cur = conn.cursor()
        cur.execute("BEGIN")
        yield cur
        cur.execute("COMMIT")
    except sqlite3.Error as e:
        print(f"Tag Autocomplete: frequency database error: {e}")
    finally:
        conn.close()


def _init_db() -> int:
    if not DB_FILE.exists():
        print("Tag Autocomplete: creating frequency database")
        with _transaction() as cur:
            cur.execute(
                "CREATE TABLE IF NOT EXISTS db_data (key TEXT PRIMARY KEY, value TEXT)"
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS tag_frequency (
                    name TEXT NOT NULL,
                    type INT NOT NULL,
                    count_pos INT,
                    count_neg INT,
                    last_used TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (name, type)
                )
                """
            )
            cur.execute(
                "INSERT OR REPLACE INTO db_data (key, value) VALUES (?, ?)",
                ("version", str(_DB_VER)),
            )
        print("Tag Autocomplete: database created")
    with _transaction() as cur:
        cur.execute("SELECT value FROM db_data WHERE key = 'version'")
        row = cur.fetchone()
    return int(row[0]) if row else 0


_db_version = _init_db()


def _db_ok() -> bool:
    return _db_version == _DB_VER


# ── LoRA / wildcard scanning ────────────────────────────────────────

_LORA_EXTS = {".safetensors", ".ckpt", ".pt"}
_WILDCARD_EXTS = {".txt"}
_YAML_EXTS = {".yml", ".yaml"}


def _scan_loras() -> List[str]:
    if _LORAS_DIR is None or not _LORAS_DIR.exists():
        return []
    return sorted(
        p.name for p in _LORAS_DIR.iterdir()
        if p.is_file() and p.suffix.lower() in _LORA_EXTS
    )


def _scan_wildcards() -> List[Dict[str, str]]:
    """Return ``[{name, path, base}]`` for each wildcard .txt file found."""
    out: List[Dict[str, str]] = []
    if _WILDCARDS_DIR is None or not _WILDCARDS_DIR.exists():
        return out
    for p in sorted(_WILDCARDS_DIR.rglob("*.txt")):
        if p.name == "put wildcards here.txt":
            continue
        if not p.is_file():
            continue
        rel = p.relative_to(_WILDCARDS_DIR).as_posix().replace(".txt", "")
        out.append({"name": rel, "path": str(p), "base": _WILDCARDS_DIR.as_posix()})
    return out


# ── default settings ────────────────────────────────────────────────
# These mirror the original extension's ``shared.OptionInfo`` defaults.
# The JS side fetches them from the config endpoint on init.

KEYMAP_DEFAULT = json.dumps({
    "MoveUp": "ArrowUp",
    "MoveDown": "ArrowDown",
    "JumpUp": "PageUp",
    "JumpDown": "PageDown",
    "JumpToStart": "Home",
    "JumpToEnd": "End",
    "ChooseSelected": "Enter",
    "ChooseFirstOrSelected": "Tab",
    "Close": "Escape",
}, indent=4)

COLORMAP_DEFAULT = json.dumps({
    "danbooru": {
        "-1": ["red", "maroon"],
        "0": ["lightblue", "dodgerblue"],
        "1": ["indianred", "firebrick"],
        "3": ["violet", "darkorchid"],
        "4": ["lightgreen", "darkgreen"],
        "5": ["orange", "darkorange"],
    },
    "e621": {
        "-1": ["red", "maroon"],
        "0": ["lightblue", "dodgerblue"],
        "1": ["gold", "goldenrod"],
        "3": ["violet", "darkorchid"],
        "4": ["lightgreen", "darkgreen"],
        "5": ["tomato", "darksalmon"],
        "6": ["red", "maroon"],
        "7": ["whitesmoke", "black"],
        "8": ["seagreen", "darkseagreen"],
    },
    "derpibooru": {
        "-1": ["red", "maroon"],
        "0": ["#60d160", "#3d9d3d"],
        "1": ["#fff956", "#918e2e"],
        "3": ["#fd9961", "#a14c2e"],
        "4": ["#cf5bbe", "#6c1e6c"],
        "5": ["#3c8ad9", "#1e5e93"],
        "6": ["#a6a6a6", "#555555"],
        "7": ["#47abc1", "#1f6c7c"],
        "8": ["#7871d0", "#392f7d"],
        "9": ["#df3647", "#8e1c2b"],
        "10": ["#c98f2b", "#7b470e"],
        "11": ["#e87ebe", "#a83583"],
    },
    "danbooru_e621_merged": {
        "-1": ["red", "maroon"],
        "0": ["lightblue", "dodgerblue"],
        "1": ["indianred", "firebrick"],
        "3": ["violet", "darkorchid"],
        "4": ["lightgreen", "darkgreen"],
        "5": ["orange", "darkorange"],
        "6": ["red", "maroon"],
        "7": ["lightblue", "dodgerblue"],
        "8": ["gold", "goldenrod"],
        "9": ["gold", "goldenrod"],
        "10": ["violet", "darkorchid"],
        "11": ["lightgreen", "darkgreen"],
        "12": ["tomato", "darksalmon"],
        "14": ["whitesmoke", "black"],
        "15": ["seagreen", "darkseagreen"],
    },
}, indent=4)

_UNDERSCORE_EXCLUSIONS = (
    "0_0,(o)_(o),+_+,+_-,._.,<o>_<o>,<|>_<|>,=_=,>_<,3_3,6_9,>_o,"
    "@_@,^_^,o_o,u_u,x_x,|_|,||_||"
)

DEFAULTS: Dict[str, Any] = {
    "tagFile": "danbooru.csv",
    "activeIn_txt2img": True,
    "activeIn_img2img": True,
    "activeIn_negativePrompts": True,
    "maxResults": 5,
    "showAllResults": False,
    "resultStepLength": 100,
    "delayTime": 100,
    "useWildcards": True,
    "sortWildcardResults": True,
    "useLoras": True,
    "showWikiLinks": False,
    "modelSortOrder": "Name",
    "frequencySort": True,
    "frequencyFunction": "Logarithmic (weak)",
    "frequencyMinCount": 3,
    "frequencyMaxAge": 30,
    "frequencyRecommendCap": 10,
    "frequencyIncludeAlias": False,
    "replaceUnderscores": True,
    "replaceUnderscoresExclusionList": _UNDERSCORE_EXCLUSIONS,
    "escapeParentheses": True,
    "appendComma": True,
    "appendSpace": True,
    "alwaysSpaceAtEnd": True,
    "addArtistAtSymbol": False,
    "wildcardCompletionMode": "To next folder level",
    "extraNetworksDefaultMultiplier": 1.0,
    "alias_searchByAlias": True,
    "alias_onlyShowAlias": False,
    "translation_translationFile": "None",
    "translation_oldFormat": False,
    "translation_searchByTranslation": True,
    "translation_liveTranslation": False,
    "extra_extraFile": "extra-quality-tags.csv",
    "extra_addMode": "Insert before",
    "chantFile": "demo-chants.json",
    "keymap": KEYMAP_DEFAULT,
    "colormap": COLORMAP_DEFAULT,
}


def _setting(api, key: str) -> Any:
    return api.get_setting(key, DEFAULTS.get(key))


def _available_csv_files() -> List[str]:
    return sorted(p.name for p in TAGS_PATH.glob("*.csv") if p.is_file())


def _available_json_files() -> List[str]:
    return sorted(p.name for p in TAGS_PATH.glob("*.json") if p.is_file())


# ── API models ──────────────────────────────────────────────────────

class ConfigUpdate(BaseModel):
    tagFile: Optional[str] = None
    activeIn_txt2img: Optional[bool] = None
    activeIn_img2img: Optional[bool] = None
    activeIn_negativePrompts: Optional[bool] = None
    maxResults: Optional[int] = None
    showAllResults: Optional[bool] = None
    resultStepLength: Optional[int] = None
    delayTime: Optional[int] = None
    useWildcards: Optional[bool] = None
    sortWildcardResults: Optional[bool] = None
    useLoras: Optional[bool] = None
    showWikiLinks: Optional[bool] = None
    modelSortOrder: Optional[str] = None
    frequencySort: Optional[bool] = None
    frequencyFunction: Optional[str] = None
    frequencyMinCount: Optional[int] = None
    frequencyMaxAge: Optional[int] = None
    frequencyRecommendCap: Optional[int] = None
    frequencyIncludeAlias: Optional[bool] = None
    replaceUnderscores: Optional[bool] = None
    replaceUnderscoresExclusionList: Optional[str] = None
    escapeParentheses: Optional[bool] = None
    appendComma: Optional[bool] = None
    appendSpace: Optional[bool] = None
    alwaysSpaceAtEnd: Optional[bool] = None
    addArtistAtSymbol: Optional[bool] = None
    wildcardCompletionMode: Optional[str] = None
    extraNetworksDefaultMultiplier: Optional[float] = None
    alias_searchByAlias: Optional[bool] = None
    alias_onlyShowAlias: Optional[bool] = None
    translation_translationFile: Optional[str] = None
    translation_oldFormat: Optional[bool] = None
    translation_searchByTranslation: Optional[bool] = None
    translation_liveTranslation: Optional[bool] = None
    extra_extraFile: Optional[str] = None
    extra_addMode: Optional[str] = None
    chantFile: Optional[str] = None
    keymap: Optional[str] = None
    colormap: Optional[str] = None


class UseCountListRequest(BaseModel):
    tagNames: List[str]
    tagTypes: List[int]
    neg: bool = False


# ── API endpoints ───────────────────────────────────────────────────
# The loader mounts this router at /api/ext/tagcomplete, so a route
# defined as "" resolves to that exact path.


# We need a reference to the api object for settings lookups inside route
# handlers. Store it during setup() and look it up here. (FastAPI route
# handlers can't easily receive the api object, so we use a module-level ref.)
_api_ref: List[Any] = []


def _build_config_response(api) -> dict:
    settings = {k: _setting(api, k) for k in DEFAULTS}
    return {
        "settings": settings,
        "csvFiles": _available_csv_files(),
        "jsonFiles": _available_json_files(),
        "loras": _scan_loras(),
        "wildcards": _scan_wildcards(),
        "dbOk": _db_ok(),
    }


@router.get("")
def config():
    """Return current settings plus lists of available CSV/JSON/LoRA/wildcard files."""
    return _build_config_response(_api_ref[0])


@router.post("/config")
def update_config(cfg: ConfigUpdate):
    api = _api_ref[0]
    changed = {}
    for field, value in cfg.model_dump(exclude_none=True).items():
        api.set_setting(field, value)
        changed[field] = value
    return {"ok": True, "changed": changed}


@router.get("/loras")
def loras():
    return {"loras": _scan_loras()}


@router.post("/refresh")
def refresh():
    """Re-scan LoRAs and wildcards. Called after a model load or a manual refresh."""
    return {"loras": _scan_loras(), "wildcards": _scan_wildcards()}


@router.get("/wildcards")
def wildcards():
    return {"wildcards": _scan_wildcards()}


@router.get("/wildcard-contents")
def wildcard_contents(basepath: str, filename: str):
    base = Path(basepath)
    if not base.exists():
        return Response(status_code=404)
    wp = base / filename
    if not wp.exists() or not wp.is_file():
        # Try with .txt extension
        wp = base / (filename + ".txt")
        if not wp.exists() or not wp.is_file():
            return Response(status_code=404)
    return FileResponse(str(wp))


# ── tag-frequency API ───────────────────────────────────────────────


def _db_request(func, get=False):
    if not _db_ok():
        return JSONResponse({"error": "Database not initialized"}, status_code=500)
    try:
        if get:
            return JSONResponse({"result": func()})
        func()
        return JSONResponse({"ok": True})
    except sqlite3.Error as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.post("/increase-use-count")
def increase_use_count(tagname: str, ttype: int, neg: bool):
    def _do():
        with _transaction() as cur:
            col = "count_neg" if neg else "count_pos"
            cur.execute(
                f"SELECT count_pos, count_neg FROM tag_frequency WHERE name = ? AND type = ?",
                (tagname, ttype),
            )
            row = cur.fetchone()
            pos, negc = (row[0] or 0, row[1] or 0) if row else (0, 0)
            if neg:
                negc += 1
            else:
                pos += 1
            cur.execute(
                "INSERT OR REPLACE INTO tag_frequency (name, type, count_pos, count_neg, last_used) "
                "VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)",
                (tagname, ttype, pos, negc),
            )
    return _db_request(_do)


@router.post("/get-use-count-list")
def get_use_count_list(body: UseCountListRequest):
    api = _api_ref[0]
    date_limit = _setting(api, "frequencyMaxAge")
    date_limit = date_limit if date_limit and date_limit > 0 else None

    def _do():
        col = "count_neg" if body.neg else "count_pos"
        results = []
        with _transaction() as cur:
            for tag, ttype in zip(body.tagNames, body.tagTypes):
                if date_limit is not None:
                    cur.execute(
                        f"SELECT {col}, last_used FROM tag_frequency "
                        f"WHERE name = ? AND type = ? "
                        f"AND last_used > datetime('now', '-' || ? || ' days')",
                        (tag, ttype, date_limit),
                    )
                else:
                    cur.execute(
                        f"SELECT {col}, last_used FROM tag_frequency "
                        f"WHERE name = ? AND type = ?",
                        (tag, ttype),
                    )
                row = cur.fetchone()
                if row:
                    results.append([tag, ttype, row[0], str(row[1]) if row[1] else None])
                else:
                    results.append([tag, ttype, 0, None])
        # Cap to the top N by count
        cap = _setting(api, "frequencyRecommendCap")
        if cap and cap > 0 and len(results) > cap:
            results = sorted(results, key=lambda x: x[2], reverse=True)[:cap]
        return results
    return _db_request(_do, get=True)


@router.put("/reset-use-count")
def reset_use_count(tagname: str, ttype: int, pos: bool, neg: bool):
    def _do():
        sets = []
        if pos:
            sets.append("count_pos = 0")
        if neg:
            sets.append("count_neg = 0")
        if not sets:
            return
        with _transaction() as cur:
            cur.execute(
                f"UPDATE tag_frequency SET {', '.join(sets)} WHERE name = ? AND type = ?",
                (tagname, ttype),
            )
    return _db_request(_do)


@router.get("/all-use-counts")
def all_use_counts():
    def _do():
        with _transaction() as cur:
            cur.execute(
                "SELECT name, type, count_pos, count_neg, last_used "
                "FROM tag_frequency WHERE count_pos > 0 OR count_neg > 0 "
                "ORDER BY count_pos + count_neg DESC"
            )
            return cur.fetchall()
    return _db_request(_do, get=True)


# ── entry point ─────────────────────────────────────────────────────


def setup(api):
    global _LORAS_DIR, _WILDCARDS_DIR

    _LORAS_DIR = api.root_dir / "models" / "loras"
    _WILDCARDS_DIR = api.root_dir / "wildcards"

    # Store a reference so the route handlers above can reach the api object
    # for settings lookups.
    _api_ref.append(api)

    # Serve the tags directory at /ext-static/tagcomplete/tags/ so the JS
    # can fetch CSV/JSON data files directly.
    api.serve_static("tags", TAGS_PATH)

    # Refresh LoRA/wildcard listings after a model load (the user might have
    # added new LoRAs between loads).
    def on_post_load(ctx):
        api.broadcast({"type": "ext:tagcomplete:refresh", "loras": _scan_loras()})

    api.on("post_load", on_post_load)

    # Mount the API router.
    api.add_api_router(router)
