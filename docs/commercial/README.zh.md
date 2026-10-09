# Future-Code 商业化预览（`commercial` 长期分支）

**产品愿景：可验证的自主科研与工程研发。** 新增客户试点评测、静态指标面板、商业化发布条件检查；现有 Foundry/Swarm 运行时保持不变，也不会修改 `main`。

使用 Node.js >=22.16：

```sh
node src/commercial/cli.mjs help
node src/commercial/cli.mjs doctor
node src/commercial/cli.mjs demo
node scripts/test-commercial.mjs
```

`doctor` 会在审批条件不满足时给出 BLOCKED；`demo` 使用**离线回放**，无法证明实际模型生产力提升。真实模型 A/B 对照实验参考英文 [README.md](README.md) 和 [PILOT_PROTOCOL.md](PILOT_PROTOCOL.md)：固定项目提交、模型、验证器、测试、预算与任务，仅允许改变调度策略，至少重复三轮。可使用 `report --input FILE --out FILE --html FILE` 生成只读 JSON 和本地 HTML 面板。

**重要：当前仍未获得验证的商业再分发授权。** 详见 `docs/SOURCE_PROVENANCE.md`，存在有待查明权利归属的导入代码和依赖。此分支不会擅自增加项目全局许可证、商业收费逻辑、未授权的云服务或者未经验证的 2 倍提效宣传。上线前还需独立完成隔离安全、法务审查和真实客户验证。

本次变更保留在 `commercial` 分支，不合并到 `main`。
