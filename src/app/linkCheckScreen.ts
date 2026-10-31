import { button, el, field, setText } from "./dom";
import {
  LinkCheckController,
  cameraSupport,
  drawQrToCanvas,
  encodeQr,
  linkCheckLocal,
  listCameras,
  type LinkCheckView,
} from "./linkCheck";
import { CameraError } from "../camera/cameraManager";
import { createTransferPanel } from './transferPanel';
import { agree, type AgreementOffer } from '../protocol/agreement';
import { encodeFrame, type ValidatedFrame } from '../protocol/frame';
import { jsonPayload } from '../protocol/sender';
import { validateCalAgree } from '../protocol/messageTypes';
import { CALIBRATION_SESSION_ID } from '../protocol/alignment';
import { runLoopback } from "../sim/loopback";
import { DEFAULT_CHANNEL } from "../sim/channel";

/** Link Check screen: live beacon QR, camera preview, bidirectional state. */
export function renderLinkCheckScreen(
  container: HTMLElement,
  onBack: () => void,
): () => void {
  container.replaceChildren();
  const sheet = el("main", "sheet");
  const back = button("Back", onBack, "btn btn-secondary");

  const title = el("h1", undefined, "Link Check");
  const status = el("p", "status", "Not started");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  // The beacon is the thing the other machine's camera has to resolve, so it
  // gets the whole stage. Our own preview is only for aiming, so it becomes a
  // small overlay in the corner instead of competing for half the screen.
  const layout = el("div", "beacon-stage");
  const displayPane = el("section", "beacon-pane");
  const canvas = el("canvas", "qr-canvas");
  canvas.setAttribute("aria-label", "Outgoing calibration beacon QR code");
  displayPane.append(canvas);

  const preview = el("video", "camera-preview");
  preview.muted = true;
  preview.playsInline = true;
  preview.autoplay = true;
  const cameraHost = el("div", "camera-pip");
  const cameraLabel = el("span", "camera-pip-label", "Peer screen");
  // The overlay sits on top of the beacon. If it covers modules, the other
  // camera fails for a reason that has nothing to do with the link, so it must
  // be hideable in one click.
  const pipToggle = button("Hide", () => togglePip(), "camera-pip-toggle");
  cameraHost.append(preview, cameraLabel, pipToggle);

  function togglePip(): void {
    const hidden = cameraHost.classList.toggle("camera-pip-hidden");
    pipToggle.textContent = hidden ? "Show" : "Hide";
  }

  layout.append(displayPane, cameraHost);

  const controls = el("div", "controls");
  const startBtn = button("Start camera", () => void start());
  const stopBtn = button("Stop", () => void stop(), "btn btn-secondary");
  stopBtn.disabled = true;
  const calibrateBtn = button(
    "Run calibration",
    () => void calibrate(),
    "btn btn-secondary",
  );
  const simulateBtn = button(
    "Simulate (no camera)",
    () => simulate(),
    "btn btn-secondary",
  );
  calibrateBtn.disabled = true;
  const flipBtn = button(
    "Switch to front camera",
    () => void flipCamera(),
    "btn btn-secondary",
  );
  flipBtn.disabled = true;
  const deviceSelect = el("select", "select");
  deviceSelect.setAttribute("aria-label", "Camera device");
  deviceSelect.disabled = true;
  controls.append(
    startBtn,
    flipBtn,
    simulateBtn,
    calibrateBtn,
    stopBtn,
    deviceSelect,
  );

  const details = el("dl", "details");
  const iSeePeer = field("I can see the peer", "no");
  const peerSeesMe = field("The peer can see me", "no");
  const peerVersion = field("Peer app version", "unknown");
  const peerProtocols = field("Peer protocol versions", "unknown");
  const rateField = field("Measured decode rate", "0 per second");
  const qualityField = field("Quality", "none");
  const calField = field("Calibration id", "not derived");
  const calPhaseField = field("Calibration", "not started");
  const chunkField = field("Chosen chunk size", "not measured");
  const frameRateField = field("Measured frame rate", "not measured");
  const rttField = field("Round-trip time", "not measured");
  const leaderField = field("Leads first probe", "not elected");
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

  const hint = el("p", "hint", "");
  const nonceLine = el("p", "mono small", "");

  sheet.append(back, title, status, hint, layout, controls, details, nonceLine);

  // Raw measurements. Deliberately unpolished: on the bench, a table of
  // numbers is worth more than a friendly verdict.
  const diagSection = el("section", "pane");
  diagSection.append(el("h2", undefined, "Measurements"));
  const diagTable = el("table", "diag");
  diagTable.append(
    el("caption", "small", "Probe ladder, largest payload first"),
  );
  const diagHead = el("tr");
  for (const label of ["Bytes", "Forward", "Reverse"])
    diagHead.append(el("th", undefined, label));
  const diagBody = el("tbody");
  diagTable.append(diagHead, diagBody);
  const diagSummary = el("p", "mono small", "No calibration run yet.");
  diagSection.append(diagTable, diagSummary);

  // Declared before the panel because the panel reads them while mounting.
  let controller: LinkCheckController | null = null;
  let facing: "environment" | "user" = "environment";
  let transferFrame: string | null = null;
  let currentChunkSize: number | null = null;
  /** Agreed with the peer; what transfer actually uses. */
  let transferChunkSize: number | null = null;
  let agreementSent = false;
  let agreeFrame: string | null = null;
  let agreeTimer: ReturnType<typeof setInterval> | null = null;
  let lastEcl: "L" | "M" | "Q" | "H" = "Q";

  sheet.append(diagSection);

  // The transfer panel shares the beacon canvas: while a file transfer
  // is active its frames are what the other machine needs to see.
  const transferPanel = createTransferPanel({
    chunkSize: () => transferChunkSize,
    // The calibration id is derived identically on both machines, so it
    // is the one session id they already share. A locally drawn random
    // id would differ per machine and no transfer frame would match.
    sessionId: () => controller?.alignment.calId ?? null,
    onFrame: (text) => {
      transferFrame = text;
      // Redraw immediately: the peer is waiting on this frame.
      const shown = text ?? controller?.displayFrameText() ?? '';
      drawBeacon(shown, controller?.displayEcl() ?? 'Q');
    },
  });
  sheet.append(transferPanel.element);

  container.append(sheet);

  const support = cameraSupport();
  if (!support.secure) {
    hint.textContent =
      "Camera access needs a secure context. Open the installed PWA or serve the app from a localhost origin; a file:// page cannot open a camera in most browsers.";
  } else if (!support.getUserMedia) {
    hint.textContent =
      "This browser does not expose getUserMedia, so scanning is unavailable here.";
  }

  let lastBeacon: string | null = null;

  /**
   * Sizes the canvas from the pane's own rendered width. A fixed pixel budget
   * made the 1024-byte probe rungs physically tiny, which would have failed on
   * camera for reasons unrelated to the link.
   */
  function displaySize(): number {
    const paneWidth = displayPane.clientWidth;
    // Never taller than the viewport allows, or the symbol would scroll out of
    // the other camera's view.
    const paneHeight = globalThis.innerHeight
      ? globalThis.innerHeight - 220
      : 0;
    const available = paneWidth > 0 ? paneWidth - 24 : 520;
    const byHeight = paneHeight > 0 ? paneHeight : available;
    return Math.max(320, Math.min(1400, Math.min(available, byHeight)));
  }

  function drawBeacon(frameText: string, ecl: LinkCheckView["frameEcl"]): void {
    const size = displaySize();
    const key = ecl + ":" + frameText + ":" + size;
    if (frameText.length === 0 || key === lastBeacon) return;
    lastBeacon = key;
    try {
      drawQrToCanvas(canvas, encodeQr(frameText, ecl), { maxCssSize: size });
    } catch (error) {
      status.textContent =
        "Beacon could not be encoded: " + (error as Error).message;
      status.dataset.kind = "unavailable";
    }
  }

  /**
   * A verdict cell. The value is text, not a class name: `el`'s second
   * argument is className, and passing the verdict there produced empty cells
   * that looked like a successful run while showing nothing.
   */
  function verdictCell(value: boolean | null): HTMLTableCellElement {
    const label = value === null ? "no answer" : value ? "ok" : "failed";
    const cell = el(
      "td",
      "verdict-" + (value === null ? "none" : value ? "ok" : "failed"),
      label,
    );
    return cell;
  }

  function renderDiagnostics(view: LinkCheckView): void {
    const diag = view.diagnostics;
    diagBody.replaceChildren();
    if (!diag) {
      diagSummary.textContent = "No calibration run yet.";
      return;
    }
    for (const row of [...diag.ladder].reverse()) {
      const tr = el("tr");
      tr.append(el("td", undefined, String(row.bytes)));
      tr.append(verdictCell(row.forward));
      tr.append(verdictCell(row.reverse));
      diagBody.append(tr);
    }
    const rtts =
      diag.rttSamples.length > 0
        ? diag.rttSamples.map((r) => r.toFixed(0)).join(", ") + " ms"
        : "none";
    diagSummary.textContent =
      "Role " +
      diag.role +
      ", EC " +
      diag.ecl +
      ", phase " +
      diag.phase +
      " | confirmed forward " +
      diag.forwardConfirmedBytes +
      " B, reverse " +
      diag.reverseConfirmedBytes +
      " B | burst " +
      diag.burstFramesSeen +
      "/" +
      diag.burstFrames +
      " | RTT " +
      rtts +
      " | timeouts " +
      diag.timeouts;
  }

  /**
   * Chunk-size agreement.
   *
   * Both machines calibrate independently and can disagree. Each keeps
   * re-displaying its own offer until the peer’s arrives, then both adopt
   * the smaller size. Min is symmetric, so no leader is needed and neither
   * side uses a size it has not itself proven it can read.
   */
  function handleAgreeFrame(frame: ValidatedFrame): void {
    let offer: AgreementOffer;
    try {
      offer = validateCalAgree(frame.json);
    } catch {
      return;
    }
    if (currentChunkSize === null) return;
    const result = agree(
      { chunkSize: currentChunkSize, ecl: lastEcl },
      offer,
    );
    transferChunkSize = result.chunkSize;
    // We have what we need; stop occupying the display so the transfer
    // panel can show its own frames.
    agreeFrame = null;
    if (agreeTimer !== null) clearInterval(agreeTimer);
    agreeTimer = null;
    transferPanel.refresh();
    setText(hint, result.reason);
  }

  function offerAgree(): void {
    if (currentChunkSize === null || controller === null) return;
    const frame = encodeFrame({
      type: "CAL_AGREE",
      sessionId: CALIBRATION_SESSION_ID,
      sequence: 0,
      payload: jsonPayload({ chunkSize: currentChunkSize, ecl: lastEcl }),
    });
    agreeFrame = frame;
    agreeTimer ??= setInterval(() => {
      if (agreeFrame === null) return;
      drawBeacon(agreeFrame, lastEcl);
    }, 1500);
  }

  function applyView(view: LinkCheckView): void {
    setText(status, view.phase);
    status.dataset.kind = view.linkUp ? "ready" : "pending";
    setText(hint, view.hint);
    const dd = (node: HTMLElement): HTMLElement =>
      node.querySelector("dd") as HTMLElement;
    setText(dd(iSeePeer), view.iSeePeer ? "yes" : "no");
    setText(dd(peerSeesMe), view.peerSeesMe ? "yes" : "no");
    setText(dd(peerVersion), view.peerAppVersion ?? "unknown");
    setText(
      dd(peerProtocols),
      view.peerProtocolVersions
        ? view.peerProtocolVersions.join(", ")
        : "unknown",
    );
    setText(dd(rateField), view.decodeRate.toFixed(2) + " per second");
    setText(dd(qualityField), view.quality);
    setText(dd(calField), view.calId ?? "not derived");
    setText(
      dd(leaderField),
      view.calId === null ? "not elected" : view.leader ? "yes" : "no",
    );
    setText(
      nonceLine,
      "Local nonce " +
        view.localNonce +
        (view.peerNonce ? " | peer nonce " + view.peerNonce : ""),
    );
    setText(dd(calPhaseField), view.calibrationMessage);
    setText(
      dd(chunkField),
      view.profile
        ? view.profile.chunkSize + " bytes (" + view.profile.ecl + ")"
        : "not measured",
    );
    setText(
      dd(frameRateField),
      view.profile && view.profile.framesPerSecond > 0
        ? view.profile.framesPerSecond.toFixed(1) +
            " per second, reliability " +
            view.profile.reliability.toFixed(2)
        : "not measured",
    );
    setText(
      dd(rttField),
      view.profile && view.profile.rttMs !== null
        ? view.profile.rttMs.toFixed(0) + " ms"
        : "not measured",
    );
    currentChunkSize = view.profile ? view.profile.chunkSize : null;
    if (view.profile) lastEcl = view.profile.ecl;
    if (currentChunkSize !== null && !agreementSent) {
      agreementSent = true;
      offerAgree();
    }
    transferPanel.refresh();
    calibrateBtn.disabled = !view.canCalibrate;
    // Priority: an active transfer frame, then an outstanding agreement
    // offer, then calibration/beacon. Without the agreement step the peer
    // would never see our offer because the view loop redraws over it.
    if (transferFrame !== null) {
      drawBeacon(transferFrame, view.frameEcl);
    } else if (agreeFrame !== null) {
      drawBeacon(agreeFrame, lastEcl);
    } else {
      drawBeacon(controller?.displayFrameText() ?? "", view.frameEcl);
    }
    deviceSelect.disabled = !controller;
    renderDiagnostics(view);
  }

  /**
   * Phones default to the selfie camera, which is useless for scanning the
   * other screen. Start already prefers the rear camera; this switches when a
   * browser ignores that preference. The label is driven by the facing the
   * track reports, not by what we asked for.
   */
  function syncFlipLabel(actual: "environment" | "user" | null): void {
    if (actual === null) {
      flipBtn.textContent = "Switch camera";
      return;
    }
    flipBtn.textContent =
      actual === "environment"
        ? "Switch to front camera"
        : "Switch to back camera";
  }

  async function flipCamera(): Promise<void> {
    if (!controller) return;
    flipBtn.disabled = true;
    // Target the opposite of what is actually open. When the platform does
    // not report facing, fall back to flipping the requested preference.
    const actual = controller.cameraSession?.facing ?? null;
    const target: "environment" | "user" =
      actual === null
        ? facing === "environment"
          ? "user"
          : "environment"
        : actual === "environment"
          ? "user"
          : "environment";
    facing = target;
    try {
      await controller.switchCamera(undefined, preview, target);
      const nowOpen = controller.cameraSession?.facing ?? null;
      syncFlipLabel(nowOpen);
      deviceSelect.replaceChildren(el("option", undefined, "Default camera"));
      const where = nowOpen ?? target;
      setText(
        hint,
        "Camera is now on the " +
          (where === "environment" ? "back" : "front") +
          " camera." +
          (nowOpen === null
            ? " (the browser does not report which lens is open)"
            : ""),
      );
    } catch (error) {
      hint.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      flipBtn.disabled = false;
    }
  }

  async function start(): Promise<void> {
    if (controller) return;
    startBtn.disabled = true;
    controller = new LinkCheckController(linkCheckLocal(), {
      onView: (view) => applyView(view),
      onPeerFrame: (frame) => {
        if (frame.type === "CAL_AGREE") {
          handleAgreeFrame(frame);
          return true;
        }
        return transferPanel.onPeerFrame(frame);
      },
    });
    try {
      await controller.start(preview, facing);
      stopBtn.disabled = false;
      flipBtn.disabled = false;
      // Label from the lens the track actually reports, not the one asked for.
      syncFlipLabel(controller.cameraSession?.facing ?? null);
      const cams = await listCameras().catch(() => []);
      deviceSelect.replaceChildren(el("option", undefined, "Default camera"));
      for (const cam of cams) {
        const option = el("option", undefined, cam.label);
        option.value = cam.deviceId;
        deviceSelect.append(option);
      }
      controller.emitView();
    } catch (error) {
      const message =
        error instanceof CameraError ? error.message : String(error);
      status.textContent = "Camera unavailable";
      status.dataset.kind = "unavailable";
      hint.textContent = message;
      startBtn.disabled = false;
    }
  }

  /**
   * Runs a full calibration exchange through the simulated optical channel.
   * Needs no camera and no peer, so it works on a single machine. The
   * numbers are a model, not a measurement, but the wiring is the real one.
   */
  function simulate(): void {
    simulateBtn.disabled = true;
    status.textContent = "Simulating calibration...";
    status.dataset.kind = "pending";
    setTimeout(() => {
      try {
        const result = runLoopback({
          channel: { ...DEFAULT_CHANNEL, modulePx: 8, captureWidth: 2400 },
          calId: "simulated-calibration-id-000000",
          ecl: "M",
        });
        const profile = result.leaderProfile;
        diagBody.replaceChildren();
        for (const row of [...result.leader.ladder].reverse()) {
          const tr = el("tr");
          tr.append(el("td", undefined, String(row.bytes)));
          tr.append(verdictCell(row.forward));
          tr.append(verdictCell(row.reverse));
          diagBody.append(tr);
        }
        // The loopback advances a virtual clock in fixed steps, so its RTT is a
        // property of the harness, not of any link. Reporting it as milliseconds
        // would be a number with no physical meaning.
        const rtts = "n/a (virtual time)";
        diagSummary.textContent =
          "SIMULATED | completed " +
          (result.completed ? "yes" : "no") +
          " | dropped " +
          result.dropped +
          " | confirmed forward " +
          result.leader.forwardConfirmedBytes +
          " B" +
          ", reverse " +
          result.leader.reverseConfirmedBytes +
          " B" +
          " | RTT " +
          rtts +
          (profile ? " | chunk " + profile.chunkSize + " B" : "");
        status.textContent = profile
          ? "Simulated calibration: " + profile.chunkSize + " bytes per frame"
          : "Simulated calibration produced no profile";
        status.dataset.kind = profile ? "ready" : "unavailable";
        setText(
          hint,
          "Simulated run only. Real hardware will differ; use the camera path for real numbers.",
        );
      } catch (error) {
        status.textContent = "Simulation failed: " + (error as Error).message;
        status.dataset.kind = "unavailable";
      } finally {
        simulateBtn.disabled = false;
      }
    }, 30);
  }

  function calibrate(): void {
    controller?.startCalibration();
  }

  async function stop(): Promise<void> {
    await controller?.stop();
    controller = null;
    preview.srcObject = null;
    startBtn.disabled = false;
    flipBtn.disabled = true;
    stopBtn.disabled = true;
    status.textContent = "Stopped";
    status.dataset.kind = "pending";
    calibrateBtn.disabled = true;
  }

  deviceSelect.addEventListener("change", () => {
    const value = deviceSelect.value;
    if (controller && value)
      void controller.switchCamera(value, preview).catch((error: unknown) => {
        hint.textContent =
          error instanceof Error ? error.message : String(error);
      });
  });

  return () => {
    if (agreeTimer !== null) clearInterval(agreeTimer);
    agreeTimer = null;
    transferPanel.destroy();
    void stop();
  };
}
