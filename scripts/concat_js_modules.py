# -*- coding: utf-8 -*-
"""将 js/common.js + js/tabs/*.js 合并为 js/main.js（修改 tab 源文件后运行）。"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JS = ROOT / "js"
order = ["common.js", "tabs/returns.js", "tabs/allocation.js", "tabs/history.js", "tabs/signals.js", "tabs/review.js"]
chunks = ["// js/main.js — ES module (split sources: js/common.js + js/tabs/*.js)\n"]
for rel in order:
    path = JS / rel
    name = path.stem
    chunks.append(f"\n// --- tab: {name} ---\n")
    chunks.append(path.read_text(encoding="utf-8"))
    if not chunks[-1].endswith("\n"):
        chunks.append("\n")
(JS / "main.js").write_text("".join(chunks), encoding="utf-8")
print("wrote js/main.js")
