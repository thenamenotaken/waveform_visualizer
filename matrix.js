const datasets = {
  triangle: window.MUSHRISTOR_TRIANGLE_HYDRATED,
  sine: window.MUSHRISTOR_SINE_HYDRATED,
  sawtooth: window.MUSHRISTOR_SAWTOOTH_HYDRATED,
  square: window.MUSHRISTOR_SQUARE_HYDRATED,
};

const WAVEFORM_ORDER = ["sine", "triangle", "sawtooth", "square"];
const CONTINUOUS_VARIABLES = ["frequencyHz", "vppSetting", "rShuntOhms"];
const ALL_VARIABLES = ["waveform", ...CONTINUOUS_VARIABLES];
const traceKeys = ["vMushroom", "currentUa", "vSource", "vShunt"];
const maxDisplayShuntOhms = 1_000_000;

const controls = {
  xAxisSelect: document.getElementById("xAxisSelect"),
  yAxisSelect: document.getElementById("yAxisSelect"),
  xSamplesSlider: document.getElementById("xSamplesSlider"),
  ySamplesSlider: document.getElementById("ySamplesSlider"),
  xSamplesControl: document.getElementById("xSamplesControl"),
  ySamplesControl: document.getElementById("ySamplesControl"),
  modeButtons: Array.from(document.querySelectorAll("[data-display-mode]")),
  fixedWaveformControl: document.getElementById("fixedWaveformControl"),
  fixedWaveformButtons: Array.from(document.querySelectorAll("[data-fixed-waveform]")),
  fixedFrequencyControl: document.getElementById("fixedFrequencyControl"),
  fixedFrequencySlider: document.getElementById("fixedFrequencySlider"),
  fixedVoltageControl: document.getElementById("fixedVoltageControl"),
  fixedVoltageSlider: document.getElementById("fixedVoltageSlider"),
  fixedShuntControl: document.getElementById("fixedShuntControl"),
  fixedShuntSlider: document.getElementById("fixedShuntSlider"),
  modulationSelect: document.getElementById("modulationSelect"),
  modulationControl: document.getElementById("modulationControl"),
  modulationSlider: document.getElementById("modulationSlider"),
  playModulation: document.getElementById("playModulation"),
  playModulationWrap: document.getElementById("playModulationWrap"),
  showGrid: document.getElementById("showGrid"),
  showAxes: document.getElementById("showAxes"),
  showCursor: document.getElementById("showCursor"),
  smoothTrace: document.getElementById("smoothTrace"),
};

const labels = {
  xSamplesValue: document.getElementById("xSamplesValue"),
  ySamplesValue: document.getElementById("ySamplesValue"),
  fixedFrequencyValue: document.getElementById("fixedFrequencyValue"),
  fixedVoltageValue: document.getElementById("fixedVoltageValue"),
  fixedShuntValue: document.getElementById("fixedShuntValue"),
  modulationLabel: document.getElementById("modulationLabel"),
  modulationValue: document.getElementById("modulationValue"),
};

const matrixCanvas = document.getElementById("matrixCanvas");
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
  xAxis: "frequencyHz",
  yAxis: "waveform",
  xSamples: 4,
  ySamples: 4,
  fixed: {
    waveform: "sine",
    frequencyHz: 10,
    vppSetting: 1,
    rShuntOhms: 1_000_000,
  },
  modulationVariable: "",
  modulationValue: 1_000_000,
  modulationPlaying: false,
  displayMode: "trueIv",
  showGrid: false,
  showAxes: false,
  showCursor: false,
  smooth: true,
};

const log10 = (value) => Math.log(value) / Math.LN10;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const lerp = (a, b, amount) => a + (b - a) * amount;
const ptp = (values) => Math.max(...values) - Math.min(...values);
const traceCache = new Map();
const boundsCache = new Map();

const VARIABLE_META = {
  waveform: {
    label: "Waveform",
    formatter: (value) => value.charAt(0).toUpperCase() + value.slice(1),
  },
  frequencyHz: {
    label: "Frequency",
    log: true,
    formatter: formatFrequency,
  },
  vppSetting: {
    label: "Voltage",
    formatter: (value) => `${value.toFixed(2).replace(/0$/, "").replace(/\.0$/, "")} Vpp`,
  },
  rShuntOhms: {
    label: "Ballast Resistance",
    log: true,
    formatter: formatResistance,
  },
};

