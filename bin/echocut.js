#!/usr/bin/env node
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
process.env.ZDE_PROJECT_ROOT = PROJECT_ROOT;

const { Command } = require('commander');
const pkg = require(path.join(PROJECT_ROOT, 'package.json'));

const program = new Command();

program
    .name('echocut')
    .description([
        'echocut · 本地素材到视频成片的一条命令',
        '',
        '快速开始:',
        '  echocut doctor                     环境自检',
        '  echocut burn ./input.mp4           烧字幕出片',
        '  echocut studio                     启动管理后台'
    ].join('\n'))
    .version(pkg.version, '-v, --version');

program
    .command('burn <file>')
    .description('给本地视频烧录字幕与标题(口播主场景)')
    .option('--headline <text>', '顶部大标题(默认 LLM 自动生成)')
    .option('--subline <text>', '顶部副标题(默认 LLM 自动生成)')
    .option('--engine <name>', 'ASR 引擎: qwen3(默认,中文最准+词级时间戳) | mlx_hq | mlx | funasr | sensevoice | whisperx', 'qwen3')
    .option('--ratio <ratio>', '画面比例: 9:16 | 16:9 | 1:1 | auto', 'auto')
    .option('--preset <name>', '视觉预设: douyin | none (默认 douyin)', 'douyin')
    .option('--preview <seconds>', '只渲染前 N 秒(调试/快速验证)')
    .option('--fallback-text <text>', '静音/无法转写时的兜底字幕')
    .option('--chunk-max-chars <n>', '单条字幕最大字符数')
    .option('--sentence-max-chars <n>', '单句字幕最大字符数')
    .option('--no-fillers', '保留口水词(默认自动过滤 "对吧/然后呢/em/um" 等)')
    .option('--cut-fillers', '视频轨道级 filler 切除(音视频字幕三轨同步,视频变短无痕)')
    .option('--cut-silence', '切除长静默段(口播思考空档 > 2.5s)')
    .option('--silence-threshold <sec>', '静默段阈值秒数', '2.5')
    .option('--bgm <name>', 'BGM 文件名(assets/bgm/下) 或 none 禁用;未指定则从 brand.json 读取')
    .option('--bgm-volume <vol>', 'BGM 音量 0-1;未指定则从 brand.json 读取')
    .option('--no-title', '隐藏顶部大标题/副标题(横屏录屏演示推荐,品牌胶囊保留)')
    .option('--obs', 'OBS 录屏(顶部人脸+底部屏幕):压窄顶部品牌带、标题缩小放 @胶囊右侧,露出人脸;配 --no-title 则只留品牌胶囊')
    .option('--brand <id>', '品牌身份: example | lisi | wangwu | <自定义>(见 configs/brands/)', 'example')
    .option('--denoise', 'RNNoise 神经网络降噪(无收音器/现场噪音场景) — 默认关闭')
    .option('--denoise-mix <n>', '降噪混合比 0-1,1=完全降噪 0.85=稳妥避免失真', '0.85')
    .option('--golden-hook', 'v0.10+ 黄金 3 秒:从片中找最炸的一句话复制到片头(提升完播率)')
    .option('--golden-start <sec>', '(配合 --golden-hook)手动指定钩子起点秒数,跳过 LLM 自动识别')
    .option('--golden-duration <sec>', '(配合 --golden-hook)钩子时长,默认 3.0', '3.0')
    .option('--auto-pad', 'v0.13:输入不是目标比例时自动 scale+pad 到 1080×1920(panel/直播录屏 4:3 源必备)')
    .option('--strip-top <px>', '(配合 --auto-pad)裁掉顶部 N 像素去除直播平台水印(如"NNNN人看过"条),默认 0')
    .option('--fill', '(配合 --auto-pad)裁切铺满(cover,抠主体)而非加黑边;横屏舞台口播→竖屏只留讲者')
    .option('--focus-x <n>', '(配合 --fill)裁切横向焦点 0..1,默认 0.5 居中;横屏讲者中偏右用 0.55~0.62')
    .option('--no-subtitle', 'v0.17:跳过 ASR/字幕烧录(剪映/Premiere 已自带字幕场景);顶部标题+品牌胶囊+封面+BGM+CTA+宣发包全保留')
    .option('--reuse-captions <file>', '复用现成 captions.json,跳过转写+LLM纠错(同视频换比例/样式快速重渲染)')
    .option('--fresh', '强制重新转写,绕过转写缓存(默认同源视频命中缓存秒跳转写)')
    .option('--no-bgm', 'v0.17.1:关闭 BGM(等同 --bgm none);其他能力全保留')
    .action((file, opts) => require('../src/cli/commands/burn')(file, opts));

