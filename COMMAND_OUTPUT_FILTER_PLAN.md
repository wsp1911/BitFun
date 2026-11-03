# 命令输出过滤/压缩方案

## 决策

新增一个默认关闭的、纯本地确定性命令输出过滤能力。它只处理已执行完成的 `ExecCommand` 输出，不依赖模型、云服务、远程 hooks 或目标工作区安装的 helper。

过滤器在 OpenBitFun Agent Runtime 的工具结果管线中运行。命令可以在本机、SSH 主机、Docker 容器或 WSL 中执行，stdout/stderr 回到 Runtime 后统一处理，因此不受当前 native hooks 仅支持本地 workspace 的限制。

实现优先采用 `lean-ctx-patterns` 作为确定性 pattern backend，并在 OpenBitFun 内包一层适配器；它是 Apache-2.0、纯 Rust、没有模型和网络调用。Tokenade 不作为整体依赖，因为 `tokenade-core` 会牵引文档、PDF、SQLite、QuickJS、tree-sitter 等大量不属于本需求的能力；Tokenade 的远程内层命令解析作为后续实现参考。Caveman 是 Go 项目，没有适合直接链接的 Rust crate，终端压缩算法作为补充移植来源。

依赖接入必须先通过许可证、依赖规模和输出兼容性 spike。若 `lean-ctx-patterns` 的发布包或其传递依赖不能满足商用许可、构建成本或 OpenBitFun 的输出/恢复契约，则退回到同一接口下的内部 Rust 实现；业务管线不依赖第三方 API 细节。

## 范围

### 包含

- `ExecCommand` 的非交互、非流式、已完成输出。
- stdout/stderr 的文本压缩和 ANSI 噪声清理。
- 基于命令名和子命令的确定性规则选择。
- 构建、测试、包管理器、日志和资源列表等重复性输出的压缩。
- 本地和所有现有 remote workspace 执行路径。
- 全局开关，默认值为关闭；开启后对后续工具调用生效。
- 原始结果保留，模型只接收压缩后的 `result_for_assistant`。

### 不包含

- 基于任务描述的模型语义抽取（Squeez 类能力）。
- 任何网络请求、embedding、LLM、vLLM、OpenAI-compatible 服务或 Edgee gateway。
- Read、Grep、Glob、Web、MCP、插件结果的压缩。
- 修改用户实际执行的命令或命令副作用。
- 交互式终端和实时流式输出。
- 默认启用或自动迁移既有 session 的历史内容。

## 许可证和依赖策略

实现目标是 OpenBitFun 现有 MIT 许可边界内的可自由商用代码。

- 不引入 RTK 默认构建中的 `rtk-engine`，因为它是 BUSL-1.1。
- 不引入 Edgee gateway；其压缩实现不在 Apache-2.0 CLI 仓库中。
- 不引入 Squeez 的 Python、Torch、Transformers 或模型下载链路。
- 可以增加 `lean-ctx-patterns` 这个窄依赖，但不能把 LeanCTX 主引擎、SDK、`ee` 或其他混合许可目录带入 OpenBitFun。
- Tokenade 的仓库声明 MIT OR Apache-2.0，但 `tokenade-core` 依赖图和功能面过大；不作为生产依赖。若只提取其命令解析代码，保留 MIT/Apache 版权并单独登记来源。
- Caveman 当前版本为 Apache-2.0，但 Go FFI 或外部 binary 会增加三平台分发、取消和 remote workspace 部署成本；不作为生产依赖。
- 不引入 RTK 默认构建中的 `rtk-engine`，因为它是 BUSL-1.1；不引入 Edgee gateway，因为真正的压缩服务不在 Apache-2.0 CLI 仓库中。
- 不引入 Squeez 的 Python、Torch、Transformers、模型下载或 OpenAI-compatible 服务链路。
- 依赖 spike 通过后，新增依赖统一放在 workspace dependency 表，使用精确版本并更新 `THIRD_PARTY_NOTICES.md`；不把依赖版本散落到成员 Cargo.toml。
- 许可证允许自由商用的候选范围为 MIT、Apache-2.0、BSD、ISC、Zlib 等；必须同时审计传递依赖，不能只看顶层 crate 的许可证。

