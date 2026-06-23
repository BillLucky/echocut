'use strict';

/**
 * aspectRatioFitter — 把任意视频 fit 到目标 9:16 / 1:1 / 16:9 容器
 *
 * 场景:burn 流水线不会自动重构图。4:3 直播录屏(960×720)直接 burn
 * 输出仍是 960×720,标题压头部,字幕叠人物,封面跟视频比例不匹配。
 *
 * 解法:burn 前先 scale + pad 到目标容器尺寸,burn 字幕/标题/品牌胶囊
 * 才能落在黑边上(顶部黑边放标题,底部黑边放字幕)。
 *
 * 设计原则:
 * - 纯函数:输入输出明确,无副作用(除写文件)
 * - 失败抛 error,不静默 fallback
 * - 不引入新依赖,只用 ffmpeg(已是项目硬依赖)
 * - 不修改已是目标尺寸的视频(early return,省 IO)
 * - 可选:同时 wipe top watermark(直播录屏顶部水印条)
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TARGET_PRESETS = {
    '9:16': { width: 1080, height: 1920, label: 'vertical' },
    '1:1':  { width: 1080, height: 1080, label: 'square' },
    '16:9': { width: 1920, height: 1080, label: 'landscape' },
};

/**
 * 探测视频宽高(ffprobe)
 */
function probeWidthHeight(filePath) {
    const r = spawnSync('ffprobe', [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height',
        '-of', 'csv=p=0',
        filePath,
    ], { encoding: 'utf8', timeout: 10000 });
    const line = String(r.stdout || '').trim();
    if (!line) throw new Error(`ffprobe 无法读取视频尺寸: ${filePath}`);
    const parts = line.split(',').map((s) => parseInt(s.trim(), 10));
    if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) {
        throw new Error(`ffprobe 输出解析失败: ${line}`);
    }
    return { width: parts[0], height: parts[1] };
}

/**
 * 计算 fit 策略:把 (srcW, srcH) 套进目标容器 (tgtW, tgtH)
 * 返回 ffmpeg filter 字符串(scale + pad)
 *
 * 策略:
 * - 保持原比例,scale 到能放进容器的最大尺寸
 * - 上下/左右 pad 黑色到目标尺寸
 *
 * 例子:
 * - 960×720 → 1080×1920: scale 1080×810,上下各 555 黑边
 * - 1920×1080 → 1080×1920: scale 1080×608(满宽),上下 656 黑边
 * - 1080×1920 → 1080×1920: 不变(early return)
 */
function buildFitFilter(srcW, srcH, tgtW, tgtH, opts = {}) {
    const stripTopPx = Math.max(0, Number(opts.stripTopWatermarkPx) || 0);
    // 先 crop 顶部水印(可选)
    let chain = '';
    let effectiveH = srcH;
    if (stripTopPx > 0 && stripTopPx < srcH) {
        chain += `crop=${srcW}:${srcH - stripTopPx}:0:${stripTopPx},`;
        effectiveH = srcH - stripTopPx;
    }
    // scale:保持比例,先按宽度算高,如果超过目标高就按高度算宽
    const ratioByW = tgtW / srcW;
    const scaledH = Math.round(effectiveH * ratioByW);
    let scaleFilter;
    if (scaledH <= tgtH) {
        scaleFilter = `scale=${tgtW}:-2:flags=lanczos`;
    } else {
        scaleFilter = `scale=-2:${tgtH}:flags=lanczos`;
    }
    chain += `${scaleFilter},`;
    // pad:居中放进容器
    chain += `pad=${tgtW}:${tgtH}:(ow-iw)/2:(oh-ih)/2:black`;
    return chain;
}

/**
 * 计算 fill(cover)策略:把 (srcW, srcH) 裁切铺满目标容器 (tgtW, tgtH)
 * 返回 ffmpeg filter 字符串(scale 放大到能盖住容器 + 按焦点 crop)
 *
 * 与 buildFitFilter(contain,加黑边)相反:
 * - fit  = 整张塞进容器,留黑边(横屏→竖屏会缩成中间一小条)
 * - fill = 裁掉两侧/上下,主体铺满容器(横屏舞台口播→竖屏抠讲者)
 *
 * 焦点(focusX/focusY,0..1):裁切窗口在被裁维度上的位置。
 * - 0.5 居中;横屏舞台讲者通常中偏右,focusX≈0.5~0.62 能把人留在画面里。
 *
 * 例子(1920×1080 → 1080×1920,focusX=0.55):
 *   先 scale 到 3413×1920(force_original_aspect_ratio=increase 盖住容器),
 *   再 crop 1080×1920,x = (3413-1080)*0.55 ≈ 1283(讲者居中偏右)。
 */
function buildFillFilter(srcW, srcH, tgtW, tgtH, opts = {}) {
    const stripTopPx = Math.max(0, Number(opts.stripTopWatermarkPx) || 0);
    const clamp01 = (n, dft) => {
        const v = Number(n);
        if (!Number.isFinite(v)) return dft;
        return Math.min(1, Math.max(0, v));
    };
    const focusX = clamp01(opts.focusX, 0.5);
    const focusY = clamp01(opts.focusY, 0.5);
    let chain = '';
    // 先 crop 顶部水印(可选),与 fit 一致
    if (stripTopPx > 0 && stripTopPx < srcH) {
        chain += `crop=${srcW}:${srcH - stripTopPx}:0:${stripTopPx},`;
    }
    // scale 到盖住容器(任一维度 ≥ 目标),再按焦点 crop 到精确目标
    chain += `scale=${tgtW}:${tgtH}:force_original_aspect_ratio=increase:flags=lanczos,`;
    chain += `crop=${tgtW}:${tgtH}:(iw-${tgtW})*${focusX}:(ih-${tgtH})*${focusY}`;
    return chain;
}

