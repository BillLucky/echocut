const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { loadBrandFile, brandToEnvString } = require('../../services/brandLoader');
const { preflightCheck } = require('../../lib/preflight');
const { acquireLock } = require('../../lib/processLock');
const { fitVideo, probeWidthHeight } = require('../../video/aspectRatioFitter');

const RATIO_TO_PRESET = {
    '9:16': 'vertical',
    '16:9': 'landscape',
    '1:1': 'square'
};

function probeRotation(filePath) {
    try {
        const { execSync } = require('child_process');
        const out = execSync(
            `ffprobe -v error -select_streams v:0 -show_entries stream_side_data=rotation:stream_tags=rotate -of default=nw=1:nk=1 "${filePath}"`,
            { encoding: 'utf8' }
        ).trim();
        for (const line of out.split(/\r?\n/)) {
            const n = parseInt(line, 10);
            if (Number.isFinite(n) && n !== 0) return n;
        }
    } catch { /* ignore */ }
    return 0;
}

// 旋转归一化:手机(尤其小米/新安卓)只在 Display Matrix side_data 里写旋转角(无老式 rotate tag)。
// 下游 cut-fillers 的 filter_complex 会把像素转正(720×1280)却保留 rotation=90 元数据,burn 再
// autorotate 一次 → 画面歪斜(人横躺、字幕正)。修法:开跑前把方向烧进像素 + 清掉所有旋转元数据,
// 让 transcribe/cut/burn 全程看到真正转正、无旋转标签的视频。一次性消灭这一类双重旋转 bug。
async function normalizeRotation(srcPath, root) {
    const rotation = probeRotation(srcPath);
    if (!rotation) return srcPath; // 无旋转元数据(已正视频):零开销原样使用
    const C = { gray: '\x1b[90m', reset: '\x1b[0m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m' };
    let size = 0; let mtime = 0;
    try { const st = fs.statSync(srcPath); size = st.size; mtime = Math.floor(st.mtimeMs); } catch { /* ignore */ }
    const base = path.basename(srcPath, path.extname(srcPath));
    const cacheDir = path.join(root, '.echo-cache', 'rotate');
    fs.mkdirSync(cacheDir, { recursive: true });
    const outPath = path.join(cacheDir, `${base}_${size}_${mtime}_norm.mp4`);
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1024) {
        console.log(`${C.gray}[rotate]${C.reset} 复用旋转归一化缓存 ${C.green}✓${C.reset}`);
        return outPath;
    }
    console.log(`${C.cyan}[rotate]${C.reset} 检测到旋转元数据 ${rotation}°,先把方向烧进像素并清除旋转标签(防下游双重旋转导致画面歪斜)`);
    // -vf 触发 ffmpeg autorotate:按 displaymatrix 的正确方向把像素转正,并消除旋转 side_data;
    // -metadata:s:v:0 rotate=0 再清老式 rotate tag(双保险)。方向由 ffmpeg 依矩阵判定,比手写
    // transpose 猜方向稳(本类 bug 的根因就是方向/标签不一致)。
    const { runFfmpegWithProgress } = require('../../lib/ffmpegProgress');
    let durationSec = 0;
    try {
        const { execSync } = require('child_process');
        durationSec = parseFloat(execSync(
            `ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "${srcPath}"`,
            { encoding: 'utf8' }
        ).trim()) || 0;
    } catch { /* ignore */ }
    const tmpOut = `${outPath}.tmp.mp4`;
    const mkArgs = (vcodec) => ([
        '-y', '-i', srcPath,
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-c:v', vcodec,
        '-pix_fmt', 'yuv420p',
        '-metadata:s:v:0', 'rotate=0',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        tmpOut
    ]);
    const t0 = Date.now();
    const codecs = process.platform === 'darwin' ? ['h264_videotoolbox', 'libx264'] : ['libx264'];
    let ok = false;
    for (const vcodec of codecs) {
        try {
            await runFfmpegWithProgress(mkArgs(vcodec), { durationSec });
            ok = true;
            break;
        } catch (err) {
            console.log(`${C.yellow}![rotate]${C.reset} ${vcodec} 编码失败,尝试下一个: ${err.message}`);
        }
    }
    if (!ok) {
        try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch { /* ignore */ }
        console.error(`${C.yellow}![rotate]${C.reset} 旋转归一化失败,改用原视频(画面可能仍歪)`);
        return srcPath;
    }
    try { fs.renameSync(tmpOut, outPath); } catch { return srcPath; }
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`${C.gray}[rotate]${C.reset} 已转正并清除旋转元数据 ${C.green}(${dt}s)${C.reset}`);
    return outPath;
}