## 配置契约

建议在 `GlobalConfig.ai` 下增加一个兼容性字段：

```json
{
  "ai": {
    "command_output_filter": {
      "enabled": false
    }
  }
}
```

Rust 侧使用 `#[serde(default)]`，旧配置没有字段时等价于 `enabled = false`。默认值应省略序列化，避免所有用户配置产生无意义的 diff。第一版只保留 `enabled`，不要提前加入多个策略档位或硬编码 token 预算。

配置解析由 `config-contracts` 负责，Core 将其映射成 provider-neutral 的过滤策略传给工具管线。若增加设置界面，需要同时更新配置 owner、语义目录、生成投影、localization、读写回读测试和旧配置反序列化测试。

前端接线位置为 `src/web-ui/src/infrastructure/config/types/index.ts`、`settingsDataPreload.ts` 和 `settings/pages/ai/ExecutionSettingsPage.tsx`。设置放在 AI Execution 页面，以一个默认关闭的 Switch 呈现；描述只说明“压缩命令输出以减少模型上下文”，不暴露实现项目名称。设置变更只影响后续工具调用，不重写历史 transcript。

## 模块归属

### `tool-runtime`

在 `src/crates/execution/tool-execution` 中新增纯模块 `command_output_filter`，只依赖输入事实和显式策略，不读取配置文件、不访问 workspace、不创建进程、不认识 Tauri 或远程连接。模块内部通过 `lean-ctx-patterns` adapter 调用 pattern backend；上层永远只依赖 OpenBitFun 自己的接口。

`tool-runtime` 新增可选 Cargo feature `command-output-filter`，仅负责把 Apache-2.0 pattern backend 编译进目标产品；运行时 `enabled` 仍由配置决定。`openbitfun-core` 增加同名 capability feature，并由 `agent-runtime`/`product-full` 显式选择。这样 CLI、Desktop、Server 使用同一实现，窄构建仍可选择不带该能力。

建议的纯接口形状：

```rust
pub struct CommandOutputFilterInput<'a> {
    pub command: &'a str,
    /// ExecCommand's decoded stdout/stderr presentation. The current tool
    /// contract exposes them as one `fields.output` string.
    pub output: &'a str,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
}

pub struct CommandOutputFilterResult {
    pub output: String,
    pub changed: bool,
    pub original_chars: usize,
    pub filtered_chars: usize,
    pub rule_id: Option<&'static str>,
}

pub fn filter(input: CommandOutputFilterInput<'_>) -> Option<CommandOutputFilterResult>;
```

`None` 表示不适用或应透传。过滤器不得因为识别失败而阻断工具调用。

adapter 的最小调用顺序为：

1. 归一化顶层命令和安全包装器；
2. 用 `lean_ctx_patterns::ansi::strip_ansi` 得到 clean output，同时保留 raw output 供长度和恢复判断；
3. 用 `lean_ctx_patterns::compress_clean(&NoEnv, command, clean, raw)` 选择专用 pattern；
4. 将 LeanCTX 的 `[lean-ctx: ... raw=true]` 标记改成 OpenBitFun 的“完整结果在工具详情/既有 artifact 中”语义，不能把不存在的 `raw=true` 指令交给模型；
5. 在 OpenBitFun 自己的 protected-line、never-grow、UTF-8、幂等和命令 allowlist 规则下再次校验，失败则透传。

不得让 LeanCTX 的 `PatternEnv` 读取 OpenBitFun 配置或 workspace；第一版使用 `NoEnv`。后续需要 URL passthrough 或用户过滤时，在 OpenBitFun adapter 外层实现，不向第三方 crate 注入产品状态。

### `openbitfun-core`

在 `ToolPipeline` 中将已解析配置转换成过滤策略，并在工具已经完成后调用纯过滤器。Core 仍拥有工具结果、权限、session 和持久化的业务编排。

`ExecCommand` 已经有结构化的 `result["output"]`、`exit_code`、`completion`、`tty`、`remote` 和 `original_output_chars` 字段。过滤器应读取这些字段，而不是解析模型可见的 `<status>/<output>` 文本。过滤完成后由 `tool-runtime::exec_command` 的 renderer 重新生成相同的状态/耗时 envelope，只替换 `<output>` 内容；无法识别结构化结果时直接跳过。

