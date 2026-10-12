# Future-Code 商业版

[English](README.md)

这是面向客户的 **可验证自主研发执行平台**。商业分支保留必要的 Foundry/Swarm 运行时、校验与恢复机制；研究论文、专利交底材料和无关的旧版终端应用均不保留在当前分支的文件树中。

## 使用步骤

要求 Node.js >=22.16、Git，建议 Linux/macOS/WSL。

```sh
node src/commercial/app.mjs provider add
node src/commercial/app.mjs provider list
node src/commercial/app.mjs license request
node src/commercial/app.mjs license status
```

配置向导由用户交互式输入自己的服务地址、模型、协议、认证头部与密钥。密钥可使用本地加密保险库、每次隐藏输入、环境变量注入或免认证的本地服务；**仓库不保存用户 URL 和 API Key**。内置 Chat Completions、Anthropic Messages、OpenAI Responses、Gemini 四种线上格式；其他服务需要兼容相应协议或另行开发适配器。

付费/授权用户从管理员获得针对安装 ID 的 Ed25519 签名激活码：

```sh
node src/commercial/app.mjs license activate --file YOUR_TOKEN_FILE
```

发行方必须先用离线工具生成私钥、将审核后的**公钥**加入受信发行者列表；私钥绝不可提交。离线激活不支持即时撤销，也不能防止别人修改源代码绕过客户端检查。

## 已授权后的运行

```sh
node src/commercial/app.mjs init --profile primary --spec examples/swarm/spec.json --allow-exec
node src/commercial/app.mjs run --profile primary --tasks examples/swarm/tasks.json --allow-exec
node src/commercial/app.mjs status
```

`--allow-exec` 将执行事先配置的检查命令。工作树隔离不等于操作系统安全沙箱，应先使用可信仓库，或在额外加固的环境中运行。

```sh
node scripts/test-commercial.mjs
node scripts/test-swarm.mjs
```

**商业发行仍存在法律前置条件**：需要确认已有源代码及第三方依赖的权属和使用授权，详见 `docs/SOURCE_PROVENANCE.md`。目前的代码与说明不构成商业再分发许可、企业级安全认证或生产力优于其他产品的验证结论。
