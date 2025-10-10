import os
import sys
from pathlib import Path

current = Path(__file__).parent

file_list = []
for p in current.iterdir():
    if p.is_file() and p.suffix in [
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".webp",
        ".bmp",
        ".tiff",
        ".svg",
        ".avif",
        ".mp4",
    ]:
        fpath = p.name
        fid = p.stem
        fdate = p.stat().st_birthtime

        file_list.append({"fname": fpath, "date": fdate})

file_list = sorted(file_list, key=lambda x: x["date"], reverse=True)

for i, item in enumerate(file_list):
    item["id"] = i + 1

with open("artlist.txt", "w") as f:
    f.write("[\n")
    for item in file_list:
        out = f'    {{"fname": "{item["fname"]}", "id": "{item["id"]}", "date":"{item["date"]}"}}'
        f.write(out + ",\n" if item != file_list[-1] else out + "\n")
    f.write("]\n")
