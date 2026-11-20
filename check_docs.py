#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
文档结构自检 —— 校验「文档分层体系」是否仍然自洽。

体系：DOCS_LAYOUT.md（职责边界）→ PROJECT_STATUS.md（现状台账）
      → PROJECT_PROGRESS.md（任务账）→ Docs/devlog/（单任务冷存档）
      → AGENTS.md（硬契约，仓库根）→ Docs/design/（设计规范）
      → ARCHITECTURE.md（工程架构与代码规则）

用法：把本脚本放在工程根目录，运行
    python check_docs.py

只依赖 Python 3，不改动任何文件。

检查项随体系演进而增加 —— **具体项数以运行时输出为准，不在此写死**。

── 换项目怎么改 ──────────────────────────────
只需改下面 CONFIG 一处（其余不用动）。

不适用某项检查时（如没有源码目录、没装技能），把对应配置留空或删掉，
脚本会标「⏭️ 跳过」而不是报红 —— 这套架子要能独立存活，不该因为"没装某个可选件"就红一片。
"""
import os
import re
import sys
import glob
import subprocess

ROOT = os.path.dirname(os.path.abspath(__file__))


def P(*a):
    return os.path.join(ROOT, *a)


# ══════════════════════════════════════════════════════════
#  CONFIG —— 换项目只改这一段
# ══════════════════════════════════════════════════════════
CONFIG = {
    # 根目录必备文件（少一个就报红）
    'required_files': [
        'README.md',
        'PROJECT_STATUS.md',
        'PROJECT_PROGRESS.md',
        'DOCS_LAYOUT.md',
        'ARCHITECTURE.md',
        'AGENTS.md',
        'check_docs.py',
    ],

    # 硬契约文件名（单源）
    'contract_file': 'AGENTS.md',

    # 老路径占位文件：若存在则必须 < stub_max_bytes（防止有人把正文写回去）
    'contract_stub': 'Docs/tech/项目指令.md',
    'stub_max_bytes': 400,

    # 配置栏指针文本的字符上限（WorkBuddy 限额 600）
    'pointer_max_chars': 600,

    # 技能目录：支持 `~` 展开；按你的平台加 / 删，不用改别处。
    #  ⚠️ 设计取舍（重要）：**一个都找不到时不报红**，视为「技能未安装」并跳过检查。
    #     技能是可选的 —— 这套架子要能独立存活，不能因为"没装技能"就红一片。
    #     找不到时脚本会列出查过哪些位置，方便你判断是"没装"还是"装错地方"。
    #
    #  DSH（DeepSeek Harness）放前面 —— 它的技能发现顺序是固定的：
    #    <项目根>/.dsh/skills  (rank 100) → <项目根>/.agents/skills (200)
    #    → <DSH_HOME>/skills   (400) → <agentsHome>/skills (500)
    #  `~/.dsh` 一般是指向 DSH_HOME 的 Junction，所以 `~/.dsh/skills` 就是用户级。
    #  ⚠️ 技能装到哪，这里就要配到哪 —— 否则「装了」会被判成「没装」。
    'skill_dirs': [
        '.dsh/skills',              # DSH 项目级（跟仓库走，rank 最高）
        '~/.dsh/skills',            # DSH 用户级（跨项目共享一份）
        '.workbuddy/skills',        # WorkBuddy 项目级（兼容旧环境）
        '~/.workbuddy/skills',      # WorkBuddy 用户级（兼容旧环境）
    ],
    'skill_prefix': 'proj-',

    # 技能别名：已并入别的技能的老名字，历史文档引用它们不算悬空
    'skill_aliases': {},

    # 引用检查的白名单：**平台约定的格式名**，不是项目文档。
    #  ⚠️ 只对「仓库里确实没有同名文件」的情况生效 —— 真存在的当然照常检查。
    #  没有这份白名单，文档里写一句「`SKILL.md` 没了等于没装」就会被当成悬空引用。
    'ref_exempt_names': [
        'SKILL.md', 'DETAIL.md', 'CLAUDE.md', 'AGENTS.local.md',
        'CLAUDE.local.md', 'README.md', 'INDEX.md',
    ],

    # 文档索引
    'index_file': 'Docs/INDEX.md',
    'layout_file': 'DOCS_LAYOUT.md',

    # 历史区（只进不出）—— 不参与「引用必须可解析」「必须登记」等检查
    'historical_dirs': ['Docs/archive', 'Docs/devlog'],

    # 扫描 .md 时整体跳过的目录
    #  ⚠️ 必须包含各类工具的配置目录（.workbuddy / .dsh / .claude / .cursor…）：
    #  技能装进项目级后，那些 SKILL.md 会被当成「项目文档」扫进引用检查与体积检查，
    #  症状是"扫描文档数莫名变多"、以及技能内部引用被报悬空。
    'skip_dirs': {
        '_delivery', '_archive', '_logs', '_packaging',
        'node_modules', 'build', 'dist', 'out', 'target',
        'Binaries', 'Intermediate', 'Saved', 'DerivedDataCache',
        '.git', '.vs', '.idea', '.vscode',
        '.workbuddy', '.dsh', '.claude', '.cursor', '.codex',
        'Plugins', '.venv', 'venv', '__pycache__',
        'memory', 'logs', 'sessions', 'traces',
    },

    # 数据目录名 —— 与 {{DATA_DIR}} 占位符保持一致。
    #  占位符检查据此定位 `<数据目录>/字段说明.md`；换目录名只改这一处，
    #  别在 placeholder_files 里再写死一份（写死就会出现"改了名却还在查旧路径"）。
    'data_dir': 'Data',

    # 占位符检查范围（这些文件里出现 {{PROJECT_NAME}} 这类记号就是没改完）
    # 留空列表 = 不检查
    'placeholder_files': [
        'AGENTS.md',
        'README.md',
        'PROJECT_STATUS.md',
        'PROJECT_PROGRESS.md',
        'DOCS_LAYOUT.md',
        'ARCHITECTURE.md',
        'Docs/INDEX.md',
        'Docs/design/README.md',
        'Tests/README.md',
    ],

    # 单文件体积上限（KB）—— 守「长文档无限膨胀」
    # 超了不一定是错，但值得警惕：通常意味着塞了不该塞的内容
    'max_file_kb': 40,
    'large_file_exempt': ['PROJECT_PROGRESS.md', 'DOCS_LAYOUT.md', 'ARCHITECTURE.md'],

    # 职责越界启发式：文件 → (正则, 为什么)
    # 出现即警告。指针句（含 → / 详见 / 见 `xxx`）自动豁免
    'role_rules': [
        ('README.md', r'当前(阶段|进度)|卡点|待办',
         '操作手册不该写「当前状态」'),
        ('PROJECT_STATUS.md', r'本批|本次收尾|第.{1,3}批(的|已)',
         '台账不该塞任务流水'),
        ('PROJECT_PROGRESS.md', r'\d{2,}\s*(项|断言|列|行|个文件)|:\d{2,3}\b',
         '项目进度不该写细节数字 / 行号'),
        ('DOCS_LAYOUT.md', r'第.{1,3}批(的|已)',
         '分层规范不该写具体任务记录'),
    ],

    # 源码目录（用于「ARCHITECTURE 覆盖全部源文件」）
    # 留空 = 跳过该检查；多个目录用列表
    'source_dirs': [],
    'source_exts': ('.h', '.cpp', '.c', '.cs', '.py', '.ts', '.go', '.rs'),
    'source_exclude': ('.generated.',),

    # 插件 / 依赖目录（用于「架构文档记录了全部插件」）—— 留空跳过
    'plugin_dir': '',

    # 收尾协议是否必须覆盖到项目进度
    'closeout_skill': 'proj-closeout',
    'closeout_must_mention': 'PROJECT_PROGRESS.md',

    # ── 「最后核对」日期守护（第 4 轮新增）────────────────────
    #  守的是什么：**"最后核对"这个断言有没有落后于它依据的文件**。
    #  为什么必须有：光写日期 = 靠记性 = 必然腐坏（这正是本体系的铁律）。
    #  为什么用 git 而不是文件 mtime：clone / 解压 / 同步工具都会重置 mtime，
    #  提交时间才是稳定事实；没装 git 时整项跳过，不红。
    'date_guard': {
        'enabled': True,
        # 认的行首标记（同一行后面紧跟日期）
        'markers': ('最后核对', '最后更新'),
        # 日期形态：YYYY-MM-DD ｜ YYYY-MM-DD（后面可跟「依据：…」）
        'pattern': r'^>\s*(?:[\*\s]*)(?:最后核对|最后更新)[：:]\s*(\d{4}-\d{2}-\d{2})',
        # 允许写「依据：」列出依赖的文档（可选；不写就按同目录同源处理）
        'basis_marker': '依据',
        # 这几种文件不参与（自己是模板/自检脚本说明，无"核对"语义）
        'skip_files': ('README_先看我.md',),
        # 落后多少天才提示（0 = 一旦落后就提示）
        'tolerance_days': 0,
    },
}
# ══════════════════════════════════════════════════════════


# 模板标记：出现在引用里说明那是"示意路径"，不是真引用
TEMPLATE_MARKERS = ('<', '>', '*', 'N批', '日期', 'YYYY', 'MM-DD', '...', '{{', '}}')

# 占位符形态
PLACEHOLDER_RE = re.compile(r'\{\{[A-Z0-9_]+\}\}')


def rel(p):
    # ⚠️ 跨盘会抛 ValueError（例如工程在 D:、用户级技能在 C:）——
    #    这正是"技能装用户级"的常规情形，必须兜住，否则脚本直接崩。
    try:
        return os.path.relpath(p, ROOT).replace(os.sep, '/')
    except ValueError:
        return os.path.abspath(p).replace(os.sep, '/')


def read(p):
    return open(p, encoding='utf-8', errors='replace').read()


def all_md():
    out = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in CONFIG['skip_dirs']]
        for f in filenames:
            if f.lower().endswith('.md'):
                out.append(os.path.join(dirpath, f))
    return sorted(out)


def resolve_skill_dirs():
    """把 CONFIG['skill_dirs'] 解析成实际路径，返回 (存在, 不存在)。"""
    found, missing = [], []
    for d in CONFIG['skill_dirs']:
        sd = os.path.expanduser(d)
        if not os.path.isabs(sd):
            sd = P(*sd.split('/'))
        (found if os.path.isdir(sd) else missing).append(sd)
    return found, missing


def skill_names(found_dirs):
    """只认「有正文的技能」：`<技能名>/SKILL.md`，或平铺的 `<技能名>.md`。

    ⚠️ 为什么不是「目录存在就算装」：DSH 的本地技能提供方只认这两种形态。
    目录还在、SKILL.md 被删了，对 DSH 等于**不存在**，而脚本会给绿灯 ——
    这种假阴性比不检查更坏（模型加载不到，体检却说"装了"）。
    """
    names = set()
    for sd in found_dirs:
        for x in sorted(os.listdir(sd)):
            p = os.path.join(sd, x)
            if os.path.isdir(p) and os.path.isfile(os.path.join(p, 'SKILL.md')):
                names.add(x)
            elif os.path.isfile(p) and x.lower().endswith('.md'):
                names.add(os.path.splitext(x)[0])
    return names


def skill_empties(found_dirs):
    """列出「目录在但没有 SKILL.md」的技能 —— 报红时点名，避免让人对着空目录排查。"""
    out = []
    for sd in found_dirs:
        for x in sorted(os.listdir(sd)):
            p = os.path.join(sd, x)
            if (os.path.isdir(p) and not os.path.isfile(os.path.join(p, 'SKILL.md'))
                    and not os.path.isfile(os.path.join(sd, x + '.md'))):
                out.append((sd, x))
    return out


# ══════════════════════════════════════════════════════════
#  「最后核对」日期守护的辅助函数
# ══════════════════════════════════════════════════════════
def git_last_commit_date(paths):
    """返回 (日期字符串, 错误说明)。任一文件在 git 里有提交就取最晚的那次。

    用 git 而不是文件 mtime：clone / 解压 / 同步都会重置 mtime，
    提交时间是稳定事实。工作区里**改了但没提交**的情况，git 看不到 ——
    这是刻意的：本项只守"已入库的事实"，未提交的改动本来就该先提交再核对。
    """
    try:
        out = subprocess.run(
            ['git', 'log', '-1', '--format=%ad', '--date=short', '--'] + list(paths),
            cwd=ROOT, capture_output=True, text=True, timeout=15,
            encoding='utf-8', errors='replace')
    except FileNotFoundError:
        return None, '没装 git'
    except Exception as e:                                  # 超时等
        return None, f'git 调用失败: {e}'
    if out.returncode != 0:
        msg = (out.stderr or '').strip().splitlines()
        return None, (msg[0][:120] if msg else f'git exit {out.returncode}')
    d = (out.stdout or '').strip()
    return (d or None), None


def has_git():
    """仓库里到底有没有 git 历史（有 .git 但零提交也算没有）。"""
    try:
        r = subprocess.run(['git', 'rev-parse', '--git-dir'], cwd=ROOT,
                           capture_output=True, text=True, timeout=10)
        return r.returncode == 0
    except Exception:
        return False


def date_guard():
    """检查各文档顶部「最后核对 / 最后更新」是否落后于它依据的文件。

    三态（沿用本脚本的约定：跳过 ≠ 报错）：
      ✅ 通过 / ⚠️ 提示（落后，不算失败）/ ⏭️ 跳过（无 git、无日期标记）→ 由调用方决定是否入 ok 列表
    返回 (状态, 说明, 明细行列表)。状态取 'ok' | 'warn' | 'skip' | 'bad'
    """
    cfg = CONFIG.get('date_guard') or {}
    if not cfg.get('enabled'):
        return 'skip', '（未启用）', []

    rx = re.compile(cfg['pattern'])
    basis_rx = re.compile(
        re.escape(cfg['basis_marker']) + r'[：:]\s*([^|｜\n]+)')

    missing, behind, unreadable = [], [], []
    checked = 0

    for f in all_md():
        r = rel(f)
        if os.path.basename(r) in cfg.get('skip_files', ()):
            continue
        # 历史区不参与（它们是冻结的）
        if any(r.startswith(d + '/') for d in CONFIG['historical_dirs']):
            continue

        lines = read(f).split('\n')[:40]        # 只扫文件头（标题 + 前言区），够用且快
        #  ⚠️ 用 40 行而不是 12：文件头常有徽章/目录/多段前言，
        #     窗口太窄会把「最后核对」漏在窗口外 → 静默当"没写"，反而不报错。
        hit = None
        raw_marker = None                       # 有标记但日期不合法 → 要报错，不能静默跳过
        for ln in lines:
            s = ln.strip()
            if not s.lstrip('>').strip():
                continue
            m = rx.match(s)
            if m:
                hit = (m.group(1), ln)
                break
            # 行首是「最后核对/最后更新」但没跟 YYYY-MM-DD → 写得不对
            mk = re.match(r'^>?\s*[\*\s]*(最后核对|最后更新)[：:]', s)
            if mk:
                raw_marker = (mk.group(1), s[:80])
        if raw_marker and not hit:
            # ⚠️ 未初始化的脚手架：日期还是 {{INIT_DATE}} 占位符。
            #    这**不是**日期写坏 —— 占位符由第 2 项专管，这里跳过，
            #    否则原样脚手架会从"只红 1 项"变成"红 2 项"，破坏基线约定。
            if PLACEHOLDER_RE.search(raw_marker[1]):
                continue
            # ⚠️ 关键：**格式写坏必须报错**。否则"把日期改坏"反而变成通过，
            #    守护会奖励最糟的做法。
            unreadable.append(f'{r} 的「{raw_marker[0]}」后面不是 YYYY-MM-DD：'
                              f'{raw_marker[1]}')
            continue
        if not hit:
            continue                            # 没有日期标记的文件不算违规
        checked += 1
        doc_date, line = hit

        # 依赖哪些文件？① 显式写了「依据：a.md、b.md」② 否则按"同目录同源"= 本文件自己
        deps = [r]
        mb = basis_rx.search(line)
        if mb:
            named = [x.strip() for x in re.split(r'[、,，/]', mb.group(1)) if x.strip()]
            found = []
            for n in named:
                cand = [P(*n.split('/')), os.path.join(os.path.dirname(f), n)]
                c = next((x for x in cand if os.path.exists(x)), None)
                if c:
                    found.append(os.path.relpath(c, ROOT).replace(os.sep, '/'))
                else:
                    unreadable.append(f'{r} 的「依据」指向不存在的 {n}')
            deps = found or deps

        gd, err = git_last_commit_date(deps)
        if err:
            unreadable.append(f'{r}: {err}')
            continue
        if not gd:
            continue                            # 该文件还没入过库，没法比
        if gd > doc_date:
            behind.append(f'{r} 写着 {doc_date}，但依据的文件 {gd} 又改过'
                          f'（依据: {", ".join(deps)}）')

    if unreadable:
        return 'bad', '；'.join(unreadable[:4]), []
    if behind:
        return 'warn', ('这些文件的「最后核对」落后了（改完记得复核并改日期）: '
                        + '；'.join(behind[:5])
                        + (' …' if len(behind) > 5 else '')), []
    if not checked:
        return 'skip', '（没有文件写「最后核对」日期，跳过）', []
    return 'ok', f'（核对过 {checked} 份）', []


def main():
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

    files = all_md()
    ok = []

    # ── 1. 根目录必备文件 ──────────────────────────────
    miss = [r for r in CONFIG['required_files']
            if not os.path.exists(P(*r.split('/')))]
    ok.append(("根目录必备文件齐全", not miss, f"缺: {miss}" if miss else ''))

    # ── 2. 占位符是否已全部替换 ────────────────────────
    #  脚手架拷到新项目后，{{PROJECT_NAME}} 这类必须换成真名。
    #  漏替换 = 生成的文档全是"某项目"，读的人不知道这是哪。
    #  只查 CONFIG['placeholder_files']，避免误伤说明文档里对占位符的讲解。
    leftover = []
    ph_files = list(CONFIG['placeholder_files'])
    dd = CONFIG.get('data_dir')
    if dd:
        ph_files.append(f"{dd}/字段说明.md")   # 与 {{DATA_DIR}} 共用一处配置

    for relp in ph_files:
        p = P(*relp.split('/'))
        if not os.path.exists(p):
            continue
        for i, line in enumerate(read(p).split('\n'), 1):
            # 只豁免「讲解占位符本身」的行：**反引号包住占位符** + 说明性字眼。
            # 旧版只判「含『替换』」就整行跳过 —— 实测会让
            # 「替换后生效 {{PROJECT_NAME}}」这种真残留漏掉（假阴性）。
            if re.search(r'`\{\{[A-Z0-9_]+\}\}`', line) and (
                    '占位符' in line or '替换' in line or '示例' in line):
                continue
            for m in PLACEHOLDER_RE.finditer(line):
                leftover.append(f"{relp}:{i} {m.group(0)}")
    ok.append(("占位符已全部替换", not leftover,
               ("残留: " + "; ".join(leftover[:6])
                + (" …" if len(leftover) > 6 else '')) if leftover else ''))

    # ── 3. 文档里引用的 .md 是否真实存在 ──────────────
    #  跳过历史区：它们的定义就是「不可变」，让它们参与
    #  「引用必须可解析」的判定与「不可变」自相矛盾。
    HISTORICAL = tuple(P(*d.split('/')) + os.sep for d in CONFIG['historical_dirs'])
    bad_ref = []
    exempt_names = set(CONFIG.get('ref_exempt_names', ()))
    # 裸文件名要靠「全仓唯一」才敢放过，先数一遍
    base_count = {}
    for f in files:
        b = os.path.basename(f)
        base_count[b] = base_count.get(b, 0) + 1

    for f in files:
        if f.startswith(HISTORICAL):
            continue
        for m in re.finditer(r'`([^`\n]+?\.md)`', read(f)):
            ref = m.group(1).strip()
            if (ref.startswith('http') or ref.startswith('~')
                    or ref.startswith('$')
                    or any(t in ref for t in TEMPLATE_MARKERS)):
                continue
            r = ref.replace('/', os.sep)
            # 平台约定的格式名（SKILL.md / DETAIL.md …）且仓库里没有同名文件
            # → 那是"说明"，不是引用。真存在的同名文件仍照常检查。
            if (exempt_names and os.path.basename(r) in exempt_names
                    and base_count.get(os.path.basename(r), 0) == 0):
                continue
            cands = [os.path.join(ROOT, r),
                     os.path.join(os.path.dirname(f), r)]
            if any(os.path.exists(c) for c in cands):
                continue
            if os.sep in r:
                # 带目录的引用：允许省掉仓库根前缀（`design/x.md` 指向
                # `Docs/design/x.md`），但**整段路径必须对得上** ——
                # 旧版的「全仓 basename 兜底」会让 `Docs/x/AGENTS.md`
                # 因为根目录有 AGENTS.md 而假通过。
                tail = os.sep + r
                if any(os.path.abspath(g).endswith(tail) for g in files):
                    continue
            elif base_count.get(r) == 1:
                # 裸文件名：只有全仓唯一时才放过。同名文件会互相顶替 ——
                # 那正是悬空引用最容易被漏掉的形态。
                continue
            bad_ref.append(f"{rel(f)} → {ref}")
    ok.append(("引用的 .md 均真实存在", not bad_ref,
               ("悬空引用: " + "; ".join(bad_ref[:6])
                + (" …" if len(bad_ref) > 6 else '')) if bad_ref else ''))

    # ── 4. Docs/ 下的文档是否都在 INDEX.md 登记 ────────
    #  ⚠️ 历史区**不登记**，而且这是规则、不是豁免：
    #    · devlog/ 是流水（每任务新增一份，永远追加）→ 进索引会让索引天天变
    #    · archive/ 是归档（只进不出，不属于"现有文档"）
    #    两者都有明确的"怎么找"的约定（devlog 取日期最大的那份），不需要索引。
    #    所以 DOCS_LAYOUT 写的是「不进 INDEX」，这里也必须跳过 —— 否则
    #    「照协议收一次尾 = 保证报红一次」，协议自己打自己。
    idx_path = P(*CONFIG['index_file'].split('/'))
    unlisted = []
    if os.path.exists(idx_path):
        idx = read(idx_path)
        docs = [f for f in glob.glob(P('Docs', '**', '*.md'), recursive=True)
                if os.path.basename(f) != 'INDEX.md'
                and not f.startswith(HISTORICAL)]
        # 同名计数：`README.md` 只有一份时，INDEX 里写裸名也算登记；
        # 一旦出现第二份同名文档，就必须写带目录的形式（`tech/README.md`）——
        # 否则两份共用一个裸名互相顶替，是漏登记最隐蔽的形态（实测过）。
        subs = {}
        for f in docs:
            b = os.path.basename(f)
            subs[b] = subs.get(b, 0) + 1

        for f in docs:
            base = os.path.basename(f)
            sub = os.path.relpath(f, P('Docs')).replace(os.sep, '/')
            forms = [sub, 'Docs/' + sub]
            if subs.get(base) == 1:
                forms.append(base)
            if not any(x in idx for x in forms):
                unlisted.append(rel(f))
        ok.append(("Docs/ 文档均已在 INDEX.md 登记", not unlisted,
                   f"未登记: {unlisted}" if unlisted else ''))
    else:
        ok.append(("Docs/ 文档均已在 INDEX.md 登记", False,
                   f"缺 {CONFIG['index_file']}"))

    # ── 5. 引用的技能是否真实存在 ──────────────────────
    #  判据不是「目录在不在」，而是「**这套技能装没装**」：
    #    · 文档引用的一批技能，一个都不存在 → 视为**未安装** → 跳过（架子要能独立存活）
    #    · 存在一部分 → **装漏了** → 报红（这才是真错）
    #    · 全部存在 → 通过
    #  ⚠️ 不能只判"目录是否存在"：用户级技能目录通常在、但里面未必装了这套 ——
    #    那种情况属于"没装"，不该红成"坏了"。
    found_dirs, missing_dirs = resolve_skill_dirs()
    skills = skill_names(found_dirs)
    empties = skill_empties(found_dirs)
    prefix = CONFIG['skill_prefix']
    aliases = CONFIG.get('skill_aliases', {})
    pat_sk = re.compile(r'`(' + re.escape(prefix) + r'[a-z0-9-]+)`')

    referenced = set()
    for f in files:
        for m in pat_sk.finditer(read(f)):
            referenced.add(m.group(1))

    empty_note = ''
    if empties:
        empty_note = ("（空目录，DSH 不认: "
                      + ", ".join(f"{rel(d)}/{n}" for d, n in empties[:4])
                      + (" …" if len(empties) > 4 else "") + "）")

    if not referenced:
        ok.append(("引用的技能均存在", None, "文档里没有技能引用，已跳过"))
    elif not found_dirs:
        ok.append(("引用的技能均存在", None,
                   "未找到技能目录，视为未安装并跳过（查过: "
                   + ", ".join(rel(d) for d in missing_dirs) + "）"))
    elif not (referenced & skills):
        ok.append(("引用的技能均存在", None,
                   f"技能目录里没有这套技能，视为未安装并跳过"
                   f"（查过: {', '.join(rel(d) for d in found_dirs)}）"
                   + empty_note))
    else:
        bad_sk = {n for n in referenced if n not in skills and n not in aliases}
        note = empty_note
        if len(found_dirs) == 1 and len(missing_dirs) > 0:
            note += (f"（只查到 {rel(found_dirs[0])}；另 "
                     f"{len(missing_dirs)} 处不存在）")
        ok.append(("引用的技能均存在", not bad_sk,
                   (f"装了但缺这几个: {sorted(bad_sk)}{note}" if bad_sk
                    else note)))

    # ── 6. 文档引用到的技能，都必须在 DOCS_LAYOUT §⑨ 登记 ──
    #  ⚠️ 判据是「**被文档引用的**技能」，不是「技能目录里的所有技能」。
    #     用户级技能目录是跨项目的（可能装了三十几个不相干的），
    #     要求每份 DOCS_LAYOUT 都把它们的名字抄一遍，是荒谬的 —— 
    #     §⑨ 的用途是「本项目用到哪些流程」，只该收本项目的。
    layout_p = P(*CONFIG['layout_file'].split('/'))
    layout_txt = read(layout_p) if os.path.exists(layout_p) else ''
    m9 = re.search(r'### ⑨ 技能(.*?)(?=\n### |\n## )', layout_txt, re.S)
    sec9 = m9.group(1) if m9 else ''

    #  （`referenced` 已在第 5 项算好，这里直接复用）
    if not referenced:
        ok.append(("文档引用的技能均已在 §⑨ 登记", None, "无技能引用，已跳过"))
    elif not sec9:
        ok.append(("文档引用的技能均已在 §⑨ 登记", False,
                   "DOCS_LAYOUT 里找不到 §⑨ 技能节"))
    else:
        unreg = [s for s in sorted(referenced) if s not in sec9]
        ok.append(("文档引用的技能均已在 §⑨ 登记", not unreg,
                   f"引用了但未登记: {unreg}" if unreg else ''))

    # ── 7. 职责违规扫描（启发式） ──────────────────────
    viol = []
    for fname, pat, why in CONFIG['role_rules']:
        p = P(*fname.split('/'))
        if not os.path.exists(p):
            continue
        rx = re.compile(pat)
        for i, line in enumerate(read(p).split('\n'), 1):
            # 指针句豁免：「想知道 X → 见 Y」是在指路，不是在写状态
            if '→' in line or '详见' in line or '见 `' in line:
                continue
            # 否定句豁免：「本文件绝不写当前进度」是禁令，不是违规
            if any(w in line for w in ('绝不', '不该', '不写', '禁止',
                                       '别写', '不要写', '不许写')):
                continue
            if rx.search(line):
                viol.append(f"{fname}:{i} {why}")
    ok.append(("职责边界无越界（启发式）", not viol,
               ("; ".join(viol[:6]) + (" …" if len(viol) > 6 else '')) if viol else ''))

    # ── 8. 硬契约唯一真源 ──────────────────────────────
    #  三项守护：① 在仓库根且关键锚点齐全 ② 指针文本 ≤ 限额
    #  ③ 老路径只剩占位（有人把正文写回去，这里当场报红）
    agents = P(*CONFIG['contract_file'].split('/'))
    a_prob = []
    anchors = ('【开工必读】', '【技能】', '【红线】', '【协作】',
               '## WorkBuddy 配置栏指针文本')
    if not os.path.exists(agents):
        a_prob.append(f'{CONFIG["contract_file"]} 不在仓库根')
    else:
        atxt = read(agents)
        a_prob += [f'缺锚点 {a}' for a in anchors if a not in atxt]
        m_ptr = re.search(
            r'## WorkBuddy 配置栏指针文本.*?```text\n(.*?)\n```', atxt, re.S)
        if not m_ptr:
            a_prob.append('找不到配置栏指针文本的 ```text 块')
        elif len(m_ptr.group(1)) > CONFIG['pointer_max_chars']:
            a_prob.append(f'指针文本 {len(m_ptr.group(1))} 字符'
                          f' > {CONFIG["pointer_max_chars"]}')
    stub_rel = CONFIG.get('contract_stub')
    if stub_rel:
        stub = P(*stub_rel.split('/'))
        if os.path.exists(stub):
            sz = os.path.getsize(stub)
            if sz >= CONFIG['stub_max_bytes']:
                a_prob.append(f'老路径 {sz} B ≥ {CONFIG["stub_max_bytes"]}'
                              f' —— 正文可能又被写回去了')
    ok.append(("硬契约在仓库根且为单源", not a_prob, '; '.join(a_prob)))

    # ── 9. DOCS_LAYOUT 是否覆盖根目录全部 .md ──────────
    not_covered = []
    if os.path.exists(layout_p):
        for f in glob.glob(P('*.md')):
            if os.path.basename(f) not in layout_txt:
                not_covered.append(os.path.basename(f))
    ok.append(("DOCS_LAYOUT 覆盖根目录所有 .md",
               not not_covered,
               f"未提及: {not_covered}" if not_covered else ''))

    # ── 10. 单文件体积上限（守长文档膨胀） ─────────────
    big = []
    limit = CONFIG['max_file_kb'] * 1024
    exempt = set(CONFIG.get('large_file_exempt', []))
    for f in files:
        r = rel(f)
        if r in exempt or r.startswith(HISTORICAL):
            continue
        sz = os.path.getsize(f)
        if sz > limit:
            big.append(f"{r} {sz // 1024}KB")
    ok.append((f"无异常膨胀文档（< {CONFIG['max_file_kb']}KB）", not big,
               f"超限: {big}" if big else ''))

    # ── 11. ARCHITECTURE 是否覆盖全部源文件 ────────────
    arch = P('ARCHITECTURE.md')
    src_dirs = CONFIG.get('source_dirs') or []
    if src_dirs:
        if not os.path.exists(arch):
            ok.append(("ARCHITECTURE 覆盖全部源文件", False, "缺 ARCHITECTURE.md"))
        else:
            atxt = read(arch)
            exts = tuple(CONFIG['source_exts'])
            excl = tuple(CONFIG.get('source_exclude', ()))
            src_files = []
            for d in src_dirs:
                dd = P(*d.split('/'))
                if not os.path.isdir(dd):
                    continue
                src_files += [f for f in os.listdir(dd)
                              if f.endswith(exts) and not any(e in f for e in excl)]
            # 归属：文件名或其基名在架构文档里出现过即可
            # （成对 .h/.cpp 时文档一般只写基名，判据必须宽松）
            miss_src = [f for f in sorted(src_files)
                        if f not in atxt and os.path.splitext(f)[0] not in atxt]
            ok.append(("ARCHITECTURE 覆盖全部源文件", not miss_src,
                       f"未提及: {miss_src}" if miss_src else ''))
    else:
        ok.append(("ARCHITECTURE 覆盖全部源文件", True, "（未配置 source_dirs，跳过）"))

    # ── 12. ARCHITECTURE 与 DOCS_LAYOUT 分工不重叠 ────
    #  判据：架构文档必须显式声明「文档归属去 DOCS_LAYOUT」，避免双源
    if os.path.exists(arch):
        atxt = read(arch)
        has_pointer = (CONFIG['layout_file'] in atxt
                       and ('不管' in atxt or '不重复' in atxt))
        ok.append(("ARCHITECTURE 显式指向 DOCS_LAYOUT（无双源）", has_pointer,
                   "架构文档未声明「文档归属见 DOCS_LAYOUT.md」" if not has_pointer else ''))
    else:
        ok.append(("ARCHITECTURE 显式指向 DOCS_LAYOUT（无双源）", False,
                   "缺 ARCHITECTURE.md"))

    # ── 13. 插件是否在架构文档有记录 ───────────────────
    plug_rel = CONFIG.get('plugin_dir')
    if plug_rel:
        plug_dir = P(*plug_rel.split('/'))
        if os.path.exists(arch):
            atxt = read(arch)
            miss_plug = []
            if os.path.isdir(plug_dir):
                for p in sorted(os.listdir(plug_dir)):
                    if not os.path.isdir(os.path.join(plug_dir, p)):
                        continue
                    names = {p}
                    for up in glob.glob(os.path.join(plug_dir, p, '*.uplugin')):
                        m = re.search(r'"FriendlyName"\s*:\s*"([^"]+)"', read(up))
                        if m:
                            names.add(m.group(1).strip())
                    if not any(n and n in atxt for n in names):
                        miss_plug.append(p)
            ok.append(("ARCHITECTURE 记录了全部插件", not miss_plug,
                       f"未提及: {miss_plug}" if miss_plug else ''))
        else:
            ok.append(("ARCHITECTURE 记录了全部插件", False, "缺 ARCHITECTURE.md"))
    else:
        ok.append(("ARCHITECTURE 记录了全部插件", True, "（未配置 plugin_dir，跳过）"))

    # ── 14. 收尾协议是否覆盖项目进度落点 ──────────────
    #  三态：技能没装 → 跳过；装了但那份技能里没提 PROJECT_PROGRESS → 报红。
    #  （旧版这里会把"文件没找到"报成"没提 PROJECT_PROGRESS"，是误导 —— 已修）
    cs = CONFIG.get('closeout_skill')
    must = CONFIG.get('closeout_must_mention', 'PROJECT_PROGRESS.md')
    if not cs:
        ok.append(("收尾协议已覆盖项目进度落点", None, "（未配置 closeout_skill，跳过）"))
    elif not found_dirs:
        ok.append((f"收尾协议已覆盖「{must}」落点", None,
                   f"技能目录未找到，无法检查 {cs}（跳过）"))
    else:
        flow = None
        for sd in found_dirs:
            cand = os.path.join(sd, cs, 'SKILL.md')
            if os.path.exists(cand):
                flow = cand
                break
        if flow is None:
            # 区分两种情况，别用一句话糊过去：
            #   ① 这套技能一个都没装 → 未安装，跳过（可选件）
            #   ② 装了这套的一部分，但缺 closeout_skill → 装漏了，报红
            #      （空目录也算"装漏"：目录在、SKILL.md 没了，DSH 加载不到）
            installed_any = bool(referenced & (skills | {n for _, n in empties}))
            ok.append((f"收尾协议已覆盖「{must}」落点",
                       False if installed_any else None,
                       (f"装了这套技能但缺 {cs}" if installed_any
                        else f"未安装 {cs}（视为未安装，跳过）")))
        else:
            good = must in read(flow)
            ok.append((f"收尾协议已覆盖「{must}」落点", good,
                       f"{rel(flow)} 里没提 {must}" if not good else ''))

    # ── 15. 「最后核对」日期没落后于依据文件 ──────────
    #  四态：✅ 通过 / ⚠️ 提示（落后，不算失败）/ ⏭️ 跳过（无 git）/ ❌ 写错了
    #  ⚠️ 用 'warn' 标在 detail 前缀上，而不是塞进 ok 的 False ——
    #     "落后"不等于"体系坏了"，不该和真错误混在一起红。
    if not has_git():
        ok.append(("「最后核对」未落后于依据文件", None,
                   "（不是 git 仓库或还没有提交，无法比较，跳过）"))
    else:
        st, note, _ = date_guard()
        if st == 'skip':
            ok.append(("「最后核对」未落后于依据文件", None, note))
        elif st == 'bad':
            ok.append(("「最后核对」未落后于依据文件", False, note))
        elif st == 'warn':
            ok.append(("「最后核对」未落后于依据文件", 'warn', note))
        else:
            ok.append(("「最后核对」未落后于依据文件", True, note))

    # ── 16. 任务账格式合法（第 5 轮新增）───────────────
    #  守两件事：账行 id 形如 t-YYYYMMDD-NN 且不重复；状态只有四值。
    #  ⚠️ 刻意**不**守「id 必须有同名 devlog」：模板未初始化时示例行必然没有 devlog，
    #     会让「只红占位符一项」这个已知预期失效；且 devlog 会随 git mv 归档，误报率高。
    #     宁可只守格式与唯一性 —— 这两条才是真会腐坏的地方。
    _prog = P('PROJECT_PROGRESS.md')
    if not os.path.exists(_prog):
        ok.append(("任务账格式合法", None, "（无 PROJECT_PROGRESS.md，跳过）"))
    else:
        _rows, _bad, _seen = [], [], set()
        for _ln in read(_prog).splitlines():
            _m = re.match(r'^\|\s*`([^`]+)`\s*\|', _ln)
            if not _m:
                continue
            _cells = [c.strip().strip('`') for c in _ln.strip().strip('|').split('|')]
            # 只认「六列账行」：首格反引号 + 至少六列。
            # ⚠️ 不能靠「id 以 t- 开头」来认 —— 那样 task-1 这种坏 id 会整行漏检，
            #    正是假阴性：格式错了反而不报红。
            if len(_cells) < 6:
                continue
            _rid = _m.group(1)
            _rows.append(_rid)
            if not re.fullmatch(r't-\d{8}-\d{2}', _rid):
                _bad.append(f"{_rid}（格式应为 t-YYYYMMDD-NN）")
            if _rid in _seen:
                _bad.append(f"{_rid}（重复）")
            _seen.add(_rid)
            if len(_cells) >= 3 and _cells[2] not in ('done', 'doing', 'blocked', 'dropped'):
                _bad.append(f"{_rid} 状态={_cells[2]!r}（只许 done/doing/blocked/dropped）")
        ok.append(("任务账格式合法", not _bad,
                   '; '.join(_bad) if _bad else f"（{len(_rows)} 条账行）"))

    # ── 输出 ──────────────────────────────────────────
    print("=" * 62)
    print(" 文档结构自检")
    print("=" * 62)
    marks = {True: "✅", False: "❌", None: "⏭️ ", 'warn': "⚠️ "}
    for name, good, detail in ok:
        print(f"  {marks.get(good, '?')} {name}")
        if good is not True and detail:
            print(f"      └─ {detail}")

    passed = sum(1 for _, g, _ in ok if g is True)
    warned = sum(1 for _, g, _ in ok if g == 'warn')
    skipped = sum(1 for _, g, _ in ok if g is None)
    total = len(ok) - skipped
    print()
    print(f"扫描文档: {len(files)} 份")
    print(f"检查项  : {passed}/{total} 通过"
          + (f"（{skipped} 项跳过）" if skipped else "")
          + (f"（{warned} 项提示）" if warned else ""))
    # ⚠️ 必须判 `is False` —— `not None` 为 True，跳过项会被误算成失败；
    #    'warn' 也不是失败，只是提示。
    broken = [n for n, g, _ in ok if g is False]
    if broken:
        print("未通过  : " + " · ".join(broken))
        print("总检: ❌ 有 %d 项未通过" % len(broken))
    else:
        print("总检: ✅ 全部通过，文档体系自洽")
    return 0 if not broken else 1


if __name__ == '__main__':
    sys.exit(main())