### 结果管线位置

现有路径是：

```text
execute_with_retry
  -> OpenCode after hook
  -> maybe_persist_large_tool_result_for_tool
  -> repair notice
  -> native PostToolUse append-only hook
```

建议改为：

```text
execute_with_retry
  -> OpenCode after hook
  -> raw-result persistence decision
  -> command output filter on canonical ExecCommand output
  -> visible-result projection with existing artifact reference
  -> repair notice
  -> native PostToolUse append-only hook
```

过滤器应位于 OpenCode after hook 之后，使现有插件仍能看到完整的模型可见输出；但 raw-result persistence decision 必须先基于规范 `result` 判断，并保留 full-output artifact handle。这样过滤器可以读取规范的 `result["output"]`，而不会从已经被 storage preview 替换的 `result_for_assistant` 反推原文。

实现时必须修正大结果存储的判断：过滤后的 `result_for_assistant` 不能掩盖规范原始结果大小。建议让 storage 返回一个不改变 raw `result` 的 `PersistedToolOutput`/reference，再由最终 visible projection 附加现有 full-output reference。对于小结果，原始 `result` 继续内联保存；对于大结果，沿用现有 artifact 和恢复入口。不得把 LeanCTX 的 `raw=true` 文案直接当成 OpenBitFun 恢复协议。

## 过滤流程

1. 只接受非流式、已完成、UTF-8 文本输出。空输出、二进制、交互式和实时流式结果直接透传。
2. 对命令做不执行的安全归一化：识别环境变量前缀、`env`、`sudo`、`timeout`、shell `-lc` 等包装器和顶层程序/子命令。不得通过 shell 重解析或重新执行命令。
3. 先匹配专用规则，再匹配通用终端规则；未匹配时透传。
4. 保护错误、失败、警告、traceback、编译位置、非零退出信息和明显的测试失败行。
5. 压缩后必须严格短于原文才替换；压缩器异常、结果变长或无法判断时 fail-open。
6. 过滤器保持幂等：对已经带有过滤标记的文本再次处理不得继续折叠。
7. 日志只记录 rule id、原始/过滤长度和耗时，不记录命令输出内容或 secret。

## 第一版规则范围

优先实现低风险、重复性强的结果：

- Git：`status`、`log`、`diff --stat`、`diff --name-only`；完整 patch 默认透传。
- Rust：`cargo check`、`cargo test`、`cargo build`、`cargo clippy` 的重复编译/成功摘要。
- Node：`npm`、`pnpm`、`yarn` 的 install/build/test 成功噪声。
- Python：pytest 的收集、通过用例和重复 traceback 外围信息；失败详情完整保留。
- 容器/集群：`docker ps/images/logs`、`kubectl get/logs/describe` 的重复表格或成功摘要。
- 通用终端：ANSI 控制序列、进度条重绘、连续重复行、普通日志中的冗余中间段。

第一版暂不压缩 `cat`、`sed`、`awk`、`jq`、`curl`、完整 `git diff`、源码搜索结果和未知 shell 管道。这些输出更可能是模型后续编辑或判断所需的原始证据。

SSH、`docker exec`、`docker compose exec`、`kubectl exec` 的内层命令解析作为第二阶段扩展。第一版即使识别不到内层命令，也仍可使用通用终端压缩，不得修改远程命令。

## Remote workspace 行为

OpenBitFun 的 Runtime 仍在选定的 OpenBitFun 主机上，SSH、Docker、WSL 只负责目标工作区的进程 I/O。过滤器消费 Runtime 已收到的文本，因此：

- 不需要在远程主机安装 OpenBitFun、RTK 或过滤器二进制；
- 不依赖本地 workspace hook 文件；
- 不会把 controller 本地路径或本地输出混入远程结果；
- 移动端、Remote Connect、Peer Device 和 Detached Dispatch 继续通过已有 Runtime 结果路径获得压缩后的模型可见文本；
- 交互式 PTY 和流式命令保持现有实时行为，第一版不做压缩。

需要特别覆盖 SSH、远程 Docker、WSL 三种非交互 `ExecCommand` 路径。过滤器的规则只读命令字符串和结果，不使用 host path 语义。

