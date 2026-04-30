const datasets = {
  triangle: window.MUSHRISTOR_TRIANGLE_HYDRATED,
  sine: window.MUSHRISTOR_SINE_HYDRATED,
  sawtooth: window.MUSHRISTOR_SAWTOOTH_HYDRATED,
  square: window.MUSHRISTOR_SQUARE_HYDRATED,
};

const controls = {
  frequencySlider: document.getElementById("frequencySlider"),
  vppSlider: document.getElementById("vppSlider"),
  resistanceSlider: document.getElementById("resistanceSlider"),
  showGrid: document.getElementById("showGrid"),
  showAxes: document.getElementById("showAxes"),
  smoothTrace: document.getElementById("smoothTrace"),
  animateTrace: document.getElementById("animateTrace"),
  unconstrainFrequency: document.getElementById("unconstrainFrequency"),
  unconstrainVoltage: document.getElementById("unconstrainVoltage"),
  unconstrainShunt: document.getElementById("unconstrainShunt"),
  snapNearest: document.getElementById("snapNearest"),
  waveformButtons: Array.from(document.querySelectorAll("[data-waveform]")),
  modeButtons: Array.from(document.querySelectorAll("[data-display-mode]")),
};

const labels = {
  frequencyValue: document.getElementById("frequencyValue"),
  vppValue: document.getElementById("vppValue"),
  resistanceValue: document.getElementById("resistanceValue"),
};

const ivCanvas = document.getElementById("ivCanvas");
const waveCanvas = document.getElementById("waveCanvas");

const missingDatasets = Object.entries(datasets)
  .filter(([, data]) => !data)
  .map(([name]) => name);

if (missingDatasets.length) {
  document.body.innerHTML = `
    <main class="shell">
      <section class="control-panel">
        <h1>Dataset missing</h1>
        <p>Missing: ${missingDatasets.join(", ")}. Run <code>python3 scripts/build_triangle_dataset.py</code> from the AgTech folder.</p>
      </section>
    </main>
  `;
  throw new Error(`Missing datasets: ${missingDatasets.join(", ")}`);
}

const state = {
  waveform: "sine",
  frequencyHz: 10,
  vppSetting: 1,
  rShuntOhms: 1_000_000,
  displayMode: "trueIv",
  showGrid: false,
  showAxes: false,
  smooth: true,
  animate: false,
  unconstrainFrequency: true,
  unconstrainVoltage: true,
  unconstrainShunt: false,
};

const log10 = (value) => Math.log(value) / Math.LN10;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const lerp = (a, b, amount) => a + (b - a) * amount;
const ptp = (values) => Math.max(...values) - Math.min(...values);
const traceKeys = ["vMushroom", "currentUa", "vSource", "vShunt"];
const boundsCache = new Map();
const maxDisplayShuntOhms = 1_000_000;

function activeDataset(target = state) {
  return datasets[target.waveform || state.waveform];
}

function activeCaptures(target = state) {
  return activeDataset(target).captures;
}

function activeRanges(target = state) {
  const ranges = activeDataset(target).ranges;
  return {
    ...ranges,
    rShuntOhms: [
      ranges.rShuntOhms[0],
      Math.min(ranges.rShuntOhms[1], maxDisplayShuntOhms),
    ],
  };
}

function activePhase(target = state) {
  return activeDataset(target).phase;
}

function featureRangesFor(target = state) {
  const ranges = activeRanges(target);
  return {
    frequency: ranges.frequencyHz.map(log10),
    resistance: ranges.rShuntOhms.map(log10),
    vpp: ranges.vppSetting,
  };
}

function clampStateToDataset() {
  const ranges = activeRanges();
  state.frequencyHz = clamp(state.frequencyHz, ranges.frequencyHz[0], ranges.frequencyHz[1]);
  state.vppSetting = clamp(state.vppSetting, ranges.vppSetting[0], ranges.vppSetting[1]);
  state.rShuntOhms = clamp(state.rShuntOhms, ranges.rShuntOhms[0], ranges.rShuntOhms[1]);
}

function invalidateBounds() {
  boundsCache.clear();
}

