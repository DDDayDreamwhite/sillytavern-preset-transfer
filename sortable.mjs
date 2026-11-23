export function attachSortable(container, onMove) {
    const events = new AbortController();
    let drag = null;
    let frame = 0;
    const listen = (type, callback) => container.addEventListener(type, callback, { signal: events.signal });
    function clearMarkers() {
        container.querySelectorAll('.pt-drop-before,.pt-drop-after').forEach(row => row.classList.remove('pt-drop-before', 'pt-drop-after'));
    }
    function cancel() {
        cancelAnimationFrame(frame);
        clearMarkers();
        container.querySelector('.pt-dragging')?.classList.remove('pt-dragging');
        const pointer = drag?.pointer;
        drag = null;
        if (pointer !== undefined && container.hasPointerCapture(pointer)) container.releasePointerCapture(pointer);
    }
    function paint() {
        if (!drag) return;
        if (drag.started) {
            const bounds = container.getBoundingClientRect();
            if (drag.y < bounds.top + 44) container.scrollTop -= Math.min(16, (bounds.top + 44 - drag.y) / 3);
            else if (drag.y > bounds.bottom - 44) container.scrollTop += Math.min(16, (drag.y - bounds.bottom + 44) / 3);
            const rows = [...container.querySelectorAll('.pt-order-row')];
            let insertion = rows.findIndex(row => {
                const box = row.getBoundingClientRect();
                return drag.y < box.top + box.height / 2;
            });
            if (insertion < 0) insertion = rows.length;
            drag.to = insertion - (insertion > drag.from ? 1 : 0);
            clearMarkers();
            if (drag.to !== drag.from) {
                if (insertion < rows.length) rows[insertion].classList.add('pt-drop-before');
                else rows.at(-1)?.classList.add('pt-drop-after');
            }
        }
        frame = requestAnimationFrame(paint);
    }
    listen('pointerdown', event => {
        const handle = event.target.closest('.pt-drag-handle');
        if (!handle || event.button !== 0 || drag) return;
        const index = Number(handle.closest('.pt-order-row').dataset.index);
        handle.focus({ preventScroll: true });
        drag = { pointer: event.pointerId, from: index, to: index, startY: event.clientY, y: event.clientY, x: event.clientX, started: false };
        container.setPointerCapture(event.pointerId);
        event.preventDefault();
        frame = requestAnimationFrame(paint);
    });
    listen('pointermove', event => {
        if (!drag || event.pointerId !== drag.pointer) return;
        drag.y = event.clientY; drag.x = event.clientX;
        if (Math.abs(drag.y - drag.startY) > 5) {
            drag.started = true;
            container.children[drag.from]?.classList.add('pt-dragging');
        }
    });
    listen('pointerup', event => {
        if (!drag || event.pointerId !== drag.pointer) return;
        const bounds = container.getBoundingClientRect();
        const { from, to, started, x } = drag;
        cancel();
        if (started && from !== to && x >= bounds.left - 40 && x <= bounds.right + 40) onMove(from, to);
    });
    listen('pointercancel', cancel);
    listen('lostpointercapture', cancel);
    listen('keydown', event => { if (event.key === 'Escape') cancel(); });
    return () => { cancel(); events.abort(); };
}