function detectRatioByProbe(filePath) {
    try {
        const { execSync } = require('child_process');
        const out = execSync(
            `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${filePath}"`,
            { encoding: 'utf8' }
        ).trim();
        let [w, h] = out.split(',').map(Number);
        if (!w || !h) return 'vertical';
        // 手机竖拍视频带 rotation=90/270，FFmpeg 自动旋转，需 swap
        const rotation = probeRotation(filePath);
        if (Math.abs(rotation) === 90 || Math.abs(rotation) === 270) {
            [w, h] = [h, w];
        }
        const ratio = w / h;
        if (ratio < 0.9) return 'vertical';
        if (ratio > 1.5) return 'landscape';
        return 'square';
    } catch {
        return 'vertical';
    }
}

function loadVisualPreset(root, name) {
    if (!name || name === 'none') return null;
    const presetPath = path.join(root, 'src/video/presets', `${name}.json`);
    if (!fs.existsSync(presetPath)) {
        console.error(`\x1b[31m✗\x1b[0m 找不到视觉预设: ${name}(查找路径: ${presetPath})`);
        console.error(`   可用:${fs.readdirSync(path.join(root, 'src/video/presets')).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', '')).join(' | ') || '(空)'}`);
        process.exit(1);
    }
    try {
        return JSON.parse(fs.readFileSync(presetPath, 'utf8'));
    } catch (err) {
        console.error(`\x1b[31m✗\x1b[0m 预设文件解析失败: ${presetPath}`, err.message);
        process.exit(1);
    }
}

