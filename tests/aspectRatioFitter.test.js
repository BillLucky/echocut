/**
 * aspectRatioFitter 单元测试
 *
 * 关键守护点:
 *   - buildFitFilter 对 4:3 / 16:9 / 9:16 / 1:1 输入都正确算出 filter
 *   - 已是目标尺寸时 skipped=true,不走 ffmpeg
 *   - stripTopWatermarkPx 加 crop filter
 *   - 不支持的 targetRatio 抛 error
 *   - probe 失败时抛清晰 error
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    buildFitFilter,
    buildFillFilter,
    isAlreadyFit,
    TARGET_PRESETS,
    fitVideo,
} = require('../src/video/aspectRatioFitter');

// ─── buildFitFilter ─────────────────────────────────────────────────────

test('buildFitFilter: 4:3 → 9:16 (本期 panel 实战:960×720 → 1080×1920)', () => {
    const f = buildFitFilter(960, 720, 1080, 1920);
    // scale width 1080 → height = 810
    assert.ok(f.includes('scale=1080:-2'), `应 scale 到 1080 宽: ${f}`);
    assert.ok(f.includes('pad=1080:1920'), `应 pad 到 1080×1920: ${f}`);
    assert.ok(f.includes('black'), '应 black 填充');
    // 居中放置
    assert.ok(f.includes('(ow-iw)/2:(oh-ih)/2'), '应居中');
});

test('buildFitFilter: 16:9 → 9:16 (横屏 1920×1080 → 1080×1920)', () => {
    const f = buildFitFilter(1920, 1080, 1080, 1920);
    // 按宽度算高 = 608,放得下 1920 高度 → scale 1080
    assert.ok(f.includes('scale=1080:-2'), `${f}`);
    assert.ok(f.includes('pad=1080:1920'));
});

test('buildFitFilter: 1080×1920 已是 9:16(no skip,但 filter 还是会生成)', () => {
    // 这个函数不判 skip,纯算 filter;skip 在 fitVideo 里判
    const f = buildFitFilter(1080, 1920, 1080, 1920);
    assert.ok(f.includes('scale=1080:-2'));
});

test('buildFitFilter: 1:1 → 9:16 (方屏 1080×1080 → 1080×1920)', () => {
    const f = buildFitFilter(1080, 1080, 1080, 1920);
    assert.ok(f.includes('scale=1080:-2'));
    assert.ok(f.includes('pad=1080:1920'));
});

test('buildFitFilter: 9:16 → 1:1 (竖屏 1080×1920 → 1080×1080 方屏)', () => {
    const f = buildFitFilter(1080, 1920, 1080, 1080);
    // 按宽度算高 = 1920 > 1080 → 按高度算宽 → scale=-2:1080
    assert.ok(f.includes('scale=-2:1080'), `9:16→1:1 应按高度 scale: ${f}`);
    assert.ok(f.includes('pad=1080:1080'));
});

test('buildFitFilter: stripTopWatermarkPx > 0 加 crop filter 在前', () => {
    const f = buildFitFilter(960, 720, 1080, 1920, { stripTopWatermarkPx: 80 });
    // crop 在 scale 之前
    const cropIdx = f.indexOf('crop=');
    const scaleIdx = f.indexOf('scale=');
    assert.ok(cropIdx >= 0, 'crop filter 应存在');
    assert.ok(cropIdx < scaleIdx, 'crop 应在 scale 之前');
    assert.ok(f.includes('crop=960:640:0:80'), `应 crop 顶部 80 px: ${f}`);
});

test('buildFitFilter: stripTopWatermarkPx 超过源视频高度 → 忽略(不能裁负数)', () => {
    const f = buildFitFilter(960, 720, 1080, 1920, { stripTopWatermarkPx: 800 });
    assert.ok(!f.includes('crop='), `crop>=source高度时应忽略: ${f}`);
});

test('buildFitFilter: stripTopWatermarkPx=0 不加 crop', () => {
    const f = buildFitFilter(960, 720, 1080, 1920, { stripTopWatermarkPx: 0 });
    assert.ok(!f.includes('crop='));
});

// ─── buildFillFilter(cover 裁切铺满,抠主体) ────────────────────────────

test('buildFillFilter: 16:9 → 9:16 横屏舞台口播抠讲者(cover,不加黑边)', () => {
    const f = buildFillFilter(1920, 1080, 1080, 1920, { focusX: 0.55 });
    assert.ok(f.includes('force_original_aspect_ratio=increase'), `应 cover 放大: ${f}`);
    assert.ok(f.includes('crop=1080:1920'), `应 crop 到目标尺寸: ${f}`);
    assert.ok(!f.includes('pad='), `fill 模式不应加黑边: ${f}`);
    assert.ok(f.includes('*0.55'), `focusX 应注入横向偏移: ${f}`);
});

test('buildFillFilter: focusX 默认 0.5 居中', () => {
    const f = buildFillFilter(1920, 1080, 1080, 1920, {});
    assert.ok(f.includes('(iw-1080)*0.5'), `默认应居中: ${f}`);
});

test('buildFillFilter: focusX 越界(>1 / <0 / NaN)被钳到 [0,1] / 默认', () => {
    assert.ok(buildFillFilter(1920, 1080, 1080, 1920, { focusX: 5 }).includes('*1'), '5 → 1');
    assert.ok(buildFillFilter(1920, 1080, 1080, 1920, { focusX: -3 }).includes('*0'), '-3 → 0');
    assert.ok(buildFillFilter(1920, 1080, 1080, 1920, { focusX: 'x' }).includes('*0.5'), 'NaN → 0.5');
});

test('buildFillFilter: stripTopWatermarkPx > 0 先 crop 顶部再 cover', () => {
    const f = buildFillFilter(1920, 1080, 1080, 1920, { stripTopWatermarkPx: 60 });
    const stripIdx = f.indexOf('crop=1920:1020:0:60');
    const scaleIdx = f.indexOf('scale=');
    assert.ok(stripIdx >= 0, `应先 crop 顶部 60px: ${f}`);
    assert.ok(stripIdx < scaleIdx, 'strip crop 应在 scale 之前');
});

// ─── isAlreadyFit ───────────────────────────────────────────────────────

test('isAlreadyFit: 完全相同 → true', () => {
    assert.equal(isAlreadyFit(1080, 1920, 1080, 1920), true);
});

test('isAlreadyFit: ±2 px 容差 → true', () => {
    assert.equal(isAlreadyFit(1080, 1918, 1080, 1920), true);
    assert.equal(isAlreadyFit(1078, 1920, 1080, 1920), true);
});

test('isAlreadyFit: 偏差 > 2 px → false', () => {
    assert.equal(isAlreadyFit(1080, 1916, 1080, 1920), false);
    assert.equal(isAlreadyFit(960, 720, 1080, 1920), false);
});

// ─── TARGET_PRESETS ─────────────────────────────────────────────────────

test('TARGET_PRESETS: 包含 9:16 / 1:1 / 16:9', () => {
    assert.deepEqual(TARGET_PRESETS['9:16'], { width: 1080, height: 1920, label: 'vertical' });
    assert.deepEqual(TARGET_PRESETS['1:1'],  { width: 1080, height: 1080, label: 'square' });
    assert.deepEqual(TARGET_PRESETS['16:9'], { width: 1920, height: 1080, label: 'landscape' });
});

// ─── fitVideo 边界(不实际跑 ffmpeg,只验参数校验) ────────────────────────

test('fitVideo: 缺 inputPath → throw', () => {
    assert.throws(() => fitVideo(null, '/tmp/out.mp4', {}), /inputPath required/);
});

test('fitVideo: 缺 outputPath → throw', () => {
    assert.throws(() => fitVideo('/tmp/in.mp4', null, {}), /outputPath required/);
});

test('fitVideo: 输入文件不存在 → throw', () => {
    assert.throws(
        () => fitVideo('/tmp/nonexistent-input-xyz.mp4', '/tmp/out.mp4', {}),
        /input not exists/
    );
});

test('fitVideo: 不支持的 targetRatio → throw', () => {
    // 用 /dev/null 作为 input 跳过 exists check(macOS /dev/null 存在)
    assert.throws(
        () => fitVideo('/dev/null', '/tmp/out.mp4', { targetRatio: '4:3' }),
        /unsupported targetRatio/
    );
});
