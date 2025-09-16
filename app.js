const videoEl = document.querySelector('#preview');
const overlayEl = document.querySelector('#overlay');
const overlayCtx = overlayEl.getContext('2d', { willReadFrequently: true });
const permissionHintEl = document.querySelector('#permission-hint');
const cameraSelectEl = document.querySelector('#camera-select');
const startButtonEl = document.querySelector('#start-button');
const stopButtonEl = document.querySelector('#stop-button');
const statusEl = document.querySelector('#status');
const textBoxEl = document.querySelector('#detected-values');
const resultListEl = document.querySelector('#detected-list');
const clearButtonEl = document.querySelector('#clear-results');

const DETECTION_INTERVAL_MS = 250;
const RESULT_TTL_MS = 8000;

let mediaStream = null;
let detectionTimer = null;
let activeDetector = null;
let detectorReady = null;
let lastResults = new Map();

class NativeBarcodeDetector {
  constructor(formats) {
    const options = Array.isArray(formats) && formats.length ? { formats } : undefined;
    this.detector = new window.BarcodeDetector(options);
  }

  async detect(video) {
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      return [];
    }

    try {
      const rawResults = await this.detector.detect(video);
      return rawResults.map((result) => ({
        rawValue: result.rawValue,
        format: result.format || 'unknown',
        box: {
          x: result.boundingBox?.x ?? 0,
          y: result.boundingBox?.y ?? 0,
          width: result.boundingBox?.width ?? video.videoWidth,
          height: result.boundingBox?.height ?? video.videoHeight,
        },
      }));
    } catch (error) {
      if (error?.name === 'InvalidStateError' || error?.name === 'TypeError') {
        return [];
      }
      throw error;
    }
  }
}

class ZXingBarcodeDetector {
  constructor(zxing) {
    const {
      MultiFormatReader,
      GenericMultipleBarcodeReader,
      DecodeHintType,
      BarcodeFormat,
      BinaryBitmap,
      HybridBinarizer,
      RGBLuminanceSource,
      NotFoundException,
      FormatException,
      ChecksumException,
    } = zxing;

    this.BinaryBitmap = BinaryBitmap;
    this.HybridBinarizer = HybridBinarizer;
    this.RGBLuminanceSource = RGBLuminanceSource;
    this.NotFoundException = NotFoundException;
    this.FormatException = FormatException;
    this.ChecksumException = ChecksumException;
    this.BarcodeFormat = BarcodeFormat;

    this.reader = new MultiFormatReader();
    this.multipleReader = GenericMultipleBarcodeReader
      ? new GenericMultipleBarcodeReader(this.reader)
      : null;
    this.hints = new Map();
    if (DecodeHintType) {
      this.hints.set(DecodeHintType.TRY_HARDER, true);
    }

    this.workerCanvas = document.createElement('canvas');
    this.workerCtx = this.workerCanvas.getContext('2d', { willReadFrequently: true });

    this._formatNameCache = new Map();
  }

  detect(video) {
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      return Promise.resolve([]);
    }

    const width = video.videoWidth;
    const height = video.videoHeight;

    if (!width || !height) {
      return Promise.resolve([]);
    }

    this.workerCanvas.width = width;
    this.workerCanvas.height = height;
    this.workerCtx.drawImage(video, 0, 0, width, height);

    const imageData = this.workerCtx.getImageData(0, 0, width, height);
    const luminanceBuffer = this._toGrayscale(imageData);
    const luminanceSource = new this.RGBLuminanceSource(luminanceBuffer, width, height);
    const binaryBitmap = new this.BinaryBitmap(new this.HybridBinarizer(luminanceSource));

    try {
      const results = this.multipleReader?.decodeMultiple
        ? this.multipleReader.decodeMultiple(binaryBitmap, this.hints)
        : [this.reader.decode(binaryBitmap, this.hints)];
      this.reader.reset();
      return Promise.resolve(results.map((result) => this._mapResult(result, width, height)));
    } catch (error) {
      this.reader.reset();

      if (this._isZXingNoResultError(error)) {
        return Promise.resolve([]);
      }

      console.error('ZXing detection error', error);
      return Promise.resolve([]);
    }
  }

  _isZXingNoResultError(error) {
    const matches = (ErrorClass, name) => {
      if (ErrorClass && error instanceof ErrorClass) {
        return true;
      }
      return error?.name === name;
    };

    return (
      matches(this.NotFoundException, 'NotFoundException') ||
      matches(this.FormatException, 'FormatException') ||
      matches(this.ChecksumException, 'ChecksumException')
    );
  }

  _mapResult(result, fallbackWidth, fallbackHeight) {
    const points = result.getResultPoints?.() ?? [];
    const box = this._pointsToRect(points, fallbackWidth, fallbackHeight);

    return {
      rawValue: result.getText?.() ?? '',
      format: this._formatToString(result.getBarcodeFormat?.()),
      box,
    };
  }

  _pointsToRect(points, fallbackWidth, fallbackHeight) {
    if (!points || !points.length) {
      return { x: 0, y: 0, width: fallbackWidth, height: fallbackHeight };
    }

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const point of points) {
      if (!point) continue;
      const x = point.getX?.();
      const y = point.getY?.();
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return { x: 0, y: 0, width: fallbackWidth, height: fallbackHeight };
    }

    const padding = 8;
    const x = Math.max(0, minX - padding);
    const y = Math.max(0, minY - padding);
    const width = Math.min(fallbackWidth, maxX + padding) - x;
    const height = Math.min(fallbackHeight, maxY + padding) - y;

    return { x, y, width: Math.max(1, width), height: Math.max(1, height) };
  }

  _formatToString(format) {
    if (this._formatNameCache.has(format)) {
      return this._formatNameCache.get(format);
    }

    for (const [name, value] of Object.entries(this.BarcodeFormat)) {
      if (value === format) {
        this._formatNameCache.set(format, name);
        return name;
      }
    }

    return 'UNKNOWN';
  }

  _toGrayscale(imageData) {
    const { data } = imageData;
    const luminances = new Uint8ClampedArray(imageData.width * imageData.height);

    for (let i = 0, j = 0; j < luminances.length; j++, i += 4) {
      // Rec. 709 luma coefficients
      luminances[j] = Math.round(data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722);
    }

    return luminances;
  }
}

