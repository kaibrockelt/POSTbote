// Pixel position of a character inside an <input>/<textarea>, measured with a
// hidden mirror element that copies the field's text layout.
const PROPS = [
  'boxSizing', 'width', 'height', 'overflowX', 'overflowY',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderStyle',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'lineHeight', 'fontFamily',
  'textAlign', 'textTransform', 'textIndent', 'letterSpacing', 'wordSpacing', 'tabSize', 'whiteSpace',
];

export function caretCoords(el, pos) {
  const cs = getComputedStyle(el);
  const div = document.createElement('div');
  const s = div.style;
  for (const p of PROPS) s[p] = cs[p];
  s.position = 'absolute';
  s.visibility = 'hidden';
  s.top = '0';
  s.left = '-9999px';
  s.overflow = 'hidden';
  if (el.nodeName === 'INPUT') s.whiteSpace = 'pre';
  div.textContent = el.value.slice(0, pos);
  const span = document.createElement('span');
  span.textContent = el.value.slice(pos) || '.';
  div.appendChild(span);
  document.body.appendChild(div);
  const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
  const r = {
    top: span.offsetTop + parseFloat(cs.borderTopWidth),
    left: span.offsetLeft + parseFloat(cs.borderLeftWidth),
    height: lineHeight,
  };
  div.remove();
  return r;
}
