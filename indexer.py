from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, asdict
import zipfile
import tarfile
import io
from pathlib import Path
from typing import Dict, List, Optional
import subprocess
import shutil
import tempfile

# GUI imports are optional until runtime; provide a helpful message if missing
try:
    from PySide6 import QtCore, QtGui, QtWidgets
    from PySide6 import QtMultimedia, QtMultimediaWidgets
except Exception as e:  # pragma: no cover
    QtCore = QtGui = QtWidgets = None  # type: ignore
    QtMultimedia = QtMultimediaWidgets = None  # type: ignore


ART_EXTS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".mp4",
    ".webp",
    ".bmp",
    ".tiff",
    ".svg",
    ".avif",
}


@dataclass
class Artwork:
    fname: str
    id: int
    date: float
    title: str
    featured: bool = False
    featured_rank: Optional[int] = None  # 1..N within featured, sparse allowed
    # Source fields
    source_type: str = "fs"  # 'fs' | 'zip' | 'tar'
    source_path: Optional[str] = None  # absolute path for archives
    inner_path: Optional[str] = None  # path within the archive

    def uid(self) -> str:
        if self.source_type == "fs":
            return f"fs|{self.fname}"
        return f"{self.source_type}|{self.source_path}|{self.inner_path}"


def get_creation_time(p: Path) -> float:
    st = p.stat()
    # Prefer birthtime when available, fallback to ctime
    return getattr(st, "st_birthtime", st.st_ctime)


def scan_art_directory(directory: Path) -> List[Dict]:
    files = []
    for p in directory.iterdir():
        if p.is_file() and p.suffix.lower() in ART_EXTS:
            files.append(
                {
                    "fname": p.name,
                    "date": get_creation_time(p),
                }
            )
    return sorted(files, key=lambda x: x["date"], reverse=True)


def scan_zip_archive(zpath: Path) -> List[Dict]:
    items: List[Dict] = []
    try:
        with zipfile.ZipFile(zpath, "r") as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                suffix = Path(info.filename).suffix.lower()
                if suffix not in ART_EXTS:
                    continue
                # ZipInfo has date_time (Y,M,D,H,M,S), convert to timestamp using time.mktime
                try:
                    from datetime import datetime

                    dt = datetime(*info.date_time)
                    date_ts = dt.timestamp()
                except Exception:
                    date_ts = 0.0
                items.append(
                    {
                        "fname": os.path.basename(info.filename),
                        "date": float(date_ts),
                        "source_type": "zip",
                        "source_path": str(zpath.resolve()),
                        "inner_path": info.filename,
                    }
                )
    except Exception:
        pass
    return items


def scan_tar_archive(tpath: Path) -> List[Dict]:
    items: List[Dict] = []
    mode = "r:*"  # auto-detect compression
    try:
        with tarfile.open(tpath, mode) as tf:
            for member in tf.getmembers():
                if not member.isfile():
                    continue
                suffix = Path(member.name).suffix.lower()
                if suffix not in ART_EXTS:
                    continue
                date_ts = float(getattr(member, "mtime", 0.0))
                items.append(
                    {
                        "fname": os.path.basename(member.name),
                        "date": date_ts,
                        "source_type": "tar",
                        "source_path": str(tpath.resolve()),
                        "inner_path": member.name,
                    }
                )
    except Exception:
        pass
    return items


def _uid_for_loaded_item(item: Dict) -> str:
    st = item.get("source_type", "fs")
    if st == "fs":
        return f"fs|{item['fname']}"
    return f"{st}|{item.get('source_path')}|{item.get('inner_path')}"


def load_metadata(meta_json: Path, legacy_txt: Path) -> Dict[str, Artwork]:
    result: Dict[str, Artwork] = {}
    # Prefer JSON metadata
    if meta_json.exists():
        try:
            data = json.loads(meta_json.read_text(encoding="utf-8"))
            for idx, item in enumerate(data):
                art = Artwork(
                    fname=item["fname"],
                    id=int(item.get("id", idx + 1)),
                    date=float(item.get("date", 0)),
                    title=item.get("title", Path(item["fname"]).stem),
                    featured=bool(item.get("featured", False)),
                    featured_rank=(
                        int(item["featured_rank"])
                        if item.get("featured_rank") is not None
                        else None
                    ),
                    source_type=item.get("source_type", "fs"),
                    source_path=item.get("source_path"),
                    inner_path=item.get("inner_path"),
                )
                result[art.uid()] = art
            return result
        except Exception:
            pass  # Fallback to legacy

    # Fallback: attempt to parse legacy text if present (expects JSON list)
    if legacy_txt.exists():
        try:
            data = json.loads(legacy_txt.read_text(encoding="utf-8"))
            for idx, item in enumerate(data):
                art = Artwork(
                    fname=item["fname"],
                    id=int(item.get("id", idx + 1)),
                    date=float(item.get("date", 0)),
                    title=Path(item["fname"]).stem,
                )
                result[art.uid()] = art
        except Exception:
            # ignore malformed legacy file
            pass
    return result


