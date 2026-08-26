import { useState, useEffect, useRef } from 'react';

// Touch-event-based pull-to-refresh. Attaches non-passive touch listeners to
// the nearest scrollable ancestor of `containerRef` (so it works with the
// app's fixed full-viewport scroll container) and only activates when that
// container is scrolled to the top. Returns the current pull distance and a
// refreshing flag for rendering an indicator.
//
// `disabled` lets the caller suspend the behavior (e.g. when the scrollable
// list isn't mounted) — toggling it re-runs the effect so listeners attach
// once the container becomes available.
export function usePullToRefresh({ onRefresh, containerRef, threshold = 70, disabled = false }) {
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const startYRef = useRef(0);
  const pullingRef = useRef(false);
  const distRef = useRef(0);
  const refreshingRef = useRef(false);
  const onRefreshRef = useRef(onRefresh);

  useEffect(() => { onRefreshRef.current = onRefresh; });

  useEffect(() => {
    if (disabled) return;
    const el = containerRef.current;
    if (!el) return;

    // Climb to the nearest ancestor that scrolls vertically.
    let scrollEl = el.parentElement;
    while (scrollEl) {
      const oy = getComputedStyle(scrollEl).overflowY;
      if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') break;
      scrollEl = scrollEl.parentElement;
    }
    if (!scrollEl) return;

    const onStart = (e) => {
      if (refreshingRef.current) return;
      if (scrollEl.scrollTop <= 0) {
        startYRef.current = e.touches[0].clientY;
        pullingRef.current = true;
      } else {
        pullingRef.current = false;
      }
    };

    const onMove = (e) => {
      if (!pullingRef.current || refreshingRef.current) return;
      const dy = e.touches[0].clientY - startYRef.current;
      if (dy <= 0) {
        if (distRef.current !== 0) { distRef.current = 0; setPullDistance(0); }
        return;
      }
      const dist = Math.min(dy * 0.5, threshold * 1.5);
      distRef.current = dist;
      setPullDistance(dist);
      if (scrollEl.scrollTop <= 0 && e.cancelable) e.preventDefault();
    };

    const onEnd = async () => {
      if (!pullingRef.current) return;
      pullingRef.current = false;
      const dist = distRef.current;
      if (dist >= threshold) {
        refreshingRef.current = true;
        setRefreshing(true);
        setPullDistance(threshold);
        try {
          await onRefreshRef.current?.();
        } finally {
          refreshingRef.current = false;
          setRefreshing(false);
          distRef.current = 0;
          setPullDistance(0);
        }
      } else {
        distRef.current = 0;
        setPullDistance(0);
      }
    };

    scrollEl.addEventListener('touchstart', onStart, { passive: true });
    scrollEl.addEventListener('touchmove', onMove, { passive: false });
    scrollEl.addEventListener('touchend', onEnd, { passive: true });
    scrollEl.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      scrollEl.removeEventListener('touchstart', onStart);
      scrollEl.removeEventListener('touchmove', onMove);
      scrollEl.removeEventListener('touchend', onEnd);
      scrollEl.removeEventListener('touchcancel', onEnd);
    };
  }, [disabled, threshold, containerRef]);

  return { pullDistance, refreshing };
}