function updateSliderRanges() {
  const featureRanges = featureRangesFor();

  controls.frequencySlider.min = featureRanges.frequency[0];
  controls.frequencySlider.max = featureRanges.frequency[1];
  controls.frequencySlider.step = 0.001;
  controls.frequencySlider.value = log10(state.frequencyHz);

  controls.resistanceSlider.min = featureRanges.resistance[0];
  controls.resistanceSlider.max = featureRanges.resistance[1];
  controls.resistanceSlider.step = 0.001;
  controls.resistanceSlider.value = log10(state.rShuntOhms);

  controls.vppSlider.min = featureRanges.vpp[0];
  controls.vppSlider.max = featureRanges.vpp[1];
  controls.vppSlider.step = 0.01;
  controls.vppSlider.value = state.vppSetting;
}

function updateWaveformButtons() {
  controls.waveformButtons.forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.waveform === state.waveform));
  });
}

function updateModeButtons() {
  controls.modeButtons.forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.displayMode === state.displayMode));
  });
}

function initControls() {
  updateSliderRanges();
  updateWaveformButtons();
  updateModeButtons();

  controls.frequencySlider.addEventListener("input", () => {
    state.frequencyHz = 10 ** Number(controls.frequencySlider.value);
    invalidateBounds();
    updateReadouts();
  });
  controls.vppSlider.addEventListener("input", () => {
    state.vppSetting = Number(controls.vppSlider.value);
    invalidateBounds();
    updateReadouts();
  });
  controls.resistanceSlider.addEventListener("input", () => {
    state.rShuntOhms = 10 ** Number(controls.resistanceSlider.value);
    invalidateBounds();
    updateReadouts();
  });
  controls.modeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.displayMode = button.dataset.displayMode;
      invalidateBounds();
      updateModeButtons();
      updateReadouts();
    });
  });
  controls.showGrid.addEventListener("change", () => {
    state.showGrid = controls.showGrid.checked;
  });
  controls.showAxes.addEventListener("change", () => {
    state.showAxes = controls.showAxes.checked;
  });
  controls.smoothTrace.addEventListener("change", () => {
    state.smooth = controls.smoothTrace.checked;
    invalidateBounds();
    updateReadouts();
  });
  controls.animateTrace.addEventListener("change", () => {
    state.animate = controls.animateTrace.checked;
  });
  controls.unconstrainFrequency.addEventListener("change", () => {
    state.unconstrainFrequency = controls.unconstrainFrequency.checked;
    invalidateBounds();
  });
  controls.unconstrainVoltage.addEventListener("change", () => {
    state.unconstrainVoltage = controls.unconstrainVoltage.checked;
    invalidateBounds();
  });
  controls.unconstrainShunt.addEventListener("change", () => {
    state.unconstrainShunt = controls.unconstrainShunt.checked;
    invalidateBounds();
  });
  controls.waveformButtons.forEach((button) => {
    button.addEventListener("dragstart", (event) => {
      event.preventDefault();
    });
    button.addEventListener("click", () => {
      state.waveform = button.dataset.waveform;
      clampStateToDataset();
      invalidateBounds();
      updateSliderRanges();
      updateWaveformButtons();
      updateReadouts();
    });
  });
  controls.snapNearest.addEventListener("click", () => {
    const nearest = nearestCaptureByPriority();
    state.frequencyHz = nearest.frequency_hz;
    state.vppSetting = nearest.vpp_setting;
    state.rShuntOhms = nearest.r_shunt_ohms;
    controls.frequencySlider.value = log10(state.frequencyHz);
    controls.vppSlider.value = state.vppSetting;
    controls.resistanceSlider.value = log10(state.rShuntOhms);
    invalidateBounds();
    updateReadouts();
  });
}

function formatFrequency(value) {
  if (value >= 1000) return `${(value / 1000).toFixed(2).replace(/\.00$/, "")} kHz`;
  if (value < 10) return `${value.toFixed(2).replace(/0$/, "").replace(/\.0$/, "")} Hz`;
  return `${value.toFixed(1).replace(/\.0$/, "")} Hz`;
}