function formatFrequency(value) {
  if (value >= 1000) return `${(value / 1000).toFixed(2).replace(/\.00$/, "")} kHz`;
  if (value < 10) return `${value.toFixed(2).replace(/0$/, "").replace(/\.0$/, "")} Hz`;
  return `${value.toFixed(1).replace(/\.0$/, "")} Hz`;
}

function formatResistance(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2).replace(/\.00$/, "")} MΩ`;
  return `${(value / 1000).toFixed(value < 100_000 ? 1 : 0).replace(/\.0$/, "")} kΩ`;
}

function activeDataset(target) {
  return datasets[target.waveform];
}

function activeCaptures(target) {
  return activeDataset(target).captures;
}

function activeRanges(target) {
  const ranges = activeDataset(target).ranges;
  return {
    ...ranges,
    rShuntOhms: [
      ranges.rShuntOhms[0],
      Math.min(ranges.rShuntOhms[1], maxDisplayShuntOhms),
    ],
  };
}

function activePhase(target) {
  return activeDataset(target).phase;
}

function featureRangesFor(target) {
  const ranges = activeRanges(target);
  return {
    frequency: ranges.frequencyHz.map(log10),
    resistance: ranges.rShuntOhms.map(log10),
    vpp: ranges.vppSetting,
  };
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

function featureDistance(capture, target) {
  const featureRanges = featureRangesFor(target);
  const fRange = featureRanges.frequency[1] - featureRanges.frequency[0];
  const rRange = featureRanges.resistance[1] - featureRanges.resistance[0];
  const df = (log10(target.frequencyHz) - log10(capture.frequency_hz)) / fRange;
  const dr = (log10(target.rShuntOhms) - log10(capture.r_shunt_ohms)) / rRange;
  return df * df + dr * dr;
}

function rankCaptures(target) {
  return activeCaptures(target)
    .map((capture) => ({ capture, distance: featureDistance(capture, target) }))
    .sort((a, b) => a.distance - b.distance);
}

function scaledCapture(capture, target) {
  const scale = target.vppSetting / capture.vpp_setting;
  return {
    vMushroom: capture.points.vMushroom.map((value) => value * scale),
    currentUa: capture.points.currentUa.map((value) => value * scale),
    vSource: capture.points.vSource.map((value) => value * scale),
    vShunt: capture.points.vShunt.map((value) => value * scale),
  };
}

function blendTraces(lowerTrace, upperTrace, amount) {
  if (amount <= 0) return lowerTrace;
  if (amount >= 1) return upperTrace;

  const pointCount = lowerTrace[traceKeys[0]].length;
  const trace = Object.fromEntries(traceKeys.map((key) => [key, Array(pointCount).fill(0)]));

  traceKeys.forEach((key) => {
    for (let index = 0; index < pointCount; index += 1) {
      trace[key][index] = lerp(lowerTrace[key][index], upperTrace[key][index], amount);
    }
  });

  return trace;
}

function canonicalCapture(capturesForPoint) {
  return capturesForPoint.slice().sort((a, b) => {
    return b.vpp_setting - a.vpp_setting || a.index - b.index;
  })[0];
}

function interpolatedTraceAtResistance(rShuntOhms, target) {
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

function interpolateTraceNearest(target) {
  const ranked = rankCaptures(target);
  const exact = ranked[0];
  if (exact.distance < 1e-10) {
    return { trace: scaledCapture(exact.capture, target) };
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
      for (let index = 0; index < pointCount; index += 1) {
        trace[key][index] += scaled[key][index] * weight;
      }
    });
  });

  return { trace };
}

function interpolateTraceBracketed(target) {
  const resistanceBracket = bracketValues(
    activeCaptures(target).map((capture) => capture.r_shunt_ohms),
    target.rShuntOhms,
    log10,
  );
  const lowerTrace = interpolatedTraceAtResistance(resistanceBracket.lower, target);
  const upperTrace = interpolatedTraceAtResistance(resistanceBracket.upper, target);
  return { trace: blendTraces(lowerTrace, upperTrace, resistanceBracket.amount) };
}

function interpolateTrace(target) {
  return ["sawtooth", "square"].includes(target.waveform)
    ? interpolateTraceBracketed(target)
    : interpolateTraceNearest(target);
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
      if (neighborsAgree && currentSpikes) next[i] = neighborMidpoint;
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

function maxAbs(values) {
  return Math.max(1e-6, ...values.map((value) => Math.abs(value)));
}

function scaleSeries(values, factor) {
  return values.map((value) => value * factor);
}

function referenceShuntForWaveform(waveform) {
  const [minResistance, maxResistance] = activeRanges({ waveform }).rShuntOhms;
  return clamp(1_000_000, minResistance, maxResistance);
}

function traceCacheKey(target) {
  return [
    target.waveform,
    log10(target.frequencyHz).toFixed(5),
    target.vppSetting.toFixed(4),
    log10(target.rShuntOhms).toFixed(5),
    state.smooth,
  ].join(":");
}

function getDisplayTrace(target) {
  const cacheKey = traceCacheKey(target);
  if (traceCache.has(cacheKey)) return traceCache.get(cacheKey);

  const result = interpolateTrace(target);
  const trace = target.waveform === "square"
    ? cleanupSquareTrace(result.trace)
    : state.smooth
      ? smoothTrace(result.trace)
      : result.trace;
  const payload = { trace };

  if (traceCache.size > 320) traceCache.clear();
  traceCache.set(cacheKey, payload);
  return payload;
}

function plotAxesForTarget(target) {
  const { trace } = getDisplayTrace(target);
  let xs = trace.vMushroom;
  let ys = state.displayMode === "trueIv" ? trace.currentUa : trace.vSource;

  if (state.displayMode !== "trueIv") {
    return { xs, ys };
  }

  const referenceShunt = referenceShuntForWaveform(target.waveform);
  if (Math.abs(referenceShunt - target.rShuntOhms) < 1e-9) {
    return { xs, ys };
  }

  const { trace: referenceTrace } = getDisplayTrace({
    ...target,
    rShuntOhms: referenceShunt,
  });
  const xScale = maxAbs(referenceTrace.vMushroom) / maxAbs(xs);
  const yScale = maxAbs(referenceTrace.currentUa) / maxAbs(ys);

  xs = scaleSeries(xs, xScale);
  ys = scaleSeries(ys, yScale);
  return { xs, ys };
}

function invalidateCaches() {
  traceCache.clear();
  boundsCache.clear();
}

function visibleWaveforms() {
  if (state.xAxis === "waveform" || state.yAxis === "waveform") {
    return WAVEFORM_ORDER.slice();
  }
  return [state.fixed.waveform];
}

function rangeForVariable(variable, waveforms = visibleWaveforms()) {
  if (variable === "waveform") return null;

  const mins = waveforms.map((waveform) => activeRanges({ waveform })[variable][0]);
  const maxs = waveforms.map((waveform) => activeRanges({ waveform })[variable][1]);
  return [Math.max(...mins), Math.min(...maxs)];
}

function midpointForRange(variable, min, max) {
  if (VARIABLE_META[variable].log) {
    return 10 ** lerp(log10(min), log10(max), 0.5);
  }
  return lerp(min, max, 0.5);
}

function clampValueForVariable(variable, value, waveforms = visibleWaveforms()) {
  const [min, max] = rangeForVariable(variable, waveforms);
  return clamp(value, min, max);
}

function sampleContinuousValues(variable, count, waveforms = visibleWaveforms()) {
  const [min, max] = rangeForVariable(variable, waveforms);
  if (count <= 1 || Math.abs(max - min) < 1e-12) {
    return [midpointForRange(variable, min, max)];
  }

  return Array.from({ length: count }, (_, index) => {
    const amount = index / (count - 1);
    if (VARIABLE_META[variable].log) {
      return 10 ** lerp(log10(min), log10(max), amount);
    }
    return lerp(min, max, amount);
  });
}

function axisValues(variable, count) {
  return variable === "waveform"
    ? WAVEFORM_ORDER.slice()
    : sampleContinuousValues(variable, count);
}

function effectiveModulationValue(timestamp) {
  if (!state.modulationVariable) return null;
  if (!state.modulationPlaying) {
    return clampValueForVariable(state.modulationVariable, state.modulationValue);
  }

  const [min, max] = rangeForVariable(state.modulationVariable);
  const cycle = ((timestamp || 0) * 0.00012) % 1;
  const pingPong = cycle < 0.5 ? cycle * 2 : (1 - cycle) * 2;
  if (VARIABLE_META[state.modulationVariable].log) {
    return 10 ** lerp(log10(min), log10(max), pingPong);
  }
  return lerp(min, max, pingPong);
}

function ensureDistinctAxes(changedAxis) {
  if (state.xAxis !== state.yAxis) return;

  const replacement = ALL_VARIABLES.find((variable) => variable !== state[changedAxis]);
  if (changedAxis === "xAxis") state.yAxis = replacement;
  else state.xAxis = replacement;
}

function eligibleModulationVariables() {
  return CONTINUOUS_VARIABLES.filter(
    (variable) => variable !== state.xAxis && variable !== state.yAxis,
  );
}

function fixedVariables() {
  return ALL_VARIABLES.filter((variable) => {
    if (variable === state.xAxis || variable === state.yAxis) return false;
    if (variable === state.modulationVariable) return false;
    return true;
  });
}

function clampStateToVisibleRanges() {
  const waveforms = visibleWaveforms();
  CONTINUOUS_VARIABLES.forEach((variable) => {
    state.fixed[variable] = clampValueForVariable(variable, state.fixed[variable], waveforms);
  });

  const eligible = eligibleModulationVariables();
  if (!eligible.includes(state.modulationVariable)) {
    state.modulationVariable = "";
    state.modulationPlaying = false;
  }

  if (state.modulationVariable) {
    state.modulationValue = clampValueForVariable(state.modulationVariable, state.modulationValue, waveforms);
  }
}

function assignVariable(target, variable, value) {
  if (variable === "waveform") target.waveform = value;
  else target[variable] = value;
}

function gridState(timestamp) {
  const xValues = axisValues(state.xAxis, state.xAxis === "waveform" ? 4 : state.xSamples);
  const yValues = axisValues(state.yAxis, state.yAxis === "waveform" ? 4 : state.ySamples);
  const modulationValue = effectiveModulationValue(timestamp);
  const cells = yValues.map((rowValue) => {
    return xValues.map((columnValue) => {
      const target = {
        waveform: state.fixed.waveform,
        frequencyHz: state.fixed.frequencyHz,
        vppSetting: state.fixed.vppSetting,
        rShuntOhms: state.fixed.rShuntOhms,
      };
      assignVariable(target, state.xAxis, columnValue);
      assignVariable(target, state.yAxis, rowValue);
      if (state.modulationVariable) {
        assignVariable(target, state.modulationVariable, modulationValue);
      }
      return { target, rowValue, columnValue };
    });
  });

  return { xValues, yValues, cells, modulationValue };
}

function liveVariableValue(variable, timestamp) {
  if (state.modulationVariable === variable) {
    return effectiveModulationValue(timestamp);
  }
  return state.fixed[variable];
}

function frequencyBoundsValues() {
  if (state.xAxis === "frequencyHz") return axisValues("frequencyHz", state.xSamples);
  if (state.yAxis === "frequencyHz") return axisValues("frequencyHz", state.ySamples);
  return sampleContinuousValues("frequencyHz", 8);
}

function voltageBoundsValues() {
  const [, maxVoltage] = rangeForVariable("vppSetting");
  return [maxVoltage];
}

function shuntBoundsValues(timestamp) {
  if (state.xAxis === "rShuntOhms") return axisValues("rShuntOhms", state.xSamples);
  if (state.yAxis === "rShuntOhms") return axisValues("rShuntOhms", state.ySamples);
  return [liveVariableValue("rShuntOhms", timestamp)];
}

function waveformBoundsValues() {
  return state.xAxis === "waveform" || state.yAxis === "waveform"
    ? WAVEFORM_ORDER.slice()
    : [state.fixed.waveform];
}

function boundsCacheKey(timestamp) {
  const shuntValue = shuntBoundsValues(timestamp)
    .map((value) => (typeof value === "number" ? log10(value).toFixed(4) : value))
    .join(",");
  return [
    state.xAxis,
    state.yAxis,
    state.xSamples,
    state.ySamples,
    state.fixed.waveform,
    log10(state.fixed.frequencyHz).toFixed(4),
    state.fixed.vppSetting.toFixed(3),
    state.displayMode,
    state.modulationVariable || "none",
    shuntValue,
    state.smooth,
  ].join(":");
}

function matrixBounds(timestamp) {
  const cacheKey = boundsCacheKey(timestamp);
  if (boundsCache.has(cacheKey)) return boundsCache.get(cacheKey);

  const waveforms = waveformBoundsValues();
  const frequencyXValues = frequencyBoundsValues();
  const frequencyYValue = liveVariableValue("frequencyHz", timestamp);
  const voltageValues = voltageBoundsValues();
  const shuntValues = shuntBoundsValues(timestamp);

  let maxX = 0.02;
  let maxY = 0.02;

  waveforms.forEach((waveform) => {
    frequencyXValues.forEach((frequencyHz) => {
      voltageValues.forEach((vppSetting) => {
        shuntValues.forEach((rShuntOhms) => {
          const { xs } = plotAxesForTarget({ waveform, frequencyHz, vppSetting, rShuntOhms });
          maxX = Math.max(maxX, ...xs.map((value) => Math.abs(value)));
        });
      });
    });
  });

  waveforms.forEach((waveform) => {
    voltageValues.forEach((vppSetting) => {
      shuntValues.forEach((rShuntOhms) => {
        const { ys } = plotAxesForTarget({
          waveform,
          frequencyHz: frequencyYValue,
          vppSetting,
          rShuntOhms,
        });
        maxY = Math.max(maxY, ...ys.map((value) => Math.abs(value)));
      });
    });
  });

  const bounds = {
    minX: -maxX * 1.12,
    maxX: maxX * 1.12,
    minY: -maxY * 1.12,
    maxY: maxY * 1.12,
  };
  if (boundsCache.size > 240) boundsCache.clear();
  boundsCache.set(cacheKey, bounds);
  return bounds;
}

function sliderValueFor(variable, value) {
  return VARIABLE_META[variable].log ? log10(value) : value;
}

function valueFromSlider(variable, slider) {
  const numeric = Number(slider.value);
  return VARIABLE_META[variable].log ? 10 ** numeric : numeric;
}

function setSliderRange(slider, variable, value) {
  const [min, max] = rangeForVariable(variable);
  slider.min = VARIABLE_META[variable].log ? log10(min) : min;
  slider.max = VARIABLE_META[variable].log ? log10(max) : max;
  slider.step = VARIABLE_META[variable].log ? 0.001 : 0.01;
  slider.value = sliderValueFor(variable, value);
}

function updateModeButtons() {
  controls.modeButtons.forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.displayMode === state.displayMode));
  });
}

function updateFixedWaveformButtons() {
  controls.fixedWaveformButtons.forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.fixedWaveform === state.fixed.waveform));
  });
}

function updateModulationOptions() {
  const eligible = eligibleModulationVariables();
  const options = ['<option value="">None</option>']
    .concat(
      eligible.map((variable) => (
        `<option value="${variable}">${VARIABLE_META[variable].label}</option>`
      )),
    )
    .join("");
  controls.modulationSelect.innerHTML = options;
  controls.modulationSelect.value = state.modulationVariable;
}

function updateSampleControls() {
  const xWaveform = state.xAxis === "waveform";
  const yWaveform = state.yAxis === "waveform";

  controls.xSamplesControl.classList.toggle("hidden", xWaveform);
  controls.ySamplesControl.classList.toggle("hidden", yWaveform);
  labels.xSamplesValue.textContent = state.xSamples;
  labels.ySamplesValue.textContent = state.ySamples;
}

function updateFixedControls() {
  const fixed = new Set(fixedVariables());
  controls.fixedWaveformControl.classList.toggle("hidden", !fixed.has("waveform"));
  controls.fixedFrequencyControl.classList.toggle("hidden", !fixed.has("frequencyHz"));
  controls.fixedVoltageControl.classList.toggle("hidden", !fixed.has("vppSetting"));
  controls.fixedShuntControl.classList.toggle("hidden", !fixed.has("rShuntOhms"));

  if (fixed.has("frequencyHz")) {
    setSliderRange(controls.fixedFrequencySlider, "frequencyHz", state.fixed.frequencyHz);
    labels.fixedFrequencyValue.textContent = formatFrequency(state.fixed.frequencyHz);
  }
  if (fixed.has("vppSetting")) {
    setSliderRange(controls.fixedVoltageSlider, "vppSetting", state.fixed.vppSetting);
    labels.fixedVoltageValue.textContent = VARIABLE_META.vppSetting.formatter(state.fixed.vppSetting);
  }
  if (fixed.has("rShuntOhms")) {
    setSliderRange(controls.fixedShuntSlider, "rShuntOhms", state.fixed.rShuntOhms);
    labels.fixedShuntValue.textContent = formatResistance(state.fixed.rShuntOhms);
  }
  updateFixedWaveformButtons();
}

function updateModulationControl(timestamp = performance.now()) {
  const enabled = Boolean(state.modulationVariable);
  controls.modulationControl.classList.toggle("hidden", !enabled);
  controls.playModulationWrap.classList.toggle("hidden", !enabled);
  if (!enabled) {
    labels.modulationValue.textContent = "";
    return;
  }

  labels.modulationLabel.textContent = VARIABLE_META[state.modulationVariable].label;
  const displayedValue = effectiveModulationValue(timestamp);
  setSliderRange(controls.modulationSlider, state.modulationVariable, displayedValue);
  labels.modulationValue.textContent = VARIABLE_META[state.modulationVariable].formatter(displayedValue);
  controls.playModulation.checked = state.modulationPlaying;
}

function updateUi(timestamp = performance.now()) {
  controls.xAxisSelect.value = state.xAxis;
  controls.yAxisSelect.value = state.yAxis;
  controls.xSamplesSlider.value = state.xSamples;
  controls.ySamplesSlider.value = state.ySamples;
  updateModeButtons();
  updateModulationOptions();
  updateSampleControls();
  updateFixedControls();
  updateModulationControl(timestamp);
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

function drawCellGrid(ctx, cell, bounds) {
  if (state.showGrid) {
    ctx.save();
    ctx.strokeStyle = "rgba(125, 220, 255, 0.08)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i += 1) {
      const x = lerp(cell.left, cell.right, i / 4);
      ctx.beginPath();
      ctx.moveTo(x, cell.top);
      ctx.lineTo(x, cell.bottom);
      ctx.stroke();
    }
    for (let i = 0; i <= 4; i += 1) {
      const y = lerp(cell.top, cell.bottom, i / 4);
      ctx.beginPath();
      ctx.moveTo(cell.left, y);
      ctx.lineTo(cell.right, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  if (!state.showAxes) return;
  const mapX = (value) => cell.left + ((value - bounds.minX) / (bounds.maxX - bounds.minX)) * (cell.right - cell.left);
  const mapY = (value) => cell.bottom - ((value - bounds.minY) / (bounds.maxY - bounds.minY)) * (cell.bottom - cell.top);
  ctx.save();
  ctx.strokeStyle = "rgba(245, 255, 174, 0.48)";
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.moveTo(cell.left, mapY(0));
  ctx.lineTo(cell.right, mapY(0));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = "rgba(190, 244, 255, 0.35)";
  ctx.beginPath();
  ctx.moveTo(mapX(0), cell.top);
  ctx.lineTo(mapX(0), cell.bottom);
  ctx.stroke();
  ctx.restore();
}

function pathTrace(ctx, xs, ys, mapX, mapY) {
  ctx.beginPath();
  ctx.moveTo(mapX(xs[0]), mapY(ys[0]));
  for (let index = 1; index < xs.length; index += 1) {
    ctx.lineTo(mapX(xs[index]), mapY(ys[index]));
  }
  ctx.lineTo(mapX(xs[0]), mapY(ys[0]));
}

function drawMatrix(timestamp) {
  const { ctx, width, height } = setupCanvas(matrixCanvas);
  const current = gridState(timestamp);
  const bounds = matrixBounds(timestamp);
  const inset = { left: 126, right: 28, top: 68, bottom: 34 };
  const xAxisTitleY = 28;
  const columnHeaderY = inset.top - 10;
  const rows = current.yValues.length;
  const cols = current.xValues.length;
  const gap = 14;
  const gridWidth = width - inset.left - inset.right;
  const gridHeight = height - inset.top - inset.bottom;
  const cellWidth = (gridWidth - gap * (cols - 1)) / cols;
  const cellHeight = (gridHeight - gap * (rows - 1)) / rows;
  const cyclePosition = ((timestamp || 0) * 0.00018) % 1;

  ctx.fillStyle = "#020406";
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.fillStyle = "rgba(234, 248, 255, 0.9)";
  ctx.font = "600 16px Avenir Next, Trebuchet MS, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(VARIABLE_META[state.xAxis].label, inset.left + gridWidth / 2, xAxisTitleY);

  ctx.translate(28, inset.top + gridHeight / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(VARIABLE_META[state.yAxis].label, 0, 0);
  ctx.restore();

  current.xValues.forEach((value, index) => {
    const x = inset.left + index * (cellWidth + gap) + cellWidth / 2;
    ctx.fillStyle = "#d7f5ff";
    ctx.font = "600 13px Avenir Next, Trebuchet MS, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(VARIABLE_META[state.xAxis].formatter(value), x, columnHeaderY);
  });

  current.yValues.forEach((value, index) => {
    const y = inset.top + index * (cellHeight + gap) + cellHeight / 2 + 5;
    ctx.fillStyle = "#d7f5ff";
    ctx.font = "600 13px Avenir Next, Trebuchet MS, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(VARIABLE_META[state.yAxis].formatter(value), inset.left - 18, y);
  });

  current.cells.forEach((row, rowIndex) => {
    row.forEach((cellState, colIndex) => {
      const left = inset.left + colIndex * (cellWidth + gap);
      const top = inset.top + rowIndex * (cellHeight + gap);
      const right = left + cellWidth;
      const bottom = top + cellHeight;
      const cell = { left, top, right, bottom };

      ctx.save();
      ctx.fillStyle = "rgba(7, 18, 24, 0.7)";
      ctx.strokeStyle = "rgba(157, 225, 255, 0.12)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(left, top, cellWidth, cellHeight, 18);
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      drawCellGrid(ctx, cell, bounds);

      const { xs, ys } = plotAxesForTarget(cellState.target);
      const mapX = (value) => left + ((value - bounds.minX) / (bounds.maxX - bounds.minX)) * cellWidth;
      const mapY = (value) => bottom - ((value - bounds.minY) / (bounds.maxY - bounds.minY)) * cellHeight;

      ctx.save();
      pathTrace(ctx, xs, ys, mapX, mapY);
      ctx.shadowColor = "rgba(43, 151, 255, 0.9)";
      ctx.shadowBlur = Math.max(5, cellWidth * 0.045);
      ctx.lineWidth = Math.max(2.3, cellWidth * 0.018);
      ctx.strokeStyle = "rgba(28, 111, 255, 0.4)";
      ctx.stroke();

      pathTrace(ctx, xs, ys, mapX, mapY);
      ctx.shadowBlur = Math.max(3, cellWidth * 0.022);
      ctx.lineWidth = Math.max(1.15, cellWidth * 0.01);
      ctx.strokeStyle = "rgba(75, 196, 255, 0.84)";
      ctx.stroke();

      pathTrace(ctx, xs, ys, mapX, mapY);
      ctx.shadowBlur = 0;
      ctx.lineWidth = Math.max(0.7, cellWidth * 0.0055);
      ctx.strokeStyle = "rgba(222, 249, 255, 0.86)";
      ctx.stroke();
      ctx.restore();

      if (state.showCursor) {
        const index = Math.floor(cyclePosition * xs.length);
        ctx.save();
        ctx.shadowColor = "rgba(133, 229, 255, 1)";
        ctx.shadowBlur = 12;
        ctx.fillStyle = "#dffaff";
        ctx.beginPath();
        ctx.arc(mapX(xs[index]), mapY(ys[index]), Math.max(2.8, cellWidth * 0.028), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    });
  });
  updateModulationControl(timestamp);
}

function redraw(timestamp = performance.now()) {
  drawMatrix(timestamp);
}

function render(timestamp) {
  if (state.modulationPlaying || state.showCursor) {
    drawMatrix(timestamp);
  }
  window.requestAnimationFrame(render);
}

function initControls() {
  updateUi();

  controls.xAxisSelect.addEventListener("change", () => {
    state.xAxis = controls.xAxisSelect.value;
    ensureDistinctAxes("xAxis");
    clampStateToVisibleRanges();
    invalidateCaches();
    updateUi();
    redraw();
  });

  controls.yAxisSelect.addEventListener("change", () => {
    state.yAxis = controls.yAxisSelect.value;
    ensureDistinctAxes("yAxis");
    clampStateToVisibleRanges();
    invalidateCaches();
    updateUi();
    redraw();
  });

  controls.xSamplesSlider.addEventListener("input", () => {
    state.xSamples = Number(controls.xSamplesSlider.value);
    invalidateCaches();
    updateUi();
    redraw();
  });

  controls.ySamplesSlider.addEventListener("input", () => {
    state.ySamples = Number(controls.ySamplesSlider.value);
    invalidateCaches();
    updateUi();
    redraw();
  });

  controls.modeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.displayMode = button.dataset.displayMode;
      invalidateCaches();
      updateUi();
      redraw();
    });
  });

  controls.fixedWaveformButtons.forEach((button) => {
    button.addEventListener("dragstart", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      state.fixed.waveform = button.dataset.fixedWaveform;
      clampStateToVisibleRanges();
      invalidateCaches();
      updateUi();
      redraw();
    });
  });

  controls.fixedFrequencySlider.addEventListener("input", () => {
    state.fixed.frequencyHz = valueFromSlider("frequencyHz", controls.fixedFrequencySlider);
    invalidateCaches();
    updateUi();
    redraw();
  });

  controls.fixedVoltageSlider.addEventListener("input", () => {
    state.fixed.vppSetting = valueFromSlider("vppSetting", controls.fixedVoltageSlider);
    invalidateCaches();
    updateUi();
    redraw();
  });

  controls.fixedShuntSlider.addEventListener("input", () => {
    state.fixed.rShuntOhms = valueFromSlider("rShuntOhms", controls.fixedShuntSlider);
    updateUi();
    redraw();
  });

  controls.modulationSelect.addEventListener("change", () => {
    state.modulationVariable = controls.modulationSelect.value;
    state.modulationPlaying = false;
    if (state.modulationVariable) {
      state.modulationValue = state.fixed[state.modulationVariable];
      state.modulationValue = clampValueForVariable(state.modulationVariable, state.modulationValue);
    }
    clampStateToVisibleRanges();
    invalidateCaches();
    updateUi();
    redraw();
  });

  controls.modulationSlider.addEventListener("input", () => {
    if (!state.modulationVariable) return;
    state.modulationValue = valueFromSlider(state.modulationVariable, controls.modulationSlider);
    redraw();
  });

  controls.playModulation.addEventListener("change", () => {
    if (!state.modulationVariable) {
      controls.playModulation.checked = false;
      return;
    }
    if (!controls.playModulation.checked) {
      state.modulationValue = effectiveModulationValue(performance.now());
    }
    state.modulationPlaying = controls.playModulation.checked;
    updateUi();
    redraw();
  });

  controls.showGrid.addEventListener("change", () => {
    state.showGrid = controls.showGrid.checked;
    redraw();
  });

  controls.showAxes.addEventListener("change", () => {
    state.showAxes = controls.showAxes.checked;
    redraw();
  });

  controls.showCursor.addEventListener("change", () => {
    state.showCursor = controls.showCursor.checked;
    redraw();
  });

  controls.smoothTrace.addEventListener("change", () => {
    state.smooth = controls.smoothTrace.checked;
    invalidateCaches();
    redraw();
  });
}

window.addEventListener("resize", () => {
  window.requestAnimationFrame(() => redraw());
});

if ("ResizeObserver" in window) {
  const redrawAfterLayout = new ResizeObserver(() => {
    window.requestAnimationFrame(() => redraw());
  });
  redrawAfterLayout.observe(matrixCanvas);
}

clampStateToVisibleRanges();
initControls();
redraw();
window.requestAnimationFrame(render);