async function createDetector() {
  if ('BarcodeDetector' in window) {
    try {
      const supportedFormats = await (window.BarcodeDetector.getSupportedFormats?.() ?? []);
      return new NativeBarcodeDetector(supportedFormats);
    } catch (error) {
      console.warn('BarcodeDetector API is present but failed to initialise, falling back to ZXing.', error);
    }
  }

  const zxing = await import('https://cdn.jsdelivr.net/npm/@zxing/library@0.20.0/+esm');
  return new ZXingBarcodeDetector(zxing);
}

async function ensureDetector() {
  if (!detectorReady) {
    detectorReady = createDetector();
  }

  if (!activeDetector) {
    activeDetector = await detectorReady;
  }

  return activeDetector;
}

async function initCamera(deviceId) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('このブラウザは getUserMedia に対応していません');
  }

  const constraints = {
    audio: false,
    video: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      facingMode: deviceId ? undefined : { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  };

  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  assignStream(stream);

  await ensureVideoCanPlay();
  await ensureVideoIsPlaying();
  resizeOverlay();
  await populateCameraOptions();
  hidePermissionHint();

  return stream;
}

function assignStream(stream) {
  if (mediaStream === stream) {
    return;
  }

  stopMediaStream();
  mediaStream = stream;
  videoEl.srcObject = stream;
  return stream;
}

function stopMediaStream() {
  if (!mediaStream) return;
  for (const track of mediaStream.getTracks()) {
    track.stop();
  }
  mediaStream = null;
  videoEl.srcObject = null;
}

function ensureVideoCanPlay() {
  return new Promise((resolve) => {
    if (videoEl.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      resolve();
      return;
    }

    const onLoaded = () => {
      videoEl.removeEventListener('loadeddata', onLoaded);
      resolve();
    };

    videoEl.addEventListener('loadeddata', onLoaded, { once: true });
  });
}

async function ensureVideoIsPlaying() {
  try {
    await videoEl.play();
  } catch (error) {
    console.warn('自動再生に失敗しました。ユーザー操作が必要な場合があります。', error);
  }
}

function resizeOverlay() {
  const width = videoEl.videoWidth;
  const height = videoEl.videoHeight;
  if (!width || !height) return;
  overlayEl.width = width;
  overlayEl.height = height;
}

async function populateCameraOptions() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return;
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const videoDevices = devices.filter((d) => d.kind === 'videoinput');

  const currentValue = cameraSelectEl.value;
  cameraSelectEl.innerHTML = '';

  videoDevices.forEach((device, index) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || `カメラ ${index + 1}`;
    cameraSelectEl.append(option);
  });

  if (videoDevices.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'カメラが見つかりません';
    cameraSelectEl.append(option);
  }

  if (currentValue && cameraSelectEl.querySelector(`option[value="${currentValue}"]`)) {
    cameraSelectEl.value = currentValue;
  }
}

function startDetectionLoop() {
  if (detectionTimer) {
    clearTimeout(detectionTimer);
    detectionTimer = null;
  }

  const tick = async () => {
    if (!mediaStream) {
      detectionTimer = null;
      return;
    }

    try {
      const detector = await ensureDetector();
      const detections = await detector.detect(videoEl);
      updateResults(detections);
    } catch (error) {
      console.error('Detection loop error', error);
      statusEl.value = '検出エラーが発生しました';
    }

    detectionTimer = window.setTimeout(tick, DETECTION_INTERVAL_MS);
  };

  tick();
}

function stopDetectionLoop() {
  if (detectionTimer) {
    clearTimeout(detectionTimer);
    detectionTimer = null;
  }
  overlayCtx.clearRect(0, 0, overlayEl.width, overlayEl.height);
}