def save_metadata(directory: Path, artworks: List[Artwork]) -> None:
    # Persist full metadata
    meta_json = directory / "artlist.json"
    data = [asdict(a) for a in artworks]
    meta_json.write_text(json.dumps(data, indent=2), encoding="utf-8")


def load_archives_config(directory: Path) -> Dict:
    cfg_path = directory / "archives.json"
    if not cfg_path.exists():
        return {"archives": [], "include_folder": True}
    try:
        return json.loads(cfg_path.read_text(encoding="utf-8"))
    except Exception:
        return {"archives": [], "include_folder": True}


def save_archives_config(
    directory: Path, archives: List[Path], include_folder: bool
) -> None:
    cfg = {
        "archives": [str(p) for p in archives],
        "include_folder": bool(include_folder),
    }
    (directory / "archives.json").write_text(
        json.dumps(cfg, indent=2), encoding="utf-8"
    )


if QtWidgets is not None:

    class PreviewWidget(QtWidgets.QStackedWidget):
        def __init__(self, parent=None):
            super().__init__(parent)
            # Image/GIF label
            self.image_label = QtWidgets.QLabel()
            self.image_label.setAlignment(QtCore.Qt.AlignCenter)
            self.image_label.setSizePolicy(QtWidgets.QSizePolicy.Expanding, QtWidgets.QSizePolicy.Expanding)
            # Video view if available
            self.video_view = None
            self.player = None
            if QtMultimediaWidgets is not None and QtMultimedia is not None:
                self.video_view = QtMultimediaWidgets.QVideoWidget()
                self.player = QtMultimedia.QMediaPlayer()
                self.player.setVideoOutput(self.video_view)
            # Add widgets
            self.addWidget(self.image_label)
            if self.video_view is not None:
                self.addWidget(self.video_view)
            self.setMinimumSize(400, 300)

        def show_image(self, pix):
            if self.player:
                self.player.stop()
            if pix.isNull():
                self.image_label.clear()
            else:
                # Scale on set; also rescale on resize
                self._pix = pix
                self._rescale_image()
            self.setCurrentWidget(self.image_label)

        def set_image_path(self, path: Path):
            # GIFs will animate via QMovie
            suffix = path.suffix.lower()
            if suffix == '.gif':
                movie = QtGui.QMovie(str(path))
                self.image_label.setMovie(movie)
                movie.start()
                self.setCurrentWidget(self.image_label)
            else:
                self.image_label.setMovie(None)
                pix = QtGui.QPixmap(str(path))
                self.show_image(pix)

        def set_pixmap(self, pixmap):
            self.image_label.setMovie(None)
            self.show_image(pixmap if pixmap is not None else QtGui.QPixmap())

        def set_video_path(self, path: Path):
            if self.player and self.video_view:
                self.player.setSource(QtCore.QUrl.fromLocalFile(str(path)))
                try:
                    self.player.setLoops(QtMultimedia.QMediaPlayer.Loops.Infinite)
                except Exception:
                    pass
                self.player.play()
                self.setCurrentWidget(self.video_view)
            else:
                # Fallback: show a placeholder
                self.image_label.setText("Video preview not supported")
                self.setCurrentWidget(self.image_label)

        def resizeEvent(self, event):  # type: ignore[override]
            super().resizeEvent(event)
            self._rescale_image()

        def _rescale_image(self):
            if not hasattr(self, '_pix'):
                return
            pix = self._pix
            if pix.isNull():
                return
            target = self.image_label.contentsRect().adjusted(4, 4, -4, -4)
            scaled = pix.scaled(target.size(), QtCore.Qt.KeepAspectRatio, QtCore.Qt.SmoothTransformation)
            self.image_label.setPixmap(scaled)

    class ThumbCache:
        def __init__(self, base_dir: Path, thumb_size: int = 80):
            self.base_dir = base_dir
            self.thumb_size = thumb_size
            self.cache: Dict[str, object] = {}

        def _scale_pix(self, pix):
            if not pix.isNull():
                h = self.thumb_size
                pix = pix.scaledToHeight(h, QtCore.Qt.SmoothTransformation)
            return pix

        def _placeholder_pix(self, label: str = "MP4"):
            w = self.thumb_size * 4 // 3
            h = self.thumb_size
            pm = QtGui.QPixmap(w, h)
            pm.fill(QtGui.QColor(40, 40, 40))
            painter = QtGui.QPainter(pm)
            painter.setPen(QtGui.QColor(255, 255, 255))
            font = painter.font()
            font.setBold(True)
            painter.setFont(font)
            painter.drawText(pm.rect(), QtCore.Qt.AlignCenter, label)
            painter.end()
            return pm

        def icon_for_artwork(self, art: Artwork) -> object:
            key = art.uid()
            if key in self.cache:
                return self.cache[key]
            pix = QtGui.QPixmap()
            ext = Path(art.fname).suffix.lower()
            if ext == '.mp4':
                pix = self._placeholder_pix()
            elif art.source_type == "fs":
                pix = QtGui.QPixmap(str(self.base_dir / art.fname))
            elif art.source_type == "zip" and art.source_path and art.inner_path:
                try:
                    with zipfile.ZipFile(art.source_path, "r") as zf:
                        data = zf.read(art.inner_path)
                    pix.loadFromData(QtCore.QByteArray(data))
                except Exception:
                    pass
            elif art.source_type == "tar" and art.source_path and art.inner_path:
                try:
                    with tarfile.open(art.source_path, "r:*") as tf:
                        f = tf.extractfile(art.inner_path)
                        if f:
                            data = f.read()
                            pix.loadFromData(QtCore.QByteArray(data))
                except Exception:
                    pass
            icon = QtGui.QIcon(self._scale_pix(pix))
            self.cache[key] = icon
            return icon

        def pixmap_for_artwork(self, art: Artwork):
            pix = QtGui.QPixmap()
            ext = Path(art.fname).suffix.lower()
            if ext == '.mp4':
                return self._placeholder_pix()
            if art.source_type == "fs":
                pix = QtGui.QPixmap(str(self.base_dir / art.fname))
            elif art.source_type == "zip" and art.source_path and art.inner_path:
                try:
                    with zipfile.ZipFile(art.source_path, "r") as zf:
                        data = zf.read(art.inner_path)
                    pix.loadFromData(QtCore.QByteArray(data))
                except Exception:
                    pass
            elif art.source_type == "tar" and art.source_path and art.inner_path:
                try:
                    with tarfile.open(art.source_path, "r:*") as tf:
                        f = tf.extractfile(art.inner_path)
                        if f:
                            data = f.read()
                            pix.loadFromData(QtCore.QByteArray(data))
                except Exception:
                    pass
            return pix


