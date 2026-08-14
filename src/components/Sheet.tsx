import { useEffect, useRef, type ReactNode } from 'react';
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
}

/**
 * The bottom sheet used across every mobile surface (survey detail, new
 * survey, pickers). Matches the reference app's anatomy: grab handle, title
 * row, an internally-scrolling body, and an optional sticky footer.
 *
 * The BODY scrolls — never the page (html/body are overflow:hidden). Swipe
 * down on the handle or backdrop tap closes.
 */
export default function Sheet({ open, title, onClose, children, footer, size = 'auto' }: Props) {
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

  return (
    <div className="sheet-root" role="dialog" aria-modal="true">
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
    </div>
  );
}
