import { button, el, setText } from './dom';
import { TransferController, type TransferUiView } from './transfer';
import type { ValidatedFrame } from '../protocol/frame';

/**
 * Transfer panel for the Link Check screen.
 *
 * Enabled only once calibration has produced a chunk size: a transfer uses
 * the measured chunk size, so without calibration there is nothing to send.
 */
export interface TransferPanelOptions {
  chunkSize(): number | null;
  /** Shared with the peer; both machines must use the same value. */
  sessionId(): string | null;
  onFrame(frameText: string | null): void;
}

export interface TransferPanelHandle {
  readonly element: HTMLElement;
  onPeerFrame(frame: ValidatedFrame): boolean;
  refresh(): void;
  destroy(): void;
}

export function createTransferPanel(options: TransferPanelOptions): TransferPanelHandle {
  const section = el('section', 'pane');
  section.append(el('h2', undefined, 'File transfer'));

  const status = el('p', 'transfer-status', 'Calibrate first, then send or receive a file.');
  const progress = el('progress', 'transfer-progress');
  progress.max = 1;
  progress.value = 0;
  progress.hidden = true;

  const fileInput = el('input', 'transfer-file');
  fileInput.type = 'file';
  fileInput.setAttribute('aria-label', 'File to send');

  const sendBtn = button('Send file', () => void sendFile(), 'btn');
  const receiveBtn = button('Receive file', () => receive(), 'btn btn-secondary');
  const saveLink = el('a', 'transfer-save', 'Save received file');
  saveLink.style.display = 'none';

  const controls = el('div', 'controls');
  controls.append(fileInput, sendBtn, receiveBtn, saveLink);
  section.append(status, progress, controls);

  let view: TransferUiView | null = null;
  let saveUrl: string | null = null;

  const controller = new TransferController({
    chunkSize: () => options.chunkSize(),
    sessionId: () => options.sessionId(),
    onFrame: (text) => options.onFrame(text),
    onChange: (next) => {
      view = next;
      render(next);
    },
  });

  function render(next: TransferUiView): void {
    setText(status, next.message);
    const total = next.totalChunks;
    if (total > 0) {
      progress.hidden = false;
      progress.max = total;
      progress.value = Math.min(next.sentChunks, total);
    } else {
      progress.hidden = true;
    }

    const active = next.phase === 'sending' || next.phase === 'receiving';
    const calibrated =
      options.chunkSize() !== null && options.sessionId() !== null;
    sendBtn.disabled = !calibrated || active;
    receiveBtn.disabled = !calibrated || active;
    fileInput.disabled = !calibrated || active;

    if (next.receivedBytes && next.fileName) {
      if (saveUrl) URL.revokeObjectURL(saveUrl);
      const blob = new Blob([next.receivedBytes], { type: 'application/octet-stream' });
      saveUrl = URL.createObjectURL(blob);
      saveLink.href = saveUrl;
      saveLink.setAttribute('download', next.fileName);
      saveLink.textContent = 'Save ' + next.fileName;
      saveLink.style.display = '';
    } else {
      saveLink.style.display = 'none';
    }
  }

  async function sendFile(): Promise<void> {
    const file = fileInput.files?.[0];
    if (!file) { setText(status, 'Choose a file first.'); return; }
    try {
      await controller.send(file);
    } catch (error) {
      setText(status, error instanceof Error ? error.message : String(error));
    }
  }

  function receive(): void {
    try {
      controller.receive();
    } catch (error) {
      setText(status, error instanceof Error ? error.message : String(error));
    }
  }

  function onPeerFrame(frame: ValidatedFrame): boolean {
    if (!controller.active) return false;
    void controller.onFrame(frame);
    return true;
  }

  function refresh(): void {
    render(view ?? {
      phase: 'idle',
      message: 'Calibrate first, then send or receive a file.',
      sentChunks: 0,
      totalChunks: 0,
      fileName: null,
      receivedBytes: null,
      receivedSha256: null,
      outcome: null,
    });
  }

  function destroy(): void {
    controller.reset();
    if (saveUrl) URL.revokeObjectURL(saveUrl);
    saveUrl = null;
  }

  refresh();

  return { element: section, onPeerFrame, refresh, destroy };
}