## 可观测性和恢复

模型看到的是压缩投影，规范工具结果仍保留原始 stdout/stderr、exit code、working directory 和现有 metadata。第一版不新增模型可见的长恢复 URL；UI 继续沿用现有工具详情和大结果 artifact 展示。

每次实际压缩可产生内部统计：rule id、原始字符数、过滤字符数、是否保留错误行、耗时。统计应进入现有 DFX/diagnostic 路径，不把原文写入日志。默认关闭时不运行分类和压缩逻辑，避免引入额外开销。

## 分阶段实现

### Phase 0：依赖和输出契约 spike

这一阶段只验证，不进入产品行为。

1. 在独立临时分支中以精确版本加入 `lean-ctx-patterns = "=0.1.0"`，不要先使用 git 依赖。
2. 用 `cargo metadata --locked` 和现有依赖审计检查顶层及传递依赖的 SPDX 许可、构建脚本、系统库和默认 features。
3. 编写一个临时 adapter，比较 LeanCTX pattern 输出与 OpenBitFun 的 `ExecCommand` 结果模型，重点验证 ANSI、Git、Cargo、npm、pytest、Docker、Kubernetes 和错误输出。
4. 验证 crate 不会下载模型、不创建网络请求、不需要 C/C++ 工具链，并记录新增编译时间、二进制体积和运行耗时。
5. 验证 marker 替换、protected lines、never-grow、幂等和 `NoEnv` 语义。
6. 若任一许可证、构建或输出契约不通过，删除依赖，保留 adapter 接口，移植经过审计的最小 pattern 子集。不得把 spike 代码留在产品依赖图中。

Spike 产物应包含依赖清单、许可证结论、输入/输出快照、体积/耗时基线和“采用依赖/内部实现”的明确决策。

### Phase 1：纯过滤器和 Core 接线

预期文件范围：

- `src/crates/execution/tool-execution/Cargo.toml`：增加可选 `command-output-filter` feature 和 `lean-ctx-patterns` 依赖。
- `src/crates/execution/tool-execution/src/command_output_filter.rs`：OpenBitFun 输入/输出契约、allowlist、protected-line、marker 和 adapter。
- `src/crates/execution/tool-execution/src/exec_command.rs`：增加结构化 output override renderer，保持现有 status/wall-time/completion 语义。
- `src/crates/execution/tool-execution/src/lib.rs`：导出模块。
- `src/crates/assembly/core/Cargo.toml`：传播 capability feature；不让依赖自动进入不需要工具执行的 crate。
- `src/crates/assembly/core/src/agentic/tools/pipeline/tool_pipeline.rs`：在 OpenCode after hook 后调用过滤器。
- `src/crates/assembly/core/src/agentic/tools/tool_result_storage.rs`：将原始结果大小判断与可见投影解耦。
- `src/crates/assembly/core/src/agentic/tools/implementations/exec_command/command.rs`：确认 raw `ExecCommand` result 和 renderer 之间的兼容性，并补充 command-level fixtures。

实施顺序：

1. 先实现 `ExecCommand` 结果提取和纯函数测试，不接配置。
2. 加入 LeanCTX adapter 和首批 allowlist；过滤器未启用时不得执行 pattern backend。
3. 调整工具结果持久化：storage 先用规范 raw result 判断是否需要 full-output artifact，并返回 reference；随后从结构化 `ExecCommand` raw output 生成压缩的 `result_for_assistant`；压缩投影不能让现有大结果保护失效。
4. 增加 `ExecCommand` visible renderer 的 output override，只重建既有 status/wall-time/output envelope，不修改 canonical `result`。
5. 保持 OpenCode after hook、repair notice 和 native PostToolUse 的既有顺序语义。native PostToolUse 仍只追加上下文，不能被当作压缩入口。
6. 为没有 `session_id`、无法保存 artifact 或结果不是文本的情况保持现有 fail-open 行为。

### Phase 2：配置、设置和产品装配

后端：