program
    .command('panel-clip <file>')
    .description('v0.14:多人 panel/圆桌一键流水线(转写→关键词扫描→推断段→切片→重构图→burn)')
    .option('--speaker-names <list>', '目标讲者名字(同音字数组,逗号分隔;例:"李标,李彪,Pan Hunt")')
    .option('--other-speakers <list>', '其他嘉宾名字(用来识别段切换;例:"Dennis,张拼拼,陈慧")')
    .option('--host-names <list>', '主持人名字(可选,提高段推断准确率)')
    .option('--brand <id>', '品牌身份', 'example')
    .option('--bgm <name>', 'BGM 文件名', '02-guzheng-zen')
    .option('--auto-pad', '4:3 源 → 1080×1920(默认开)', true)
    .option('--no-auto-pad', '关闭 auto-pad(源已是 1080×1920 时)')
    .option('--strip-top <px>', '裁顶部水印像素(默认 0)', '0')
    .option('--out-dir <dir>', '输出目录(默认 <video>_panel/)')
    .option('--dry-run', '只跑到段推断输出 segments.json,不切片/burn(校对段时间戳用)')
    .option('--compilation-only', '只出合集,跳过每段独立 burn')
    .option('--skip-burn', '切片完停,产 segments/*.mp4 + compilation_raw.mp4 不 burn')
    .option('--min-duration <sec>', '段最短秒数,< 此值的过滤掉', '60')
    .option('--max-duration <sec>', '段最长秒数,超过截到此值', '900')
    .option('--start-buffer <sec>', '把主持人提问前 N 秒包进段开头', '0')
    .option('--host-threshold <n>', '主持人触发分阈值(0-1,默认 0.5,越高越严)', '0.5')
    .option('--headlines <list>', '每段标题(逗号分隔,数量对应段数)')
    .option('--sublines <list>', '每段副标题(逗号分隔)')
    .option('--compilation-headline <text>', '合集标题')
    .option('--compilation-subline <text>', '合集副标题')
    .action((file, opts) => require('../src/cli/commands/panelClip')(file, opts));

program
    .command('identity-card <file>')
    .description('v0.15:持久身份卡片 overlay(姓名 + 头衔常驻水印,适合 panel/演讲嘉宾视频)')
    .option('--name <text>', '姓名(必填,或从 --brand 提取 identity.name)')
    .option('--title <text>', '头衔(可选,如"echocut CEO")')
    .option('--brand <id>', '品牌(从 brand.identity.name/title 提取默认值)')
    .option('--position <pos>', '位置: bottom-left | bottom-right | top-left | top-right', 'bottom-left')
    .option('--name-font-size <n>', '姓名字号', '36')
    .option('--title-font-size <n>', '头衔字号', '28')
    .option('--name-color <hex>', '姓名颜色', '#FFFFFF')
    .option('--title-color <hex>', '头衔颜色(品牌黄)', '#FFD54F')
    .option('--box-color <expr>', '背景框 ffmpeg 颜色表达式', 'black@0.7')
    .option('--font-file <path>', '字体文件(默认 PingFang)')
    .option('--out <path>', '输出路径(默认 <input>_identity.mp4)')
    .option('--crf <n>', 'libx264 CRF', '18')
    .option('--preset <name>', 'libx264 preset', 'medium')
    .action((file, opts) => require('../src/cli/commands/identityCard')(file, opts));

