# Phase 02 — Card Improvements: "+ Card" and "Nhân bản" Buttons

## Overview

Add two small action buttons to each card header. The "+ Card" button shows a 2-option inline dropdown (Thêm sau / Thêm trước). The "Nhân bản" button clones the card with `status=idle`. The existing delete button stays unchanged.

---

## Requirements

1. "+ Card" button: opens a small inline dropdown with "Thêm sau" / "Thêm trước"
2. "Nhân bản": clones card (same prompt, `status='idle'`, empty outputs)
3. All three header buttons must be visually small (`btn-sm`) and consistent
4. No new modals — dropdown is a simple absolute-positioned div
5. Dropdown auto-closes on outside click

---

## Files to Modify

### `static/js/tabs/t2v.js`

#### Change 1 — Update card header HTML in `renderCard()` (line ~118–119)

Find (line 118):
```js
        <button class="btn btn-secondary btn-sm" onclick="T2V.genCard('${card.id}')" ${card.status === 'running' ? 'disabled' : ''}>▶ Tạo Video</button>
        <button class="btn btn-secondary btn-sm" onclick="T2V.deleteCard('${card.id}')">🗑</button>
```

Replace with:
```js
        <button class="btn btn-secondary btn-sm" onclick="T2V.genCard('${card.id}')" ${card.status === 'running' ? 'disabled' : ''}>▶ Tạo Video</button>
        <div class="card-action-group">
          <button class="btn btn-secondary btn-sm card-add-btn" onclick="T2V.toggleAddMenu('${card.id}',event)">+ Card ▾</button>
          <div class="card-add-menu" id="add-menu-${card.id}" style="display:none;">
            <div onclick="T2V.insertCard('${card.id}','after')">Thêm sau</div>
            <div onclick="T2V.insertCard('${card.id}','before')">Thêm trước</div>
          </div>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="T2V.cloneCard('${card.id}')" title="Nhân bản card">⧉ Nhân bản</button>
        <button class="btn btn-secondary btn-sm" onclick="T2V.deleteCard('${card.id}')">🗑</button>
```

#### Change 2 — Same update in `reRenderRight()` header section (line ~186–206)

The `reRenderRight()` function only re-renders the `right` div and the status dot in the header — it does NOT re-build header buttons. No change needed here since header is only built once in `renderCard`.

#### Change 3 — Add `toggleAddMenu`, `insertCard`, `cloneCard` to `window.T2V` public API (after existing methods, before closing `}` of the `window.T2V = {...}` block, around line 660)

```js
    toggleAddMenu(cardId, event) {
      event.stopPropagation();
      // Close all other open menus first
      document.querySelectorAll('.card-add-menu').forEach(m => {
        if (m.id !== `add-menu-${cardId}`) m.style.display = 'none';
      });
      const menu = document.getElementById(`add-menu-${cardId}`);
      if (menu) menu.style.display = menu.style.display === 'none' ? '' : 'none';
    },

    insertCard(refCardId, position) {
      // Close menu
      const menu = document.getElementById(`add-menu-${refCardId}`);
      if (menu) menu.style.display = 'none';

      const refIdx = cards.findIndex(c => c.id === refCardId);
      if (refIdx === -1) return;

      const newC = newCard('');
      const insertIdx = position === 'after' ? refIdx + 1 : refIdx;
      cards.splice(insertIdx, 0, newC);

      // Re-render all cards from scratch (simple approach for small card lists)
      _reRenderAllCards();
      refreshEmpty();
      // Focus the new card's textarea
      setTimeout(() => {
        const ta = document.getElementById(`prompt-${newC.id}`);
        if (ta) ta.focus();
      }, 50);
    },

    cloneCard(cardId) {
      const src = cards.find(c => c.id === cardId);
      if (!src) return;
      const clone = newCard(src.prompt);
      clone.chars = src.chars.map(ch => ({ ...ch })); // shallow copy of chars array
      const srcIdx = cards.indexOf(src);
      cards.splice(srcIdx + 1, 0, clone);
      _reRenderAllCards();
      refreshEmpty();
      toast('Đã nhân bản card', 'success');
    },
```

#### Change 4 — Add `_reRenderAllCards()` helper function (private, add near top of module after `refreshEmpty`, around line 47)

```js
  function _reRenderAllCards() {
    const container = cardsEl();
    container.innerHTML = '';
    cards.forEach(card => renderCard(card, true));
  }
```

#### Change 5 — Close dropdown on document click (add inside `init_text_to_video`, after existing event listeners)

```js
    document.addEventListener('click', () => {
      document.querySelectorAll('.card-add-menu').forEach(m => m.style.display = 'none');
    });
```

---

### `static/css/app.css`

Add after the existing `.t2v-card-header` styles (search for `.t2v-card-header` block, append after it):

```css
/* ── Card action group (+ Card dropdown) ─────────────────── */
.card-action-group {
  position: relative;
  display: inline-flex;
}

.card-add-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 6px;
  z-index: 100;
  min-width: 120px;
  box-shadow: 0 4px 12px rgba(0,0,0,.4);
  overflow: hidden;
}

.card-add-menu div {
  padding: 8px 14px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text);
  transition: background var(--transition);
}

.card-add-menu div:hover {
  background: var(--bg3);
  color: var(--accent);
}
```

---

## Implementation Steps

1. In `t2v.js` — add `_reRenderAllCards()` helper near `refreshEmpty` 
2. In `t2v.js` — update `renderCard()` header HTML to add the two new buttons
3. In `t2v.js` — add `toggleAddMenu`, `insertCard`, `cloneCard` to `window.T2V`
4. In `t2v.js` — add document click listener in `init_text_to_video` to close menus
5. In `app.css` — add `.card-action-group` and `.card-add-menu` styles

---

## Success Criteria

- [ ] Each card header shows: `[▶ Tạo Video] [+ Card ▾] [⧉ Nhân bản] [🗑]`
- [ ] Clicking "+ Card ▾" opens inline dropdown with "Thêm sau" / "Thêm trước"
- [ ] "Thêm sau" inserts blank card immediately after the clicked card, numbered correctly
- [ ] "Thêm trước" inserts blank card immediately before, numbered correctly
- [ ] New blank card's textarea receives focus
- [ ] Clicking outside closes dropdown
- [ ] "⧉ Nhân bản": new card inserted after source, same prompt, status=idle, chars copied
- [ ] Existing generate/delete behavior unchanged
- [ ] Card numbering renumbers correctly after insert/clone
