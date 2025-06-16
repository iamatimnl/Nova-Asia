# Button Press Feedback Specification

This document describes the visual and haptic feedback used on buttons in `index.html`.

## Styles

- **Normal state** uses existing colors defined per button.
- **Pressed state** (`button:active`)
  - Brightness reduced to **85%** using `filter: brightness(0.85)`.
  - Scaled to **94%** of its size via `transform: scale(0.94)`.
  - Inset shadow `inset 0 3px 6px rgba(0,0,0,0.35)`.
- Transition for `transform`, `filter` and `box-shadow` lasts **100 ms**.
- Release animation falls back over **200 ms** via CSS transition.
- Buttons keep `touch-action: manipulation` to remove 300 ms tap delay on mobile.

```css
button {
  transition: transform 0.1s ease, filter 0.1s ease, box-shadow 0.1s ease;
  touch-action: manipulation;
}
button:active {
  transform: scale(0.94);
  filter: brightness(0.85);
  box-shadow: inset 0 3px 6px rgba(0,0,0,0.35);
}
```

A vibration feedback of **50 ms** is triggered on `mousedown`/`touchstart` when supported by the browser:

```javascript
const vibrate = () => { if (navigator.vibrate) navigator.vibrate(50); };
buttons.forEach(btn => {
  btn.addEventListener('mousedown', vibrate);
  btn.addEventListener('touchstart', vibrate, { passive: true });
});
```

## Sizes

- Quantity buttons inside menu items are **2.2 rem** on desktop and **1.8 rem** on screens narrower than **600 px**.
- Cart toggle button is **56 px** square.
- Checkout button stretches to container width with generous padding `12px 24px`.

## Example

Normal and pressed states are illustrated below:

| Normal | Pressed |
| ------ | ------- |
| ![normal button](button-before.svg) | ![pressed button](button-after.svg) |