- `src/crates/contracts/config-contracts/src/types.rs` 增加 `CommandOutputFilterConfig`，默认 false，默认值省略序列化。
- 增加旧配置反序列化、新配置回读、未知字段保留和默认投影测试。
- Core 在创建/刷新 Runtime 或 ToolPipeline options 时读取配置，转换成不可变的 `CommandOutputFilterPolicy`。
- 将 capability 加入 Desktop、CLI、Server 的实际 agent-runtime/product-full 装配路径；不改变远程 workspace 的 capability 判断为“本地 hook”。

前端：

- `src/web-ui/src/infrastructure/config/types/index.ts` 增加 `AIConfig` 字段和 `ConfigPath`。
- `src/web-ui/src/app/scenes/settings/settingsDataPreload.ts` 将路径加入 `ai.execution`。
- `ExecutionSettingsPage.tsx` 增加 Switch、保存失败回滚和成功提示。
- 在 `settings/runtime` 的所有受支持 locale 增加同名 key；运行 `pnpm run i18n:generate` 和 `pnpm run i18n:audit`。
- 如果设置面向 Peer/Remote controller，确认配置读写通过现有 RemoteCommand/host owner；不能让 controller 本地直接改变远端文件。

### Phase 3：远程和结果持久化验收

1. 本机非交互 `ExecCommand`：验证压缩前后模型文本、原始结果和 tool detail。
2. SSH workspace：验证命令在目标机执行，过滤在 Runtime 主机执行，controller 不读取本地路径。
3. Remote Docker：验证 `docker exec` 的 stdout/stderr、取消、超时和错误退出码。
4. WSL workspace：验证 POSIX 命令输出和 Windows Runtime 上的文本解码边界。
5. 大输出：验证 raw artifact 仍创建，模型只看到压缩投影，full-output reference 仍可用。
6. 断线/恢复：验证已完成工具结果带着原始结果和可见投影进入 session replay，controller 重连不重新压缩或重复写 artifact。

### Phase 4：覆盖扩展和维护闭环

- 从 Tokenade 移植经过测试的 SSH、`docker exec`、`docker compose exec`、`kubectl exec --` 内层命令解析；只解析参数，不执行命令。
- 根据真实 session 样本增加规则，每条规则同时提交成功样例、失败样例、不得压缩样例和输出快照。
- 对 LeanCTX 依赖做定期版本升级评估；升级必须重新跑 snapshot、许可证审计、体积和耗时基线。
- 若第三方 pattern 输出与 OpenBitFun 恢复契约长期不一致，保留 `command_output_filter` 接口并替换 backend，不影响 Core 管线和配置。

## 实施任务拆分

### A. 依赖接入任务

- [ ] 锁定 `lean-ctx-patterns` 版本/来源 commit 和 Apache-2.0 文本。
- [ ] 生成 Cargo 传递依赖 SPDX 清单，确认没有模型权重、网络初始化、C/C++ build script 或不允许的许可证。
- [ ] 将许可和来源加入 `THIRD_PARTY_NOTICES.md`，记录 pattern engine 版本。
- [ ] 建立 snapshot fixture，固定第三方输出升级时的审查入口。

### B. 过滤器任务

- [ ] 定义 `ExecCommand` raw stdout/stderr 提取契约。
- [ ] 实现 command allowlist 和 wrapper 归一化。
- [ ] 接入 `lean-ctx-patterns`，替换不适合 OpenBitFun 的 marker。
- [ ] 实现 protected-line、never-grow、UTF-8、idempotence 和 fail-open。
- [ ] 输出 rule id、长度、耗时统计，不记录正文。

### C. 管线任务

- [ ] 在 `ToolPipeline` 的正确位置调用过滤器。
- [ ] 将过滤策略从全局配置注入每个 Runtime/ToolPipeline，而不是在工具实现中读取配置。
- [ ] 让大结果存储使用 raw result 计算资格，不被 `result_for_assistant` 覆盖。
- [ ] 维持 plugin/native hook 语义和已有 error/repair notice 顺序。

### D. 配置和产品任务

- [ ] 增加 `CommandOutputFilterConfig` 和兼容性测试。
- [ ] 接入 Desktop、CLI、Server 的 capability feature。
- [ ] 接入 Web UI Execution Settings 和所有 locale。
- [ ] 更新配置 owner registry、semantic catalog、generated projection 和读写回读测试。

### E. Remote/Upgrade 任务

