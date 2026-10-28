# AgentRouter

Magpie 的 AgentRouter 供应商插件：五种独立登录方式、原生多账号与智能路由、可选每日签到，以及跨协议的请求保护。请求保护由供应商的 `auth.loader.fetch` 执行，不启动独立代理，不改 Codex 配置或本地会话，不给其他供应商套全局拦截器。

运行时只使用 JavaScript、标准 Web API 和读取自带图标文件的 `node:fs`，跑在 Magpie 的 Bun 插件宿主上，不分 Windows、macOS、Linux。设计与验收标准见 [DESIGN.md](DESIGN.md)，来源与许可见 [UPSTREAM.md](UPSTREAM.md)。

## 安装

```sh
magpie plugin add opencode-agentrouter-auth          # npm
magpie plugin add github:roiding/opencode-agentrouter-auth   # git
magpie plugin add /path/to/opencode-agentrouter-auth # 本地文件夹
magpie plugin login agentrouter
```

需要 Magpie 0.1.1813 及以上：账号密码与系统访问令牌登录依赖宿主的 `keyless` 支持，旧版会退回多余的 API key 提问。

本插件与社区 AgentRouter 插件使用相同的供应商 ID `agentrouter`。两者同时安装时，用 `magpie plugin use` 选择由哪个插件服务该供应商，不把两份认证实现串联。已有 API key、站点会话、用户 ID、显式端点及请求头会通过兼容层读取；不会删除账号、重置令牌或擅自改变旧的独立请求/站点地址。**旧账号即使保存了密码，也不会因此默认开启自动签到**；需要通过账号密码方式明确选择开启。其他供应商的配置不改。

## 登录方式

| 入口 | 需要提供什么 | 自动签到 | 余额 |
| --- | --- | --- | --- |
| 账号密码 | AgentRouter 站点用户名、密码 | 可选，默认关闭 | 有效站点会话允许时读取 |
| GitHub | 浏览器完成正常授权，再交接回调或本站会话 | 不自动执行每日 OAuth | 有效站点会话允许时读取 |
| LinuxDO | 浏览器完成正常授权，再交接本站会话 | 不自动执行每日 OAuth | 有效站点会话允许时读取 |
| 系统 Access Token | AgentRouter 系统令牌和用户 ID | 不允许 | 站点权限及防护允许时读取 |
| 模型 API key | 模型调用密钥 | 不允许 | 不查询账号余额 |

所有入口都提供端点选择、可选账号名称和基础自定义头能力。账号级额外请求头、已有调用密钥 ID 放在可选高级设置中，不要求所有用户依次填密码、Cookie、访问令牌和各种备用凭据。

账号密码、OAuth 和系统令牌入口会读取账号已有的调用密钥：只有一个有效密钥时使用它；存在多个时要求明确选择数字 ID，不擅自选第一条。没有有效密钥会明确失败，要求用户在站点管理好密钥后再连接。不会调用重置系统访问令牌的 `/api/user/token`，也不会自动创建、旋转或删除调用密钥。

模型 API key 和系统 Access Token 是两类不同凭据，不能混用。API key 入口只提供模型发现和请求保护。

## GitHub / LinuxDO 回调与端点

每个账号选择 `agentrouter.org` 或 `ps.air-outer.com`。新账号的默认 API 与站点操作使用所选端点；OAuth 应用注册的回调仍是 `agentrouter.org`，之后的 AgentRouter 侧登录兑换可以在所选端点进行。

GitHub 默认沿用未消费授权码的交接方式：浏览器返回 `agentrouter.org/oauth/github/magpie` 后，将完整地址粘回 Magpie。该子路径可能显示未找到页面，这是为了不让站点普通回调页先兑换授权码。插件校验可信域名、路径和本次 state，再携带该流程自己的站点 Cookie 向所选端点兑换；授权码不能重放。

**LinuxDO 不假设可以沿用 GitHub 的回调子路径。** 默认走网站自己的完整登录流程，再由用户明确交接 AgentRouter 会话：

1. 在打开的站点登录页选择 LinuxDO，完成正常浏览器登录；必要时将返回地址中的 `agentrouter.org` 换成所选端点域名。
2. 登录后打开浏览器开发者工具的 Network，刷新账号页面，找到本站的 `GET /api/user/self`，选择 Copy as cURL（bash 格式）。
3. 将复制内容粘到 Magpie 的登录交接框。也可使用包含 `cookie` 和 `userId` 的 JSON 导出。

该内容是敏感凭据，只在本机 Magpie 中使用，不要粘贴到聊天、Issue 或日志。**插件只解析文本，不执行 cURL 或任何命令**，只接受已知 AgentRouter 域名的本站请求。随后只读校验用户 ID，再读取已有调用密钥。导入的浏览器客户端头仅用于本站接口，不覆盖模型请求的客户端标识。

GitHub 也可选择这种完整网页登录后的交接方式。LinuxDO 的未消费回调 URL 方式保留为高级选项，但不能拿已被站点网页兑换的授权码再试。

不保存 GitHub/LinuxDO 的网站登录 Cookie，不管理它们的多账号浏览器资料，不每天自动重新授权。OAuth 登录是否同时获得当日奖励，以站点实际响应为准，不能仅凭已有会话或余额刷新宣称签到成功。

## 签到、余额和多账号

