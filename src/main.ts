import { APP_VERSION, BUILD_ID, BUILD_KIND, SUPPORTED_PROTOCOL_VERSIONS } from './version';
import { button, el, field } from './app/dom';
import { renderLinkCheckScreen } from './app/linkCheckScreen';
import { IndexedDbReceiverStorage } from './transfer/indexedDbStorage';

/**
 * Phase 0-3 shell.
 *
 * Everything shown here is derived from real state: the build identity, the
 * offline layer, and the camera/beacon status reported by the link-check
 * controller. File transfer and calibration are not implemented yet and are
 * labelled as such rather than presented as working buttons.
 */

const root = document.getElementById('app');
if (!root) throw new Error('#app missing');
const app: HTMLElement = root;

const sheet = el('main', 'sheet');
const title = el('h1', undefined, 'QRRelay');
const subtitle = el(
  'p',
  'subtitle',
  'Offline two-way optical file transfer between two computers using their displays and cameras.',
);

const status = el('p', 'status', 'Checking offline availability…');
status.setAttribute('role', 'status');
status.setAttribute('aria-live', 'polite');

const details = el('dl', 'details');
details.append(
  field('App version', APP_VERSION),
  field('Build ID', BUILD_ID),
  field('Delivery format', BUILD_KIND === 'single' ? 'single-file HTML' : 'installable PWA'),
  field('Protocol versions', SUPPORTED_PROTOCOL_VERSIONS.join(', ')),
);

const actions = el('div', 'controls');
const linkCheckBtn = button('Link Check', () => void openLinkCheck());

const roadmap = el('section', 'pane');
roadmap.append(
  el('h2', undefined, 'Current scope'),
  el(
    'p',
    'note',
    'Implemented: QRF1 frame protocol, reliable-mode simulation, QR encode/decode, live beacon exchange (link check) between two app instances over screens and cameras, and bidirectional calibration that derives a conservative chunk size from what both screens actually decoded.',
  ),
  el(
    'p',
    'note',
    'Not implemented: file transfer over the optical link, folder ZIP packaging, stream mode, encryption. Those are not offered as working actions.',
  ),
);

sheet.append(title, subtitle, status, details, actions, roadmap);
app.append(sheet);
actions.append(linkCheckBtn);

function setStatus(text: string, kind: 'pending' | 'ready' | 'unavailable'): void {
  status.textContent = text;
  status.dataset.kind = kind;
}

function openLinkCheck(): void {
  const cleanup = renderLinkCheckScreen(app, () => {
    cleanup();
    app.replaceChildren();
    app.append(sheet);
  });
}

async function checkOfflineReady(): Promise<void> {
  if (!window.isSecureContext) {
    setStatus('Offline ready unavailable: this page is not running in a secure context.', 'unavailable');
    return;
  }
  if (BUILD_KIND === 'single') {
    const external = [...document.querySelectorAll('script[src], link[rel=stylesheet][href]')].filter(
      (node) => !(node.getAttribute('src') ?? '').startsWith('data:') && !(node.getAttribute('href') ?? '').startsWith('data:'),
    );
    if (external.length > 0) {
      setStatus('Offline ready unavailable: the single-file build still references external files.', 'unavailable');
      return;
    }
    setStatus('Offline ready: every asset is inside this HTML file.', 'ready');
    return;
  }
  if (!('serviceWorker' in navigator)) {
    setStatus('Offline ready unavailable: this browser does not support service workers.', 'unavailable');
    return;
  }
  try {
    await navigator.serviceWorker.register('./sw.js');
    const ready = await navigator.serviceWorker.ready;
    if (ready.active || navigator.serviceWorker.controller) {
      setStatus('Offline ready: app shell precached by the service worker.', 'ready');
    } else {
      setStatus('Offline ready pending: service worker registered but not active yet.', 'pending');
    }
  } catch (error) {
    setStatus('Offline ready unavailable: service worker registration failed (' + (error as Error).message + ').', 'unavailable');
  }
}

// Diagnostics hook. The durable storage class can only be exercised in a real
// browser, and the built bundle exposes no module paths, so tests reach it
// here. Nothing in the app reads this; it exists for the browser suite.
(globalThis as unknown as { __qrrelay?: unknown }).__qrrelay = { IndexedDbReceiverStorage };

void checkOfflineReady();
