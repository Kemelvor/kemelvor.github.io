from pathlib import Path

current = Path(__file__).parent
art = current  / "src" / "art"
if not art.exists():
    art.mkdir(parents=True)
compact = current / "src" / "compact_art"
if not compact.exists():
    compact.mkdir(parents=True)
posters = current / "src" / "compact_art_posters"
if not posters.exists():
    posters.mkdir(parents=True)
compact_lq = current / "src" / "compact_art_lq"
if not compact_lq.exists():
    compact_lq.mkdir(parents=True)
compact_ulq = current / "src" / "compact_art_ulq"
if not compact_ulq.exists():
    compact_ulq.mkdir(parents=True)
posters_lq = current / "src" / "compact_art_posters_lq"
if not posters_lq.exists():
    posters_lq.mkdir(parents=True)
posters_ulq = current / "src" / "compact_art_posters_ulq"
if not posters_ulq.exists():
    posters_ulq.mkdir(parents=True)
file_list = []
for p in art.iterdir():
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
    ]:
        file_list.append(p)
for p in file_list:
    source = art / p.name
    dest = compact / p.name
    # Always recopy GIFs to avoid prior resized/corrupted outputs; non-GIFs will be generated from source.
    if p.suffix.lower() == ".gif":
        if (not dest.exists()) or (source.stat().st_mtime > dest.stat().st_mtime):
            print(f"Copying GIF {p.name}...")
            with open(source, "rb") as fsrc:
                if not dest.exists():
                    dest.touch()
                with open(dest, "wb") as fdst:
                    fdst.write(fsrc.read())

print("Generating resized images and posters (ULQ/LQ/HQ)...")
from PIL import Image


def save_resized(src_path: Path, max_dim: int, out_path: Path):
    with Image.open(src_path) as im:
        im_format = im.format
        w, h = im.size
        scale = min(1.0, max_dim / max(w, h))
        new_w, new_h = int(w * scale), int(h * scale)
        if scale < 1.0:
            im = im.resize((new_w, new_h), Image.LANCZOS)
        # Ensure parents exist
        out_path.parent.mkdir(parents=True, exist_ok=True)
        im.save(out_path)


for p in file_list:
    src = art / p.name
    suffix = p.suffix.lower()
    stem = p.stem
    if suffix == ".gif":
        # Posters from original GIF first frame at ULQ/LQ/HQ
        try:
            with Image.open(src) as im:
                try:
                    im.seek(0)
                except Exception:
                    pass
                poster = im.convert("RGBA")
                # Save three sizes
                for size, out_dir in [
                    (96, posters_ulq),
                    (256, posters_lq),
                    (512, posters),
                ]:
                    w, h = poster.size
                    scale = min(1.0, size / max(w, h))
                    new_w, new_h = int(w * scale), int(h * scale)
                    out_img = (
                        poster
                        if scale == 1.0
                        else poster.resize((new_w, new_h), Image.LANCZOS)
                    )
                    out_path = out_dir / f"{stem}.png"
                    out_img.save(out_path)
                    print(f"Poster {size}px saved for {p.name} -> {out_path.name}")
        except Exception as e:
            print(f"Failed to create posters for {p.name}: {e}")
    else:
        # Generate ULQ/LQ/HQ resized images from original
        hq = compact / p.name
        lq = compact_lq / p.name
        ulq = compact_ulq / p.name
        try:
            save_resized(src, 512, hq)
            print(f"Saved HQ 512px for {p.name}")
            save_resized(src, 256, lq)
            print(f"Saved LQ 256px for {p.name}")
            save_resized(src, 96, ulq)
            print(f"Saved ULQ 96px for {p.name}")
        except Exception as e:
            print(f"Failed to resize {p.name}: {e}")

print("done!")