program
    .command('package <file>')
    .description('v0.16:brand 包装(用户已剪好视频 → 加 brand 封面 + BGM + CTA;不烧字幕)')
    .option('--headline <text>', '封面主标题(不传则用文件名 stem)')
    .option('--subline <text>', '封面副标题')
    .option('--brand <id>', '品牌身份', 'example')
    .option('--bgm <name>', 'BGM 文件名(assets/bgm/),none=禁用;不传从 brand 读')
    .option('--bgm-volume <vol>', 'BGM 音量 0-1;不传从 brand 读')
    .option('--cover <path>', '指定封面 jpg(默认 brand 自动生成);none=不加封面帧')
    .option('--cta-title <text>', 'CTA 主文案(默认 brand.cta.title)')
    .option('--cta-subtitle <text>', 'CTA 副文案(默认 brand.cta.subtitle)')
    .option('--cta-hint <text>', 'CTA 引导文案(默认 brand.cta.hint)')
    .option('--no-cta', '禁用 CTA 尾卡')
    .option('--denoise', '主音轨 RNNoise 神经网络降噪')
    .option('--denoise-mix <n>', '降噪混合比 0-1', '0.85')
    .option('--out-dir <dir>', '输出目录(默认输入文件同目录)')
    .option('--out <path>', '输出路径(默认 <input>_packaged.mp4)')
    .action((file, opts) => require('../src/cli/commands/package')(file, opts));

program
    .command('batch <dir>')
    .description('批量处理目录下所有视频(burn 或 highlights)')
    .option('--action <action>', '批量动作: burn | highlights', 'burn')
    .option('--preset <name>', '视觉预设: douyin | none', 'douyin')
    .option('--cut-fillers', '视频轨道级 filler 切除')
    .option('--no-fillers', '保留口水词')
    .option('--engine <name>', 'ASR 引擎(默认 qwen3)', 'qwen3')
    .option('--ratio <ratio>', '画面比例: 9:16 | 16:9 | 1:1 | auto', 'auto')
    .option('--segments <n>', '(highlights 专用)目标切片数量')
    .option('--limit <n>', '最多处理 N 个文件(默认全部)')
    .option('--recursive', '递归遍历子目录')
    .option('--brand <id>', '品牌身份(见 configs/brands/)', 'example')
    .action((dir, opts) => require('../src/cli/commands/batch')(dir, opts));

program
    .command('article')
    .description('从视频/音频/文本生成公众号文章 + 朋友圈文案')
    .option('--transcript-file <path>', '已转写的 transcript.json')
    .option('--video-file <path>', '视频文件(会先转写)')
    .option('--audio-file <path>', '音频文件(会先转写)')
    .option('--text <text>', '直接输入纯文本')
    .option('--mode <mode>', '文章风格: default | hardcore | soul | nomad', 'default')
    .option('--output <path>', '输出 md 文件路径(默认打印到终端)')
    .option('--engine <name>', '(音视频)ASR 引擎(默认 qwen3)', 'qwen3')
    .option('--brand <id>', '品牌身份(见 configs/brands/)', 'example')
    .option('--cta <text>', '覆盖品牌 CTA 文案(支持换行用 \\n);不传则读 brand.cta')
    .action((opts) => require('../src/cli/commands/article')(opts));

