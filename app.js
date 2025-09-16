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
const algorithmSelectEl = document.querySelector('#algorithm-select');
const videoWrapperEl = document.querySelector('.video-wrapper');

const DETECTION_INTERVAL_MS = 250;
const RESULT_TTL_MS = 8000;
const DETECTOR_DEFINITIONS = [
  { id: 'native', label: 'BarcodeDetector' },
  { id: 'zxing', label: 'ZXing' },
];

let mediaStream = null;
let detectionTimer = null;
let lastResults = new Map();
let lastOverlayWidth = 0;
let lastOverlayHeight = 0;
let lastOverlayDpr = 0;
const detectorCache = new Map();
const detectorAvailability = new Map(DETECTOR_DEFINITIONS.map(({ id }) => [id, false]));
let selectedAlgorithm = null;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getOverlayMetrics() {
  const videoWidth = videoEl.videoWidth;
  const videoHeight = videoEl.videoHeight;
  const overlayWidth = overlayEl.clientWidth;
  const overlayHeight = overlayEl.clientHeight;

  if (!videoWidth || !videoHeight || !overlayWidth || !overlayHeight) {
    return null;
  }

  const scale = Math.max(overlayWidth / videoWidth, overlayHeight / videoHeight);
  const displayedWidth = videoWidth * scale;
  const displayedHeight = videoHeight * scale;
  const offsetX = (overlayWidth - displayedWidth) / 2;
  const offsetY = (overlayHeight - displayedHeight) / 2;

  return { scale, offsetX, offsetY, overlayWidth, overlayHeight };
}

function clearOverlay() {
  overlayCtx.save();
  overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
  overlayCtx.clearRect(0, 0, overlayEl.width, overlayEl.height);
  overlayCtx.restore();
}

function convertPointsToOverlay(points) {
  const metrics = getOverlayMetrics();
  if (!metrics || !Array.isArray(points) || points.length === 0) {
    return null;
  }

  const converted = [];

  for (const point of points) {
    const x = point?.x ?? point?.getX?.();
    const y = point?.y ?? point?.getY?.();
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }
    converted.push({
      x: x * metrics.scale + metrics.offsetX,
      y: y * metrics.scale + metrics.offsetY,
    });
  }

  return converted.length ? converted : null;
}