if QtWidgets is not None:

    class ArtModel(QtGui.QStandardItemModel):
        COL_TITLE = 0

        def __init__(self, parent=None):
            super().__init__(parent)
            self.setColumnCount(1)
            self.setHorizontalHeaderLabels(["Artwork"])

        def add_artwork_item(self, art: Artwork, icon: Optional[object] = None):
            text = self._format_text(art)
            item = QtGui.QStandardItem(text)
            item.setEditable(True)
            item.setCheckable(True)
            item.setCheckState(
                QtCore.Qt.Checked if art.featured else QtCore.Qt.Unchecked
            )
            if icon is not None:
                item.setIcon(icon)  # type: ignore[arg-type]
            item.setData(art.fname, QtCore.Qt.UserRole + 1)
            item.setData(art, QtCore.Qt.UserRole + 2)  # store object
            # Enable drag/drop reordering
            item.setFlags(
                QtCore.Qt.ItemIsEnabled
                | QtCore.Qt.ItemIsSelectable
                | QtCore.Qt.ItemIsEditable
                | QtCore.Qt.ItemIsUserCheckable
                | QtCore.Qt.ItemIsDragEnabled
                | QtCore.Qt.ItemIsDropEnabled
            )
            self.appendRow(item)
            return item

        def artworks(self) -> List[Artwork]:
            arts: List[Artwork] = []
            for row in range(self.rowCount()):
                item = self.item(row, self.COL_TITLE)
                art: Artwork = item.data(QtCore.Qt.UserRole + 2)
                # Update title from edited text without featured adornment
                art.title = self._extract_title_from_item_text(item.text())
                art.featured = item.checkState() == QtCore.Qt.Checked
                arts.append(art)
            # Assign sequential ids based on current order
            for i, a in enumerate(arts, start=1):
                a.id = i
            # Assign featured ranks compactly in current order among featured
            rank = 1
            for a in arts:
                if a.featured:
                    a.featured_rank = rank
                    rank += 1
                else:
                    a.featured_rank = None
            return arts

        def _format_text(self, art: Artwork) -> str:
            feat = (
                f"  ★{art.featured_rank}" if art.featured and art.featured_rank else ""
            )
            return f"{art.title}{feat}\n{art.fname}"

        def _extract_title_from_item_text(self, text: str) -> str:
            # Stored as: "<title>  ★N\n<fname>"
            title_line = text.splitlines()[0] if text else ""
            # Strip featured tag if present
            star_idx = title_line.find("★")
            if star_idx != -1:
                title_line = title_line[:star_idx].rstrip()
            return title_line