program
    .command('highlights <file>')
    .description('长视频精华切片:LLM 挑 N 段精华,每段独立烧字幕+标题+宣发包')
    .option('--segments <n>', '目标切片数量 (2-8)', '4')
    .option('--engine <name>', 'ASR 引擎: qwen3(默认,中文最准+词级时间戳) | mlx_hq | mlx | funasr | sensevoice | whisperx', 'qwen3')
    .option('--preset <name>', '视觉预设: douyin | none', 'douyin')
    .option('--style-preset <name>', '画面比例预设: vertical | landscape | square | safe | auto', 'auto')
    .option('--cut-fillers', '视频轨道级 filler 切除')
    .option('--cut-silence', '切除长静默段(> 2.5s)')
    .option('--silence-threshold <sec>', '静默段阈值秒数', '2.5')
    .option('--bgm <name>', 'BGM 文件名(assets/bgm/下) 或 none 禁用;未指定则从 brand.json 读取')
    .option('--bgm-volume <vol>', 'BGM 音量 0-1;未指定则从 brand.json 读取')
    .option('--no-fillers', '保留口水词')
    .option('--output-dir <dir>', '输出目录', '')
    .option('-y, --yes', '跳过确认,直接执行')
    .option('--no-publish-kit', '不生成宣发素材包')
    .option('--brand <id>', '品牌身份(见 configs/brands/)', 'example')
    .option('--golden-hook', 'v0.10+ 每个精华段加黄金 3 秒钩子')
    .option('--golden-start <sec>', '(配合 --golden-hook)手动指定钩子起点')
    .option('--golden-duration <sec>', '(配合 --golden-hook)钩子时长,默认 3.0', '3.0')
    .action((file, opts) => require('../src/cli/commands/highlights')(file, opts));

// V2:两阶段命令 — 先 ls 分析列候选,再 make 选择性产出。
// 自适应切片数量(LLM 按内容决定),磁盘缓存(下次秒开),不污染老 highlights。
program
    .command('highlights-ls <file>')
    .alias('hls')
    .description('V2 分析长视频,列出 LLM 识别的候选精华片段(不产出视频,首次约 1-3 分钟)')
    .option('--engine <name>', 'ASR 引擎(默认 qwen3)', 'qwen3')
    .option('--rerun', '强制重新分析(忽略缓存)')
    .option('--min-score <n>', '只显示质量评分 ≥ N 的候选 (0-1)', '0')
    .action((file, opts) => require('../src/cli/commands/highlights-ls')(file, opts));

program
    .command('article-from-clip <file>')
    .alias('afc')
    .description('V2 基于 hls 缓存,直接从精华片段生成公众号长文(复用 example persona + articleModes)')
    .option('--seg <ids>', '产出指定 seg,逗号分隔:seg-01 或 1,2,3', '')
    .option('--min-score <n>', '产出评分 ≥ N 的所有候选', '')
    .option('--all', '产出全部候选')
    .option('--mode <modes>', '文章风格: default|hardcore|soul|nomad|auto, 逗号多选', 'auto')
    .option('--model <name>', '临时覆盖 Ollama 模型(如 deepseek-r1:14b)')
    .option('--brand <id>', '品牌身份(用于读 CTA,见 configs/brands/)', 'example')
    .option('--cta <text>', '覆盖品牌 CTA 文案(支持换行用 \\n);不传则读 brand.cta')
    .option('--deep-review', '(v0.9)命中 AI 腔时触发 LLM 自检重写,耗时翻倍但质量更稳')
    .action((file, opts) => require('../src/cli/commands/article-from-clip')(file, opts));

program
    .command('highlights-make <file>')
    .alias('hmk')
    .description('V2 基于 hls 的缓存,产出指定或筛选的精华片段(调 burn 完整流水线)')
    .option('--seg <ids>', '产出指定片段 id,逗号分隔:--seg seg-01 或 --seg 1,3,5', '')
    .option('--min-score <n>', '产出评分 ≥ N 的所有候选', '')
    .option('--all', '产出全部候选片段')
    .option('--denoise', 'RNNoise 降噪(户外录音)')
    .option('--bgm <name>', 'BGM 名;未指定走 brand 默认')
    .option('--brand <id>', '品牌身份', 'example')
    .option('--no-cut-fillers', '关闭 filler 词切除(默认开)')
    .option('--no-cut-silence', '关闭长静默切除(默认开)')
    .option('--golden-hook', 'v0.10+ 黄金 3 秒:每个 seg 把最炸一句复制到片头(提升完播率)')
    .option('--golden-start <sec>', '(配合 --golden-hook)手动指定钩子起点,跳过 LLM')
    .option('--golden-duration <sec>', '(配合 --golden-hook)钩子时长,默认 3.0', '3.0')
    .action((file, opts) => require('../src/cli/commands/highlights-make')(file, opts));

