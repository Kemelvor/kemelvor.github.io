function positionHighlightToItem(item) {
    const highlight = document.querySelector(".navbar_footer_highlight");
    const footer = document.querySelector(".navbar_footer");
    if (!item || !highlight || !footer) return;

    const itemRect = item.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();

    // Position and size in pixels so it's resolution/viewport independent
    const leftPx = itemRect.left - footerRect.left;
    const widthPx = itemRect.width;

    highlight.style.left = `${leftPx}px`;
    highlight.style.width = `${widthPx}px`;
}

document.addEventListener("DOMContentLoaded", function () {
    const navbar = document.querySelector(".navbar");
    const items = document.querySelectorAll(".navbar_item");
    if (!navbar || items.length === 0) return;

    let activeIndex = 0;

    // Initial placement under the first item
    positionHighlightToItem(items[activeIndex]);

    items.forEach((item, index) => {
        item.addEventListener("mouseenter", () => {
            positionHighlightToItem(item);
        });
        item.addEventListener("click", () => {
            activeIndex = index;
            positionHighlightToItem(item);
        });
    });

    // When leaving the navbar, snap back to the active item
    navbar.addEventListener("mouseleave", () => {
        positionHighlightToItem(items[activeIndex]);
    });

    // Recompute on resize to keep alignment correct
    window.addEventListener("resize", () => {
        positionHighlightToItem(items[activeIndex]);
    });
});