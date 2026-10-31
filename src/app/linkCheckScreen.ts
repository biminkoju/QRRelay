import { button, el, field, setText } from './dom';
import {
  LinkCheckController,
  cameraSupport,
  drawQrToCanvas,
  encodeQr,
  linkCheckLocal,
  listCameras,
  type LinkCheckView,
} from './linkCheck';
import { CameraError } from '../camera/cameraManager';

/** Link Check screen: live beacon QR, camera preview, bidirectional state. */
export function renderLinkCheckScreen(container: HTMLElement, onBack: () => void): () => void {
  container.replaceChildren();
  const sheet = el('main', 'sheet');
  const back = button('Back', onBack, 'btn btn-secondary');

  const title = el('h1', undefined, 'Link Check');
  const status = el('p', 'status', 'Not started');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const layout = el('div', 'link-layout');
  const displayPane = el('section', 'pane');
  displayPane.append(el('h2', undefined, 'This screen (beacon)'));
  const canvas = el('canvas', 'qr-canvas');
  canvas.setAttribute('aria-label', 'Outgoing calibration beacon QR code');
  displayPane.append(canvas);

  const cameraPane = el('section', 'pane');
  cameraPane.append(el('h2', undefined, 'Peer screen (camera)'));
  const preview = el('video', 'camera-preview');
  preview.muted = true;
  preview.playsInline = true;
  preview.autoplay = true;
  const cameraHost = el('div', 'camera-host');
  cameraHost.append(preview);
  cameraPane.append(cameraHost);

  layout.append(displayPane, cameraPane);

  const controls = el('div', 'controls');
  const startBtn = button('Start camera', () => void start());
  const stopBtn = button('Stop', () => void stop(), 'btn btn-secondary');
  stopBtn.disabled = true;
  const calibrateBtn = button('Run calibration', () => void calibrate(), 'btn btn-secondary');
  calibrateBtn.disabled = true;
  const deviceSelect = el('select', 'select');
  deviceSelect.setAttribute('aria-label', 'Camera device');
  deviceSelect.disabled = true;
  controls.append(startBtn, calibrateBtn, stopBtn, deviceSelect);

  const details = el('dl', 'details');
  const iSeePeer = field('I can see the peer', 'no');
  const peerSeesMe = field('The peer can see me', 'no');
  const peerVersion = field('Peer app version', 'unknown');
  const peerProtocols = field('Peer protocol versions', 'unknown');
  const rateField = field('Measured decode rate', '0 per second');
  const qualityField = field('Quality', 'none');
  const calField = field('Calibration id', 'not derived');
  const calPhaseField = field('Calibration', 'not started');
  const chunkField = field('Chosen chunk size', 'not measured');
  const frameRateField = field('Measured frame rate', 'not measured');
  const rttField = field('Round-trip time', 'not measured');
  const leaderField = field('Leads first probe', 'not elected');
  details.append(
    iSeePeer,
    peerSeesMe,
    peerVersion,
    peerProtocols,
    rateField,
    qualityField,
    calField,
    leaderField,
    calPhaseField,
    chunkField,
    frameRateField,
    rttField,
  );

  const hint = el('p', 'hint', '');
  const nonceLine = el('p', 'mono small', '');

  sheet.append(back, title, status, hint, layout, controls, details, nonceLine);
  container.append(sheet);

  const support = cameraSupport();
  if (!support.secure) {
    hint.textContent = 'Camera access needs a secure context. Open the installed PWA or serve the app from a localhost origin; a file:// page cannot open a camera in most browsers.';
  } else if (!support.getUserMedia) {
    hint.textContent = 'This browser does not expose getUserMedia, so scanning is unavailable here.';
  }

  let controller: LinkCheckController | null = null;
  let lastBeacon: string | null = null;

  function drawBeacon(frameText: string): void {
    if (frameText.length === 0 || frameText === lastBeacon) return;
    lastBeacon = frameText;
    try {
      drawQrToCanvas(canvas, encodeQr(frameText, 'Q'), { maxCssSize: 520 });
    } catch (error) {
      status.textContent = 'Beacon could not be encoded: ' + (error as Error).message;
      status.dataset.kind = 'unavailable';
    }
  }

  function applyView(view: LinkCheckView): void {
    setText(status, view.phase);
    status.dataset.kind = view.linkUp ? 'ready' : 'pending';
    setText(hint, view.hint);
    const dd = (node: HTMLElement): HTMLElement => node.querySelector('dd') as HTMLElement;
    setText(dd(iSeePeer), view.iSeePeer ? 'yes' : 'no');
    setText(dd(peerSeesMe), view.peerSeesMe ? 'yes' : 'no');
    setText(dd(peerVersion), view.peerAppVersion ?? 'unknown');
    setText(dd(peerProtocols), view.peerProtocolVersions ? view.peerProtocolVersions.join(', ') : 'unknown');
    setText(dd(rateField), view.decodeRate.toFixed(2) + ' per second');
    setText(dd(qualityField), view.quality);
    setText(dd(calField), view.calId ?? 'not derived');
    setText(dd(leaderField), view.calId === null ? 'not elected' : view.leader ? 'yes' : 'no');
    setText(nonceLine, 'Local nonce ' + view.localNonce + (view.peerNonce ? ' | peer nonce ' + view.peerNonce : ''));
    setText(dd(calPhaseField), view.calibrationMessage);
    setText(dd(chunkField), view.profile ? view.profile.chunkSize + ' bytes (' + view.profile.ecl + ')' : 'not measured');
    setText(
      dd(frameRateField),
      view.profile && view.profile.framesPerSecond > 0
        ? view.profile.framesPerSecond.toFixed(1) + ' per second, reliability ' + view.profile.reliability.toFixed(2)
        : 'not measured',
    );
    setText(dd(rttField), view.profile && view.profile.rttMs !== null ? view.profile.rttMs.toFixed(0) + ' ms' : 'not measured');
    calibrateBtn.disabled = !view.canCalibrate;
    drawBeacon(controller?.displayFrameText() ?? '');
    deviceSelect.disabled = !controller;
  }

  async function start(): Promise<void> {
    if (controller) return;
    startBtn.disabled = true;
    controller = new LinkCheckController(linkCheckLocal(), {
      onView: (view) => applyView(view),
    });
    try {
      await controller.start(preview);
      stopBtn.disabled = false;
      const cams = await listCameras().catch(() => []);
      deviceSelect.replaceChildren(el('option', undefined, 'Default camera'));
      for (const cam of cams) {
        const option = el('option', undefined, cam.label);
        option.value = cam.deviceId;
        deviceSelect.append(option);
      }
      controller.emitView();
    } catch (error) {
      const message = error instanceof CameraError ? error.message : String(error);
      status.textContent = 'Camera unavailable';
      status.dataset.kind = 'unavailable';
      hint.textContent = message;
      startBtn.disabled = false;
    }
  }

  function calibrate(): void {
    controller?.startCalibration();
  }

  async function stop(): Promise<void> {
    await controller?.stop();
    controller = null;
    preview.srcObject = null;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    status.textContent = 'Stopped';
    status.dataset.kind = 'pending';
    calibrateBtn.disabled = true;
  }

  deviceSelect.addEventListener('change', () => {
    const value = deviceSelect.value;
    if (controller && value) void controller.switchCamera(value, preview).catch((error: unknown) => {
      hint.textContent = error instanceof Error ? error.message : String(error);
    });
  });

  return () => {
    void stop();
  };
}