program
    .command('weekly-retro')
    .description('周度复盘:生成数据模板 → 用户填 → LLM 分析爆款/掉量 + 下周选题建议')
    .option('--period <range>', '周期,格式 "YYYY-MM-DD~MM-DD"(例 2026-04-14~04-20)')
    .option('--brand <id>', '品牌身份', 'example')
    .option('--force', '模板已存在时强制覆盖', false)
    .option('--analyze <path>', '分析已填好的 weekly retro 模板(跳过模板生成)')
    .action((opts) => require('../src/cli/commands/weekly-retro')(opts));

program
    .command('cross-lang [file]')
    .description('中文 → 目标语言 bundle(hooks + Twitter thread + blog article);支持 en/ja/es')
    .option('--seg <id>', '从 hls 缓存的某个 seg 生成(默认最高分)')
    .option('--transcript-file <path>', '直接读 transcript.json(免 hls)')
    .option('--text <text>', '直接从中文文本生成目标语言 bundle')
    .option('--target-lang <lang>', '目标语言: en | ja | es(默认 en)', 'en')
    .option('--output-dir <dir>', '输出目录(默认和 hmk/afc 成片同目录的 crosslang/ 或 crosslang-<lang>/)')
    .option('--brand <id>', '品牌身份(用 brand.identity.taglineEn/taglineJa/taglineEs)', 'example')
    .option('--model <name>', '临时覆盖 Ollama 模型')
    .action((file, opts) => require('../src/cli/commands/cross-lang')(file, opts));

program
    .command('distribute [file]')
    .description('一次成片 → 六平台独立分发包(抖音/快手/小红书/视频号/公众号/Twitter)')
    .option('--seg <id>', '从 hls 缓存的某个 seg 生成(默认最高分)')
    .option('--transcript-file <path>', '直接读 transcript.json(免 hls)')
    .option('--text <text>', '直接从纯文本生成')
    .option('--output-dir <dir>', '输出目录(默认和 hmk/afc 成片同目录的 distribute/)')
    .option('--brand <id>', '品牌身份(决定 persona/identity)', 'example')
    .option('--model <name>', '临时覆盖 Ollama 模型(如 deepseek-r1:14b)')
    .action((file, opts) => require('../src/cli/commands/distribute')(file, opts));

program
    .command('hook-gen [file]')
    .description('生成 5 个前 3 秒钩子候选(反常识/挑衅/自报家门/数字悬念/故事)')
    .option('--seg <id>', '从 hls 缓存的某个 seg 生成(默认最高分 seg);file 需指向视频')
    .option('--transcript-file <path>', '直接读 transcript.json(免 hls)')
    .option('--text <text>', '直接从纯文本生成')
    .option('--output <path>', '保存到 md 文件,不传只打印')
    .option('--brand <id>', '品牌身份(用于 persona)', 'example')
    .option('--model <name>', '临时覆盖 Ollama 模型(如 deepseek-r1:14b)')
    .option('--rounds <n>', 'A/B 模式:跑 N 轮 × 5 候选,去重取 Top 5(默认 1,不建议 > 3)', '1')
    .action((file, opts) => require('../src/cli/commands/hook-gen')(file, opts));

program
    .command('ingest <dir>')
    .description('v0.11.1 批量分析视频素材,用本地 minicpm 视觉模型打 tag,输出 metadata.json 供 vlog 编排用')
    .option('--model <name>', '视觉模型', 'openbmb/minicpm-o2.6:latest')
    .option('--rerun', '忽略缓存,全部重跑')
    .option('--limit <n>', '只跑前 N 个(调试用)', '0')
    .action((dir, opts) => require('../src/cli/commands/ingest')(dir, opts));