function formatResistance(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2).replace(/\.00$/, "")} MΩ`;
  return `${(value / 1000).toFixed(value < 100_000 ? 1 : 0).replace(/\.0$/, "")} kΩ`;
}

function featureDistance(capture, target = state, options = {}) {
  const featureRanges = featureRangesFor(target);
  const fRange = featureRanges.frequency[1] - featureRanges.frequency[0];
  const rRange = featureRanges.resistance[1] - featureRanges.resistance[0];
  const df = (log10(target.frequencyHz) - log10(capture.frequency_hz)) / fRange;
  const dr = (log10(target.rShuntOhms) - log10(capture.r_shunt_ohms)) / rRange;
  const baseDistance = df * df + dr * dr;

  // The scope showed voltage as a pure 2D scale factor, so interpolation shape
  // is chosen from frequency/resistance and voltage is applied afterward.
  if (!options.includeVoltage) return baseDistance;

  const vRange = featureRanges.vpp[1] - featureRanges.vpp[0];
  const dv = (target.vppSetting - capture.vpp_setting) / vRange;
  return baseDistance + 0.25 * dv * dv;
}

function rankCaptures(target = state, options = {}) {
  return activeCaptures(target)
    .map((capture) => ({ capture, distance: featureDistance(capture, target, options) }))
    .sort((a, b) => a.distance - b.distance);
}

function nearestCaptureByPriority(target = state) {
  const scored = activeCaptures(target).map((capture) => ({
    capture,
    resistanceDistance: Math.abs(log10(target.rShuntOhms) - log10(capture.r_shunt_ohms)),
    frequencyDistance: Math.abs(log10(target.frequencyHz) - log10(capture.frequency_hz)),
    voltageDistance: Math.abs(target.vppSetting - capture.vpp_setting),
  }));

  return scored.sort((a, b) => {
    return a.resistanceDistance - b.resistanceDistance
      || a.frequencyDistance - b.frequencyDistance
      || a.voltageDistance - b.voltageDistance;
  })[0].capture;
}

function uniqueSorted(values) {
  return Array.from(new Set(values)).sort((a, b) => a - b);
}

function bracketValues(values, targetValue, transform = (value) => value) {
  const sorted = uniqueSorted(values);
  if (sorted.length === 1) return { lower: sorted[0], upper: sorted[0], amount: 0 };
  if (targetValue <= sorted[0]) return { lower: sorted[0], upper: sorted[0], amount: 0 };
  if (targetValue >= sorted[sorted.length - 1]) {
    const value = sorted[sorted.length - 1];
    return { lower: value, upper: value, amount: 0 };
  }

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const lower = sorted[i];
    const upper = sorted[i + 1];
    if (targetValue >= lower && targetValue <= upper) {
      const transformedLower = transform(lower);
      const transformedUpper = transform(upper);
      const amount = transformedLower === transformedUpper
        ? 0
        : (transform(targetValue) - transformedLower) / (transformedUpper - transformedLower);
      return { lower, upper, amount: clamp(amount, 0, 1) };
    }
  }

  const fallback = sorted[0];
  return { lower: fallback, upper: fallback, amount: 0 };
}

function blendTraces(lowerTrace, upperTrace, amount) {
  if (amount <= 0) return lowerTrace;
  if (amount >= 1) return upperTrace;
  const pointCount = lowerTrace[traceKeys[0]].length;
  const trace = Object.fromEntries(traceKeys.map((key) => [key, Array(pointCount).fill(0)]));

  traceKeys.forEach((key) => {
    for (let i = 0; i < pointCount; i += 1) {
      trace[key][i] = lerp(lowerTrace[key][i], upperTrace[key][i], amount);
    }
  });

  return trace;
}

function canonicalCapture(capturesForPoint) {
  return capturesForPoint.slice().sort((a, b) => {
    return b.vpp_setting - a.vpp_setting
      || a.index - b.index;
  })[0];
}

function interpolatedTraceAtResistance(rShuntOhms, target = state) {
  const capturesAtResistance = activeCaptures(target)
    .filter((capture) => capture.r_shunt_ohms === rShuntOhms);
  const frequencyBracket = bracketValues(
    capturesAtResistance.map((capture) => capture.frequency_hz),
    target.frequencyHz,
    log10,
  );

  const traceAtFrequency = (frequencyHz) => {
    const capturesAtPoint = capturesAtResistance
      .filter((capture) => capture.frequency_hz === frequencyHz);
    return scaledCapture(canonicalCapture(capturesAtPoint), target);
  };

  return blendTraces(
    traceAtFrequency(frequencyBracket.lower),
    traceAtFrequency(frequencyBracket.upper),
    frequencyBracket.amount,
  );
}

function interpolateTraceNearest(target = state) {
  const ranked = rankCaptures(target);
  const exact = ranked[0];
  if (exact.distance < 1e-10) {
    return {
      trace: scaledCapture(exact.capture, target),
    };
  }

  const neighbors = ranked.slice(0, 8);
  const weights = neighbors.map(({ distance }) => 1 / ((distance + 0.0025) ** 2));
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const pointCount = activePhase(target).length;
  const trace = Object.fromEntries(traceKeys.map((key) => [key, Array(pointCount).fill(0)]));

  neighbors.forEach(({ capture }, neighborIndex) => {
    const weight = weights[neighborIndex] / weightSum;
    const scaled = scaledCapture(capture, target);
    traceKeys.forEach((key) => {
      for (let i = 0; i < pointCount; i += 1) {
        trace[key][i] += scaled[key][i] * weight;
      }
    });
  });

  return { trace };
}

function interpolateTraceBracketed(target = state) {
  const resistanceBracket = bracketValues(
    activeCaptures(target).map((capture) => capture.r_shunt_ohms),
    target.rShuntOhms,
    log10,
  );
  const lowerTrace = interpolatedTraceAtResistance(resistanceBracket.lower, target);
  const upperTrace = interpolatedTraceAtResistance(resistanceBracket.upper, target);

  return {
    trace: blendTraces(lowerTrace, upperTrace, resistanceBracket.amount),
  };
}

function interpolateTrace(target = state) {
  return ["sawtooth", "square"].includes(target.waveform || state.waveform)
    ? interpolateTraceBracketed(target)
    : interpolateTraceNearest(target);
}

function scaledCapture(capture, target = state) {
  const scale = target.vppSetting / capture.vpp_setting;
  return {
    vMushroom: capture.points.vMushroom.map((value) => value * scale),
    currentUa: capture.points.currentUa.map((value) => value * scale),
    vSource: capture.points.vSource.map((value) => value * scale),
    vShunt: capture.points.vShunt.map((value) => value * scale),
  };
}

function rangeIndices(start, end, length) {
  const indices = [];
  let index = start;
  for (let guard = 0; guard <= length; guard += 1) {
    indices.push(index);
    if (index === end) break;
    index = (index + 1) % length;
  }
  return indices;
}

function smoothSegment(values, indices, radius = 6, passes = 3) {
  let segment = indices.map((index) => values[index]);

  for (let pass = 0; pass < passes; pass += 1) {
    const next = segment.slice();
    for (let i = 1; i < segment.length - 1; i += 1) {
      let weightedSum = 0;
      let weightSum = 0;
      const left = Math.max(0, i - radius);
      const right = Math.min(segment.length - 1, i + radius);

      for (let j = left; j <= right; j += 1) {
        const weight = radius + 1 - Math.abs(i - j);
        weightedSum += segment[j] * weight;
        weightSum += weight;
      }

      next[i] = weightedSum / weightSum;
    }
    segment = next;
  }

  return segment;
}

function smoothTrace(trace) {
  const pointCount = trace.vSource.length;
  const source = trace.vSource;
  let minIndex = 0;
  let maxIndex = 0;

  for (let i = 1; i < source.length; i += 1) {
    if (source[i] < source[minIndex]) minIndex = i;
    if (source[i] > source[maxIndex]) maxIndex = i;
  }

  const branches = [
    rangeIndices(minIndex, maxIndex, pointCount),
    rangeIndices(maxIndex, minIndex, pointCount),
  ];
  const smoothed = Object.fromEntries(traceKeys.map((key) => [key, trace[key].slice()]));

  branches.forEach((indices) => {
    if (indices.length < 8) return;
    traceKeys.forEach((key) => {
      const segment = smoothSegment(trace[key], indices);
      indices.forEach((traceIndex, segmentIndex) => {
        smoothed[key][traceIndex] = segment[segmentIndex];
      });
    });
  });

  return smoothed;
}

function despikeValues(values, thresholdRatio = 0.018, passes = 2) {
  let output = values.slice();
  const amplitude = Math.max(0.001, ptp(values));
  const threshold = amplitude * thresholdRatio;

  for (let pass = 0; pass < passes; pass += 1) {
    const next = output.slice();
    for (let i = 1; i < output.length - 1; i += 1) {
      const previous = output[i - 1];
      const current = output[i];
      const following = output[i + 1];
      const neighborMidpoint = (previous + following) / 2;
      const neighborsAgree = Math.abs(previous - following) < threshold;
      const currentSpikes = Math.abs(current - neighborMidpoint) > threshold * 1.6;

      if (neighborsAgree && currentSpikes) {
        next[i] = neighborMidpoint;
      }
    }
    output = next;
  }

  return output;
}

function cleanupSquareTrace(trace) {
  return Object.fromEntries(
    traceKeys.map((key) => [key, despikeValues(trace[key])]),
  );
}

function getDisplayTrace(target = state) {
  const result = interpolateTrace(target);
  const waveform = target.waveform || state.waveform;
  if (waveform === "square") {
    return {
      ...result,
      trace: cleanupSquareTrace(result.trace),
    };
  }

  const shouldSmooth = state.smooth;
  return {
    ...result,
    trace: shouldSmooth ? smoothTrace(result.trace) : result.trace,
  };
}

function updateReadouts() {
  labels.frequencyValue.textContent = formatFrequency(state.frequencyHz);
  labels.vppValue.textContent = `${state.vppSetting.toFixed(2).replace(/0$/, "").replace(/\.0$/, "")} Vpp`;
  labels.resistanceValue.textContent = formatResistance(state.rShuntOhms);
}

function setupCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width: rect.width, height: rect.height };
}

function drawGrid(ctx, width, height, inset) {
  ctx.save();
  ctx.fillStyle = "#020406";
  ctx.fillRect(0, 0, width, height);

  if (!state.showGrid) {
    ctx.restore();
    return;
  }

  const left = inset.left;
  const right = width - inset.right;
  const top = inset.top;
  const bottom = height - inset.bottom;
  const cols = 10;
  const rows = 8;

  ctx.strokeStyle = "rgba(125, 220, 255, 0.12)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= cols; i += 1) {
    const x = lerp(left, right, i / cols);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
  }
  for (let i = 0; i <= rows; i += 1) {
    const y = lerp(top, bottom, i / rows);
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
  }

  ctx.fillStyle = "rgba(180, 242, 255, 0.48)";
  for (let i = 0; i <= cols; i += 1) {
    for (let j = 0; j <= rows; j += 1) {
      const x = lerp(left, right, i / cols);
      const y = lerp(top, bottom, j / rows);
      ctx.beginPath();
      ctx.arc(x, y, 1.15, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function pathTrace(ctx, xs, ys, mapX, mapY, closePath = true) {
  ctx.beginPath();
  ctx.moveTo(mapX(xs[0]), mapY(ys[0]));
  for (let i = 1; i < xs.length; i += 1) {
    ctx.lineTo(mapX(xs[i]), mapY(ys[i]));
  }
  if (closePath) {
    ctx.lineTo(mapX(xs[0]), mapY(ys[0]));
  }
}

function getSymmetricBounds(xs, ys) {
  const maxX = Math.max(0.02, ...xs.map((value) => Math.abs(value))) * 1.12;
  const maxY = Math.max(0.02, ...ys.map((value) => Math.abs(value))) * 1.12;
  return { minX: -maxX, maxX, minY: -maxY, maxY };
}

function measuredResistanceValues(target = state) {
  const [minResistance, maxResistance] = activeRanges(target).rShuntOhms;
  return uniqueSorted(
    activeCaptures(target)
      .map((capture) => capture.r_shunt_ohms)
      .filter((value) => value >= minResistance && value <= maxResistance),
  );
}

function boundsSampleValues(axis) {
  const ranges = activeRanges();
  const frequencyValues = state.unconstrainFrequency && axis === "x"
    ? uniqueSorted(activeCaptures().map((capture) => capture.frequency_hz))
    : [state.frequencyHz];
  const voltageValues = state.unconstrainVoltage
    ? [ranges.vppSetting[1]]
    : [state.vppSetting];
  const shuntValues = state.unconstrainShunt
    ? measuredResistanceValues()
    : [state.rShuntOhms];

  return { frequencyValues, voltageValues, shuntValues };
}

function boundsCacheKey() {
  return [
    state.waveform,
    state.displayMode,
    state.smooth,
    state.unconstrainFrequency,
    state.unconstrainVoltage,
    state.unconstrainShunt,
    log10(state.frequencyHz).toFixed(4),
    state.vppSetting.toFixed(3),
    log10(state.rShuntOhms).toFixed(4),
  ].join(":");
}

function maxForBoundsAxis(axis) {
  const { frequencyValues, voltageValues, shuntValues } = boundsSampleValues(axis);
  let maxValue = 0.02;

  frequencyValues.forEach((frequencyHz) => {
    voltageValues.forEach((vppSetting) => {
      shuntValues.forEach((rShuntOhms) => {
        const { trace } = getDisplayTrace({
          ...state,
          frequencyHz,
          vppSetting,
          rShuntOhms,
        });
        const values = axis === "x"
          ? trace.vMushroom
          : state.displayMode === "trueIv"
            ? trace.currentUa
            : trace.vSource;
        maxValue = Math.max(maxValue, ...values.map((value) => Math.abs(value)));
      });
    });
  });

  return maxValue * 1.12;
}

function presentationBounds() {
  const cacheKey = [
    boundsCacheKey(),
    "presentation",
  ].join(":");
  if (boundsCache.has(cacheKey)) return boundsCache.get(cacheKey);

  const maxX = maxForBoundsAxis("x");
  const maxY = maxForBoundsAxis("y");
  const bounds = {
    minX: -maxX,
    maxX,
    minY: -maxY,
    maxY,
  };
  boundsCache.set(cacheKey, bounds);
  return bounds;
}

function drawIv(timestamp) {
  const { ctx, width, height } = setupCanvas(ivCanvas);
  const inset = { left: 48, right: 28, top: 26, bottom: 38 };
  const { trace } = getDisplayTrace();
  const xs = trace.vMushroom;
  const ys = state.displayMode === "trueIv" ? trace.currentUa : trace.vSource;
  const bounds = presentationBounds();
  const plotLeft = inset.left;
  const plotRight = width - inset.right;
  const plotTop = inset.top;
  const plotBottom = height - inset.bottom;
  const mapX = (value) => plotLeft + ((value - bounds.minX) / (bounds.maxX - bounds.minX)) * (plotRight - plotLeft);
  const mapY = (value) => plotBottom - ((value - bounds.minY) / (bounds.maxY - bounds.minY)) * (plotBottom - plotTop);

  drawGrid(ctx, width, height, inset);

  if (state.showAxes) {
    ctx.save();
    ctx.strokeStyle = "rgba(245, 255, 174, 0.85)";
    ctx.lineWidth = 1.4;
    ctx.setLineDash([8, 8]);
    ctx.beginPath();
    ctx.moveTo(plotLeft, mapY(0));
    ctx.lineTo(plotRight, mapY(0));
    ctx.stroke();

    ctx.strokeStyle = "rgba(190, 244, 255, 0.62)";
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(mapX(0), plotTop);
    ctx.lineTo(mapX(0), plotBottom);
    ctx.stroke();
    ctx.restore();
  }

  ctx.save();
  pathTrace(ctx, xs, ys, mapX, mapY);
  ctx.shadowColor = "rgba(43, 151, 255, 0.98)";
  ctx.shadowBlur = 18;
  ctx.lineWidth = 5.5;
  ctx.strokeStyle = "rgba(28, 111, 255, 0.42)";
  ctx.stroke();

  pathTrace(ctx, xs, ys, mapX, mapY);
  ctx.shadowBlur = 8;
  ctx.lineWidth = 2.4;
  ctx.strokeStyle = "rgba(75, 196, 255, 0.86)";
  ctx.stroke();

  pathTrace(ctx, xs, ys, mapX, mapY);
  ctx.shadowBlur = 0;
  ctx.lineWidth = 1.05;
  ctx.strokeStyle = "rgba(215, 248, 255, 0.88)";
  ctx.stroke();
  ctx.restore();

  if (state.animate) {
    const cyclePosition = ((timestamp || 0) * 0.00018) % 1;
    const index = Math.floor(cyclePosition * xs.length);
    const x = mapX(xs[index]);
    const y = mapY(ys[index]);
    ctx.save();
    ctx.shadowColor = "rgba(133, 229, 255, 1)";
    ctx.shadowBlur = 20;
    ctx.fillStyle = "#dffaff";
    ctx.beginPath();
    ctx.arc(x, y, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function normalizeWaveform(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const center = (min + max) / 2;
  const halfRange = Math.max(0.001, (max - min) / 2);
  return values.map((value) => (value - center) / halfRange);
}

function drawOverlayTrace(ctx, signal, geometry) {
  const { values, color } = signal;
  const { left, right, centerY, amplitude } = geometry;
  const normalized = normalizeWaveform(values);
  const mapX = (index) => left + (index / (normalized.length - 1)) * (right - left);
  const mapY = (value) => centerY - value * amplitude;

  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = 12;
  ctx.strokeStyle = color;
  ctx.lineWidth = 4.2;
  ctx.globalAlpha = 0.35;
  ctx.beginPath();
  normalized.forEach((value, index) => {
    const x = mapX(index);
    const y = mapY(value);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.globalAlpha = 0.98;
  ctx.shadowBlur = 5;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  normalized.forEach((value, index) => {
    const x = mapX(index);
    const y = mapY(value);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.restore();
}

function drawWaveLegend(ctx, signals, left, top, right) {
  ctx.save();
  ctx.shadowBlur = 0;
  ctx.font = "12px Avenir Next, Trebuchet MS, sans-serif";

  signals.forEach((signal, index) => {
    const y = top + index * 24;
    ctx.fillStyle = signal.color;
    ctx.beginPath();
    ctx.arc(left + 5, y - 4, 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "rgba(230, 250, 255, 0.92)";
    ctx.textAlign = "left";
    ctx.fillText(signal.label, left + 18, y);

    ctx.fillStyle = "rgba(160, 205, 219, 0.9)";
    ctx.textAlign = "right";
    ctx.fillText(`pp ${ptp(signal.values).toFixed(3)} ${signal.unit}`, right, y);
  });
  ctx.restore();
}

function drawWaveforms() {
  if (!waveCanvas) return;

  const { ctx, width, height } = setupCanvas(waveCanvas);
  const { trace } = getDisplayTrace();
  const inset = { left: 22, right: 22, top: 18, bottom: 18 };
  drawGrid(ctx, width, height, inset);

  const left = inset.left + 6;
  const right = width - inset.right - 6;
  const top = inset.top + 18;
  const bottom = height - inset.bottom - 10;
  const centerY = (top + bottom) / 2;
  const amplitude = (bottom - top) * 0.38;
  const lanes = [
    {
      label: "CH2 source voltage",
      values: trace.vSource,
      unit: "V",
      color: "rgba(230, 212, 95, 0.95)",
    },
    {
      label: "CH1 mushroom voltage",
      values: trace.vMushroom,
      unit: "V",
      color: "rgba(72, 201, 255, 0.95)",
    },
    {
      label: "Computed current",
      values: trace.currentUa,
      unit: "uA",
      color: "rgba(31, 123, 255, 0.95)",
    },
  ];

  if (state.showAxes) {
    ctx.save();
    ctx.strokeStyle = "rgba(190, 244, 255, 0.35)";
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(left, centerY);
    ctx.lineTo(right, centerY);
    ctx.stroke();
    ctx.strokeStyle = "rgba(190, 244, 255, 0.2)";
    ctx.beginPath();
    ctx.moveTo(left, top);
    ctx.lineTo(left, bottom);
    ctx.stroke();
    ctx.restore();
  }

  lanes.forEach((lane) => {
    drawOverlayTrace(ctx, lane, { left, right, centerY, amplitude });
  });

  drawWaveLegend(ctx, lanes, left + 10, top + 6, right - 8);
}

function render(timestamp) {
  drawIv(timestamp);
  drawWaveforms();
  window.requestAnimationFrame(render);
}

window.addEventListener("resize", () => {
  window.requestAnimationFrame(() => {
    drawIv(performance.now());
    drawWaveforms();
  });
});

if ("ResizeObserver" in window) {
  const redrawAfterLayout = new ResizeObserver(() => {
    window.requestAnimationFrame(() => {
      drawIv(performance.now());
      drawWaveforms();
    });
  });

  redrawAfterLayout.observe(ivCanvas);
  if (waveCanvas) redrawAfterLayout.observe(waveCanvas);
}

initControls();
updateReadouts();
window.requestAnimationFrame(render);
