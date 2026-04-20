/* Lightweight UI enhancer for consistent-video character picking */
(function () {
  'use strict';

  let stylesInjected = false;
  let observerStarted = false;

  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const style = document.createElement('style');
    style.textContent = `
      .cv-char-choice-enhanced {
        position: relative;
        transition: transform .12s ease, box-shadow .12s ease, border-color .12s ease;
      }
      .cv-char-choice-enhanced.cv-char-choice-selected {
        transform: translateY(-2px);
        box-shadow: 0 0 0 2px var(--accent), 0 8px 20px rgba(0,0,0,.18);
        border-radius: 10px;
      }
      .cv-char-choice-badge {
        position: absolute;
        top: 8px;
        right: 8px;
        width: 24px;
        height: 24px;
        border-radius: 999px;
        background: rgba(15, 23, 42, .75);
        color: white;
        display: none;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        font-weight: 700;
        box-shadow: 0 2px 8px rgba(0,0,0,.25);
        pointer-events: none;
      }
      .cv-char-choice-enhanced.cv-char-choice-selected .cv-char-choice-badge {
        display: flex;
        background: var(--accent);
      }
    `;
    document.head.appendChild(style);
  }

  function findCharacterModal() {
    const overlays = [...document.body.children].filter(el => {
      const style = window.getComputedStyle(el);
      return style.position === 'fixed' && style.zIndex && Number(style.zIndex) >= 1000;
    });
    return overlays.find(el => {
      const text = (el.textContent || '').toLowerCase();
      return text.includes('áp dụng nhân vật') || text.includes('chon toi da 3 anh') || text.includes('chọn card áp dụng');
    }) || null;
  }

  function findChoiceTile(img, root) {
    let cur = img.parentElement;
    while (cur && cur !== root) {
      const rect = cur.getBoundingClientRect();
      if (rect.width >= 60 && rect.width <= 220 && rect.height >= 60 && rect.height <= 260) {
        return cur;
      }
      cur = cur.parentElement;
    }
    return null;
  }

  function decorateModal(root) {
    if (!root) return;
    injectStyles();
    const seen = new Set();
    root.querySelectorAll('img').forEach(img => {
      const tile = findChoiceTile(img, root);
      if (!tile || seen.has(tile)) return;
      seen.add(tile);
      if (!tile.classList.contains('cv-char-choice-enhanced')) {
        tile.classList.add('cv-char-choice-enhanced');
        const badge = document.createElement('div');
        badge.className = 'cv-char-choice-badge';
        badge.textContent = '✓';
        tile.appendChild(badge);
      }
    });
  }

  function bindModalInteractions(root) {
    if (!root || root.dataset.cvBound === '1') return;
    root.dataset.cvBound = '1';

    root.addEventListener('click', e => {
      const tile = e.target.closest('.cv-char-choice-enhanced');
      if (!tile || !root.contains(tile)) return;
      requestAnimationFrame(() => {
        tile.classList.toggle('cv-char-choice-selected');
      });
    }, true);
  }

  function startObserver() {
    if (observerStarted) return;
    observerStarted = true;
    const mo = new MutationObserver(() => {
      const modal = findCharacterModal();
      if (!modal) return;
      decorateModal(modal);
      bindModalInteractions(modal);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  function initEnhancer() {
    injectStyles();
    startObserver();
    document.getElementById('cv-apply-chars')?.addEventListener('click', () => {
      setTimeout(() => {
        const modal = findCharacterModal();
        if (!modal) return;
        decorateModal(modal);
        bindModalInteractions(modal);
      }, 50);
    });
  }

  window.CVUIEnhancer = {
    init: initEnhancer,
    decorateNow() {
      const modal = findCharacterModal();
      if (!modal) return;
      decorateModal(modal);
      bindModalInteractions(modal);
    },
  };
})();