function updateResults(detections) {
  const now = Date.now();
  let updated = false;

  detections.forEach((detection) => {
    const key = detection.rawValue || `${detection.box.x}-${detection.box.y}`;
    const existing = lastResults.get(key) || {};
    lastResults.set(key, {
      ...existing,
      ...detection,
      lastSeen: now,
    });
    updated = true;
  });

  for (const [key, value] of Array.from(lastResults.entries())) {
    if (now - value.lastSeen > RESULT_TTL_MS) {
      lastResults.delete(key);
      updated = true;
    }
  }

  if (updated) {
    renderResults();
  }
}

function renderResults() {
  overlayCtx.clearRect(0, 0, overlayEl.width, overlayEl.height);

  const ordered = Array.from(lastResults.values()).sort((a, b) => b.lastSeen - a.lastSeen);
  const lines = [];
  resultListEl.innerHTML = '';

  ordered.forEach((result, index) => {
    drawBoundingBox(result, index);
    lines.push(`${result.rawValue} (${result.format})`);

    const listItem = document.createElement('li');
    const valueSpan = document.createElement('span');
    valueSpan.className = 'result-value';
    valueSpan.textContent = result.rawValue || '(値なし)';

    const metaSpan = document.createElement('span');
    metaSpan.className = 'result-meta';
    const elapsed = Math.max(0, Math.round((Date.now() - result.lastSeen) / 1000));
    metaSpan.textContent = `${result.format} / ${elapsed} 秒前`;

    listItem.append(valueSpan, metaSpan);
    resultListEl.append(listItem);
  });

  textBoxEl.value = lines.join('\n');

  if (ordered.length === 0) {
    textBoxEl.value = '';
  }
}

function drawBoundingBox(result, index) {
  const { box } = result;
  if (!box) return;

  const hue = (index * 57) % 360;
  const strokeStyle = `hsl(${hue} 85% 65%)`;
  const fillStyle = `hsla(${hue} 85% 50% / 0.15)`;

  overlayCtx.save();
  overlayCtx.strokeStyle = strokeStyle;
  overlayCtx.fillStyle = fillStyle;
  overlayCtx.lineWidth = 3;
  overlayCtx.beginPath();
  overlayCtx.roundRect?.(box.x, box.y, box.width, box.height, 12);
  if (!overlayCtx.roundRect) {
    overlayCtx.rect(box.x, box.y, box.width, box.height);
  }
  overlayCtx.fill();
  overlayCtx.stroke();

  overlayCtx.fillStyle = strokeStyle;
  overlayCtx.font = '16px system-ui, sans-serif';
  overlayCtx.textBaseline = 'top';
  const label = result.rawValue ? `${result.rawValue}` : '(値なし)';
  overlayCtx.fillText(label, box.x + 8, Math.max(0, box.y - 22));
  overlayCtx.restore();
}

function hidePermissionHint() {
  permissionHintEl.classList.add('hidden');
}

function showPermissionHint() {
  permissionHintEl.classList.remove('hidden');
}

async function handleStart() {
  startButtonEl.disabled = true;
  stopButtonEl.disabled = false;
  statusEl.value = 'カメラ初期化中…';

  try {
    await ensureDetector();
    const stream = await initCamera(cameraSelectEl.value || undefined);
    if (stream) {
      statusEl.value = '検出を開始しました';
      startDetectionLoop();
    }
  } catch (error) {
    console.error(error);
    statusEl.value = error.message || 'カメラの初期化に失敗しました';
    showPermissionHint();
    startButtonEl.disabled = false;
    stopButtonEl.disabled = true;
  }
}

function handleStop() {
  stopDetectionLoop();
  stopMediaStream();
  statusEl.value = '停止しました';
  startButtonEl.disabled = false;
  stopButtonEl.disabled = true;
}

async function handleCameraChange() {
  if (startButtonEl.disabled) {
    try {
      await initCamera(cameraSelectEl.value || undefined);
      statusEl.value = 'カメラを切り替えました';
    } catch (error) {
      console.error(error);
      statusEl.value = error.message || 'カメラ切替に失敗しました';
    }
  }
}

function handleClearResults() {
  lastResults = new Map();
  renderResults();
}

async function bootstrap() {
  if (!navigator.mediaDevices?.getUserMedia) {
    statusEl.value = 'このブラウザではカメラが利用できません';
    startButtonEl.disabled = true;
    showPermissionHint();
    return;
  }

  try {
    await populateCameraOptions();
  } catch (error) {
    console.warn('カメラリスト取得に失敗', error);
  }

  videoEl.addEventListener('loadedmetadata', resizeOverlay);

  startButtonEl.addEventListener('click', handleStart);
  stopButtonEl.addEventListener('click', handleStop);
  cameraSelectEl.addEventListener('change', handleCameraChange);
  clearButtonEl.addEventListener('click', handleClearResults);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      stopDetectionLoop();
    } else if (startButtonEl.disabled) {
      startDetectionLoop();
    }
  });
}

bootstrap().catch((error) => {
  console.error('初期化に失敗しました', error);
  statusEl.value = '初期化に失敗しました';
});
