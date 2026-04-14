#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_OUTPUT = 'public/scenes/hodsock-gatehouse/splats/HodsockCombined30k.ksplat';
const DEFAULT_SPZ_OUTPUT = 'public/scenes/hodsock-gatehouse/splats/HodsockCombined30k.spz';
const DEFAULT_INPUT_CANDIDATES = [
  'public/scenes/hodsock-gatehouse/splats/HodsockCombined30k.splat',
  'public/scenes/hodsock-gatehouse/splats/HodsockCombined30k.ply',
];

const PRESETS = {
  speed: {
    compressionLevel: 2,
    alphaRemovalThreshold: 8,
    optimizeSplatData: true,
    sectionSize: 12000,
    blockSize: 5,
    bucketSize: 256,
    sphericalHarmonicsDegree: 0,
  },
  balanced: {
    compressionLevel: 1,
    alphaRemovalThreshold: 4,
    optimizeSplatData: true,
    sectionSize: 12000,
    blockSize: 5,
    bucketSize: 256,
    sphericalHarmonicsDegree: 0,
  },
  quality: {
    compressionLevel: 0,
    alphaRemovalThreshold: 1,
    optimizeSplatData: true,
    sectionSize: 16000,
    blockSize: 5,
    bucketSize: 256,
    sphericalHarmonicsDegree: 1,
  },
};

function parseArg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || index + 1 >= process.argv.length) {
    return fallback;
  }
  return process.argv[index + 1];
}

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function assertFormat(format) {
  if (format !== 'ksplat' && format !== 'spz') {
    throw new Error(`Unsupported output format "${format}". Use "ksplat" or "spz".`);
  }
}

function getExt(filePath) {
  return path.extname(filePath).toLowerCase();
}

function formatBytes(bytes) {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(2)} MB`;
}

async function toKSplat(inputPath, outputPath, presetName, libs, options) {
  const { THREE, GaussianSplats3D } = libs;
  const preset = PRESETS[presetName];
  if (!preset) {
    throw new Error(`Unknown preset "${presetName}". Use speed, balanced, or quality.`);
  }

  const inputBuffer = await fs.readFile(inputPath);
  const inputExt = getExt(inputPath);
  const inputArrayBuffer = toArrayBuffer(inputBuffer);
  const sceneCenter = new THREE.Vector3(0, 0, 0);
  const chunkOrder = options.chunkOrder;
  const sectionSize = options.sectionSize;

  let splatBuffer;
  if (inputExt === '.splat' && chunkOrder === 'topDown') {
    const splatArray = GaussianSplats3D.SplatParser.parseStandardSplatToUncompressedSplatArray(
      inputArrayBuffer,
    );
    splatArray.splats.sort((a, b) => b[1] - a[1]);
    const generator = GaussianSplats3D.SplatBufferGenerator.getStandardGenerator(
      preset.alphaRemovalThreshold,
      preset.compressionLevel,
      sectionSize,
      sceneCenter,
      preset.blockSize,
      preset.bucketSize,
    );
    splatBuffer = generator.generateFromUncompressedSplatArray(splatArray);
  } else if (inputExt === '.splat') {
    splatBuffer = await GaussianSplats3D.SplatLoader.loadFromFileData(
      inputArrayBuffer,
      preset.alphaRemovalThreshold,
      preset.compressionLevel,
      preset.optimizeSplatData,
      sectionSize,
      sceneCenter,
      preset.blockSize,
      preset.bucketSize,
    );
  } else if (inputExt === '.ply') {
    splatBuffer = await GaussianSplats3D.PlyLoader.loadFromFileData(
      inputArrayBuffer,
      preset.alphaRemovalThreshold,
      preset.compressionLevel,
      preset.optimizeSplatData,
      preset.sphericalHarmonicsDegree,
      sectionSize,
      sceneCenter,
      preset.blockSize,
      preset.bucketSize,
    );
  } else if (inputExt === '.ksplat') {
    await fs.copyFile(inputPath, outputPath);
    return;
  } else {
    throw new Error(`Unsupported input extension "${inputExt}". Use .splat, .ply, or .ksplat.`);
  }

  await fs.writeFile(outputPath, Buffer.from(splatBuffer.bufferData));
}

async function run() {
  const format = parseArg('format', 'ksplat');
  assertFormat(format);

  const presetName = parseArg('preset', 'balanced');
  const preset = PRESETS[presetName];
  if (!preset) {
    throw new Error(`Unknown preset "${presetName}". Use speed, balanced, or quality.`);
  }
  const chunkOrder = parseArg('chunk-order', 'default');
  const sectionSizeArg = Number.parseInt(parseArg('section-size', `${preset.sectionSize}`), 10);
  const sectionSize = Number.isFinite(sectionSizeArg) ? Math.max(0, sectionSizeArg) : preset.sectionSize;
  let inputPath = parseArg('input', null);
  const outputPath = parseArg('output', format === 'spz' ? DEFAULT_SPZ_OUTPUT : DEFAULT_OUTPUT);
  if (!inputPath) {
    for (const candidate of DEFAULT_INPUT_CANDIDATES) {
      try {
        await fs.access(path.resolve(process.cwd(), candidate));
        inputPath = candidate;
        break;
      } catch {
        // Try next candidate.
      }
    }
  }
  if (!inputPath) {
    throw new Error(
      'No default source asset found. Supply --input <path-to-.splat-or-.ply> to run conversion.',
    );
  }

  const absoluteInput = path.resolve(process.cwd(), inputPath);
  const absoluteOutput = path.resolve(process.cwd(), outputPath);
  const outputDir = path.dirname(absoluteOutput);
  await fs.mkdir(outputDir, { recursive: true });

  if (typeof globalThis.window === 'undefined') {
    globalThis.window = globalThis;
  }
  if (typeof globalThis.self === 'undefined') {
    globalThis.self = globalThis;
  }
  if (typeof globalThis.navigator === 'undefined') {
    globalThis.navigator = { userAgent: 'node' };
  }
  const [THREE, GaussianSplats3D] = await Promise.all([
    import('three'),
    import('@mkkellogg/gaussian-splats-3d'),
  ]);

  const start = performance.now();
  if (format === 'spz') {
    const inputExt = getExt(absoluteInput);
    if (inputExt !== '.spz') {
      throw new Error(
        'Direct SPZ export is not implemented in this pipeline. Provide an external .spz via --input and this script will copy it into the scene asset path.',
      );
    }
    await fs.copyFile(absoluteInput, absoluteOutput);
  } else {
    await toKSplat(absoluteInput, absoluteOutput, presetName, { THREE, GaussianSplats3D }, {
      chunkOrder,
      sectionSize,
    });
  }
  const elapsedMs = performance.now() - start;

  const [inputStat, outputStat] = await Promise.all([fs.stat(absoluteInput), fs.stat(absoluteOutput)]);
  const reduction = (1 - outputStat.size / inputStat.size) * 100;
  console.info(
    `[convert] format=ksplat preset=${presetName} chunk_order=${chunkOrder} section_size=${sectionSize} input=${formatBytes(inputStat.size)} output=${formatBytes(outputStat.size)} reduction=${reduction.toFixed(1)}% elapsed_ms=${elapsedMs.toFixed(1)}`,
  );
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[convert] failed: ${message}`);
  process.exitCode = 1;
});
