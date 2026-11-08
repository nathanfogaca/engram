import { useEffect } from "react";

export function useHeroPointer(area, light) {
  useEffect(() => {
    const hero = area.current;
    const spotlight = light.current;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const fine = matchMedia("(any-pointer: fine)");
    let pending = 0;
    let x = 0, y = 0;
    let origin;

    function paint() {
      pending = 0;
      if (!origin) {
        const { left, top } = hero.getBoundingClientRect();
        origin = { x: left + scrollX, y: top + scrollY };
      }
      spotlight.style.transform = `translate3d(${x - origin.x}px, ${y - origin.y}px, 0)`;
      if (!hero.dataset.pointer) hero.dataset.pointer = "active";
    }

    function move(event) {
      if (event.pointerType !== "mouse" || reduced.matches || !fine.matches) return;
      x = event.pageX;
      y = event.pageY;
      if (!pending) pending = requestAnimationFrame(paint);
    }

    function clear() {
      cancelAnimationFrame(pending);
      pending = 0;
      origin = null;
      delete hero.dataset.pointer;
    }

    hero.addEventListener("pointermove", move, { passive: true });
    hero.addEventListener("pointerleave", clear);
    hero.addEventListener("pointercancel", clear);
    hero.addEventListener("wheel", clear, { passive: true });
    window.addEventListener("resize", clear);
    reduced.addEventListener("change", clear);
    fine.addEventListener("change", clear);
    return () => {
      clear();
      hero.removeEventListener("pointermove", move);
      hero.removeEventListener("pointerleave", clear);
      hero.removeEventListener("pointercancel", clear);
      hero.removeEventListener("wheel", clear);
      window.removeEventListener("resize", clear);
      reduced.removeEventListener("change", clear);
      fine.removeEventListener("change", clear);
    };
  }, [area, light]);
}

export function useViewportMotion(page) {
  useEffect(() => {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const atmosphere = page.current.querySelector("[data-atmosphere]");
    const elements = page.current.querySelectorAll("[data-reveal], [data-pulse], [data-atmosphere]");
    const waiting = new Set();
    let observer;
    let timer = 0;
    let lastScroll = -Infinity;
    let atmosphereVisible = false;

    function noteScroll() {
      lastScroll = performance.now();
      if (!atmosphere?.hasAttribute("data-drifting")) return;
      atmosphere.removeAttribute("data-drifting");
      waiting.add(atmosphere);
      if (!timer) startVisibleMotion();
    }

    function startVisibleMotion() {
      const remaining = 110 - (performance.now() - lastScroll);
      if (remaining > 0) {
        timer = setTimeout(startVisibleMotion, remaining);
        return;
      }
      timer = 0;
      for (const target of waiting) {
        if (target === atmosphere) {
          target.toggleAttribute("data-drifting", !document.hidden);
        } else if (target.hasAttribute("data-pulse")) {
          target.dataset.beating = "";
        } else {
          target.dataset.revealed = "";
          observer.unobserve(target);
        }
      }
      waiting.clear();
    }

    function syncAtmosphere() {
      if (!atmosphere) return;
      if (document.hidden) {
        atmosphere.removeAttribute("data-drifting");
        waiting.delete(atmosphere);
      } else if (atmosphereVisible && !reduced.matches) {
        waiting.add(atmosphere);
        if (!timer) startVisibleMotion();
      }
    }

    function update() {
      observer?.disconnect();
      clearTimeout(timer);
      timer = 0;
      waiting.clear();
      atmosphereVisible = false;
      atmosphere?.removeAttribute("data-drifting");
      if (reduced.matches) {
        elements.forEach(element => { delete element.dataset.beating; });
        return;
      }
      observer = new IntersectionObserver(entries => {
        if (reduced.matches) return;
        for (const { target, isIntersecting } of entries) {
          if (target === atmosphere) atmosphereVisible = isIntersecting;
          if (isIntersecting) {
            waiting.add(target);
          } else {
            waiting.delete(target);
            delete target.dataset.beating;
            if (target === atmosphere) target.removeAttribute("data-drifting");
          }
        }
        if (!timer && waiting.size) startVisibleMotion();
      }, { threshold: .08 });
      elements.forEach(element => {
        if (!element.hasAttribute("data-revealed")) observer.observe(element);
      });
    }

    update();
    window.addEventListener("scroll", noteScroll, { passive: true });
    document.addEventListener("visibilitychange", syncAtmosphere);
    reduced.addEventListener("change", update);
    return () => {
      clearTimeout(timer);
      observer?.disconnect();
      window.removeEventListener("scroll", noteScroll);
      document.removeEventListener("visibilitychange", syncAtmosphere);
      reduced.removeEventListener("change", update);
    };
  }, [page]);
}
