根据知识库检索结果，imeta 在本项目语境中是 iuap 元数据体系里的**元数据查询组件**。需要说明：知识库中没有一篇专门定义 imeta 整体的现行版主题页，以下是从多个相关页面归纳的证据：

1. **定位**：元数据服务（iuap-metadata-base）页面写明，元数据服务"向上对接元数据 SDK、imeta 查询组件"，即 imeta 是运行在元数据 SDK 之上的查询组件（wiki/modules/元数据服务（iuap-metadata-base）.md）。

2. **核心查询 API 是 QuerySchema**："QuerySchema（imeta 查询 API）"页说明 imeta 提供的一套面向元数据的查询 API，风格遵循 GraphQL，核心特点是屏蔽底层存储模型、完全面向元数据实体进行查询，基于 Java 实现，具有只读语义（wiki/topics/QuerySchema（imeta 查询 API）.md）。

3. **接入方式**：通过 Spring Boot starter `iuap-ap-metaquery-starter` 依赖引入（来源摘要页 wiki/sources/3-元数据--14-11-元数据服务sdk与缓存--1cyes42.md 的"imeta核心内容"）；其 Spring 装配与 QueryConfiguration 构建流程见 wiki/designs/imeta Spring 装配与查询核心生命周期.md。

4. **配置形态**：imeta 通过 imeta.xml 等配置管理查询仓、执行路由、查询语义、SQL 构建等参数，参数默认值与能力边界集中在 wiki/constraints/imeta 查询配置参数与能力边界.md；误配查询仓可导致升级后报错（案例见 wiki/cases/KKZC-73200-R6升级V5后imeta查询仓配置报错.md）。

5. **历史组件结构**（仅历史参考）：2016-2017 旧版资料记载 imeta 由 core（元数据结构）、io（加载/保存/模型转换）、orm（数据库增删改查与查询解析）、biz、tpl、Spring 集成等部分组成（wiki/legacy/营销云领域元数据体系总览（2016-2017 旧版）.md）。该结构来自旧版历史文档，不代表当前版本实现。

**证据边界**：现行版本下 imeta 的官方整体定义页缺失，上述第 1-4 点来自各相关页面交叉印证，属来源事实；历史组件结构仅适用于旧版资料。