if QtWidgets is not None:

    class FeaturedController(QtCore.QObject):
        featured_changed = QtCore.Signal()

        def __init__(self, model: ArtModel):
            super().__init__()
            self.model = model

        def refresh_featured_ranks(self):
            arts = self.model.artworks()
            # Update item texts to reflect ranks
            # Map fname -> rank
            rank_map = {a.uid(): a.featured_rank for a in arts}
            for row in range(self.model.rowCount()):
                item = self.model.item(row, 0)
                art: Artwork = item.data(QtCore.Qt.UserRole + 2)
                art.featured_rank = rank_map.get(art.uid())
                item.setText(self.model._format_text(art))
            self.featured_changed.emit()

        def set_featured(self, item, is_featured: bool):
            item.setCheckState(
                QtCore.Qt.Checked if is_featured else QtCore.Qt.Unchecked
            )
            self.refresh_featured_ranks()

        def move_featured(self, item, direction: int):
            # direction: -1 up, +1 down within featured ordering
            arts = self.model.artworks()
            featured = [a for a in arts if a.featured]
            if not featured:
                return
            # Find index in featured by fname
            art: Artwork = item.data(QtCore.Qt.UserRole + 2)
            try:
                idx = next(i for i, a in enumerate(featured) if a.uid() == art.uid())
            except StopIteration:
                return
            new_idx = max(0, min(len(featured) - 1, idx + direction))
            if new_idx == idx:
                return
            # Swap ranks
            featured[idx], featured[new_idx] = featured[new_idx], featured[idx]
            # Reassign ranks sequentially
            for rank, a in enumerate(featured, start=1):
                a.featured_rank = rank
            # Update underlying items by fname
            rank_map = {a.uid(): a.featured_rank for a in featured}
            for row in range(self.model.rowCount()):
                it = self.model.item(row, 0)
                a2: Artwork = it.data(QtCore.Qt.UserRole + 2)
                if a2.uid() in rank_map:
                    a2.featured_rank = rank_map[a2.uid()]
                    it.setText(self.model._format_text(a2))
            self.featured_changed.emit()