function getBoundingRectFromPoints(points) {
  if (!Array.isArray(points) || points.length === 0) {
    return null;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const point of points) {
    if (!point) continue;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return null;
  }

  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

function convertBoxToOverlay(box) {
  const metrics = getOverlayMetrics();
  if (!metrics || !box) {
    return null;
  }

  const rawX = box.x * metrics.scale + metrics.offsetX;
  const rawY = box.y * metrics.scale + metrics.offsetY;
  const rawWidth = box.width * metrics.scale;
  const rawHeight = box.height * metrics.scale;

  if ([rawX, rawY, rawWidth, rawHeight].some((value) => !Number.isFinite(value))) {
    return null;
  }

  const startX = rawWidth >= 0 ? rawX : rawX + rawWidth;
  const endX = rawWidth >= 0 ? rawX + rawWidth : rawX;
  const startY = rawHeight >= 0 ? rawY : rawY + rawHeight;
  const endY = rawHeight >= 0 ? rawY + rawHeight : rawY;

  const clampedStartX = clamp(startX, 0, metrics.overlayWidth);
  const clampedEndX = clamp(endX, 0, metrics.overlayWidth);
  const clampedStartY = clamp(startY, 0, metrics.overlayHeight);
  const clampedEndY = clamp(endY, 0, metrics.overlayHeight);

  const width = clampedEndX - clampedStartX;
  const height = clampedEndY - clampedStartY;

  if (width <= 0 || height <= 0) {
    return null;
  }

  return {
    x: clampedStartX,
    y: clampedStartY,
    width: Math.max(1, width),
    height: Math.max(1, height),
  };
}

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
      return rawResults.map((result) => {
        const cornerPoints = Array.isArray(result.cornerPoints)
          ? result.cornerPoints
              .map((point) => {
                const x = point?.x ?? point?.[0];
                const y = point?.y ?? point?.[1];
                if (!Number.isFinite(x) || !Number.isFinite(y)) {
                  return null;
                }
                return { x, y };
              })
              .filter(Boolean)
          : null;

        return {
          rawValue: result.rawValue,
          format: result.format || 'unknown',
          box: {
            x: result.boundingBox?.x ?? 0,
            y: result.boundingBox?.y ?? 0,
            width: result.boundingBox?.width ?? video.videoWidth,
            height: result.boundingBox?.height ?? video.videoHeight,
          },
          points: cornerPoints && cornerPoints.length ? cornerPoints : null,
        };
      });
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
    const rawPoints = result.getResultPoints?.() ?? [];
    const points = rawPoints
      .map((point) => {
        const x = point?.getX?.();
        const y = point?.getY?.();
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          return null;
        }
        return { x, y };
      })
      .filter(Boolean);
    const box = this._pointsToRect(points, fallbackWidth, fallbackHeight);

    return {
      rawValue: result.getText?.() ?? '',
      format: this._formatToString(result.getBarcodeFormat?.()),
      box,
      points,
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
      const x = point?.x ?? point?.getX?.();
      const y = point?.y ?? point?.getY?.();
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

async function createDetectorByType(type) {
  if (type === 'native') {
    if (!('BarcodeDetector' in window)) {
      throw new Error('BarcodeDetector API は利用できません');
    }

    let supportedFormats = [];
    try {
      supportedFormats = await (window.BarcodeDetector.getSupportedFormats?.() ?? []);
    } catch (error) {
      console.warn('BarcodeDetector の対応フォーマット取得に失敗しました', error);
    }

    try {
      return new NativeBarcodeDetector(supportedFormats);
    } catch (error) {
      throw new Error(`BarcodeDetector の初期化に失敗しました: ${error?.message || error}`);
    }
  }

  if (type === 'zxing') {
    const zxing = await import('https://cdn.jsdelivr.net/npm/@zxing/library@0.20.0/+esm');
    return new ZXingBarcodeDetector(zxing);
  }

  throw new Error(`未知の検出アルゴリズムです: ${type}`);
}

async function ensureDetector(type) {
  if (!type) {
    return null;
  }

  if (detectorCache.has(type)) {
    return detectorCache.get(type);
  }

  const detector = await createDetectorByType(type);
  detectorCache.set(type, detector);
  return detector;
}

function getAlgorithmLabel(type) {
  const entry = DETECTOR_DEFINITIONS.find((definition) => definition.id === type);
  return entry?.label ?? type;
}

function updateAlgorithmSelectOptions() {
  if (!algorithmSelectEl) {
    return;
  }

  const currentValue = algorithmSelectEl.value;
  algorithmSelectEl.innerHTML = '';
  let availableCount = 0;

  DETECTOR_DEFINITIONS.forEach(({ id, label }) => {
    const option = document.createElement('option');
    option.value = id;
    const available = detectorAvailability.get(id);
    option.textContent = available ? label : `${label} (未対応)`;
    option.disabled = !available;
    if (available) {
      availableCount += 1;
    }
    algorithmSelectEl.append(option);
  });

  if (selectedAlgorithm && detectorAvailability.get(selectedAlgorithm)) {
    algorithmSelectEl.value = selectedAlgorithm;
  } else if (detectorAvailability.get(currentValue)) {
    selectedAlgorithm = currentValue;
    algorithmSelectEl.value = currentValue;
  } else {
    const fallback = DETECTOR_DEFINITIONS.find(({ id }) => detectorAvailability.get(id));
    selectedAlgorithm = fallback?.id ?? null;
    algorithmSelectEl.value = selectedAlgorithm ?? '';
  }

  if (!selectedAlgorithm) {
    algorithmSelectEl.value = '';
  }

  algorithmSelectEl.disabled = availableCount <= 1;
}

async function prepareDetectorOptions() {
  for (const { id } of DETECTOR_DEFINITIONS) {
    let available = false;
    try {
      const detector = await ensureDetector(id);
      if (detector) {
        available = true;
      }
    } catch (error) {
      detectorCache.delete(id);
      console.warn(`${getAlgorithmLabel(id)} は利用できません`, error);
    }
    detectorAvailability.set(id, available);
  }

  if (!selectedAlgorithm || !detectorAvailability.get(selectedAlgorithm)) {
    const fallback = DETECTOR_DEFINITIONS.find(({ id }) => detectorAvailability.get(id));
    selectedAlgorithm = fallback?.id ?? null;
  }

  updateAlgorithmSelectOptions();
}

async function ensureActiveDetector() {
  if (!selectedAlgorithm) {
    return null;
  }

  if (!detectorAvailability.get(selectedAlgorithm)) {
    return null;
  }

  try {
    return await ensureDetector(selectedAlgorithm);
  } catch (error) {
    console.error(`${getAlgorithmLabel(selectedAlgorithm)} の初期化に失敗しました`, error);
    detectorCache.delete(selectedAlgorithm);
    detectorAvailability.set(selectedAlgorithm, false);
    updateAlgorithmSelectOptions();
    return null;
  }
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
  if (videoWrapperEl) {
    const intrinsicWidth = videoEl.videoWidth;
    const intrinsicHeight = videoEl.videoHeight;
    if (intrinsicWidth && intrinsicHeight) {
      const aspect = `${intrinsicWidth} / ${intrinsicHeight}`;
      if (videoWrapperEl.style.aspectRatio !== aspect) {
        videoWrapperEl.style.aspectRatio = aspect;
      }
    } else if (videoWrapperEl.style.aspectRatio) {
      videoWrapperEl.style.aspectRatio = '';
    }
  }

  const rect = videoEl.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.round(rect.width * dpr);
  const height = Math.round(rect.height * dpr);

  if (!width || !height) {
    return;
  }

  if (width === lastOverlayWidth && height === lastOverlayHeight && dpr === lastOverlayDpr) {
    return;
  }

  lastOverlayWidth = width;
  lastOverlayHeight = height;
  lastOverlayDpr = dpr;

  overlayEl.width = width;
  overlayEl.height = height;
  overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  clearOverlay();
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

    const detector = await ensureActiveDetector();

    if (!detector) {
      if (statusEl.value !== '選択したアルゴリズムが利用できません') {
        statusEl.value = '選択したアルゴリズムが利用できません';
      }
    } else {
      try {
        const detections = await detector.detect(videoEl);
        updateResults(detections);
      } catch (error) {
        console.error('Detection loop error', error);
        statusEl.value = '検出エラーが発生しました';
      }
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
  clearOverlay();
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
  resizeOverlay();
  clearOverlay();

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
  const displayPoints = convertPointsToOverlay(result.points);
  let displayBox = convertBoxToOverlay(result.box);

  if ((!displayBox || !displayBox.width || !displayBox.height) && displayPoints) {
    displayBox = getBoundingRectFromPoints(displayPoints);
  }

  if (!displayBox) return;

  const hue = (index * 57) % 360;
  const strokeStyle = `hsl(${hue} 85% 65%)`;
  const fillStyle = `hsla(${hue} 85% 50% / 0.15)`;

  overlayCtx.save();
  overlayCtx.strokeStyle = strokeStyle;
  overlayCtx.fillStyle = fillStyle;
  overlayCtx.lineWidth = 3;
  overlayCtx.beginPath();

  if (displayPoints && displayPoints.length >= 3) {
    overlayCtx.moveTo(displayPoints[0].x, displayPoints[0].y);
    for (let i = 1; i < displayPoints.length; i += 1) {
      overlayCtx.lineTo(displayPoints[i].x, displayPoints[i].y);
    }
    overlayCtx.closePath();
    overlayCtx.fill();
    overlayCtx.stroke();
  } else {
    overlayCtx.roundRect?.(displayBox.x, displayBox.y, displayBox.width, displayBox.height, 12);
    if (!overlayCtx.roundRect) {
      overlayCtx.rect(displayBox.x, displayBox.y, displayBox.width, displayBox.height);
    }
    overlayCtx.fill();
    overlayCtx.stroke();
  }

  overlayCtx.fillStyle = strokeStyle;
  overlayCtx.font = '16px system-ui, sans-serif';
  overlayCtx.textBaseline = 'top';
  const label = result.rawValue ? `${result.rawValue}` : '(値なし)';
  const textY = displayBox.y - 22 >= 0 ? displayBox.y - 22 : displayBox.y + displayBox.height + 4;
  overlayCtx.fillText(label, displayBox.x + 8, textY);
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
    const detector = await ensureActiveDetector();
    if (!detector) {
      statusEl.value = '利用可能な検出アルゴリズムがありません';
      startButtonEl.disabled = false;
      stopButtonEl.disabled = true;
      return;
    }

    const stream = await initCamera(cameraSelectEl.value || undefined);
    if (stream) {
      statusEl.value = `${getAlgorithmLabel(selectedAlgorithm)} で検出を開始しました`;
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

function handleAlgorithmChange() {
  if (!algorithmSelectEl) {
    return;
  }

  const next = algorithmSelectEl.value;
  if (!next) {
    return;
  }

  if (!detectorAvailability.get(next)) {
    statusEl.value = `${getAlgorithmLabel(next)} は利用できません`;
    updateAlgorithmSelectOptions();
    return;
  }

  selectedAlgorithm = next;
  const label = getAlgorithmLabel(next);
  statusEl.value = startButtonEl.disabled ? `${label} に切り替えました` : `${label} を選択しました`;
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

  try {
    await prepareDetectorOptions();
  } catch (error) {
    console.warn('検出アルゴリズムの初期化に失敗', error);
    updateAlgorithmSelectOptions();
  }

  videoEl.addEventListener('loadedmetadata', resizeOverlay);
  window.addEventListener('resize', resizeOverlay);

  startButtonEl.addEventListener('click', handleStart);
  stopButtonEl.addEventListener('click', handleStop);
  cameraSelectEl.addEventListener('change', handleCameraChange);
  algorithmSelectEl?.addEventListener('change', handleAlgorithmChange);
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