- [ ] 覆盖本机、SSH、Remote Docker、WSL 的非交互执行。
- [ ] 验证 Peer Device/Remote Control/Detached Dispatch 不发生 controller-local fallback。
- [ ] 验证老版本读取新配置时忽略字段，新版本读取旧配置时默认关闭。
- [ ] 验证断线重连、session replay 和已保存 artifact 的幂等性。

### F. 质量和发布任务

- [ ] 运行 focused Rust tests、`pnpm run fmt:rs` 和 `pnpm run check:core-boundaries`。
- [ ] 运行 `pnpm run i18n:generate`、`pnpm run i18n:audit`（接入 UI 时）。
- [ ] 运行依赖许可证/漏洞审计和 `git diff --check`。
- [ ] 记录默认关闭、启用后收益、规则覆盖和已知透传范围。

## 验收标准

### 功能

- 默认配置和旧配置均不改变模型可见输出。
- 开启后，符合规则的 `ExecCommand` 输出变短；不符合规则的输出逐字节/逐字符透传。
- 命令实际执行字符串和副作用完全不变。
- 非零退出、错误、traceback、编译位置和失败测试仍可被模型看到。
- 过滤失败或输出变长时自动透传。
- 原始结果仍可从 session/tool detail 或既有大结果 artifact 获取。

### 远程

- 本机、SSH、远程 Docker、WSL 的非交互命令使用相同过滤规则。
- Controller 不执行过滤，也不读取 controller 本地文件系统。
- 交互式/流式命令不被延迟或改写。

### 兼容性

- 缺少配置字段的旧配置正常读取，默认关闭。
- 新配置可被旧代码忽略而不破坏启动或 session 读取。
- session transcript 同时保留规范原始结果和模型可见投影。

### 质量

- 纯函数测试覆盖归一化、规则选择、错误保护、幂等、不可增长、无效 UTF-8 透传和 secret 不写日志。
- Pipeline 测试覆盖过滤与 OpenCode after hook、large-result storage、native PostToolUse 的顺序。
- 远程 provider conformance fixture 覆盖 SSH/Docker/WSL 结果路径；不以本地测试冒充远程证据。
- `cargo fmt`/focused Rust tests、`check:core-boundaries` 和依赖许可证审计通过。

## 主要风险和处理

| 风险 | 处理 |
|---|---|
| 规则误删模型需要的证据 | 只压缩摘要型输出；错误/失败行保护；完整 patch、源码搜索和未知命令透传 |
| 过滤投影阻止原始大结果持久化 | 先按规范原始结果计算存储资格，再设置 `result_for_assistant` |
| Remote workspace 再次走 controller-local 逻辑 | 过滤器只放在 Runtime 工具结果管线，不接入本地 hooks 或 controller adapter |
| 外部项目许可证或依赖发生变化 | 仅在 spike 通过后锁定精确版本；升级前保留 snapshot、NOTICE 和 SPDX 审计结果 |
| 规则数量膨胀、维护成本失控 | 先保持单一安全策略；每个新增规则必须有真实输出样本和回归测试 |

## 当前实现状态

第一版已落地：

- 使用 pinned `lean-ctx-patterns` revision `7b157a3`，通过 `command-output-filter` capability feature 编译；运行时开关仍默认关闭。
- `ExecCommand` 在插件 PostToolUse 和 large-result 持久化之后生成 assistant projection，canonical `result.output` 始终保留原始内容。
- 首批白名单覆盖 `git status/log/diff --stat|--name-only|--numstat`、Cargo 构建/检查/测试、npm/pnpm/yarn 常用构建/安装/测试、pytest、Docker 列表/日志和 kubectl get/logs/describe；未知命令、管道、交互/运行中命令和完整 diff 透传。
- 配置 owner、生成的产品控制目录、Execution Settings、三种 Web locale、CLI/Desktop/Server/SDK Host 的 capability closure 已同步。
- 已完成配置回读、过滤器、pipeline canonical/raw 分离、产品控制、工具结果存储、capability generation、i18n 和 core-boundary 验证。尚未启动开发服务器或进行 UI 交互验证；远程 provider 的真实 SSH/Docker/WSL conformance fixture 仍属于后续验证项。