if QtWidgets is not None:

    class IndexerWindow(QtWidgets.QMainWindow):
        def __init__(self, directory: Path):
            super().__init__()
            self.setWindowTitle("Art Indexer")
            self.resize(1100, 700)
            self.directory = directory
            self.meta_json = directory / "artlist.json"
            self.legacy_txt = directory / "artlist.txt"
            self.thumb_cache = ThumbCache(directory, thumb_size=80)

            # Models and views
            self.model = ArtModel(self)
            self.featured_ctl = FeaturedController(self.model)

            self.search_edit = QtWidgets.QLineEdit(
                placeholderText="Search title or file name…"
            )
            self.show_featured_only = QtWidgets.QCheckBox("Show featured only")
            self.list_view = QtWidgets.QTreeView()
            self.list_view.setModel(self.model)
            self.list_view.setRootIsDecorated(False)
            self.list_view.setHeaderHidden(True)
            self.list_view.setSelectionMode(QtWidgets.QAbstractItemView.SingleSelection)
            self.list_view.setDragDropMode(QtWidgets.QAbstractItemView.InternalMove)
            self.list_view.setDefaultDropAction(QtCore.Qt.MoveAction)
            self.list_view.setDragEnabled(True)
            self.list_view.setAcceptDrops(True)
            self.list_view.setAlternatingRowColors(True)

            # Detail panel
            self.preview = PreviewWidget()
            self.preview_frame = QtWidgets.QFrame()
            self.preview_frame.setFrameShape(QtWidgets.QFrame.StyledPanel)
            self.preview_frame.setLayout(QtWidgets.QVBoxLayout())
            self.preview_frame.layout().setContentsMargins(0, 0, 0, 0)
            self.preview_frame.layout().addWidget(self.preview)
            self.title_edit = QtWidgets.QLineEdit()
            self.featured_check = QtWidgets.QCheckBox("Featured")
            self.btn_feat_up = QtWidgets.QToolButton(text="▲")
            self.btn_feat_down = QtWidgets.QToolButton(text="▼")
            # Sorting controls
            self.sort_combo = QtWidgets.QComboBox()
            self.sort_combo.addItems(
                [
                    "Custom (id)",
                    "Date (newest first)",
                    "Date (oldest first)",
                    "File name (A→Z)",
                    "File name (Z→A)",
                    "Title (A→Z)",
                    "Title (Z→A)",
                    "Featured rank (1→N)",
                ]
            )
            self.btn_apply_sort = QtWidgets.QPushButton("Apply sort")

            # Sources (archives)
            self.include_folder_check = QtWidgets.QCheckBox("Include folder items")
            self.archives_list = QtWidgets.QListWidget()
            self.btn_add_zip = QtWidgets.QPushButton("Add ZIP…")
            self.btn_add_tar = QtWidgets.QPushButton("Add TAR…")
            self.btn_remove_archive = QtWidgets.QPushButton("Remove selected")
            self.btn_clear_archives = QtWidgets.QPushButton("Clear all")

            # Actions
            self.btn_rescan = QtWidgets.QPushButton("Rescan")
            self.btn_save = QtWidgets.QPushButton("Save")
            self.btn_export = QtWidgets.QPushButton("Export list + files")

            # Layouts
            left = QtWidgets.QWidget()
            left_layout = QtWidgets.QVBoxLayout(left)
            left_layout.addWidget(self.search_edit)
            left_layout.addWidget(self.show_featured_only)
            left_layout.addWidget(self.list_view, 1)

            right = QtWidgets.QWidget()
            right_layout = QtWidgets.QFormLayout(right)
            right_layout.setFieldGrowthPolicy(
                QtWidgets.QFormLayout.AllNonFixedFieldsGrow
            )
            right_layout.addRow("Preview", self.preview_frame)
            right_layout.addRow("Title", self.title_edit)
            feat_row = QtWidgets.QHBoxLayout()
            feat_row.addWidget(self.featured_check)
            feat_row.addStretch(1)
            feat_row.addWidget(QtWidgets.QLabel("Order:"))
            feat_row.addWidget(self.btn_feat_up)
            feat_row.addWidget(self.btn_feat_down)
            feat_container = QtWidgets.QWidget()
            feat_container.setLayout(feat_row)
            right_layout.addRow("Featured", feat_container)
            # Sources row
            sources_col = QtWidgets.QWidget()
            sources_layout = QtWidgets.QGridLayout(sources_col)
            sources_layout.addWidget(self.include_folder_check, 0, 0, 1, 3)
            sources_layout.addWidget(QtWidgets.QLabel("Archives:"), 1, 0)
            sources_layout.addWidget(self.archives_list, 2, 0, 1, 3)
            sources_layout.addWidget(self.btn_add_zip, 3, 0)
            sources_layout.addWidget(self.btn_add_tar, 3, 1)
            sources_layout.addWidget(self.btn_remove_archive, 3, 2)
            sources_layout.addWidget(self.btn_clear_archives, 4, 0, 1, 3)
            right_layout.addRow("Sources", sources_col)
            # Sorting row
            sort_row = QtWidgets.QHBoxLayout()
            sort_row.addWidget(QtWidgets.QLabel("Sort by:"))
            sort_row.addWidget(self.sort_combo, 1)
            sort_row.addWidget(self.btn_apply_sort)
            sort_container = QtWidgets.QWidget()
            sort_container.setLayout(sort_row)
            right_layout.addRow("Sorting", sort_container)
            # Buttons
            btn_row = QtWidgets.QHBoxLayout()
            btn_row.addWidget(self.btn_rescan)
            btn_row.addStretch(1)
            btn_row.addWidget(self.btn_save)
            btn_row.addWidget(self.btn_export)
            right_layout.addRow(btn_row)

            splitter = QtWidgets.QSplitter()
            splitter.addWidget(left)
            splitter.addWidget(right)
            splitter.setStretchFactor(0, 3)
            splitter.setStretchFactor(1, 2)
            self.setCentralWidget(splitter)

            # Status
            self.status = self.statusBar()
            self.unsaved = False

            # Signals
            # Debounce filters for responsiveness
            self._filter_timer = QtCore.QTimer(self)
            self._filter_timer.setSingleShot(True)
            self._filter_timer.setInterval(120)
            self._filter_timer.timeout.connect(self.apply_filter)
            self.search_edit.textChanged.connect(lambda: self._filter_timer.start())
            self.show_featured_only.toggled.connect(self.apply_filter)
            self.model.itemChanged.connect(self.on_item_changed)
            self.model.rowsMoved.connect(self.on_rows_moved)
            self.list_view.selectionModel().currentChanged.connect(
                self.on_selection_changed
            )
            self.btn_save.clicked.connect(self.on_save)
            self.btn_rescan.clicked.connect(self.on_rescan)
            self.featured_check.toggled.connect(self.on_featured_toggled)
            self.btn_feat_up.clicked.connect(lambda: self.on_featured_move(-1))
            self.btn_feat_down.clicked.connect(lambda: self.on_featured_move(+1))
            self.featured_ctl.featured_changed.connect(self.refresh_preview)
            self.title_edit.textEdited.connect(self.on_title_edited)
            self.btn_apply_sort.clicked.connect(self.apply_sort)
            self.btn_add_zip.clicked.connect(lambda: self.add_archive("zip"))
            self.btn_add_tar.clicked.connect(lambda: self.add_archive("tar"))
            self.btn_remove_archive.clicked.connect(self.remove_selected_archive)
            self.btn_clear_archives.clicked.connect(self.clear_archives)
            self.include_folder_check.toggled.connect(self.on_sources_changed)
            self.btn_export.clicked.connect(self.export_list_and_files)

            # Initial load
            self.archives: List[Path] = []
            self.include_folder: bool = True
            self.load_sources_config()
            self.populate_model()
            if self.model.rowCount() > 0:
                self.list_view.setCurrentIndex(self.model.index(0, 0))

        # Data IO
        def populate_model(self):
            self.model.removeRows(0, self.model.rowCount())
            existing = load_metadata(self.meta_json, self.legacy_txt)
            # Gather items from folder and archives
            file_items: List[Dict] = []
            if self.include_folder:
                file_items.extend(scan_art_directory(self.directory))
            for ap in self.archives:
                if ap.suffix.lower() == ".zip":
                    file_items.extend(scan_zip_archive(ap))
                elif ap.suffix.lower() in (
                    ".tar",
                    ".tgz",
                    ".tar.gz",
                    ".tar.bz2",
                    ".tbz",
                    ".tbz2",
                    ".txz",
                    ".tar.xz",
                ):
                    file_items.extend(scan_tar_archive(ap))

            # Merge: keep metadata when available, else default
            items: List[Artwork] = []
            for idx, f in enumerate(file_items, start=1):
                # Build an Artwork and check for persisted metadata by UID
                art = Artwork(
                    fname=f["fname"],
                    id=idx,
                    date=float(f["date"]),
                    title=Path(f["fname"]).stem,
                    featured=False,
                    featured_rank=None,
                    source_type=f.get("source_type", "fs"),
                    source_path=f.get("source_path"),
                    inner_path=f.get("inner_path"),
                )
                prev = existing.get(art.uid())
                if prev:
                    # Merge metadata
                    art.title = prev.title
                    art.featured = prev.featured
                    art.featured_rank = prev.featured_rank
                    # keep previous id if present to preserve custom order by default sort
                    if prev.id:
                        art.id = prev.id
                items.append(art)

            # Sort by id (persisted order)
            items.sort(key=lambda a: (a.id if a.id else 10**9))

            # Assign compact featured ranks in order
            rank = 1
            for a in items:
                if a.featured:
                    a.featured_rank = rank
                    rank += 1

            for a in items:
                icon = self.thumb_cache.icon_for_artwork(a)
                self.model.add_artwork_item(a, icon)

        # Filtering
        def apply_filter(self):
            query = self.search_edit.text().strip().lower()
            featured_only = self.show_featured_only.isChecked()
            for row in range(self.model.rowCount()):
                idx = self.model.index(row, 0)
                item = self.model.itemFromIndex(idx)
                art: Artwork = item.data(QtCore.Qt.UserRole + 2)
                visible = True
                if query:
                    visible = query in art.title.lower() or query in art.fname.lower()
                if featured_only:
                    visible = visible and item.checkState() == QtCore.Qt.Checked
                self.list_view.setRowHidden(row, QtCore.QModelIndex(), not visible)

        # UI reactions
        def on_item_changed(self, item):
            # Update featured ranks and preview when check state or text changes
            self.featured_ctl.refresh_featured_ranks()
            self.unsaved = True
            self.status.showMessage("Unsaved changes", 2000)

        def on_selection_changed(self, current, previous):
            self.refresh_preview()

        def current_item(self):
            idx = self.list_view.currentIndex()
            if not idx.isValid():
                return None
            return self.model.itemFromIndex(idx)

        def refresh_preview(self):
            item = self.current_item()
            if not item:
                # Clear preview
                self.preview.set_image_path(Path())
                self.title_edit.clear()
                self.featured_check.setChecked(False)
                return
            art: Artwork = item.data(QtCore.Qt.UserRole + 2)
            # Load according to source and type
            ext = Path(art.fname).suffix.lower()
            if art.source_type == "fs":
                if ext == '.mp4':
                    self.preview.set_video_path(self.directory / art.fname)
                else:
                    self.preview.set_image_path(self.directory / art.fname)
            else:
                if ext == '.mp4':
                    # No player for archives; show placeholder
                    pm = self.thumb_cache.pixmap_for_artwork(art)
                    self.preview.set_pixmap(pm)
                else:
                    pix = self.thumb_cache.pixmap_for_artwork(art)
                    self.preview.set_pixmap(pix)
            # Meta
            self.title_edit.blockSignals(True)
            self.title_edit.setText(art.title)
            self.title_edit.blockSignals(False)
            self.featured_check.blockSignals(True)
            self.featured_check.setChecked(item.checkState() == QtCore.Qt.Checked)
            self.featured_check.blockSignals(False)

        def resizeEvent(self, event):  # type: ignore[override]
            super().resizeEvent(event)
            self.refresh_preview()

        def on_featured_toggled(self, checked: bool):
            item = self.current_item()
            if not item:
                return
            self.featured_ctl.set_featured(item, checked)
            self.unsaved = True

        def on_featured_move(self, direction: int):
            item = self.current_item()
            if not item:
                return
            if item.checkState() != QtCore.Qt.Checked:
                return
            # Move the actual row up/down to reflect custom order
            row = item.row()
            new_row = max(0, min(self.model.rowCount() - 1, row + direction))
            if new_row == row:
                return
            taken = self.model.takeRow(row)
            self.model.insertRow(new_row, taken)
            # Keep selection on moved item
            self.list_view.setCurrentIndex(self.model.index(new_row, 0))
            self.featured_ctl.refresh_featured_ranks()
            self.unsaved = True

        def on_title_edited(self, text: str):
            item = self.current_item()
            if not item:
                return
            art: Artwork = item.data(QtCore.Qt.UserRole + 2)
            art.title = text
            item.setText(self.model._format_text(art))
            self.unsaved = True

        def on_rows_moved(self, *args):
            # Drag-drop reordering should refresh ranks and mark unsaved
            # Debounce to avoid repeated work during continuous drag
            if not hasattr(self, "_rank_timer"):
                self._rank_timer = QtCore.QTimer(self)
                self._rank_timer.setSingleShot(True)
                self._rank_timer.setInterval(80)
                self._rank_timer.timeout.connect(
                    lambda: (
                        self.featured_ctl.refresh_featured_ranks(),
                        setattr(self, "unsaved", True),
                    )
                )
            self._rank_timer.start()

        def apply_sort(self):
            mode = self.sort_combo.currentText()
            # Extract items
            arts = self.model.artworks()
            if mode == "Custom (id)":
                arts.sort(key=lambda a: a.id)
            elif mode == "Date (newest first)":
                arts.sort(key=lambda a: a.date, reverse=True)
            elif mode == "Date (oldest first)":
                arts.sort(key=lambda a: a.date)
            elif mode == "File name (A→Z)":
                arts.sort(key=lambda a: a.fname.lower())
            elif mode == "File name (Z→A)":
                arts.sort(key=lambda a: a.fname.lower(), reverse=True)
            elif mode == "Title (A→Z)":
                arts.sort(key=lambda a: a.title.lower())
            elif mode == "Title (Z→A)":
                arts.sort(key=lambda a: a.title.lower(), reverse=True)
            elif mode == "Featured rank (1→N)":
                # Non-featured at end
                arts.sort(
                    key=lambda a: (
                        a.featured_rank is None,
                        a.featured_rank or 1_000_000,
                    )
                )
            # Rebuild model in that order
            self.model.removeRows(0, self.model.rowCount())
            for a in arts:
                icon = self.thumb_cache.icon_for_artwork(a)
                self.model.add_artwork_item(a, icon)
            self.featured_ctl.refresh_featured_ranks()
            self.unsaved = True

        def on_rescan(self):
            self.populate_model()
            self.apply_filter()
            self.status.showMessage("Rescanned directory", 2000)

        # Source management
        def load_sources_config(self):
            cfg = load_archives_config(self.directory)
            self.include_folder = bool(cfg.get("include_folder", True))
            self.include_folder_check.setChecked(self.include_folder)
            self.archives = [Path(p) for p in cfg.get("archives", []) if p]
            self.refresh_archives_list()

        def refresh_archives_list(self):
            self.archives_list.clear()
            for p in self.archives:
                self.archives_list.addItem(str(p))

        def on_sources_changed(self):
            self.include_folder = self.include_folder_check.isChecked()
            save_archives_config(self.directory, self.archives, self.include_folder)
            self.populate_model()
            self.apply_filter()

        def add_archive(self, kind: str):
            if kind == "zip":
                path, _ = QtWidgets.QFileDialog.getOpenFileName(
                    self,
                    "Select ZIP archive",
                    str(self.directory),
                    "Zip Archives (*.zip)",
                )
            else:
                path, _ = QtWidgets.QFileDialog.getOpenFileName(
                    self,
                    "Select TAR archive",
                    str(self.directory),
                    "Tar Archives (*.tar *.tgz *.tar.gz *.tar.bz2 *.tbz *.tbz2 *.txz *.tar.xz)",
                )
            if not path:
                return
            p = Path(path)
            if not p.exists():
                return
            self.archives.append(p)
            self.refresh_archives_list()
            save_archives_config(self.directory, self.archives, self.include_folder)
            self.populate_model()
            self.apply_filter()

        def remove_selected_archive(self):
            row = self.archives_list.currentRow()
            if row < 0:
                return
            self.archives.pop(row)
            self.refresh_archives_list()
            save_archives_config(self.directory, self.archives, self.include_folder)
            self.populate_model()
            self.apply_filter()

        def clear_archives(self):
            if not self.archives:
                return
            self.archives.clear()
            self.refresh_archives_list()
            save_archives_config(self.directory, self.archives, self.include_folder)
            self.populate_model()
            self.apply_filter()

        def on_save(self):
            arts = self.model.artworks()
            save_metadata(self.directory, arts)
            self.unsaved = False
            self.status.showMessage("Saved artlist.json", 3000)

        def export_list_and_files(self):
            arts = self.model.artworks()
            export_dir = self.directory
            exported = 0
            renamed = 0
            failed = 0

            def unique_name(name: str) -> str:
                stem = Path(name).stem
                ext = Path(name).suffix
                i = 1
                candidate = name
                while (export_dir / candidate).exists():
                    i += 1
                    candidate = f"{stem}-{i}{ext}"
                return candidate

            for row in range(self.model.rowCount()):
                item = self.model.item(row, 0)
                art: Artwork = item.data(QtCore.Qt.UserRole + 2)
                try:
                    ext = Path(art.fname).suffix.lower()
                    if art.source_type == 'fs':
                        # Already in export dir by design; ensure MP4->GIF if needed
                        if ext == '.mp4':
                            src_path = export_dir / art.fname
                            if src_path.exists():
                                gif_name = f"{Path(art.fname).stem}.gif"
                                gif_name_final = gif_name if not (export_dir / gif_name).exists() else unique_name(gif_name)
                                gif_path = export_dir / gif_name_final
                                self._convert_mp4_to_gif(src_path, gif_path)
                                # Update to gif
                                art.fname = gif_name_final
                                # Update UI
                                item.setText(self.model._format_text(art))
                                icon = self.thumb_cache.icon_for_artwork(art)
                                item.setIcon(icon)
                                exported += 1
                        continue
                    data: bytes = b''
                    # Read from archive
                    if art.source_type == 'zip' and art.source_path and art.inner_path:
                        with zipfile.ZipFile(art.source_path, 'r') as zf:
                            data = zf.read(art.inner_path)
                    elif art.source_type == 'tar' and art.source_path and art.inner_path:
                        with tarfile.open(art.source_path, 'r:*') as tf:
                            f = tf.extractfile(art.inner_path)
                            if f:
                                data = f.read()
                    else:
                        failed += 1
                        continue
                    # Determine target name, avoid clobbering existing files
                    target_name = art.fname
                    target_path = export_dir / target_name
                    if Path(art.fname).suffix.lower() == '.mp4':
                        # Write temp mp4 then convert to gif
                        with tempfile.NamedTemporaryFile(delete=False, suffix='.mp4') as tmp:
                            tmp.write(data)
                            tmp_path = Path(tmp.name)
                        gif_name = f"{Path(art.fname).stem}.gif"
                        gif_name_final = gif_name if not (export_dir / gif_name).exists() else unique_name(gif_name)
                        gif_path = export_dir / gif_name_final
                        self._convert_mp4_to_gif(tmp_path, gif_path)
                        try:
                            tmp_path.unlink(missing_ok=True)
                        except Exception:
                            pass
                        # Update artwork to gif
                        art.fname = gif_name_final
                        art.source_type = 'fs'
                        art.source_path = None
                        art.inner_path = None
                        exported += 1
                        # Update UI
                        item.setText(self.model._format_text(art))
                        icon = self.thumb_cache.icon_for_artwork(art)
                        item.setIcon(icon)
                        continue
                    if target_path.exists():
                        new_name = unique_name(target_name)
                        target_name = new_name
                        target_path = export_dir / target_name
                        renamed += 1
                    # Write file
                    target_path.write_bytes(data)
                    exported += 1
                    # Update artwork to point to fs copy
                    art.fname = target_name
                    art.source_type = 'fs'
                    art.source_path = None
                    art.inner_path = None
                    # Update UI item text and icon
                    item.setText(self.model._format_text(art))
                    icon = self.thumb_cache.icon_for_artwork(art)
                    item.setIcon(icon)
                except Exception:
                    failed += 1
                    continue

            # Save updated metadata
            save_metadata(export_dir, self.model.artworks())
            self.unsaved = False
            self.status.showMessage(
                f"Export complete: {exported} files, {renamed} renamed, {failed} failed. Saved artlist.json.",
                5000,
            )

        def _convert_mp4_to_gif(self, src: Path, dst: Path):
            # Requires ffmpeg in PATH
            ff = shutil.which('ffmpeg')
            if not ff:
                # Best effort: mark as failed by touching empty gif so pipeline continues
                dst.write_bytes(b'')
                return
            # Reasonable default palette-based conversion
            #  -r 12 for frame rate, scale down wide videos to ~720 width keeping ratio
            #  palettegen/paletteuse for good colors
            palette = dst.with_suffix('.palette.png')
            try:
                subprocess.run([ff, '-y', '-i', str(src), '-vf', 'fps=12,scale=720:-1:flags=lanczos,palettegen', str(palette)], check=True)
                subprocess.run([ff, '-y', '-i', str(src), '-i', str(palette), '-lavfi', 'fps=12,scale=720:-1:flags=lanczos [x]; [x][1:v] paletteuse', str(dst)], check=True)
            except subprocess.CalledProcessError:
                # Fallback simple conversion
                subprocess.run([ff, '-y', '-i', str(src), '-r', '12', str(dst)], check=False)
            finally:
                try:
                    palette.unlink(missing_ok=True)
                except Exception:
                    pass


def run_gui():
    if QtWidgets is None:
        print("PySide6 is required. Install with: pip install PySide6")
        sys.exit(1)
    base_dir = Path(__file__).parent / "src" / "art"
    if not base_dir.exists():
        print(f"Art directory not found: {base_dir}")
        base_dir.mkdir(parents=True, exist_ok=True)
    app = QtWidgets.QApplication(sys.argv)
    win = IndexerWindow(base_dir)  # type: ignore[name-defined]
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    # Default to GUI. If "--headless" passed, perform a one-shot index and write legacy file.
    if "--headless" in sys.argv:
        base_dir = Path(__file__).parent / "src" / "art"
        files = scan_art_directory(base_dir)
        artworks = [
            Artwork(
                fname=f["fname"],
                id=i + 1,
                date=f["date"],
                title=Path(f["fname"]).stem,
            )
            for i, f in enumerate(files)
        ]
        save_metadata(base_dir, artworks)
        print(f"Indexed {len(artworks)} items to artlist.json and artlist.txt")
    else:
        run_gui()
