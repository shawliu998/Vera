# Vera 产品收束 P4：同案工作流基线

日期：2026-07-12

## 结论

`npm run test:vera:civil-case-workflow` 在一个临时、文件落盘的案件库中
连续执行同一宗民商事案件的七个阶段，并在关闭、重新打开本地仓库后核对
持久化结果。该测试不使用模型、浏览器 API mock 或 loopback 语义结果。

夹具分类为 `synthetic_anonymized_structure`。它使用脱敏的中国民商事案件
结构和合成内容，不含真实客户材料，因此不能作为真实案卷质量验证。

## 已验证

1. 中文民商事案件接收字段持久化。
2. 同批导入 TXT、XLSX 和真实三页 image-only PDF；PDF 第二页包含表格布局。
3. OCR helper 返回错误 schema 时 PDF 失败关闭，不产生伪造文本。
4. 修复 runtime 后使用 Apple Vision 重试，页码、置信度和解析尝试落盘。
5. 扫描件与表格来源按 PDF 页边界进入 source index；第 1、2 页摘录可同时绑定。
6. 两页摘录全部撤回后 Agent 输入失败关闭，重新检索确认后恢复。
7. 低置信度 OCR 摘录要求律师比对原件后才能确认。
8. 核验法律依据后确认抗辩，同时保留不确定性。
9. 更正送达日期会使旧期限和派生任务失效。
10. 诉讼文书生成 v1、律师修改为 v2、形成 diff 并完成版本审批。
11. 未批准和过期批准均不能导出；重新生成、批准后可下载 OOXML DOCX。
12. 庭审卷宗索引落盘；重开仓库后事实、抗辩和批准文书仍可读取。

重复运行的九个阶段用时约 2-6 秒，主要波动来自 Swift/Apple Vision 冷启动。
人工接管点是 OCR runtime 修复、低置信度
原件比对，以及程序日期更正后的重新计算和确认。

## 尚未覆盖

- 真实脱敏客户 PDF；
- 可信本地中文模型评测；
- backend Node runtime 的 SQLCipher 重启。打包版 Electron SQLCipher 由独立审计覆盖。

因此 P4 当前完成了计划中的 **9/9 核心后端工作流阶段**，但仍不是完整产品
E2E，也不是
法律正确性或生产就绪证明。

多页夹具还暴露并修复了两个生产风险：OCR helper 提前退出时大文件 stdin
写入会产生未处理的 `EPIPE`；短多页 PDF 会被合并为单一第 1 页 chunk。当前
实现会捕获 OCR 输入管道失败，并强制 chunk overlap 不得跨越 PDF 页边界。

重建的本地 `Vera.app` 已通过 SQLCipher runtime、包资源卫生、隔离启动、
原始文档安全保存和 packaged native OCR 审计；应用重开后的前后端健康检查
均为 200。当前产物仍未签名、未公证，仅供本地验证。
