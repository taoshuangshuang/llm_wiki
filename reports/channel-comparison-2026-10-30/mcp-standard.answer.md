imeta 是 BIP 平台的元数据引擎（元数据组件库/SDK），围绕元数据的建模、存储与查询提供核心能力。知识库中没有名为 “imeta” 的独立主题页，以下结论由相关页面汇总：

1. **组件定位与结构**：旧版总览（wiki/legacy/营销云领域元数据体系总览（2016-2017 旧版）.md，注意为 2016-2017 历史资料）描述了 imeta 组件结构：core（元数据结构）、io（元数据加载、保存、模型转换）、orm（数据库增删改查、查询方案解析）、biz（业务基类、业务校验、Json 序列化、导入导出）、tpl（代码/文档/测试生成）、Spring.*（Spring 集成）。FAQ 页（wiki/faqs/元数据相关问题排查指引.md）也把 imeta 与“元数据、元数据服务、特征、元数据SDK”并列为独立模块。

2. **查询能力（当前知识库中 imeta 内容最集中的维度）**：imeta 提供 QuerySchema 查询 API，将查询 Schema 转为 SQL 并获取实体，整体链路见 wiki/designs/imeta QuerySchema转SQL与实体获取流程.md；其 Spring 自动装配与 QueryConfiguration 构建见 wiki/designs/imeta Spring 装配与查询核心生命周期.md；配置参数（如查询仓、执行路由、EnableElasticAutoCompose 等）的能力边界见 wiki/constraints/imeta 查询配置参数与能力边界.md。

3. **与开发框架的关系**：wiki/concepts/MDD 与 YPD 调用 imeta 查询的入口与职责边界.md 说明——YPD 将 QuerySchema 查询完整交给 imeta 执行，MDD 仅借用 QuerySqlBuilder 生成 QuerySqlStruct，SQL 执行与结果处理由 MDD 自行接管（该页论断来自来源文档描述，未标注源码验证）。

**证据边界**：imeta 的模块划分来自标注为历史版本的总览页，当前版本的组件结构未经源码验证；知识库现有页面主要覆盖 imeta 的查询链路、配置约束与升级限制（另见 wiki/constraints/imeta升级与二开适配限制.md）。如需更完整的 imeta 定义页（如建模、发布、存储管理能力），现有 wiki 尚无对应主题页，属于知识缺口。