program
    .command('music')
    .description('MiniMax 音乐生成 · 单首 ad-hoc / 批量 / 本地库管理 — BGM 用')
    .option('--prompt <text>', '单首生成的 prompt(例 "uplifting piano jazz")')
    .option('--name <name>', '(配合 --prompt)输出文件名,默认 music-adhoc-<时间>')
    .option('--set <name>', '预设批次: background / solo / creator / dj')
    .option('--file <path>', '自定义 JSON 文件 [{name, prompt}, ...]')
    .option('--list-sets', '列出所有预设及样例')
    .option('--list', '扫描 assets/bgm/ 列出本地已有 BGM(按 set 分组,带时长/大小)')
    .option('--filter <kw>', '(配合 --list)按文件名关键词过滤')
    .option('--out-dir <dir>', '输出目录(默认 assets/bgm/)')
    .option('--model <name>', '音乐模型(默认 music-2.6)')
    .option('--timeout <seconds>', '单首超时,默认 240')
    .option('--overwrite', '同名 mp3 已存在时强制重跑(默认跳过)', false)
    .action((opts) => require('../src/cli/commands/music')(opts));

program
    .command('vlog-plan')
    .description('v0.11.4 ⭐ AI 写 plan:给主题+核心理念,LLM 看素材自动设计 N 个 plan JSON(字幕围绕你的理念)')
    .requiredOption('--ingest <path>', '已 ingest 过的素材目录 或 _metadata.json')
    .requiredOption('--theme <text>', '主题(一句话,如 "创业者的一天")')
    .requiredOption('--idea <text>', '核心理念/思想(你想表达的,字幕会围绕它)')
    .option('--count <n>', '候选 plan 数,默认 3', '3')
    .option('--duration <sec>', '目标时长(秒,不填让 LLM 自选 25-90s)')
    .option('--style <name>', '强制风格(startup-journey/growth-reflection/...,不填 LLM 自选)')
    .option('--bgm <hint>', 'BGM 偏好(文件名或描述,不填 LLM 自选)')
    .option('--output-dir <dir>', '输出目录,默认 ./vlog-plans/')
    .option('--model <name>', 'LLM 模型,默认 qwen3.5:9b')
    .action((opts) => require('../src/cli/commands/vlog-plan')(opts));

program
    .command('vlog')
    .description('v0.11.4 ⭐ 一步到位:vlog-plan + 批量渲染(主题+理念 → N 条成片)')
    .requiredOption('--ingest <path>', '素材目录(已 ingest)')
    .requiredOption('--theme <text>', '主题')
    .requiredOption('--idea <text>', '核心理念')
    .option('--count <n>', '候选数,默认 3(建议 2-5)', '3')
    .option('--duration <sec>', '目标时长,不填 LLM 自选')
    .option('--style <name>', '风格,不填 LLM 自选')
    .option('--bgm <hint>', 'BGM 偏好')
    .option('--brand <id>', '品牌', 'example')
    .option('--output-dir <dir>', '输出目录,默认 ./vlog-output-<时间>/')
    .option('--model <name>', 'LLM 模型,默认 qwen3.5:9b')
    .action((opts) => require('../src/cli/commands/vlog')(opts));

program
    .command('translate <md-or-dir>')
    .description('中→英本地化翻译(your-blog.com 博客风格,信达雅 + 不逐字翻译)')
    .option('--rerun', '强制重新翻译已存在的 -en.md(默认跳过)')
    .option('--minimax-model <name>', '覆盖 MiniMax 文本模型(默认 MiniMax-M2.7)')
    .action((input, opts) => require('../src/cli/commands/translate')(input, opts));