- 自动签到只由 Magpie 的 `auth.checkin` 调度。供应商启用签到后，插件仍要求该账号明确选择签到、并具备站点账密和用户 ID。
- 开启签到才把站点密码保存到 Magpie 本地认证存储；关闭时密码只用于当次登录。这里不是承诺使用系统钥匙串或加密存储，仍需保护本机认证文件。
- 签到是站点登录操作，响应 `checked_in: true` 才记为新领取；当日已处理则不再次登录。并发重复调用会合并。
- 返回的站点用户 ID 必须匹配目标账号；错误密码、验证码或账号变更不能覆盖另一个账号的会话，也不误判独立模型 key 失效。
- `auth.usage` 严格只读，不因查余额失败而登录签到。余额缺失或受 WAF 拦截时显示未知；累计消耗不是余额，未知不是零。
- 有真实余额时使用 Magpie 的钱包余额字段参加原生路由，不伪造百分比或午夜刷新窗口。签到奖励增加余额，不等于额度每天自动重置。

可重复添加多个账号。每个账号的端点、凭据、模型和签到状态独立，由 Magpie 决定账号选择、冷却、并发及故障切换；插件内部没有隐藏的账号池。按意图换模型也使用 Magpie 的原生路由组，过滤器自己不换模型。

## 模型与请求头

**没有默认模型。** 模型目录按账号发现，公共元数据仅补充协议能力，不凭公共定价表增加账号模型。用户显式声明的模型和 API 地址作为人工覆盖保留，最终权限仍由上游校验。发现失败时保留可信缓存/显式配置，不退回写死的模型名单。

模型 API 可以是 Responses、Chat Completions、Anthropic Messages 或 Gemini。用户显式 SDK/模型配置优先；不使用一个无条件的 loader `baseURL` 覆盖所有模型的独立地址。AgentRouter 元数据只写 `openai` 时无法区分 Chat 与 Responses，默认按该站点现有 Responses 接入，仍允许用户明确覆盖 SDK。

自定义头不是某种登录的附加特权。账号默认头只补充请求，Magpie 已合并的本次请求/当前模型头优先；不混合其他模型的头。兼容客户端标识可关闭或覆盖。认证头使用当前账号的模型密钥，并按出站协议选择 Bearer、`x-api-key` 或 `x-goog-api-key`。站点 Cookie、系统令牌及用户 ID 不发送到模型接口。

账号级自定义头不能直接覆盖认证、Cookie、Host、连接与长度等受管理字段；此类凭据应由对应登录方式维护。

## 多协议请求保护

保护四类对话 API 的流式与非流式请求：

1. 首次保留请求体原始字节；普通重试也保留，不预先删历史、不替换 `model`。这里指 `fetch` 收到的上游协议请求；Magpie 可能已转换客户端协议。
2. 仅 Responses 的明确资源不匹配或 `invalid_encrypted_content` 才执行已验证的历史清理。非流式 HTTP 200 中明确的错误对象也在交付前检查。
3. 清理保留消息正文、图片、phase、工具参数/结果及 `call_id` 配对；需要无法恢复的服务端引用、压缩或 item reference 时明确失败，不静默丢上下文。
4. Chat、Anthropic、Gemini 不套用 Responses 字段删除。thinking、signature、thoughtSignature 不会因为泛化错误而被删掉；未经验证的签名修复不猜着做。
5. 限流、传输与已识别的可用性错误有限重试；认证失败、余额不足和普通参数错误不触发清理。

单次选定供应商调用最多额外重试 20 次，资源/限流/传输/可用性分别最多 5/20/10/10 次，遵守服务端等待提示、总期限、空闲期限和客户端取消。Magpie 跨账号故障切换是独立外层，不应把这里的 20 次宣传为整条调用链的总数。

SSE 在确认有效终止前不交付内容或客户端工具调用。Responses 识别 completed/incomplete；Chat 检查 choices 和 DONE；Anthropic 检查 message_stop；Gemini 检查候选项结束或合法阻断，并等待正常流结束、保留用量尾帧。失败尝试整体丢弃，同一网络块中终止标记之后的多余内容不泄露。合法拒绝、长度终止不当成断流重放。

未知路径及上传、删除、批任务、站点管理等操作不盲目重放。压缩/二进制请求体暂按原格式透传，不冒充能够安全清理；正常 fetch 自动解压的上游 JSON/SSE 响应可以处理。插件不能扩展 Magpie 尚未提供的网关入口。

全量缓冲增加首字等待。默认单个请求/响应缓冲上限 64 MiB，并非整个宿主的内存上限；并发及拷贝会增加峰值。取消会中止读取和退避；超限明确失败，不改成先输出再重试。它不保证上游工具或推理只执行/计费一次。

## 开关与参数

供应商开关「安全重试加密历史错误」只控制请求保护，不影响认证及账号能力。默认开启。插件选项示例：

```json
{
  "quotaPerUnit": 500000,
  "filter": {
    "enabled": true,
    "deadlineMs": 1800000,
    "idleTimeoutMs": 120000,
    "maxBufferBytes": 67108864,
    "maxRequestBytes": 67108864
  }
}
```

日志只记录结构化事件、类别、计数和耗时，不记录请求正文、密码、Cookie、令牌、授权码或 state。

## 开发

```sh
npm test
bun test
```

普通测试只使用模拟数据和本地 HTTP 服务，不读取真实账号或调用收费模型。真实 Magpie 宿主/网关测试默认跳过，必须明确提供测试路径：

```sh
MAGPIE_TEST_HOST=/path/to/host.js MAGPIE_TEST_BUN=/path/to/bun npm run test:host
MAGPIE_TEST_BINARY=/path/to/magpie MAGPIE_TEST_BUN=/path/to/bun npm run test:gateway
```

宿主脚本应来自隔离 HOME 中 Magpie 写出的缓存。这些测试创建临时配置、模拟账号和回环服务，并在结束后清理，不修改现有 Magpie 配置。

本包自包含，不捆绑上游源码。旧通用供应商入口 `generic.mjs` 继续保留，用于非 AgentRouter 场景，不会由默认入口自动注册。

## License

MIT
