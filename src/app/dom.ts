/** Tiny DOM helpers. No innerHTML, no inline handlers: CSP-safe by construction. */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(label: string, onClick: () => void, className = 'btn'): HTMLButtonElement {
  const b = el('button', className, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

export function field(label: string, value: string, id?: string): HTMLElement {
  const row = el('div', 'row');
  const dt = el('dt', undefined, label);
  const dd = el('dd', undefined, value);
  if (id) dd.id = id;
  row.append(dt, dd);
  return row;
}

export function setText(node: HTMLElement | null, text: string): void {
  if (node && node.textContent !== text) node.textContent = text;
}
