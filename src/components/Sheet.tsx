import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './sheet.css';

interface Props {
  open: boolean;
  title?: ReactNode;
  onClose(): void;
  children: ReactNode;
  /** Sticky footer (primary actions) that never scrolls away. */
  footer?: ReactNode;
  /** 'auto' hugs content up to 88vh; 'tall' opens at 88vh. */
  size?: 'auto' | 'tall';
  /** Accessible name for the dialog. Defaults to the title when it is plain
      text — a role="dialog" gets no name from its contents, and an unnamed
      dialog is unfindable to a screen reader (and to getByRole). */
  label?: string;
}

/**
 * The bottom sheet used across every mobile surface (survey detail, new
 * survey, pickers). Matches the reference app's anatomy: grab handle, title
 * row, an internally-scrolling body, and an optional sticky footer.
 *
 * The BODY scrolls — never the page (html/body are overflow:hidden). Swipe
 * down on the handle or backdrop tap closes.
 */
export default function Sheet({ open, title, onClose, children, footer, size = 'auto', label }: Props) {
  const startY = useRef<number | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  /* PORTALED to <body>, not rendered in place. The sheet is position:fixed,
     and in the iOS webview that hosts this app a fixed element inside the
     shell's momentum scroller (.as-mobile-main, -webkit-overflow-scrolling:
     touch) gets CONTAINED by it: the sheet was laid out against the scroller,
     slid under the tab dock, and its bottom rows — real, selectable records —
     were unreachable on a phone while desktop looked fine. From <body> there is
     no ancestor scroller or transform to trap it, and z-index finally means
     what it says against the dock. */
  const accessibleName = label ?? (typeof title === 'string' ? title : undefined);
  return createPortal(
    <div className="sheet-root" role="dialog" aria-modal="true" aria-label={accessibleName}>
      <button className="sheet-backdrop" aria-label="Close" onClick={onClose} />
      <div
        className={size === 'tall' ? 'sheet-panel tall' : 'sheet-panel'}
        ref={panelRef}
        onTouchStart={(e) => {
          startY.current = e.touches[0]?.clientY ?? null;
        }}
        onTouchMove={(e) => {
          if (startY.current === null) return;
          const dy = (e.touches[0]?.clientY ?? 0) - startY.current;
          // Only drag when the body is already at the top — otherwise the
          // gesture belongs to the scroller.
          const body = panelRef.current?.querySelector('.sheet-body');
          if (dy > 0 && (!body || body.scrollTop <= 0)) {
            panelRef.current!.style.transform = `translateY(${dy}px)`;
          }
        }}
        onTouchEnd={(e) => {
          const dy = (e.changedTouches[0]?.clientY ?? 0) - (startY.current ?? 0);
          if (panelRef.current) panelRef.current.style.transform = '';
          startY.current = null;
          if (dy > 90) onClose();
        }}
      >
        <div className="sheet-grip" aria-hidden="true" />
        {title && <h2 className="sheet-title">{title}</h2>}
        <div className="sheet-body scroll-y">{children}</div>
        {footer && <div className="sheet-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