module.exports = async function burn(file, opts) {
    const root = process.env.ZDE_PROJECT_ROOT || process.cwd();
    let abs = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);

    if (!fs.existsSync(abs)) {
        console.error(`\x1b[31m✗\x1b[0m 找不到文件: ${abs}`);
        process.exit(1);
    }

    // 跑前守门:磁盘/内存/大视频警告。ZDE_SKIP_PREFLIGHT=1 可强制跳过
    preflightCheck(abs, { engine: opts.engine, force: !!opts.force });

    // 进程锁:防并发跑两个 burn 抢资源(今早事故就是这个)
    try {
        acquireLock('burn.lock', { allowWait: true });
    } catch (err) {
        console.error(`\x1b[31m✗\x1b[0m ${err.message}`);
        process.exit(1);
    }

    // 旋转归一化(手机竖拍尤其小米/新安卓):开跑前把方向烧进像素 + 清旋转元数据,
    // 否则 cut-fillers 与 burn 会双重旋转导致画面歪斜。无旋转的源零开销原样通过。
    abs = await normalizeRotation(abs, root);

    let preset;
    if (!opts.ratio || opts.ratio === 'auto') {
        preset = detectRatioByProbe(abs);
    } else {
        preset = RATIO_TO_PRESET[opts.ratio];
        if (!preset) {
            console.error(`\x1b[31m✗\x1b[0m 不支持的 --ratio: ${opts.ratio}(可用 9:16/16:9/1:1/auto)`);
            process.exit(1);
        }
    }

    // v0.13 — auto-pad:输入不是目标比例时自动 scale+pad 到目标容器
    // panel/直播录屏 4:3 源(960×720)直接 burn 会让标题压人头,字幕叠人物
    // 加 --auto-pad 后,burn 前先用 ffmpeg fit 到 1080×1920(或 1:1/16:9),burn 流水线
    // 才能把字幕落底部黑边、标题落顶部黑边
    let abs_for_burn = abs;
    const stripTopPx = Math.max(0, Number(opts.stripTop) || 0);
    // 横屏源默认保持横屏(全屏录屏教程要满屏可读,套进竖容器会让画面缩成中间一小条)。
    // 封面统一竖版,通过 postProcess 虚化铺满进第一帧(横屏=竖封面居中+自身虚化填充两侧,
    // 竖屏=封面直接铺满),不再强制把横屏改成竖屏。需要竖屏 feed 版用 --ratio 9:16 --auto-pad。
    if (opts.autoPad || stripTopPx > 0) {
        // v0.13.1 修:用户显式 --ratio 优先;否则 --auto-pad 默认走 9:16
        // (而不是跟随 detectRatioByProbe — 4:3 落在 0.9-1.5 区间被识别成 square,
        //  但 panel/直播录屏 4:3 的真实目标平台都是竖屏 抖音/视频号/小红书)
        const userExplicitRatio = opts.ratio && opts.ratio !== 'auto';
        const TARGET_RATIO_MAP = { vertical: '9:16', square: '1:1', landscape: '16:9' };
        const targetRatio = userExplicitRatio ? opts.ratio : '9:16';
        // 同步覆盖 burn 内部的 preset,否则字幕 style preset 还会跟着 auto-detect 走 square
        const PRESET_FROM_RATIO = { '9:16': 'vertical', '1:1': 'square', '16:9': 'landscape' };
        const newPreset = PRESET_FROM_RATIO[targetRatio];
        if (newPreset && newPreset !== preset) {
            console.log(`\x1b[36m[auto-pad]\x1b[0m preset 调整 ${preset} → ${newPreset}(默认 9:16;加 --ratio 1:1 / 16:9 强制其他)`);
            preset = newPreset;
        }
        try {
            const srcSize = probeWidthHeight(abs);
            const targetW = targetRatio === '16:9' ? 1920 : 1080;
            const targetH = targetRatio === '9:16' ? 1920 : (targetRatio === '16:9' ? 1080 : 1080);
            const needsFit = srcSize.width !== targetW || srcSize.height !== targetH;
            if (needsFit || stripTopPx > 0) {
                const padDir = path.join(path.dirname(abs), '.echo-fitted');
                fs.mkdirSync(padDir, { recursive: true });
                const padOut = path.join(padDir, `${path.basename(abs, path.extname(abs))}_${targetRatio.replace(':', 'x')}_${stripTopPx > 0 ? `striptop${stripTopPx}_` : ''}fitted.mp4`);
                const C = { gray: '\x1b[90m', reset: '\x1b[0m', cyan: '\x1b[36m', green: '\x1b[32m' };
                console.log(`${C.cyan}[auto-pad]${C.reset} ${srcSize.width}×${srcSize.height} → ${targetW}×${targetH}${stripTopPx > 0 ? `,strip top ${stripTopPx}px` : ''}`);
                const t0 = Date.now();
                // --fill:裁切铺满(cover,抠主体),横屏舞台口播→竖屏只留讲者;
                // 默认(不加 --fill)仍是 scale+pad 加黑边,保持旧行为不变。
                const fillMode = !!opts.fill;
                const focusX = opts.focusX != null && opts.focusX !== '' ? Number(opts.focusX) : undefined;
                if (fillMode) {
                    console.log(`${C.cyan}[auto-pad]${C.reset} fill 模式:裁切铺满(抠主体)${focusX != null ? `,焦点 x=${focusX}` : ''}`);
                }
                const r = fitVideo(abs, padOut, {
                    targetRatio,
                    stripTopWatermarkPx: stripTopPx,
                    fill: fillMode,
                    focusX,
                });
                const dt = ((Date.now() - t0) / 1000).toFixed(1);
                if (r.skipped) {
                    console.log(`${C.gray}[auto-pad]${C.reset} 已是目标尺寸,跳过${C.green}(${dt}s)${C.reset}`);
                } else {
                    console.log(`${C.gray}[auto-pad]${C.reset} 重构图完成${C.green}(${dt}s)${C.reset} → ${path.relative(process.cwd(), padOut)}`);
                }
                abs_for_burn = padOut;
            }
        } catch (err) {
            console.error(`\x1b[31m✗\x1b[0m auto-pad 失败,改用原视频: ${err.message}`);
        }
    }

    const visualPreset = loadVisualPreset(root, opts.preset);

    const args = [
        'scripts/run-video-cases.js',
        `--video-file=${abs_for_burn}`,
        `--engine=${opts.engine || 'qwen3'}`,
        `--style-preset=${preset}`
    ];
    if (opts.headline) args.push(`--headline=${opts.headline}`);
    if (opts.subline) args.push(`--subline=${opts.subline}`);
    if (opts.fallbackText) args.push(`--fallback-text=${opts.fallbackText}`);
    if (opts.preview) args.push(`--preview-seconds=${opts.preview}`);
    if (opts.chunkMaxChars) args.push(`--chunk-max-chars=${opts.chunkMaxChars}`);
    if (opts.sentenceMaxChars) args.push(`--sentence-max-chars=${opts.sentenceMaxChars}`);

    const childEnv = { ...process.env };
    if (visualPreset && visualPreset.config && typeof visualPreset.config === 'object') {
        childEnv.ZDE_PRESET_CONFIG = JSON.stringify(visualPreset.config);
    }
    // commander 的 --no-fillers 会把 opts.fillers 置为 false
    if (opts.fillers === false) {
        childEnv.ZDE_KEEP_FILLERS = '1';
    }
    if (opts.cutFillers) {
        childEnv.ZDE_CUT_FILLERS = '1';
    }
    if (opts.cutSilence) {
        childEnv.ZDE_CUT_SILENCE = '1';
        if (opts.silenceThreshold) {
            childEnv.ZDE_SILENCE_THRESHOLD = String(opts.silenceThreshold);
        }
    }
    // v0.17.1 --no-bgm 等同 --bgm none(commander 把 --no-bgm 解析为 opts.bgm=false)
    if (opts.bgm === false) {
        childEnv.ZDE_BGM_NAME = 'none';
    } else if (opts.bgm && opts.bgm !== 'none') {
        childEnv.ZDE_BGM_NAME = String(opts.bgm);
    } else if (opts.bgm === 'none') {
        childEnv.ZDE_BGM_NAME = 'none';
    }
    if (opts.bgmVolume) {
        childEnv.ZDE_BGM_VOLUME = String(opts.bgmVolume);
    }
    if (opts.title === false) {
        childEnv.ZDE_NO_HEADLINE = '1';
    }
    // v0.17 --no-subtitle:剪映/Premiere 已剪好字幕,burn 跳过 ASR/字幕烧录,brand 能力全保留
    if (opts.subtitle === false) {
        childEnv.ZDE_NO_SUBTITLE = '1';
    }
    // 转写/字幕复用提速:--reuse-captions 喂现成字幕(换比例/样式重渲染不重转写+不重LLM);
    // --fresh 强制重转写绕过转写缓存(同源视频默认命中缓存秒跳转写)
    if (opts.reuseCaptions) {
        const rc = path.isAbsolute(opts.reuseCaptions) ? opts.reuseCaptions : path.resolve(process.cwd(), opts.reuseCaptions);
        if (!fs.existsSync(rc)) {
            console.error(`\x1b[31m✗\x1b[0m --reuse-captions 文件不存在: ${rc}`);
            process.exit(1);
        }
        childEnv.ZDE_REUSE_CAPTIONS = rc;
    }
    if (opts.fresh) {
        childEnv.ZDE_FRESH = '1';
    }
    // OBS 录屏(顶部人脸+底部屏幕):压窄顶部品牌带、标题缩小放胶囊右侧,露出人脸,不影响普通口播竖屏
    if (opts.obs) {
        childEnv.ZDE_OBS = '1';
    }
    // v0.10+ 黄金 3 秒钩子
    if (opts.goldenHook) {
        childEnv.ZDE_GOLDEN_HOOK = '1';
        if (opts.goldenStart != null && opts.goldenStart !== '') {
            childEnv.ZDE_GOLDEN_START = String(opts.goldenStart);
        }
        if (opts.goldenDuration != null && opts.goldenDuration !== '') {
            childEnv.ZDE_GOLDEN_DURATION = String(opts.goldenDuration);
        }
    }
    if (opts.denoise) {
        childEnv.ZDE_DENOISE = '1';
        if (opts.denoiseMix) childEnv.ZDE_DENOISE_MIX = String(opts.denoiseMix);
    }
    // ASR initial_prompt 增强:headline/subline 作为已知上下文,提升专有名词识别率
    if (opts.headline) childEnv.ZDE_ASR_HINT_HEADLINE = String(opts.headline);
    if (opts.subline) childEnv.ZDE_ASR_HINT_SUBLINE = String(opts.subline);
    // 品牌穿透:加载 brand.json 后序列化到 env,子进程 brandLoader 会直接读这个 env
    const brandId = opts.brand || 'example';
    let brandLoaded = null;
    try {
        brandLoaded = loadBrandFile(brandId);
        childEnv.ZDE_BRAND_CONFIG = brandToEnvString(brandLoaded);
        childEnv.ZDE_DEFAULT_BRAND = brandId;
    } catch (err) {
        console.error(`\x1b[31m✗\x1b[0m 品牌加载失败: ${err.message}`);
        process.exit(1);
    }

    const C = { gray: '\x1b[90m', reset: '\x1b[0m', cyan: '\x1b[36m', bold: '\x1b[1m', green: '\x1b[32m' };
    console.log(`\n${C.bold}${C.cyan}📹 echocut burn${C.reset}`);
    console.log(`   ${C.gray}文件${C.reset}   ${path.basename(abs)}`);
    console.log(`   ${C.gray}引擎${C.reset}   ${opts.engine || 'qwen3'}`);
    console.log(`   ${C.gray}比例${C.reset}   ${preset}${opts.ratio === 'auto' ? ' (auto detect)' : ''}`);
    if (visualPreset) {
        console.log(`   ${C.gray}预设${C.reset}   ${C.green}${visualPreset.name}${C.reset} — ${visualPreset.displayName || ''}`);
        console.log(`   ${C.gray}覆盖${C.reset}   ${Object.keys(visualPreset.config || {}).length} 项配置`);
    }
    if (brandLoaded) {
        console.log(`   ${C.gray}品牌${C.reset}   ${C.green}${brandLoaded.id}${C.reset} — ${brandLoaded.displayName || brandLoaded.identity?.name || ''}`);
    }
    if (opts.headline) console.log(`   ${C.gray}标题${C.reset}   ${opts.headline}`);
    if (opts.preview) console.log(`   ${C.gray}预览${C.reset}   前 ${opts.preview}s`);
    if (opts.denoise) console.log(`   ${C.gray}降噪${C.reset}   ${C.green}RNNoise${C.reset} mix=${opts.denoiseMix}`);
    console.log('');

    const child = spawn('node', args, { stdio: 'inherit', cwd: root, env: childEnv });
    child.on('exit', (code) => process.exit(code || 0));
    child.on('error', (err) => {
        console.error(`\x1b[31m✗\x1b[0m spawn 失败:`, err.message);
        process.exit(1);
    });
};