program
    .command('essay <source>')
    .description('从视频 transcript / 视频目录 / .txt 纯文本生成公众号文章(主角恒等于"Example")')
    .option('--style <name>', '风格: structured(刘润/Keso) | narrative(何加盐/池建强) | hardcore(半佛/和菜头) | all', 'all')
    .option('--model <name>', '模型: ollama(本地) | minimax(云端 M2.7) | both', 'both')
    .option('--voice <name>', '口吻: first(我=Example本人) | third(旁观叙述者讲Example) | both', 'first')
    .option('--title <text>', '(仅 .txt 输入)显式指定主题,LLM 会基于这个写;不传则让 LLM 自己提炼')
    .option('--translate', '跑完中文立即翻译成英文(your-blog.com 风格,作者名 Bill,信达雅不逐字)', false)
    .option('--out-dir <dir>', '产出目录(默认 transcript 同目录的 essays/;.txt 输入用 essays-<filename>/)')
    .option('--ollama-model <name>', '覆盖本地 Ollama 模型(默认读 OLLAMA_MODEL env)')
    .option('--minimax-model <name>', '覆盖 MiniMax 文本模型(默认 MiniMax-M2.7)')
    .action((source, opts) => require('../src/cli/commands/essay')(source, opts));

program
    .command('cover')
    .description('独立生成统一品牌封面(不处理视频,只出 jpg)— 用于你用别的工具剪视频但要品牌统一封面')
    .requiredOption('--headline <text>', '主标题(必填)')
    .option('--subline <text>', '副标题')
    .option('--brand <id>', '品牌身份(见 configs/brands/)', 'example')
    .option('--output <path>', '输出 jpg 路径(默认 ./cover.jpg;若已存在会自动加时间戳,--force 强制覆盖)')
    .option('--ratio <ratio>', '封面比例: 9:16(竖屏) | 1:1(方图);横屏 16:9 待 v0.11', '9:16')
    .option('--force', '目标文件已存在时强制覆盖', false)
    .action((opts) => require('../src/cli/commands/cover')(opts));

program
    .command('brand')
    .description('品牌管理:列出/查看/检查当前可用品牌配置')
    .option('--list', '列出所有可用品牌')
    .option('--show <id>', '查看指定品牌的详细配置')
    .option('--checklist [id]', '打印品牌资产 7 点 checklist(bio/改名/视觉/CTA/禁忌/节奏)', false)
    .action((opts) => require('../src/cli/commands/brand')(opts));

program
    .command('publish [file]')
    .description('上传成片到 S3/MinIO,返回带时效签名的下载 URL (默认 7 天)')
    .option('--brand <id>', '上传到哪个品牌的目录', 'default')
    .option('--list', '列出 bucket 里的所有文件')
    .option('--prefix <p>', '(配合 --list)只列出指定前缀')
    .option('--purge [days]', '清理超过 N 天的旧文件 (默认 7)')
    .option('--status', '查看 storage 状态')
    .action((file, opts) => require('../src/cli/commands/publish')(file, opts));

program
    .command('doctor')
    .description('环境自检: Node / FFmpeg / Python / Ollama / MiniMax / 内存')
    .option('--minimax', '探活 MiniMax API key 是否可用')
    .action((opts) => require('../src/cli/commands/doctor')(opts));

// v0.11.5 ⭐ MiniMax 能力套件:tts / image / video / music-cover / lyrics / quota
// 独立正交,不混入其他子命令。BGM 音乐生成继续走 `echocut music`。
const minimaxCmd = program
    .command('minimax')
    .description('v0.11.5 ⭐ MiniMax 能力套件(tts/image/video/music-cover/lyrics)— 独立正交,未来换供应商只改这里');
require('../src/cli/commands/minimax').registerSubcommands(minimaxCmd);

program
    .command('studio')
    .description('启动管理后台(默认 http://localhost:3399)')
    .action(() => require('../src/cli/commands/studio')());

program.showHelpAfterError('(用 --help 查看完整用法)');

// 给每个子命令的 --help 末尾追加"示例"段(src/cli/examples.js)
require('../src/cli/examples').attachExamplesToCommands(program);

program.parseAsync(process.argv).catch((err) => {
    console.error('\x1b[31m✗\x1b[0m', err.message || err);
    process.exit(1);
});
