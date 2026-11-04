import { useEffect, useRef, useState } from 'react';

/** Environment eligibility is independent of the user's play/pause preference. */
export function useSceneMotion() {
  const ref = useRef<HTMLElement>(null);
  const [reduced, setReduced] = useState(
    () => matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const [visible, setVisible] = useState(() => !document.hidden);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const onMedia = () => setReduced(media.matches);
    const onVisibility = () => setVisible(!document.hidden);
    media.addEventListener('change', onMedia);
    document.addEventListener('visibilitychange', onVisibility);
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), {
      threshold: 0,
    });
    if (ref.current) observer.observe(ref.current);
    return () => {
      media.removeEventListener('change', onMedia);
      document.removeEventListener('visibilitychange', onVisibility);
      observer.disconnect();
    };
  }, []);

  return { ref, reduced, visible, inView, eligible: !reduced && visible && inView };
}
