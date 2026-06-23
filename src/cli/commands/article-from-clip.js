'use strict';

const fs = require('fs');
const path = require('path');
const { Spinner, StepTimeline } = require('../../lib/cliUtils');
const cache = require('../../services/highlightsCache');
const { loadBrandFile } = require('../../services/brandLoader');
const { composeArticleCta } = require('../../lib/ctaComposer');
const { scanArticle, renderScanReport, deepReviewAndRewrite } = require('../../lib/articleQuality');

const C = {
    gray: '\x1b[90m', reset: '\x1b[0m', cyan: '\x1b[36m', bold: '\x1b[1m',
    green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', dim: '\x1b[2m'
};

// hook_type → 最合适的文章 mode(用户没显式指定 --mode 时自动)
const HOOK_TO_MODE = {
    反常识: 'hardcore',
    故事: 'soul',
    地理见闻: 'nomad',
    观点: 'hardcore',
    实用: 'default',
    提问: 'default'
};

function selectSegs(all, opts) {
    if (opts.seg) {
        const wanted = String(opts.seg).split(',').map((x) => x.trim()).filter(Boolean)
            .map((w) => /^\d+$/.test(w) ? `seg-${String(w).padStart(2, '0')}` : w);
        return all.filter((c) => wanted.includes(c.id));
    }
    if (opts.minScore != null && opts.minScore !== '') {
        const min = Number(opts.minScore);
        return all.filter((c) => (c.quality_score || 0) >= min);
    }
    if (opts.all) return all;
    // 默认:最高分 1 个
    return [...all].sort((a, b) => (b.quality_score || 0) - (a.quality_score || 0)).slice(0, 1);
}

function parseModes(modeStr, hook) {
    if (!modeStr || modeStr === 'auto') {
        return [HOOK_TO_MODE[hook] || 'default'];
    }
    return String(modeStr).split(',').map((x) => x.trim()).filter(Boolean);
}

// 把 words 按 [start, end] 秒切出一段文本(用 stripHallucinatedLoop 防 ASR 循环幻觉)
function extractSegmentText(words, startSec, endSec) {
    const buf = [];
    for (const w of words) {
        const s = Number(w.start) || 0;
        const e = Number(w.end) || 0;
        if (e < startSec) continue;
        if (s > endSec) break;
        buf.push(String(w.word ?? w.text ?? '').trim());
    }
    return buf.join('').replace(/\s+/g, '');
}

// 构造 afc 的 user prompt:把 seg 元信息(场景/叙事弧)喂给 LLM,
// 让它基于口语原稿生成文章。明确要求保留原细节、不编造。
function buildUserPrompt(seg, transcriptSlice) {
    const pieces = [];
    if (seg.context_note) pieces.push(`【场景/背景】${seg.context_note}`);
    if (seg.narrative_arc) pieces.push(`【叙事弧结构】${seg.narrative_arc}`);
    if (seg.value_note) pieces.push(`【核心价值】${seg.value_note}`);
    if (seg.tags && seg.tags.length) pieces.push(`【关键词】${seg.tags.join('、')}`);
    pieces.push('');
    pieces.push('【原始口语稿】(这是视频里真实说的话,含口水词。你的任务是把它提炼、升华、排版成一篇文章,**保留**其中的真实细节(地名/金额/人物),**不允许**添加原稿里没有的事实。只能基于原稿写。)');
    pieces.push('---');
    pieces.push(transcriptSlice);
    pieces.push('---');
    pieces.push('');
    pieces.push('请按上方的系统角色和风格要求,写一篇公众号长文。');
    return pieces.join('\n');
}

module.exports = async function articleFromClip(file, opts) {
    const root = process.env.ZDE_PROJECT_ROOT || process.cwd();
    const abs = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
    if (!fs.existsSync(abs)) {
        console.error(`${C.red}✗${C.reset} 找不到文件: ${abs}`);
        process.exit(1);
    }
    try { process.chdir(root); } catch (_) {}

    const { hash, dir } = cache.getCacheDir(abs, root);
    const transcript = cache.readTranscript(dir);
    const candidates = (cache.readCandidates(dir) || {}).candidates || [];
    if (!transcript || !candidates.length) {
        console.error(`${C.red}✗${C.reset} 没有 hls 缓存。先跑:`);
        console.error(`   ${C.cyan}echocut hls ${path.basename(abs)}${C.reset}\n`);
        process.exit(1);
    }

    const selected = selectSegs(candidates, opts);
    if (!selected.length) {
        console.error(`${C.red}✗${C.reset} 没有匹配的候选`);
        process.exit(1);
    }

    // 延迟加载避免冷启动
    const { getConfig } = require('../../config');
    const { initDb } = require('../../db');
    const { ensureDefaultConfigs } = require('../../db/configRepo');
    const { generateArticle } = require('../../services/processor');
    const _config = getConfig();
    initDb(_config.contentDbPath);
    ensureDefaultConfigs();

    const modelOverride = opts.model && String(opts.model).trim();
    const ollamaModel = modelOverride || _config.ollamaModel;

    // 加载 brand(用于 CTA);CLI --cta 可覆盖
    const brandId = opts.brand || process.env.ZDE_DEFAULT_BRAND || 'example';
    let brand = null;
    try { brand = loadBrandFile(brandId); } catch (err) {
        console.warn(`${C.yellow}⚠${C.reset} 品牌 ${brandId} 加载失败: ${err.message} — 继续但不插入 CTA`);
    }
    const ctaBlock = composeArticleCta({ brand, cliCta: opts.cta });

    console.log(`\n${C.bold}${C.cyan}📝 echocut article-from-clip${C.reset}`);
    console.log(`   ${C.gray}文件${C.reset}    ${path.basename(abs)}`);
    console.log(`   ${C.gray}片段${C.reset}    ${selected.length} 个 (${selected.map((s) => s.id).join(', ')})`);
    console.log(`   ${C.gray}模型${C.reset}    ${ollamaModel}${modelOverride ? ' (手动指定)' : ''}`);
    if (brand) console.log(`   ${C.gray}品牌${C.reset}    ${C.green}${brand.id}${C.reset} — ${brand.displayName || brand.identity?.name || ''}`);
    if (ctaBlock) {
        const preview = ctaBlock.replace(/\n+/g, ' | ').trim().slice(0, 50);
        console.log(`   ${C.gray}CTA${C.reset}     ${preview}${preview.length >= 50 ? '…' : ''}`);
    }
    console.log('');

    const timeline = new StepTimeline();

    for (let i = 0; i < selected.length; i += 1) {
        const seg = selected[i];
        const sliceText = extractSegmentText(transcript.words, seg.start, seg.end);
        if (!sliceText || sliceText.length < 100) {
            console.warn(`${C.yellow}⚠${C.reset} ${seg.id} 文本太短(${sliceText.length} 字),跳过`);
            continue;
        }
        const modes = parseModes(opts.mode || 'auto', seg.hook_type);
        console.log(`${C.bold}━━━ [${i + 1}/${selected.length}] ${seg.id}  ${seg.title}${C.reset}`);
        console.log(`${C.gray}    ${seg.context_note || ''}  |  hook=${seg.hook_type}  |  ${sliceText.length} 字原稿${C.reset}`);
        console.log(`${C.gray}    → 生成 ${modes.length} 篇: ${modes.join(', ')}${C.reset}`);

        const prodDir = cache.getProductDir(dir, seg.id);
        fs.mkdirSync(prodDir, { recursive: true });

        for (const mode of modes) {
            const spinner = new Spinner(`  ${mode}`).start();
            try {
                const userPrompt = buildUserPrompt(seg, sliceText);
                const article = await generateArticle(userPrompt, {
                    ollamaUrl: _config.ollamaUrl,
                    ollamaModel,
                    ollamaTimeoutMs: 300000,
                    ollamaRetries: 1
                }, mode);
                const outPath = path.join(prodDir, `article-${mode}.md`);
                // 加一个 front matter 方便检索
                const frontMatter = [
                    '---',
                    `seg_id: ${seg.id}`,
                    `mode: ${mode}`,
                    `title: ${(seg.suggested_headline || seg.title || '').replace(/\n/g, ' ')}`,
                    `context: ${(seg.context_note || '').replace(/\n/g, ' ')}`,
                    `hook_type: ${seg.hook_type}`,
                    `quality_score: ${seg.quality_score}`,
                    `model: ${ollamaModel}`,
                    `generated_at: ${new Date().toISOString()}`,
                    `source_video: ${path.basename(abs)}`,
                    `time_range: ${Math.round(seg.start)}s-${Math.round(seg.end)}s`,
                    '---',
                    ''
                ].join('\n');
                // 代码级 AI 腔扫描
                let finalArticle = article.trim();
                let scan = scanArticle(finalArticle);
                let reviewInfo = null;

                // --deep-review: 如果命中 AI 腔,让 LLM 再跑一遍改写
                if (opts.deepReview && scan.totalHits > 0) {
                    const { callChat } = require('../../services/processor');
                    spinner.stop(`${scan.totalHits} 处 AI 腔,触发 --deep-review 重写`);
                    const reviewSpinner = new (require('../../lib/cliUtils').Spinner)(`  deep-review 重写中`).start();
                    try {
                        reviewInfo = await deepReviewAndRewrite({
                            article: finalArticle,
                            callChat,
                            options: {
                                ollamaUrl: _config.ollamaUrl,
                                ollamaModel,
                                ollamaTimeoutMs: 300000,
                                ollamaRetries: 1
                            },
                            personaBase: brand?.llm?.personaBase || ''
                        });
                        finalArticle = reviewInfo.rewritten;
                        scan = scanArticle(finalArticle);
                        reviewSpinner.stop(`重写完成 · 质量 ${reviewInfo.beforeScore} → ${reviewInfo.afterScore}(Δ +${reviewInfo.improvement})`);
                    } catch (err) {
                        reviewSpinner.fail(`重写失败: ${err.message || err}`);
                        // 保留原文,不阻塞
                    }
                }

                const words = finalArticle.length;
                const body = finalArticle + (ctaBlock || '') + '\n';
                fs.writeFileSync(outPath, frontMatter + body);
                const scoreTag = scan.totalHits
                    ? `${words} 字 / 质量 ${scan.score}/100 (${scan.totalHits} AI 腔)`
                    : `${words} 字 / 质量 ${scan.score}/100 ✓`;
                if (!opts.deepReview) {
                    spinner.stop(`${scoreTag} → ${path.basename(outPath)}`);
                } else {
                    console.log(`  → ${C.green}${path.basename(outPath)}${C.reset}  ${scoreTag}`);
                }
                if (scan.totalHits) {
                    console.log(`    ${renderScanReport(scan)}`);
                }
                const tlLabel = `${seg.id} ${mode}${opts.deepReview ? ' +review' : ''}`;
                timeline.record(tlLabel, spinner.elapsedMs, scoreTag);
            } catch (err) {
                spinner.fail(String(err.message || '').slice(0, 100));
                timeline.record(`${seg.id} ${mode}`, spinner.elapsedMs, 'failed');
            }
        }
        console.log('');
    }

    console.log(timeline.summary());
    console.log(`\n${C.green}✓${C.reset} article-from-clip 完成。产出:`);
    console.log(`   ${C.cyan}${path.join(dir, 'products')}/seg-*/article-*.md${C.reset}\n`);

    // 活干完显式退出:文章已 writeFileSync 落盘,但到 Ollama / 本地 mlx server 的
    // keep-alive 连接会让 node 事件循环一直不空,进程跑完不退出、空挂(实测 1h+)。
    // CLI 一次性任务,显式 exit(0) 最稳,不留僵尸进程占资源。
    process.exit(0);
};