/**
 * 判断视频是否已经是目标尺寸(允许 ±2 px 容差)
 */
function isAlreadyFit(srcW, srcH, tgtW, tgtH) {
    return Math.abs(srcW - tgtW) <= 2 && Math.abs(srcH - tgtH) <= 2;
}

/**
 * fitVideo — 把视频套进目标比例容器
 *
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {object} opts
 * @param {string} opts.targetRatio  '9:16' | '1:1' | '16:9'(默认 '9:16')
 * @param {number} opts.stripTopWatermarkPx  顶部 crop 像素(去直播水印,默认 0)
 * @param {boolean} opts.fill  true=裁切铺满(cover,抠主体);false=加黑边(contain,默认)
 * @param {number} opts.focusX fill 模式下裁切窗口横向焦点 0..1(默认 0.5;横屏讲者中偏右用 0.55~0.62)
 * @param {number} opts.focusY fill 模式下裁切窗口纵向焦点 0..1(默认 0.5)
 * @param {string} opts.crf  libx264 CRF(默认 '18')
 * @param {string} opts.preset libx264 preset(默认 'medium')
 * @returns {{ skipped: boolean, srcSize: {width,height}, tgtSize: {width,height}, filter: string }}
 */
function fitVideo(inputPath, outputPath, opts = {}) {
    if (!inputPath || typeof inputPath !== 'string') throw new Error('inputPath required');
    if (!outputPath || typeof outputPath !== 'string') throw new Error('outputPath required');
    if (!fs.existsSync(inputPath)) throw new Error(`input not exists: ${inputPath}`);
    const targetRatio = String(opts.targetRatio || '9:16');
    const preset = TARGET_PRESETS[targetRatio];
    if (!preset) {
        throw new Error(`unsupported targetRatio: ${targetRatio}(支持 ${Object.keys(TARGET_PRESETS).join('/')})`);
    }
    const src = probeWidthHeight(inputPath);
    const tgtW = preset.width;
    const tgtH = preset.height;
    const stripTopPx = Math.max(0, Number(opts.stripTopWatermarkPx) || 0);
    const fill = !!opts.fill;

    // 已是目标尺寸 + 不需要 crop → 直接 hardlink/copy
    if (isAlreadyFit(src.width, src.height, tgtW, tgtH) && stripTopPx === 0) {
        // 不重新编码,只 copy
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        if (inputPath !== outputPath) fs.copyFileSync(inputPath, outputPath);
        return {
            skipped: true,
            srcSize: src,
            tgtSize: { width: tgtW, height: tgtH },
            filter: '',
        };
    }

    const filter = fill
        ? buildFillFilter(src.width, src.height, tgtW, tgtH, {
            stripTopWatermarkPx: stripTopPx,
            focusX: opts.focusX,
            focusY: opts.focusY,
        })
        : buildFitFilter(src.width, src.height, tgtW, tgtH, { stripTopWatermarkPx: stripTopPx });
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    // 编码器:Darwin 默认硬件 h264_videotoolbox(48 分钟长视频软件 x264 medium 要 1-2 小时,
    // 硬编 5-10 倍速),失败回退 libx264 —— 对齐项目「编码器回退链」哲学。
    // ZDE_FIT_FORCE_SW=1 或 opts.forceSoftware 强制软编(需要 CRF 精确质量时)。
    const baseTail = [
        '-pix_fmt', 'yuv420p',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        outputPath,
    ];
    const head = ['-y', '-i', inputPath, '-vf', filter];
    const swCodec = [
        '-c:v', 'libx264',
        '-preset', String(opts.preset || 'medium'),
        '-crf', String(opts.crf || '18'),
    ];
    const hwCodec = ['-c:v', 'h264_videotoolbox', '-b:v', String(opts.bitrate || '8M')];
    const forceSw = opts.forceSoftware || process.env.ZDE_FIT_FORCE_SW === '1';
    const tryHw = !forceSw && process.platform === 'darwin';

    let r = { status: 1, stderr: '' };
    if (tryHw) {
        r = spawnSync('ffmpeg', [...head, ...hwCodec, ...baseTail], { encoding: 'utf8' });
        if (r.status !== 0) {
            console.warn(`[fitVideo] h264_videotoolbox 失败,回退 libx264:${(r.stderr || '').slice(-200)}`);
        }
    }
    if (r.status !== 0) {
        r = spawnSync('ffmpeg', [...head, ...swCodec, ...baseTail], { encoding: 'utf8' });
    }
    if (r.status !== 0) {
        const stderr = (r.stderr || '').slice(-400);
        throw new Error(`ffmpeg fit 失败 (exit=${r.status}): ${stderr}`);
    }
    return {
        skipped: false,
        srcSize: src,
        tgtSize: { width: tgtW, height: tgtH },
        filter,
    };
}

module.exports = {
    fitVideo,
    probeWidthHeight,
    buildFitFilter,
    buildFillFilter,
    isAlreadyFit,
    TARGET_PRESETS,
};
