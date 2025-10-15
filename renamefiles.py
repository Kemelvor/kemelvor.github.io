from pathlib import Path

current = Path(__file__).parent
art = current / "src" / "compact_art"

for p in art.iterdir():
    if p.is_file() and p.suffix == ".gif":
        if " (2)" in p.stem:
            new_name = p.stem.replace(" (2)", "") + p.suffix
            new_path = art / new_name
            if new_path.exists():
                new_path.unlink()
            print(f"Renaming {p.name} to {new_name}...")
            p.rename(new_path)
